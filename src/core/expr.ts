/**
 * Reflex Core - Expression Compiler
 *
 * Handles expression parsing and compilation with:
 * - Fast-path optimizations for common patterns (80%+ of cases)
 * - Expression caching with FIFO eviction
 * - Security validation for prototype pollution prevention
 * - CSP-safe mode support via external parser
 *
 * ## CSP (Content Security Policy) Compatibility
 *
 * CRITICAL FIX (Issue #5): Default CSP Violation Documentation
 *
 * ### The Problem
 * Standard mode uses `new Function()` which requires 'unsafe-eval' in CSP headers.
 * Many enterprise environments (banking, government, healthcare) block 'unsafe-eval'.
 * Without proper configuration, Reflex will crash with cryptic CSP errors.
 *
 * ### The Solution
 * Reflex auto-detects CSP restrictions and warns developers. For CSP-safe mode:
 *
 * ```javascript
 * import { Reflex } from 'reflex';
 * import { SafeExprParser } from 'reflex/csp';
 *
 * const app = new Reflex({ count: 0 });
 * app.configure({
 *   cspSafe: true,
 *   parser: new SafeExprParser()
 * });
 * ```
 *
 * ### Performance Trade-off
 * - Standard mode: ~10x faster expression compilation (uses native `new Function()`)
 * - CSP-safe mode: Slower but works in strict CSP environments
 *
 * For high-performance needs in CSP environments, consider pre-compiling expressions
 * at build time instead of runtime.
 */

import { META, RESERVED, ID_RE, createMembrane, createElementMembrane, createGlobalBarrier } from './symbols.js';

/**
 * Expression cache with LRU (Least Recently Used) eviction strategy.
 * Uses Map's insertion order to track access recency.
 * When cache is full, removes the least recently accessed entry.
 * This prevents cache thrashing that would cause compilation storms.
 */
export class ExprCache {
  declare max: number;
  declare cache: Map<string, any>;

  constructor(maxSize = 1000) {
    this.max = maxSize;
    this.cache = new Map();
  }

  get(key: string) {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by deleting and re-inserting
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set<T>(key: string, value: T): T {
    // If key exists, delete it first so re-insertion moves it to end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      // LRU eviction: remove oldest (first) entry
      // Map maintains insertion order, so first key is least recently used
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
    return value;
  }

  has(key: string) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Expression compiler mixin for Reflex class.
 */
export const ExprMixin = {
  /**
   * Compile an expression string to an evaluator function.
   *
   * @param {string} exp - Expression to compile
   * @param {boolean} isH - Is handler mode (no return value expected)
   * @returns {Function} Evaluator (state, context, $event, $el) => result
   */
  _fn(exp, isH = false) {
    // TASK 9.2: Trim whitespace to ensure fast paths work correctly
    // Without this, expressions like " item " (with spaces from {{ item }})
    // don't match fast path regexes and fall through to slow path without
    // proper dependency tracking for FlatScopes
    exp = exp.trim();

    const k = (isH ? 'H:' : '') + exp;
    const cached = this._ec.get(k);
    if (cached) return cached;

    // SECURITY NOTE: Standard mode now uses "The Iron Membrane 2.0" - a white-list only
    // runtime Proxy sandbox that provides defense-in-depth against code injection.
    // The membrane wraps state and context objects, blocking access to dangerous
    // properties like 'constructor', '__proto__', 'prototype', and global objects.
    // This replaces fragile regex validation with runtime enforcement that cannot
    // be bypassed through string concatenation or Unicode escapes.

    // === FAST PATH OPTIMIZATIONS ===
    // Skip new Function/regex for common simple expressions
    // SECURITY (SEC-2026-003 Issue #5): Fast Path Security Bypass
    //
    // VULNERABILITY: Fast path regex `^[a-z_$][\w$.]*$` allows accessing any property
    // including Object.prototype methods (toString, valueOf, etc.) which could be used
    // for gadget chains or to bypass the membrane.
    //
    // FIX: Expand PROTO_PROPS_FAST to include ALL known Object.prototype methods.
    // This ensures fast paths fall through to the membrane for dangerous properties.
    //
    // Alternative: Remove fast paths entirely and rely solely on the membrane.
    // Trade-off: Fast paths provide ~5x performance boost for simple expressions,
    // so we keep them but block ALL prototype methods, not just the dangerous three.
    const PROTO_PROPS_FAST: { [key: string]: 1 } = {
      // Dangerous prototype chain properties
      constructor: 1, '__proto__': 1, prototype: 1,
      // Object.prototype methods (could be used for gadgets)
      toString: 1, valueOf: 1, toLocaleString: 1,
      isPrototypeOf: 1, propertyIsEnumerable: 1,
      hasOwnProperty: 1, // Already safe in membrane but block in fast path
      // Function.prototype (if accessed on function values)
      call: 1, apply: 1, bind: 1,
      // Additional potential vectors
      __defineGetter__: 1, __defineSetter__: 1,
      __lookupGetter__: 1, __lookupSetter__: 1
    };
    const hasProtoProperty = (parts: string[]) => parts.some(p => PROTO_PROPS_FAST[p]);

    // Fast path 1: Simple negation (!isActive, !user.verified)
    // SECURITY: Skip fast path for prototype-related properties
    if (!isH && exp.charCodeAt(0) === 33 && /^![a-z_$][\w$.]*$/i.test(exp)) {
      const inner = exp.slice(1);
      const p = inner.split('.');
      // SECURITY: Skip fast path for dangerous properties - use slow path with membrane
      if (hasProtoProperty(p)) {
        // Fall through to slow path
      } else {
        const self = this;
        return this._ec.set(k, (s, o) => {
          if (o) { const meta = o[META] || self._mf.get(o); if (meta) self.trackDependency(meta, p[0]); }
          let v = (o && p[0] in o) ? o : s;
          for (const pk of p) { if (v == null) return true; v = v[pk]; }
          return !v;
        });
      }
    }

    // Fast path 2: Simple property path (count, user.name, user.profile.avatar)
    // SECURITY: Skip fast path for prototype-related properties
    if (!isH && /^[a-z_$][\w$.]*$/i.test(exp)) {
      const p = exp.split('.');
      // SECURITY: Skip fast path for dangerous properties - use slow path with membrane
      if (!hasProtoProperty(p)) {
        const self = this;
        // Optimization: specialize for single-segment paths (most common)
        if (p.length === 1) {
          const key = p[0];
          return this._ec.set(k, (s, o) => {
            if (o) { const meta = o[META] || self._mf.get(o); if (meta) self.trackDependency(meta, key); }
            return (o && key in o) ? o[key] : s[key];
          });
        }
        return this._ec.set(k, (s, o) => {
          if (o) { const meta = o[META] || self._mf.get(o); if (meta) self.trackDependency(meta, p[0]); }
          let v = (o && p[0] in o) ? o : s;
          for (const pk of p) { if (v == null) return; v = v[pk]; }
          return v;
        });
      }
    }

    // Fast path 3: Simple array access with numeric literal (items[0], users[1].name)
    // SECURITY: Skip fast path for prototype-related properties
    const arrMatch = !isH && /^([a-z_$][\w$]*)\[(\d+)\](\.[\w$.]+)?$/i.exec(exp);
    if (arrMatch) {
      const arrName = arrMatch[1], idx = parseInt(arrMatch[2], 10), rest = arrMatch[3];
      const restParts = rest ? rest.slice(1).split('.') : null;
      // SECURITY: Skip fast path for dangerous properties - use slow path with membrane
      if (restParts && hasProtoProperty(restParts)) {
        // Fall through to slow path
      } else {
        const self = this;
        return this._ec.set(k, (s, o) => {
          if (o) { const meta = o[META] || self._mf.get(o); if (meta) self.trackDependency(meta, arrName); }
          let arr = (o && arrName in o) ? o[arrName] : s[arrName];
          if (arr == null) return;
          let v = arr[idx];
          if (restParts) {
            for (const pk of restParts) { if (v == null) return; v = v[pk]; }
          }
          return v;
        });
      }
    }

    // CRITICAL SECURITY FIX (SEC-FINAL-004 Issue #1): Standard Mode Eliminated
    //
    // Standard mode using `new Function()` was FUNDAMENTALLY INSECURE and has been REMOVED.
    // The exploit {{ (function(){}).constructor('alert(1)')() }} bypassed all security measures
    // because the Global Barrier only intercepts variable lookups, not property access on
    // native objects created inside the expression.
    //
    // CSP-SAFE MODE IS NOW MANDATORY
    // Reflex now requires the SafeExprParser which operates at the AST level and can block
    // dangerous property access on ALL objects, including literals.
    //
    // To use Reflex, you MUST configure a parser:
    //   import { Reflex } from 'reflex';
    //   import { SafeExprParser } from 'reflex/csp';
    //   const app = new Reflex({ count: 0 });
    //   app.configure({ parser: new SafeExprParser() });
    //
    // This change eliminates the RCE vulnerability entirely at the cost of requiring
    // an external parser. The performance difference is negligible for most applications.

    try {
      const fn = this._getParser().compile(exp, this);
      return this._ec.set(k, fn);
    } catch (err) {
      console.warn('Reflex: Expression compile error:', exp, err);
      return this._ec.set(k, () => undefined);
    }
  },

  /**
   * $dispatch helper: dispatch custom event from element
   */
  _dispatch(event, detail, el) {
    const e = new CustomEvent(event, { detail, bubbles: true, cancelable: true });
    (el || this._dr).dispatchEvent(e);
    return e;
  },

  /**
   * Get parser (MANDATORY - Standard Mode has been removed for security)
   */
  _getParser() {
    if (!this._parser) {
      throw new Error(
        'Reflex: Expression parser is REQUIRED. Standard mode has been removed due to unfixable RCE vulnerability.\n' +
        'Configure a parser with: app.configure({ parser: new SafeExprParser() })\n' +
        'Import with: import { SafeExprParser } from \'reflex/csp\'\n' +
        'See: https://reflex.dev/security/csp-mode'
      );
    }
    return this._parser;
  },

  /**
   * Clear the expression cache
   */
  clearCache() {
    this._ec.clear();
    return this;
  }
};
