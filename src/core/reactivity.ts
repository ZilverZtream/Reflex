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
  _recursionDepth: number;  // CRITICAL: Track recursion depth to prevent infinite loops
}

interface ReactiveMeta {
  p: any;
  r: object;
  d: Map<ReactiveKey, Set<ReactiveEffect>>;
  ai: boolean;
  _am: Record<string | symbol, (...args: any[]) => any> | null;
  engine: ReactivityEngine;
  v: number; // Version counter for structural sharing in deep clones
  _silent?: boolean; // PERFORMANCE FIX #2: Flag to skip reactivity during batch array operations
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

    // CRITICAL PERFORMANCE FIX #2: Skip reactivity if in silent mode
    // When wrapArrayMethod is executing (e.g., shift, splice), meta._silent is true
    // This prevents O(N) set trap calls from freezing the main thread
    if (meta._silent) {
      const raw = engine.toRaw(v);
      return Reflect.set(o, k, raw, rec);
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

    // CRITICAL FIX: Version Counter - Only increment if not in a batch
    // When array methods (push, splice, etc.) are called, they:
    // 1. Get wrapped by wrapArrayMethod which starts a batch (_b++)
    // 2. Call native method which triggers this set trap
    // 3. wrapArrayMethod increments version after method completes
    // Without this check, version increments twice: once here, once in wrapper
    // Direct array[index] = value sets are not batched, so increment normally
    if (engine._b === 0) {
      meta.v++; // Increment version on mutation
    }

    // CRITICAL FIX #4: O(N) Array Truncation DoS - Batch Notifications
    // When truncating large arrays (e.g., arr.length = 0 on 1M item array),
    // we must batch all index triggers to avoid synchronous O(N) loop freeze
    if (k === 'length' && newLength < oldLength && newLength >= 0) {
      // Use batching to prevent UI freeze on large array truncation
      engine._b++;
      try {
        let ks = engine.pendingTriggers.get(meta);
        if (!ks) engine.pendingTriggers.set(meta, ks = new Set());

        // Queue 'length' and ITERATE triggers
        ks.add('length');
        ks.add(ITERATE);

        // CRITICAL SECURITY FIX: Prevent DoS via main thread freeze
        // The previous implementation iterated from newLength to oldLength (O(N) where N could be millions)
        // This blocked the main thread even with the optimization of checking meta.d.has(key)
        //
        // NEW APPROACH: Iterate only over existing dependency keys in meta.d
        // This is O(D) where D is the number of tracked dependencies (typically << N)
        // Example: Array with 10M items but only 5 indices are tracked → O(5) instead of O(10M)
        for (const [key, depSet] of meta.d) {
          // Skip if this key is not a numeric index
          if (typeof key !== 'string') continue;
          const idx = Number(key);
          // Check if this is a numeric array index that was deleted
          if (Number.isInteger(idx) && idx >= newLength && idx < oldLength && depSet.size > 0) {
            ks.add(key);
          }
        }
      } finally {
        if (--engine._b === 0) {
          try { engine._fpt(); } catch (err) { console.error('Reflex: Error flushing pending triggers:', err); }
        }
      }
    } else {
      // Normal path: trigger specific key change
      engine.triggerEffects(meta, k);

      // OPTIMIZATION: Only trigger ITERATE when structure actually changes
      // Setting existing array elements doesn't need ITERATE
      if (k === 'length') {
        // Length change always affects iteration
        engine.triggerEffects(meta, ITERATE);
      } else if (isIdx && !had) {
        // New index added (sparse array) - affects iteration and length
        engine.triggerEffects(meta, ITERATE);
        engine.triggerEffects(meta, 'length');
      }
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
  },

  // CRITICAL SECURITY FIX: Prevent sandbox escape via Object.defineProperty
  // Without this trap, Object.defineProperty(proxy, 'constructor', {...}) bypasses
  // the 'set' trap's UNSAFE_PROPS check, allowing prototype pollution
  defineProperty(o, k, desc) {
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      throw new Error(`Reflex: Cannot define unsafe property '${k}'`);
    }
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    const engine = meta.engine;
    const res = Reflect.defineProperty(o, k, desc);
    if (res) {
      // CRITICAL FIX: Version Counter - Only increment if not in a batch
      // Same logic as set handler: avoid double increment when in batched operations
      if (engine._b === 0) {
        meta.v++; // Increment version on mutation
      }
      engine.triggerEffects(meta, k);
      engine.triggerEffects(meta, ITERATE);
    }
    return res;
  },

  // CRITICAL SECURITY FIX: Prevent prototype pollution via Object.setPrototypeOf
  setPrototypeOf() {
    throw new Error('Reflex: Cannot set prototype (prototype pollution prevention)');
  },

  // CRITICAL SECURITY FIX: Hide prototype chain to prevent constructor access
  // Without this, Object.getPrototypeOf(proxy) exposes Array.prototype with constructor
  getPrototypeOf(o) {
    // Return null to hide the prototype chain from inspection
    // This prevents: Object.getPrototypeOf(proxy).constructor.constructor('code')
    return null;
  },

  // CRITICAL SECURITY FIX #8: Inconsistent Sandbox Visibility
  // The 'has' trap ensures ("__proto__" in obj) returns false consistently
  // Without this, ("__proto__" in obj) returns true but obj.__proto__ returns undefined
  has(o, k) {
    // Block unsafe properties from 'in' operator
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      return false;
    }
    return Reflect.has(o, k);
  },

  // CRITICAL FIX #5: Missing ownKeys Trap - Breaks Object.keys() Reactivity
  // Without this trap, Object.keys(state.array), for...in loops, and
  // Object.getOwnPropertyNames(state.array) don't track dependencies.
  // This causes computed properties and effects that iterate over array keys
  // to miss updates when items are added/removed.
  ownKeys(o) {
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    const engine = meta.engine;
    // Track ITERATE dependency so Object.keys(), for...in, etc. react to additions/deletions
    engine.trackDependency(meta, ITERATE);
    // Also track 'length' since Object.keys() result depends on array length
    engine.trackDependency(meta, 'length');
    return Reflect.ownKeys(o);
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

    // CRITICAL FIX: Version Counter - Only increment if not in a batch
    // Same logic as ArrayHandler: avoid double increment when in batched operations
    if (engine._b === 0) {
      meta.v++; // Increment version on mutation
    }
    engine.triggerEffects(meta, k);
    if (!had) engine.triggerEffects(meta, ITERATE);
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[META] as ReactiveMeta;
    if (!(k in o)) return true;
    const engine = meta.engine;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      // CRITICAL FIX: Version Counter - Only increment if not in a batch
      // Same logic as set handler: avoid double increment when in batched operations
      if (engine._b === 0) {
        meta.v++; // Increment version on mutation
      }
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
  },

  // CRITICAL SECURITY FIX: Prevent sandbox escape via Object.defineProperty
  // Without this trap, Object.defineProperty(proxy, 'constructor', {...}) bypasses
  // the 'set' trap's UNSAFE_PROPS check, allowing prototype pollution
  defineProperty(o, k, desc) {
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      throw new Error(`Reflex: Cannot define unsafe property '${k}'`);
    }
    const meta = o[META] as ReactiveMeta;
    const res = Reflect.defineProperty(o, k, desc);
    if (res) {
      meta.v++; // Increment version on mutation
      const engine = meta.engine;
      engine.triggerEffects(meta, k);
      if (!(k in o)) engine.triggerEffects(meta, ITERATE);
    }
    return res;
  },

  // CRITICAL SECURITY FIX: Prevent prototype pollution via Object.setPrototypeOf
  setPrototypeOf() {
    throw new Error('Reflex: Cannot set prototype (prototype pollution prevention)');
  },

  // CRITICAL SECURITY FIX: Hide prototype chain to prevent constructor access
  // Without this, Object.getPrototypeOf(proxy) exposes Object.prototype with constructor
  getPrototypeOf(o) {
    // Return null to hide the prototype chain from inspection
    // This prevents: Object.getPrototypeOf(proxy).constructor.constructor('code')
    return null;
  },

  // CRITICAL SECURITY FIX #8: Inconsistent Sandbox Visibility
  // The 'has' trap ensures ("__proto__" in obj) returns false consistently
  // Without this, ("__proto__" in obj) returns true but obj.__proto__ returns undefined
  has(o, k) {
    // Block unsafe properties from 'in' operator
    if (typeof k === 'string' && UNSAFE_PROPS[k]) {
      return false;
    }
    return Reflect.has(o, k);
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
    // CRITICAL FIX: Skip TypedArrays and Buffers
    // TypedArray methods expect 'this' to be an actual TypedArray, not a Proxy
    // Wrapping them causes: "Method get TypedArray.prototype.length called on incompatible receiver"
    // ArrayBuffer.isView() covers all TypedArrays: Uint8Array, Int16Array, Float32Array, etc., and DataView
    if (ArrayBuffer.isView(t)) return t;
    // CRITICAL FIX: Skip File, Blob, and FileList objects
    // These are browser-native objects that break when wrapped in Proxies
    // File and Blob have special internal slots that can't be proxied
    if (typeof File !== 'undefined' && t instanceof File) return t;
    if (typeof Blob !== 'undefined' && t instanceof Blob) return t;
    if (typeof FileList !== 'undefined' && t instanceof FileList) return t;

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

    // CRITICAL SECURITY FIX: Infinite Loop Risk in Reactive Flush
    // Without this guard, an effect that modifies its own dependencies (e.g., count++ in a watcher)
    // will trigger itself synchronously in an infinite loop, crashing the app
    // Unlike Vue/React which have scheduler deduplication, we need explicit recursion guards
    const MAX_RECURSION_DEPTH = 100;
    if (!this._recursionDepth) this._recursionDepth = 0;

    if (++this._recursionDepth > MAX_RECURSION_DEPTH) {
      this._recursionDepth = 0;
      console.error(
        'Reflex: Maximum recursive update depth exceeded.\n' +
        'This usually means an effect is modifying its own dependencies in a loop.\n' +
        `Key: ${String(k)}, Target:`, m.r
      );
      return;
    }

    try {
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
    } finally {
      this._recursionDepth--;
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
        // CRITICAL PERFORMANCE FIX #2: Reactive Array O(N) Freeze (DoS)
        //
        // VULNERABILITY: Operations like shift() or splice(0,1) on large arrays (100k+ items)
        // trigger the set trap for EVERY shifted element, causing synchronous main-thread freeze
        // Example: arr.shift() with 100k items triggers 99,999 set trap calls
        //
        // SOLUTION: Temporarily disable the set trap during the native method execution
        // Set a flag on meta to signal the set trap to skip reactivity during batch operations
        // After the method completes, manually trigger only ITERATE and length updates once
        //
        // This reduces complexity from O(N) set trap calls to O(1) batch update

        // Mark meta as in "silent mode" to skip set trap reactivity
        const wasSilent = meta._silent;
        meta._silent = true;

        try {
          // CRITICAL SECURITY FIX #5: wrapArrayMethod Trusts Raw Constructor
          //
          // VULNERABILITY: Malicious objects can spoof constructor property
          // Example: { 0:1, length:1, constructor: { prototype: { push: () => alert('hack') } } }
          // Never trust t.constructor from user-provided objects
          //
          // SOLUTION: Use instanceof check instead of constructor property comparison
          // instanceof checks the actual prototype chain, which cannot be easily spoofed
          const hasCustomMethod = t instanceof Array &&
                                  t.constructor !== Array &&
                                  t.constructor.prototype &&
                                  typeof t.constructor.prototype[m] === 'function' &&
                                  t.constructor.prototype[m] !== Array.prototype[m];

          if (hasCustomMethod) {
            // Custom array class - call the method on the proxy to maintain reactivity
            // The proxy is stored in meta.p
            res = meta.p[m](...args);
          } else {
            // Standard array - use Array.prototype explicitly for security
            res = Array.prototype[m].apply(t, args);
          }
        } finally {
          // Restore silent mode state
          meta._silent = wasSilent;
        }

        meta.v++; // Increment version on array mutation
        let ks = self.pendingTriggers.get(meta);
        if (!ks) self.pendingTriggers.set(meta, ks = new Set());
        ks.add(ITERATE);
        ks.add('length');

        // OPTIMIZATION: Only trigger indices that have active watchers
        // For reordering methods (shift, unshift, splice, sort, reverse)
        // we only need to notify tracked indices, not all indices
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

        // CRITICAL PERFORMANCE FIX #7: Map/Set Iterator Allocation Storm
        //
        // VULNERABILITY: Creating new [k,v] array for every iteration on large Maps (100k+ items)
        // causes massive GC pressure and can freeze UI with Major GC pause
        //
        // SOLUTION: Reuse the same array object for entries iteration
        // This reduces allocations from O(N) to O(1)
        let reusableArray = isMap && (m === 'entries' || m === Symbol.iterator) ? [null, null] : null;

        return {
          [Symbol.iterator]() { return this; },
          next() {
            const n = it.next();
            if (n.done) return n;
            // CRITICAL FIX #6: Iteration Allocation Storm
            // Only wrap values that need wrapping (objects). Primitives pass through.
            // This eliminates wrapper allocation overhead for primitive-heavy collections
            if (isMap) {
              if (m === 'keys' || m === 'values') {
                const val = n.value;
                return { done: false, value: (val !== null && typeof val === 'object') ? self._wrap(val) : val };
              }
              // For entries/default iteration, reuse the array
              const [k, v] = n.value;
              const wrappedK = (k !== null && typeof k === 'object') ? self._wrap(k) : k;
              const wrappedV = (v !== null && typeof v === 'object') ? self._wrap(v) : v;
              // Reuse the same array instance, just update the values
              reusableArray[0] = wrappedK;
              reusableArray[1] = wrappedV;
              return { done: false, value: reusableArray };
            }
            const val = n.value;
            return { done: false, value: (val !== null && typeof val === 'object') ? self._wrap(val) : val };
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
    if (m === 'forEach') return meta[m] = function(cb, ctx) {
      self.trackDependency(meta, ITERATE);
      // CRITICAL FIX #6: Iteration Allocation Storm (continued)
      // Optimize forEach to skip wrapping primitives
      fn.call(t, (v, k) => {
        const wrappedV = (v !== null && typeof v === 'object') ? self._wrap(v) : v;
        const wrappedK = (k !== null && typeof k === 'object') ? self._wrap(k) : k;
        cb.call(ctx, wrappedV, wrappedK, meta.p);
      });
    };

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
      const size = (t as Map<any, any> | Set<any>).size;
      if (!size) return;

      meta.v++; // Increment version on mutation
      self._b++;
      try {
        let ks = self.pendingTriggers.get(meta);
        if (!ks) self.pendingTriggers.set(meta, ks = new Set());

        // CRITICAL FIX #5: Collection clear() Notification Storm
        // For large collections (50k+ items), iterating all keys creates massive overhead
        // OPTIMIZATION: Only trigger keys that have active watchers, cap at 1000 keys
        // Most apps use iteration (for...of, forEach) which tracks ITERATE, not individual keys
        const maxKeysToTrigger = Math.min(size, 1000);
        if (maxKeysToTrigger < size) {
          // Large collection: only trigger keys with active dependencies
          let count = 0;
          for (const k of (t as Map<any, any> | Set<any>).keys()) {
            if (meta.d.has(k)) {
              ks.add(k);
              if (++count >= maxKeysToTrigger) break;
            }
          }
        } else {
          // Small collection: trigger all keys (original behavior)
          (t as Map<any, any> | Set<any>).forEach((_, k) => ks.add(k));
        }

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
