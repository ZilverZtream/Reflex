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
  ARRAY_MUTATORS, REORDER_METHODS, COLLECTION_METHODS,
  UNSAFE_PROPS
} from './symbols.js';

type ReactiveKey = PropertyKey;

interface ReactiveEffect {
  f: number;
  d: Array<Set<ReactiveEffect>>;
  s: ((effect: ReactiveEffect) => void) | null;
}

interface ReactivityEngine {
  _e: ReactiveEffect | null;
  _b: number;
  pendingTriggers: Map<ReactiveMeta, Set<ReactiveKey>>;
  _mf: WeakMap<object, ReactiveMeta>;
  s: unknown;
  _dtEmit: (event: string, payload: { target: object; key: ReactiveKey; state: unknown }) => void;
  _wrap: <T>(value: T) => T;
  trackDependency: (meta: ReactiveMeta, key: ReactiveKey) => void;
  triggerEffects: (meta: ReactiveMeta, key: ReactiveKey) => void;
  _fpt: () => void;
  queueJob: (effect: ReactiveEffect) => void;
  wrapArrayMethod: (target: any[], method: string, meta: ReactiveMeta) => (...args: any[]) => any;
  wrapCollectionMethod: (
    target: Map<any, any> | Set<any>,
    method: ReactiveKey,
    meta: ReactiveMeta,
    isMap: boolean
  ) => (...args: any[]) => any;
  toRaw: <T>(value: T) => T;
}

interface ReactiveMeta {
  p: any;
  r: object;
  d: Map<ReactiveKey, Set<ReactiveEffect>>;
  ai: boolean;
  _am: Record<string | symbol, (...args: any[]) => any> | null;
  engine: ReactivityEngine;
  v: number; // Version counter for structural sharing in deep clones
  [key: string | symbol]: any;
}

type ReactiveTarget = Record<ReactiveKey, any> & {
  [META]?: ReactiveMeta;
  [SKIP]?: boolean;
};

// === STATIC PROXY HANDLERS ===
// Optimization: Define handlers ONCE to eliminate per-object allocation.
// Each reactive object reuses the same handler object.
// The engine (Reflex instance) is stored on meta.engine.

export const ArrayHandler: ProxyHandler<any[]> = {
  get(o, k, rec) {
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    // Security: Block access to dangerous properties at runtime
    // This prevents dynamic property access bypasses like obj[dynamicKey]
    if (UNSAFE_PROPS[k]) {
      console.warn('Reflex: Blocked runtime access to unsafe property:', k);
      return undefined;
    }

    const engine = meta.engine;

    // Cache array method wrappers to prevent closure factory bug
    if (ARRAY_MUTATORS[k]) {
      if (!meta._am) meta._am = Object.create(null);
      if (!meta._am[k]) meta._am[k] = engine.wrapArrayMethod(o, k as string, meta);
      return meta._am[k];
    }

    engine.trackDependency(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    const engine = meta.engine;

    // Security: Block setting dangerous properties
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      throw new Error(`Reflex: Cannot set unsafe property '${k}'`);
    }

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

    // CRITICAL FIX: Array Truncation Bug
    // When setting array.length to a smaller value, we must trigger
    // watchers on all deleted indices, not just the length property.
    // Example: arr.length = 0 should trigger watchers on arr[0], arr[1], etc.
    const oldLength = k === 'length' ? o.length : -1;
    const newLength = k === 'length' ? Number(raw) : -1;

    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    meta.v++; // Increment version on mutation
    // Trigger specific key change
    engine.triggerEffects(meta, k);

    // OPTIMIZATION: Only trigger ITERATE when structure actually changes
    // Setting existing array elements doesn't need ITERATE
    if (k === 'length') {
      // Length change always affects iteration
      engine.triggerEffects(meta, ITERATE);

      // CRITICAL FIX: Trigger watchers on deleted indices when truncating
      // If newLength < oldLength, indices from newLength to oldLength-1 are deleted
      if (newLength < oldLength && newLength >= 0) {
        for (let i = newLength; i < oldLength; i++) {
          engine.triggerEffects(meta, String(i));
        }
      }
    } else if (isIdx && !had) {
      // New index added (sparse array) - affects iteration and length
      engine.triggerEffects(meta, ITERATE);
      engine.triggerEffects(meta, 'length');
    }
    // Note: Updating existing indices (arr[5] = x when arr.length > 5)
    // does NOT trigger ITERATE, preventing O(N) over-reactivity
    return true;
  },

  deleteProperty(o, k) {
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      meta.v++; // Increment version on mutation
      const engine = meta.engine;
      engine.triggerEffects(meta, k);
      engine.triggerEffects(meta, ITERATE);
      engine.triggerEffects(meta, 'length');
    }
    return res;
  }
};

export const ObjectHandler: ProxyHandler<ReactiveTarget> = {
  get(o, k, rec) {
    const meta = o[META] as ReactiveMeta;
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    // Security: Block access to dangerous properties at runtime
    // This prevents dynamic property access bypasses like obj[dynamicKey]
    if (UNSAFE_PROPS[k]) {
      console.warn('Reflex: Blocked runtime access to unsafe property:', k);
      return undefined;
    }

    const engine = meta.engine;
    engine.trackDependency(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[META] as ReactiveMeta;
    const engine = meta.engine;

    // Security: Block setting dangerous properties
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      throw new Error(`Reflex: Cannot set unsafe property '${k}'`);
    }

    const raw = engine.toRaw(v);
    const old = o[k];
    if (Object.is(old, raw)) return true;

    const had = k in o;
    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    meta.v++; // Increment version on mutation
    engine.triggerEffects(meta, k);
    if (!had) engine.triggerEffects(meta, ITERATE);
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[META] as ReactiveMeta;
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      meta.v++; // Increment version on mutation
      const engine = meta.engine;
      engine.triggerEffects(meta, k);
      engine.triggerEffects(meta, ITERATE);
    }
    return res;
  },

  // CRITICAL FIX: Incomplete Proxy Traps
  // Object.keys(), for...in loops, and Object.getOwnPropertyNames() use ownKeys trap
  // Without this, iteration over object keys doesn't track ITERATE dependency
  // This causes computed properties and effects that use Object.keys() to miss updates
  ownKeys(o) {
    const meta = o[META] as ReactiveMeta;
    const engine = meta.engine;
    // Track ITERATE dependency so Object.keys(), for...in, etc. react to additions/deletions
    engine.trackDependency(meta, ITERATE);
    return Reflect.ownKeys(o);
  }
};

export const MapHandler: ProxyHandler<Map<any, any>> = {
  get(o, k, rec) {
    const meta = (o as Map<any, any> & ReactiveTarget)[META] as ReactiveMeta;
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    // Security: Block access to dangerous properties at runtime
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      console.warn('Reflex: Blocked runtime access to unsafe property:', k);
      return undefined;
    }

    const engine = meta.engine;

    if (k === 'size') { engine.trackDependency(meta, ITERATE); return o.size; }

    if ((k === Symbol.iterator || COLLECTION_METHODS[k]) && typeof o[k] === 'function') {
      return engine.wrapCollectionMethod(o, k, meta, true);
    }

    engine.trackDependency(meta, k);
    return Reflect.get(o, k, rec);
  },

  set(o, k, v, rec) {
    return Reflect.set(o, k, v, rec);
  },

  deleteProperty(o, k) {
    return Reflect.deleteProperty(o, k);
  }
};

export const SetHandler: ProxyHandler<Set<any>> = {
  get(o, k, rec) {
    const meta = (o as Set<any> & ReactiveTarget)[META] as ReactiveMeta;
    if (k === META) return meta;
    if (k === SKIP) return o[SKIP];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    // Security: Block access to dangerous properties at runtime
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      console.warn('Reflex: Blocked runtime access to unsafe property:', k);
      return undefined;
    }

    const engine = meta.engine;

    if (k === 'size') { engine.trackDependency(meta, ITERATE); return o.size; }

    if ((k === Symbol.iterator || COLLECTION_METHODS[k]) && typeof o[k] === 'function') {
      return engine.wrapCollectionMethod(o, k, meta, false);
    }

    engine.trackDependency(meta, k);
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
  _r<T>(t: T): T {
    if (t === null || typeof t !== 'object') return t;
    if ((t as ReactiveTarget)[SKIP]) return t;
    if (t instanceof Node) return t;

    // Check for OWN META property to avoid inheriting from prototype chain
    const existing = Object.prototype.hasOwnProperty.call(t, META)
      ? (t as ReactiveTarget)[META]
      : this._mf.get(t as object);
    if (existing) return existing.p;

    // Store engine reference on meta for static handler access
    const meta: ReactiveMeta = {
      p: null,
      r: t as object,
      d: new Map(),
      ai: false,
      _am: null,
      engine: this,
      v: 0 // Initialize version counter for structural sharing
    };
    const isArr = Array.isArray(t);
    const isMap = t instanceof Map;
    const isSet = t instanceof Set;

    // Use static handlers - ZERO allocation per reactive object
    let h: ProxyHandler<any>;
    if (isArr) h = ArrayHandler;
    else if (isMap) h = MapHandler;
    else if (isSet) h = SetHandler;
    else h = ObjectHandler;

    meta.p = new Proxy(t as object, h);

    if (Object.isExtensible(t)) {
      Object.defineProperty(t as object, META, { value: meta, configurable: true });
    } else {
      this._mf.set(t as object, meta);
    }

    return meta.p;
  },

  /**
   * Wrap a value in a reactive proxy if applicable
   */
  _wrap<T>(v: T): T {
    return v !== null &&
      typeof v === 'object' &&
      !(v as ReactiveTarget)[SKIP] &&
      !(v instanceof Node)
      ? this._r(v)
      : v;
  },

  /**
   * Track key access for dependency collection
   */
  trackDependency(m: ReactiveMeta, k: ReactiveKey) {
    if (!this._e) return;

    if (Array.isArray(m.r) && typeof k === 'string') {
      const n = Number(k);
      if (n >= 0 && Number.isInteger(n) && String(n) === k) m.ai = true;
    }

    let s = m.d.get(k);
    if (!s) m.d.set(k, s = new Set());
    if (!s.has(this._e)) {
      s.add(this._e);
      // MEMORY LEAK FIX: Store meta reference to enable pruning empty dependency sets
      // Instead of just pushing the Set, store {meta, key, set} so _cln_eff can
      // delete the key from meta.d when the Set becomes empty after cleanup
      this._e.d.push({ m, k, s });
    }
  },

  /**
   * Trigger effects when a key changes
   */
  triggerEffects(m: ReactiveMeta, k: ReactiveKey) {
    if (this._b > 0) {
      let ks = this.pendingTriggers.get(m);
      if (!ks) this.pendingTriggers.set(m, ks = new Set());
      ks.add(k);
      return;
    }
    // Safe environment check without relying on global namespace
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      this._dtEmit('state:change', { target: m.r, key: k, state: this.s });
    }
    const s = m.d.get(k);
    if (s) {
      for (const e of s) {
        if (e.f & ACTIVE && !(e.f & RUNNING)) {
          e.s ? e.s(e) : this.queueJob(e);
        }
      }
    }
  },

  /**
   * Flush pending triggers after batch completes
   */
  _fpt() {
    if (!this.pendingTriggers.size) return;
    const pt = this.pendingTriggers;
    this.pendingTriggers = new Map();
    for (const [m, ks] of pt) {
      for (const k of ks) {
        try { this.triggerEffects(m, k); } catch (err) { console.error('Reflex: Error triggering update for key:', k, err); }
      }
    }
  },

  /**
   * Create cached array method wrapper
   * Prevents closure factory bug by caching wrappers on meta
   */
  wrapArrayMethod(t: any[], m: string, meta: ReactiveMeta) {
    const self = this;
    return function(...args) {
      self._b++;
      let res;
      try {
        res = Array.prototype[m].apply(t, args);

        meta.v++; // Increment version on array mutation
        let ks = self.pendingTriggers.get(meta);
        if (!ks) self.pendingTriggers.set(meta, ks = new Set());
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
  wrapCollectionMethod(t: Map<any, any> | Set<any>, m: ReactiveKey, meta: ReactiveMeta, isMap: boolean) {
    if (meta[m]) return meta[m];
    const self = this;
    const proto = isMap ? Map.prototype : Set.prototype;
    const fn = (proto as any)[m];

    if (m === Symbol.iterator || m === 'entries' || m === 'values' || m === 'keys') {
      return meta[m] = function() {
        self.trackDependency(meta, ITERATE);
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

    if (m === 'get') return meta[m] = k => {
      const rk = self.toRaw(k);
      self.trackDependency(meta, rk);
      return self._wrap((t as Map<any, any>).get(rk));
    };
    if (m === 'has') return meta[m] = k => {
      const rk = self.toRaw(k);
      self.trackDependency(meta, rk);
      return (t as Map<any, any> | Set<any>).has(rk);
    };
    if (m === 'forEach') return meta[m] = function(cb, ctx) { self.trackDependency(meta, ITERATE); fn.call(t, (v, k) => cb.call(ctx, self._wrap(v), self._wrap(k), meta.p)); };

    if (m === 'set') return meta[m] = function(k, v) {
      const map = t as Map<any, any>;
      const rk = self.toRaw(k);
      const rv = self.toRaw(v);
      const had = map.has(rk);
      const old = had ? map.get(rk) : undefined;
      map.set(rk, rv);
      if (!had || !Object.is(old, rv)) {
        meta.v++; // Increment version on mutation
        self._b++;
        try {
          let ks = self.pendingTriggers.get(meta);
          if (!ks) self.pendingTriggers.set(meta, ks = new Set());
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
      const set = t as Set<any>;
      if (!set.has(rv)) {
        set.add(rv);
        meta.v++; // Increment version on mutation
        self._b++;
        try {
          let ks = self.pendingTriggers.get(meta);
          if (!ks) self.pendingTriggers.set(meta, ks = new Set());
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
      const rk = self.toRaw(k);
      const had = (t as Map<any, any> | Set<any>).has(rk);
      const res = (t as Map<any, any> | Set<any>).delete(rk);
      if (had) {
        meta.v++; // Increment version on mutation
        self._b++;
        try {
          let ks = self.pendingTriggers.get(meta);
          if (!ks) self.pendingTriggers.set(meta, ks = new Set());
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
      if (!(t as Map<any, any> | Set<any>).size) return;
      meta.v++; // Increment version on mutation
      self._b++;
      try {
        let ks = self.pendingTriggers.get(meta);
        if (!ks) self.pendingTriggers.set(meta, ks = new Set());
        (t as Map<any, any> | Set<any>).forEach((_, k) => ks.add(k));
        ks.add(ITERATE);
        (t as Map<any, any> | Set<any>).clear();
      } finally {
        if (--self._b === 0) {
          try { self._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
        }
      }
    };

    return meta[m] = function() { self.trackDependency(meta, ITERATE); return fn.call(t); };
  }
};
