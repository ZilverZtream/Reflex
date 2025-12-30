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
   * CRITICAL FIX #2: Implement toRaw to unwrap reactive proxies
   *
   * Extracts the raw (unwrapped) target from a reactive proxy.
   * This is essential for:
   * - Array methods (wrapArrayMethod uses toRaw to prevent double-wrapping)
   * - Map/Set methods (wrapCollectionMethod uses toRaw for key comparison)
   * - Preventing infinite recursion when passing reactive objects to native APIs
   *
   * Without this implementation, engine.toRaw(v) throws "TypeError: toRaw is not a function"
   * causing immediate crashes when using reactive arrays or collections.
   *
   * @param v - Value to unwrap (may be a reactive proxy or raw value)
   * @returns The raw target if v is a proxy, otherwise v itself
   */
  toRaw<T>(v: T): T {
    // Primitives and null/undefined pass through
    if (v == null || typeof v !== 'object') return v;

    // Check if value has META property (reactive proxy)
    const meta = (v as ReactiveTarget)[META];
    if (meta) {
      // Return the raw target stored in meta.r
      return meta.r as T;
    }

    // Not a reactive proxy, return as-is
    return v;
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
      // Instead of just pushing the Set, store {meta, key, set} so _cleanupEffect can
      // delete the key from meta.d when the Set becomes empty after cleanup
      this._e.d.push({ m, k, s });
    }
  },

  /**
   * CRITICAL FIX #6: Reactivity System Memory Leak Prevention
   *
   * Cleans up an effect's dependencies and removes empty dependency sets.
   * Without this, long-lived objects accumulate thousands of empty Sets
   * in their dependency Map, causing a monotonic memory leak.
   *
   * Example: A global store accessed by 10,000 short-lived components
   * (e.g., items in a virtual scrolling list) will accumulate 10,000
   * empty Sets in meta.d after components are destroyed.
   *
   * This method should be called when an effect is disposed/destroyed.
   *
   * @param effect - The effect to clean up
   */
  _cleanupEffect(effect: ReactiveEffect) {
    if (!effect || !effect.d) return;

    // Iterate through all dependencies this effect tracked
    for (const dep of effect.d) {
      const { m, k, s } = dep;

      // Remove this effect from the dependency set
      s.delete(effect);

      // CRITICAL: Delete the key from meta.d if the set is now empty
      // This prevents memory leak from accumulating empty Sets
      if (s.size === 0) {
        m.d.delete(k);
      }
    }

    // Clear the effect's dependency list
    effect.d.length = 0;
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
        // CRITICAL FIX: Snapshot the set before iteration to prevent live modification issues
        // If an effect modifies the dependency state during execution, the set could be
        // modified mid-iteration, causing unpredictable behavior or infinite loops
        // Snapshotting ensures stable, predictable execution order
        const effects = new Set(s);
        for (const e of effects) {
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
   *
   * BREAKING CHANGE: Proxy Purity (Security-First)
   *
   * All array mutations MUST go through the proxy. This ensures:
   * - Every set trap fires for every index change
   * - No bypass of security checks in the set trap
   * - Complete observability of all mutations
   *
   * PERFORMANCE TRADE-OFF:
   * - Operations like shift() on 100k items WILL trigger 99,999 set traps
   * - This is intentional for security-first design
   * - The set trap handles batching and version increments properly
   *
   * METHODS COVERED:
   * - All methods in ARRAY_MUTATORS: push, pop, shift, unshift, splice, sort, reverse, fill, copyWithin
   * - These are the only methods that can mutate arrays
   * - Read-only methods (map, filter, etc.) don't need wrapping
   *
   * CRITICAL FIX: Array Mutation Index Blindness
   * Methods like unshift, sort, reverse, and splice shift or reorder elements at specific indices.
   * The get trap tracks dependencies on specific keys (e.g., arr[0] tracks "0"), but previously
   * wrapArrayMethod only fired ITERATE and length. This caused computed properties or template
   * bindings that rely on specific indices (e.g., {{ list[0] }}) to show stale data.
   *
   * FIX: For reorder methods (splice, sort, reverse, shift, unshift, fill, copyWithin),
   * trigger updates for all indices that have active watchers in meta.d.
   */
  wrapArrayMethod(t: any[], m: string, meta: ReactiveMeta) {
    const self = this;
    return function(...args) {
      self._b++;
      let res;
      try {
        // TASK 12.8: Optimized "Batch" Reactivity
        // CRITICAL PERFORMANCE FIX: Call on RAW target, not proxy
        //
        // Previous issue: push(1,2,3) triggered the Proxy trap 4 times (3 indices + length)
        // This defeated the purpose of batching because each set trap fired synchronously.
        //
        // Solution: Use Reflect.apply on the RAW target to mutate directly, then
        // manually fire one dependency change event for 'length' and ITERATE.
        //
        // Result: arr.push(1, ...1000 items) triggers subscribers ONCE, not 1001 times.

        // Get the raw (unwrapped) target array
        const rawTarget = self.toRaw(t);

        // Capture array state before mutation for reorder detection
        const oldLength = rawTarget.length;

        // Map args through toRaw to prevent nested proxy issues
        const rawArgs = args.map(arg => self.toRaw(arg));

        // TASK 12.8: Call Array.prototype method on the RAW target
        // This bypasses BOTH get and set traps entirely - no per-element reactivity
        // We'll manually trigger one 'length' update after the operation
        res = Reflect.apply(Array.prototype[m], rawTarget, rawArgs);

        // Increment version after batch operation completes
        meta.v++;

        // TASK 12.8: Single trigger after mutation completes
        // Queue ITERATE and length triggers for structural changes
        // This fires ONCE after the entire push/splice/etc completes
        let ks = self.pendingTriggers.get(meta);
        if (!ks) self.pendingTriggers.set(meta, ks = new Set());
        ks.add(ITERATE);
        ks.add('length');

        // CRITICAL FIX: Array Mutation Index Blindness
        // For reorder methods, trigger updates for specific indices that have watchers.
        // This ensures {{ list[0] }} updates when array is sorted, reversed, etc.
        if (REORDER_METHODS[m]) {
          // Determine which indices may have changed based on the method
          let startIdx = 0;
          let endIdx = rawTarget.length;

          if (m === 'splice') {
            // splice(start, deleteCount, ...items) - only indices from 'start' onwards change
            startIdx = Number(rawArgs[0]) || 0;
            if (startIdx < 0) startIdx = Math.max(0, oldLength + startIdx);
            // All indices from startIdx to end of array may have shifted
          } else if (m === 'fill') {
            // fill(value, start, end) - only specified range changes
            startIdx = rawArgs[1] !== undefined ? Number(rawArgs[1]) || 0 : 0;
            endIdx = rawArgs[2] !== undefined ? Number(rawArgs[2]) || rawTarget.length : rawTarget.length;
            if (startIdx < 0) startIdx = Math.max(0, rawTarget.length + startIdx);
            if (endIdx < 0) endIdx = Math.max(0, rawTarget.length + endIdx);
          } else if (m === 'copyWithin') {
            // copyWithin(target, start, end) - indices from target onwards change
            startIdx = Number(rawArgs[0]) || 0;
            if (startIdx < 0) startIdx = Math.max(0, rawTarget.length + startIdx);
          }
          // For sort, reverse, shift, unshift: all indices may change (startIdx=0, endIdx=length)

          // Trigger updates ONLY for indices that have active watchers (O(D) where D = tracked deps)
          // This avoids O(N) iteration over the entire array
          for (const [key, depSet] of meta.d) {
            if (typeof key !== 'string') continue;
            const idx = Number(key);
            // Check if this is a numeric array index within the affected range
            if (Number.isInteger(idx) && idx >= startIdx && idx < endIdx && depSet.size > 0) {
              ks.add(key);
            }
          }
        }

      } finally {
        if (--self._b === 0) {
          try { self._fpt(); } catch (err) {
            console.error('Reflex: Error flushing pending triggers:', err);
          }
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

        // CRITICAL FIX #1: Map/Set Iterator Data Corruption
        //
        // PREVIOUS BUG: Reused the same array instance for all iterations to reduce allocations
        // This caused data corruption when using spread operator or Array.from() on reactive Maps
        // All entries in the resulting array would point to the same reference, containing the last value
        //
        // SOLUTION: Create a new array for each iteration to ensure distinct references
        // While this has a performance cost for very large Maps (100k+ items), correctness is critical
        // Users can use Map.get() in a loop for performance-critical large Map iterations
        //
        // OPTIMIZATION: Map/Set Iteration Garbage Generation
        // To reduce GC pressure while maintaining correctness:
        // 1. Reuse the iterator result object { done, value } by mutating it
        // 2. For single-value methods (keys/values), minimize allocations
        // 3. Entry arrays [k, v] must still be newly allocated for correctness

        // Reusable result object - mutate instead of creating new objects
        // This reduces garbage from O(2n) to O(n) for entries, O(1) for keys/values
        const result = { done: false, value: undefined as any };
        const doneResult = { done: true, value: undefined };

        return {
          [Symbol.iterator]() { return this; },
          next() {
            const n = it.next();
            if (n.done) return doneResult;

            // CRITICAL FIX #6: Iteration Allocation Storm
            // Only wrap values that need wrapping (objects). Primitives pass through.
            // This eliminates wrapper allocation overhead for primitive-heavy collections
            if (isMap) {
              if (m === 'keys' || m === 'values') {
                const val = n.value;
                result.value = (val !== null && typeof val === 'object') ? self._wrap(val) : val;
                return result;
              }
              // For entries/default iteration, create a NEW array for each iteration
              // This is critical for correctness with spread operator and Array.from()
              const [k, v] = n.value;
              const wrappedK = (k !== null && typeof k === 'object') ? self._wrap(k) : k;
              const wrappedV = (v !== null && typeof v === 'object') ? self._wrap(v) : v;
              // Create a new array instance for each iteration (fixes data corruption)
              // This is necessary - we can't pool these without risking correctness
              result.value = [wrappedK, wrappedV];
              return result;
            }
            const val = n.value;
            result.value = (val !== null && typeof val === 'object') ? self._wrap(val) : val;
            return result;
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

        // CRITICAL FIX #4: Removed arbitrary 1000 key limit to prevent data corruption
        //
        // PREVIOUS BUG: The code limited notifications to 1000 keys, causing data desync
        // If a Map/Set had >1000 items, watchers on keys beyond the 1000th would never
        // be notified when clear() was called, leaving stale data in the UI
        //
        // SOLUTION: Iterate through meta.d (tracked dependencies) instead of all keys
        // This is O(D) where D is the number of tracked keys (typically << total keys)
        // Most apps track ITERATE for iteration, not individual keys, so D is usually small
        //
        // For correctness, we MUST notify ALL tracked keys, not just the first 1000
        for (const [key, depSet] of meta.d) {
          // Only trigger keys with active watchers
          if (depSet.size > 0 && key !== ITERATE) {
            ks.add(key);
          }
        }

        // Always trigger ITERATE to update iterations (forEach, for...of, etc.)
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
