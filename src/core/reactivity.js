/**
 * Reflex Core - Reactivity System
 *
 * Implements fine-grained reactivity using ES6 Proxies.
 * Features:
 * - Static proxy handlers (no per-object allocation)
 * - Dependency tracking with automatic cleanup
 * - Batched updates with double-buffered scheduler
 * - Support for Arrays, Maps, Sets, and plain Objects
 */

import {
  META, ITERATE, SKIP,
  ACTIVE, RUNNING,
  ARRAY_MUTATORS, REORDER_METHODS, COLLECTION_METHODS
} from './symbols.js';

// === STATIC PROXY HANDLERS ===
// Optimization: Define handlers ONCE to eliminate per-object allocation.
// Each reactive object reuses the same handler object.
// The engine (Reflex instance) is stored on meta.engine.

export const ArrayHandler = {
  get(o, k, rec) {
    const meta = o[META];
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    const engine = meta.engine;

    // Cache array method wrappers to prevent closure factory bug
    if (ARRAY_MUTATORS[k]) {
      if (!meta._am) meta._am = Object.create(null);
      if (!meta._am[k]) meta._am[k] = engine._am(o, k, meta);
      return meta._am[k];
    }

    engine._tk(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[META];
    const engine = meta.engine;
    const raw = engine.toRaw(v);
    const old = o[k];
    if (Object.is(old, raw) && k !== 'length') return true;

    let had, isIdx = false, n = -1;
    if (typeof k === 'string') {
      n = Number(k);
      isIdx = n >= 0 && Number.isInteger(n) && String(n) === k;
    }
    if (k === 'length') had = true;
    else if (isIdx) had = n < o.length;
    else had = k in o;

    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    engine._tr(meta, k);
    if (k === 'length') {
      engine._tr(meta, ITERATE);
    } else if (isIdx) {
      engine._tr(meta, ITERATE);
      if (!had) engine._tr(meta, 'length');
    }
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[META];
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      const engine = meta.engine;
      engine._tr(meta, k);
      engine._tr(meta, ITERATE);
      engine._tr(meta, 'length');
    }
    return res;
  }
};

export const ObjectHandler = {
  get(o, k, rec) {
    const meta = o[META];
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    const engine = meta.engine;
    engine._tk(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[META];
    const engine = meta.engine;
    const raw = engine.toRaw(v);
    const old = o[k];
    if (Object.is(old, raw)) return true;

    const had = k in o;
    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    engine._tr(meta, k);
    if (!had) engine._tr(meta, ITERATE);
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[META];
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      const engine = meta.engine;
      engine._tr(meta, k);
      engine._tr(meta, ITERATE);
    }
    return res;
  }
};

export const MapHandler = {
  get(o, k, rec) {
    const meta = o[META];
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    const engine = meta.engine;

    if (k === 'size') { engine._tk(meta, ITERATE); return o.size; }

    if ((k === Symbol.iterator || COLLECTION_METHODS[k]) && typeof o[k] === 'function') {
      return engine._cm(o, k, meta, true);
    }

    engine._tk(meta, k);
    return Reflect.get(o, k, rec);
  },

  set(o, k, v, rec) {
    return Reflect.set(o, k, v, rec);
  },

  deleteProperty(o, k) {
    return Reflect.deleteProperty(o, k);
  }
};

export const SetHandler = {
  get(o, k, rec) {
    const meta = o[META];
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    const engine = meta.engine;

    if (k === 'size') { engine._tk(meta, ITERATE); return o.size; }

    if ((k === Symbol.iterator || COLLECTION_METHODS[k]) && typeof o[k] === 'function') {
      return engine._cm(o, k, meta, false);
    }

    engine._tk(meta, k);
    return Reflect.get(o, k, rec);
  },

  set(o, k, v, rec) {
    return Reflect.set(o, k, v, rec);
  },

  deleteProperty(o, k) {
    return Reflect.deleteProperty(o, k);
  }
};

/**
 * Reactivity mixin for Reflex class.
 * This provides the core reactive functionality.
 */
export const ReactivityMixin = {
  /**
   * Create a reactive proxy for an object
   * @param {Object} t - Target object
   * @returns {Proxy} Reactive proxy
   */
  _r(t) {
    if (t === null || typeof t !== 'object') return t;
    if (t[SKIP]) return t;
    if (t instanceof Node) return t;

    const existing = t[META] || this._mf.get(t);
    if (existing) return existing.p;

    // Store engine reference on meta for static handler access
    const meta = { p: null, r: t, d: new Map(), ai: false, _am: null, engine: this };
    const isArr = Array.isArray(t);
    const isMap = t instanceof Map;
    const isSet = t instanceof Set;

    // Use static handlers - ZERO allocation per reactive object
    let h;
    if (isArr) h = ArrayHandler;
    else if (isMap) h = MapHandler;
    else if (isSet) h = SetHandler;
    else h = ObjectHandler;

    meta.p = new Proxy(t, h);

    if (Object.isExtensible(t)) {
      Object.defineProperty(t, META, { value: meta, configurable: true });
    } else {
      this._mf.set(t, meta);
    }

    return meta.p;
  },

  /**
   * Wrap a value in a reactive proxy if applicable
   */
  _wrap(v) {
    return v !== null && typeof v === 'object' && !v[SKIP] && !(v instanceof Node)
      ? this._r(v)
      : v;
  },

  /**
   * Track key access for dependency collection
   */
  _tk(m, k) {
    if (!this._e) return;

    if (Array.isArray(m.r) && typeof k === 'string') {
      const n = Number(k);
      if (n >= 0 && Number.isInteger(n) && String(n) === k) m.ai = true;
    }

    let s = m.d.get(k);
    if (!s) m.d.set(k, s = new Set());
    if (!s.has(this._e)) {
      s.add(this._e);
      this._e.d.push(s);
    }
  },

  /**
   * Trigger effects when a key changes
   */
  _tr(m, k) {
    if (this._b > 0) {
      let ks = this._pt.get(m);
      if (!ks) this._pt.set(m, ks = new Set());
      ks.add(k);
      return;
    }
    const s = m.d.get(k);
    if (s) {
      for (const e of s) {
        if (e.f & ACTIVE && !(e.f & RUNNING)) {
          e.s ? e.s(e) : this._qj(e);
        }
      }
    }
  },

  /**
   * Flush pending triggers after batch completes
   */
  _fpt() {
    if (!this._pt.size) return;
    const pt = this._pt;
    this._pt = new Map();
    for (const [m, ks] of pt) {
      for (const k of ks) {
        try { this._tr(m, k); } catch (err) { console.error('Reflex: Error triggering update for key:', k, err); }
      }
    }
  },

  /**
   * Create cached array method wrapper
   * Prevents closure factory bug by caching wrappers on meta
   */
  _am(t, m, meta) {
    const self = this;
    return function(...args) {
      self._b++;
      let res;
      try {
        res = Array.prototype[m].apply(t, args);

        let ks = self._pt.get(meta);
        if (!ks) self._pt.set(meta, ks = new Set());
        ks.add(ITERATE);
        ks.add('length');

        if (meta.ai && REORDER_METHODS[m]) {
          for (const [k, depSet] of meta.d) {
            if (!depSet.size) { meta.d.delete(k); continue; }
            if (typeof k === 'string') {
              const n = Number(k);
              if (n >= 0 && Number.isInteger(n) && String(n) === k) ks.add(k);
            }
          }
        }
      } finally {
        if (--self._b === 0) {
          try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
        }
      }
      return res;
    };
  },

  /**
   * Create cached collection method wrapper for Map/Set
   */
  _cm(t, m, meta, isMap) {
    if (meta[m]) return meta[m];
    const self = this;
    const proto = isMap ? Map.prototype : Set.prototype;
    const fn = proto[m];

    if (m === Symbol.iterator || m === 'entries' || m === 'values' || m === 'keys') {
      return meta[m] = function() {
        self._tk(meta, ITERATE);
        const it = fn.call(t);
        return {
          [Symbol.iterator]() { return this; },
          next() {
            const n = it.next();
            if (n.done) return n;
            if (isMap) {
              if (m === 'keys' || m === 'values') return { done: false, value: self._wrap(n.value) };
              const [k, v] = n.value;
              return { done: false, value: [self._wrap(k), self._wrap(v)] };
            }
            return { done: false, value: self._wrap(n.value) };
          },
          return(v) { return it.return ? it.return(v) : { done: true, value: v }; }
        };
      };
    }

    if (m === 'get') return meta[m] = k => { const rk = self.toRaw(k); self._tk(meta, rk); return self._wrap(fn.call(t, rk)); };
    if (m === 'has') return meta[m] = k => { const rk = self.toRaw(k); self._tk(meta, rk); return fn.call(t, rk); };
    if (m === 'forEach') return meta[m] = function(cb, ctx) { self._tk(meta, ITERATE); fn.call(t, (v, k) => cb.call(ctx, self._wrap(v), self._wrap(k), meta.p)); };

    if (m === 'set') return meta[m] = function(k, v) {
      const rk = self.toRaw(k), rv = self.toRaw(v), had = t.has(rk), old = had ? t.get(rk) : undefined;
      fn.call(t, rk, rv);
      if (!had || !Object.is(old, rv)) {
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rk); ks.add(ITERATE);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
          }
        }
      }
      return meta.p;
    };

    if (m === 'add') return meta[m] = function(v) {
      const rv = self.toRaw(v);
      if (!t.has(rv)) {
        fn.call(t, rv);
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rv); ks.add(ITERATE);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
          }
        }
      }
      return meta.p;
    };

    if (m === 'delete') return meta[m] = k => {
      const rk = self.toRaw(k), had = t.has(rk), res = fn.call(t, rk);
      if (had) {
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rk); ks.add(ITERATE);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
          }
        }
      }
      return res;
    };

    if (m === 'clear') return meta[m] = () => {
      if (!t.size) return;
      self._b++;
      try {
        let ks = self._pt.get(meta);
        if (!ks) self._pt.set(meta, ks = new Set());
        t.forEach((_, k) => ks.add(k)); ks.add(ITERATE);
        fn.call(t);
      } finally {
        if (--self._b === 0) {
          try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
        }
      }
    };

    return meta[m] = function() { self._tk(meta, ITERATE); return fn.call(t); };
  }
};
