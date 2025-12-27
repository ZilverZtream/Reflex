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

import { META, RESERVED, UNSAFE_PROPS, UNSAFE_EXPR_RE, ID_RE } from './symbols.js';

/**
 * Expression cache with FIFO eviction strategy.
 * Removes oldest 10% of entries when at capacity to prevent
 * cache thrashing that would cause compilation storms.
 */
export class ExprCache {
  constructor(maxSize = 1000) {
    this.max = maxSize;
    this.cache = new Map();
    this._evictCount = Math.max(1, Math.floor(maxSize * 0.1));
  }

  get(key) {
    return this.cache.get(key);
  }

  set(key, value) {
    // FIFO eviction: remove oldest entries when at capacity
    // Map maintains insertion order, so first entries are oldest
    if (this.cache.size >= this.max) {
      let removed = 0;
      for (const k of this.cache.keys()) {
        if (removed >= this._evictCount) break;
        this.cache.delete(k);
        removed++;
      }
    }
    this.cache.set(key, value);
    return value;
  }

  has(key) {
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
  _fn(exp, isH) {
    const k = (isH ? 'H:' : '') + exp;
    const cached = this._ec.get(k);
    if (cached) return cached;

    // Security: Block dangerous expression patterns
    if (UNSAFE_EXPR_RE.test(exp)) {
      console.warn('Reflex: Blocked potentially unsafe expression:', exp);
      return this._ec.set(k, () => undefined);
    }

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
        if (o) { const meta = o[META] || self._mf.get(o); if (meta) self._tk(meta, p[0]); }
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
          if (o) { const meta = o[META] || self._mf.get(o); if (meta) self._tk(meta, key); }
          return (o && key in o) ? o[key] : s[key];
        });
      }
      return this._ec.set(k, (s, o) => {
        if (o) { const meta = o[META] || self._mf.get(o); if (meta) self._tk(meta, p[0]); }
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
        if (o) { const meta = o[META] || self._mf.get(o); if (meta) self._tk(meta, arrName); }
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
    // Inject magic properties: $refs, $dispatch, $nextTick, $el, $event
    const magicArgs = 'var $refs=_r,$dispatch=_d,$nextTick=_n,$el=_el;';

    // For handlers that mutate state (like count++), we need to use 'with'
    // to allow direct property access. For read expressions, we use local vars.
    // Note: 'with' works in sloppy mode (new Function doesn't add 'use strict')
    const self = this;

    if (isH) {
      // Handler mode: use 'with' to allow mutations like count++
      // First check if there's a context (c), fall back to state (s)
      const body = `${magicArgs}with(c||{}){with(s){${exp}}}`;
      try {
        const rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', body);
        return this._ec.set(k, (s, c, e, el) => rawFn(
          s, c || {}, e,
          self._refs,
          self._dispatch.bind(self),
          self.nextTick.bind(self),
          el
        ));
      } catch (err) {
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
      const rawFn = new Function('s', 'c', '$event', '_r', '_d', '_n', '_el', body);
      // Wrap to inject magic properties
      return this._ec.set(k, (s, c, e, el) => rawFn(
        s, c, e,
        self._refs,
        self._dispatch.bind(self),
        self.nextTick.bind(self),
        el
      ));
    } catch (err) {
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
