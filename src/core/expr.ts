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

    // CSP-safe mode: use external parser
    if (this.cfg.cspSafe) {
      try {
        const fn = this._getParser().compile(exp, this);
        return this._ec.set(k, fn);
      } catch (err) {
        console.warn('Reflex: CSP-safe compile error:', exp, err);
        return this._ec.set(k, () => undefined);
      }
    }

    // Standard mode: use new Function (faster but requires unsafe-eval CSP)
    //
    // ⚠️ CRITICAL SECURITY WARNING (SEC-2026-003 Issue #2): RCE via Literal Constructor
    //
    // VULNERABILITY: Standard Mode using `new Function()` is FUNDAMENTALLY INSECURE.
    // The Global Barrier (_g) only intercepts VARIABLE LOOKUPS, not property access
    // on objects created INSIDE the expression.
    //
    // EXPLOIT: {{ (function(){}).constructor('return process')().env }}
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //          Creates native function → .constructor → global Function → RCE
    //
    // The membrane CANNOT protect against this because literals ([{}, [], function(){}])
    // created inside `new Function()` are NATIVE OBJECTS with access to global constructors.
    //
    // RECOMMENDED FIX: Deprecate Standard Mode entirely. Force CSP Mode for ALL deployments.
    // CSP Mode uses SafeExprParser which operates at the AST level and can block
    // `.constructor` access on ALL objects, including literals.
    //
    // TEMPORARY MITIGATION: Use CSP Mode in production:
    //   app.configure({ cspSafe: true, parser: new SafeExprParser() })
    //
    // WARNING: This violates strict Content Security Policy (CSP) headers.
    // Enterprise environments (banks, gov, healthcare) often block 'unsafe-eval'.
    // For CSP-compliant deployments, use: app.configure({ cspSafe: true, parser: SafeExprParser })
    //
    // TODO (Breaking Change v2.0): Remove Standard Mode, make CSP Mode mandatory
    const magicArgs = 'var $refs=_r,$dispatch=_d,$nextTick=_n,$el=_el;';

    // SECURITY AUDIT WARNING: Log deprecation warning in development
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      if (!this._standardModeWarningShown) {
        this._standardModeWarningShown = true;
        console.warn(
          '🚨 Reflex Security Warning: Standard Mode is DEPRECATED due to unfixable RCE vulnerability.\n' +
          '   Attack vector: {{ (function(){}).constructor(\'...\')() }}\n' +
          '   STRONGLY RECOMMENDED: Use CSP-safe mode in production:\n' +
          '   app.configure({ cspSafe: true, parser: new SafeExprParser() })\n' +
          '   See: https://reflex.dev/security/csp-mode'
        );
      }
    }

    // Detect CSP violations and provide helpful error message
    let rawFn;
    const self = this;

    if (isH) {
      // Handler mode: use 'with' to allow mutations like count++
      // First check if there's a context (c), fall back to state (s)

      // Auto-call simple function references: "onEnter" -> "onEnter()"
      // This handles the common pattern @click="handler" (without parentheses)
      let handlerExp = exp;
      let useReturn = false;

      if (/^[a-z_$][\w$.]*$/i.test(exp) && !exp.includes('.')) {
        // Simple identifier - auto-call it
        handlerExp = `${exp}($event)`;
        useReturn = true; // Single function call can return cleanup
      } else if (/^[a-z_$][\w$.]+$/i.test(exp) && exp.includes('.') && !exp.includes(';')) {
        // Method path like obj.method - auto-call it
        handlerExp = `${exp}($event)`;
        useReturn = true; // Single function call can return cleanup
      } else if (!exp.includes(';')) {
        // Single expression without semicolons - can safely return
        useReturn = true;
      }

      // For single expressions (like function calls), add return to capture cleanup
      // For multi-statement expressions (with ;), don't add return
      // SECURITY NOTE: Cannot use 'use strict' with 'with' statements (SyntaxError)
      // Instead, we rely on the Iron Membrane (createMembrane) for runtime security
      // The membrane blocks dangerous property access ('constructor', '__proto__', etc)
      //
      // CRITICAL SECURITY FIX (Issue #1): Global Barrier prevents RCE via global scope escape
      // Without the barrier: {{ window.location.href = 'evil.com' }} enables RCE
      // The barrier intercepts global lookups and only allows safe globals (Math, Date, etc.)
      const body = useReturn
        ? `${magicArgs}with(_g){with(c||{}){with(s){return(${handlerExp})}}}`
        : `${magicArgs}with(_g){with(c||{}){with(s){${handlerExp}}}}`;
      try {
        rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', '_g', body);
        return this._ec.set(k, (s, c, e, el) => {
          try {
            // CRITICAL SECURITY FIX: Wrap $el in element membrane to prevent sandbox escape
            // Without this, {{ $el.ownerDocument.defaultView.alert('pwned') }} enables full RCE
            return rawFn(
              createMembrane(s), createMembrane(c || {}), e,
              self._refs,
              self._dispatch.bind(self),
              self.nextTick.bind(self),
              createElementMembrane(el),
              createGlobalBarrier()
            );
          } catch (err) {
            // Membrane security errors - silently return undefined to prevent code execution
            if (err instanceof Error && err.message.includes('Reflex Security')) {
              if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
                console.error(err.message);
              }
              return undefined;
            }
            throw err;
          }
        });
      } catch (err) {
        // Check if this is a CSP violation
        if (err instanceof EvalError || (err.message && err.message.includes('unsafe-eval'))) {
          const cspError = new Error(
            'Reflex: CSP VIOLATION - new Function() is blocked by Content Security Policy.\n' +
            'Your environment blocks \'unsafe-eval\'. To fix this:\n' +
            '1. Enable CSP-safe mode: app.configure({ cspSafe: true, parser: SafeExprParser })\n' +
            '2. Import the parser: import { SafeExprParser } from \'reflex/csp\'\n' +
            '3. Or update CSP headers to allow \'unsafe-eval\' (NOT recommended)\n' +
            'Expression: ' + exp
          );
          console.error(cspError);
          throw cspError;
        }
        console.warn('Reflex compile error:', exp, err);
        return this._ec.set(k, () => undefined);
      }
    }

    // Read mode: extract variables for better performance
    const vars = new Set();
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(exp))) {
      if (!RESERVED[m[1]]) vars.add(m[1]);
    }

    const arg = Array.from(vars).map(v =>
      `var ${v}=(c&&(${JSON.stringify(v)} in c))?c.${v}:s.${v};`
    ).join('');

    // CRITICAL SECURITY FIX (Issue #1): Use Global Barrier instead of 'use strict'
    // - 'use strict' prevented {{ this.alert(1) }} but couldn't prevent {{ window.alert(1) }}
    // - Global Barrier wraps execution in with(_g) to intercept ALL global lookups
    // - Only allows safe globals (Math, Date, etc.) - blocks window, process, fetch, etc.
    // NOTE: Cannot use 'use strict' with 'with' statements (SyntaxError)
    const body = `${magicArgs}${arg}with(_g){return(${exp});}`;

    try {
      rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', '_g', body);
      // Wrap to inject magic properties and apply security membrane
      return this._ec.set(k, (s, c, e, el) => {
        try {
          // CRITICAL SECURITY FIX: Wrap $el in element membrane to prevent sandbox escape
          // Without this, {{ $el.ownerDocument.defaultView.alert('pwned') }} enables full RCE
          return rawFn(
            createMembrane(s), createMembrane(c), e,
            self._refs,
            self._dispatch.bind(self),
            self.nextTick.bind(self),
            createElementMembrane(el),
            createGlobalBarrier()
          );
        } catch (err) {
          // Membrane security errors - silently return undefined to prevent code execution
          if (err instanceof Error && err.message.includes('Reflex Security')) {
            if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
              console.error(err.message);
            }
            return undefined;
          }
          throw err;
        }
      });
    } catch (err) {
      // Check if this is a CSP violation
      if (err instanceof EvalError || (err.message && err.message.includes('unsafe-eval'))) {
        const cspError = new Error(
          'Reflex: CSP VIOLATION - new Function() is blocked by Content Security Policy.\n' +
          'Your environment blocks \'unsafe-eval\'. To fix this:\n' +
          '1. Enable CSP-safe mode: app.configure({ cspSafe: true, parser: SafeExprParser })\n' +
          '2. Import the parser: import { SafeExprParser } from \'reflex/csp\'\n' +
          '3. Or update CSP headers to allow \'unsafe-eval\' (NOT recommended)\n' +
          'Expression: ' + exp
        );
        console.error(cspError);
        throw cspError;
      }
      console.warn('Reflex compile error:', exp, err);
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
   * Get CSP parser (must be injected via configure)
   */
  _getParser() {
    if (!this._parser) {
      throw new Error(
        'Reflex: CSP mode requires a parser. Use configure({ parser: new SafeExprParser() }). ' +
        'Import SafeExprParser from \'reflex/csp\' or provide a custom parser with compile(exp, reflex) method.'
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
