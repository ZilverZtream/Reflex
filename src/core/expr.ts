/**
 * Reflex Core - Expression Compiler
 *
 * Handles expression parsing and compilation with:
 * - Fast-path optimizations for common patterns (80%+ of cases)
 * - Expression caching with FIFO eviction
 * - Security validation for prototype pollution prevention
 * - CSP-safe mode support via external parser
 *
 * Standard mode uses `new Function()` for performance.
 * CSP mode requires an external parser (SafeExprParser).
 */

import { META, RESERVED, UNSAFE_PROPS, UNSAFE_EXPR_RE, ID_RE, normalizeUnicodeEscapes, createMembrane } from './symbols.js';

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
    const k = (isH ? 'H:' : '') + exp;
    const cached = this._ec.get(k);
    if (cached) return cached;

    // SECURITY: Enforce regex check before compiling (defense-in-depth)
    // Normalize Unicode escapes to prevent bypass attempts
    const normalized = normalizeUnicodeEscapes(exp);
    if (!this.cfg.cspSafe && UNSAFE_EXPR_RE.test(normalized)) {
      console.warn('Reflex: unsafe expression blocked:', exp);
      return this._ec.set(k, () => {});
    }

    // SECURITY NOTE: Standard mode now uses "The Iron Membrane" - an unbypassable
    // runtime Proxy sandbox that provides defense-in-depth against code injection.
    // The membrane wraps state and context objects, blocking access to dangerous
    // properties like 'constructor', '__proto__', 'prototype', and global objects.
    // This replaces fragile regex validation with runtime enforcement that cannot
    // be bypassed through string concatenation or Unicode escapes.

    // === FAST PATH OPTIMIZATIONS ===
    // Skip new Function/regex for common simple expressions

    // Fast path 1: Simple negation (!isActive, !user.verified)
    if (!isH && exp.charCodeAt(0) === 33 && /^![a-z_$][\w$.]*$/i.test(exp)) {
      const inner = exp.slice(1);
      const p = inner.split('.');
      for (const seg of p) {
        if (UNSAFE_PROPS[seg]) {
          console.warn('Reflex: Blocked access to unsafe property:', seg);
          return this._ec.set(k, () => undefined);
        }
      }
      const self = this;
      return this._ec.set(k, (s, o) => {
        if (o) { const meta = o[META] || self._mf.get(o); if (meta) self.trackDependency(meta, p[0]); }
        let v = (o && p[0] in o) ? o : s;
        for (const pk of p) { if (v == null) return true; v = v[pk]; }
        return !v;
      });
    }

    // Fast path 2: Simple property path (count, user.name, user.profile.avatar)
    if (!isH && /^[a-z_$][\w$.]*$/i.test(exp)) {
      const p = exp.split('.');
      for (const seg of p) {
        if (UNSAFE_PROPS[seg]) {
          console.warn('Reflex: Blocked access to unsafe property:', seg);
          return this._ec.set(k, () => undefined);
        }
      }
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

    // Fast path 3: Simple array access with numeric literal (items[0], users[1].name)
    const arrMatch = !isH && /^([a-z_$][\w$]*)\[(\d+)\](\.[\w$.]+)?$/i.exec(exp);
    if (arrMatch) {
      const arrName = arrMatch[1], idx = parseInt(arrMatch[2], 10), rest = arrMatch[3];
      if (UNSAFE_PROPS[arrName]) {
        console.warn('Reflex: Blocked access to unsafe property:', arrName);
        return this._ec.set(k, () => undefined);
      }
      const restParts = rest ? rest.slice(1).split('.') : null;
      if (restParts) {
        for (const seg of restParts) {
          if (UNSAFE_PROPS[seg]) {
            console.warn('Reflex: Blocked access to unsafe property:', seg);
            return this._ec.set(k, () => undefined);
          }
        }
      }
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
    // WARNING: This violates strict Content Security Policy (CSP) headers.
    // Enterprise environments (banks, gov, healthcare) often block 'unsafe-eval'.
    // For CSP-compliant deployments, use: app.configure({ cspSafe: true, parser: SafeExprParser })
    const magicArgs = 'var $refs=_r,$dispatch=_d,$nextTick=_n,$el=_el;';

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
      const body = useReturn
        ? `${magicArgs}with(c||{}){with(s){return(${handlerExp})}}`
        : `${magicArgs}with(c||{}){with(s){${handlerExp}}}`;
      try {
        rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', body);
        return this._ec.set(k, (s, c, e, el) => {
          try {
            return rawFn(
              createMembrane(s), createMembrane(c || {}), e,
              self._refs,
              self._dispatch.bind(self),
              self.nextTick.bind(self),
              el
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

    const body = `${magicArgs}${arg}return(${exp});`;

    try {
      rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', body);
      // Wrap to inject magic properties and apply security membrane
      return this._ec.set(k, (s, c, e, el) => {
        try {
          return rawFn(
            createMembrane(s), createMembrane(c), e,
            self._refs,
            self._dispatch.bind(self),
            self.nextTick.bind(self),
            el
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
