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

type ReactiveKey = PropertyKey;

// SECURITY: Prototype-related properties that should be blocked when setting
// These properties could lead to prototype pollution attacks if allowed
// Note: Using Object.create(null) to avoid __proto__ issues
const PROTO_PROPS = Object.assign(Object.create(null), {
  constructor: 1,
  '__proto__': 1,
  prototype: 1
});

// Helper to check if a property is prototype-related
const isProtoProperty = (k: PropertyKey): boolean => {
  return typeof k === 'string' && PROTO_PROPS[k] === 1;
};

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
  toRawDeep: <T>(value: T, options?: { force?: boolean }) => T;  // CRITICAL FIX: Recursive deep unwrap for nested proxies
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

    // SECURITY: White-list security is now handled by createMembrane()
    // The membrane wraps objects before they're exposed to expressions,
    // blocking prototype chain access through own property checks.

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

    // SECURITY: Block setting prototype-related properties (defense in depth)
    if (isProtoProperty(k)) {
      throw new Error(
        `Reflex Security: Cannot set property "${String(k)}". ` +
        `This could lead to prototype pollution attacks.`
      );
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
  // the 'set' trap check, allowing prototype pollution
  defineProperty(o, k, desc) {
    if (isProtoProperty(k)) {
      throw new Error(
        `Reflex Security: Cannot define property "${String(k)}". ` +
        `This could lead to prototype pollution attacks.`
      );
    }
    const meta = (o as ReactiveTarget)[META] as ReactiveMeta;
    const engine = meta.engine;

    // CRITICAL FIX (Audit Issue #4): Reactivity Blindness with Accessor Descriptors
    // PREVIOUS BUG: Only checked for 'value' in desc:
    //   const newLength = k === 'length' && 'value' in desc ? Number(desc.value) : -1;
    // This failed for accessor descriptors like { get: () => 0 }, causing truncation
    // watchers to never fire when using Object.defineProperty(arr, 'length', { get: () => 0 })
    //
    // FIX: Capture oldLength BEFORE the operation, then check actual length AFTER.
    // This works regardless of whether a value or accessor descriptor is used.
    const oldLength = k === 'length' ? o.length : -1;

    const res = Reflect.defineProperty(o, k, desc);
    if (!res) return false;

    // CRITICAL FIX (Audit Issue #4): Check actual length AFTER operation
    // This detects truncation from accessor descriptors (getter-based length)
    const actualNewLength = k === 'length' ? o.length : -1;

    // CRITICAL FIX: Version Counter - Only increment if not in a batch
    // Same logic as set handler: avoid double increment when in batched operations
    if (engine._b === 0) {
      meta.v++; // Increment version on mutation
    }

    // CRITICAL FIX (Audit Issue #4): Array Truncation Batch Notifications
    // Trigger watchers when array is truncated, using actual length after operation
    // Works for both value descriptors and accessor descriptors
    if (k === 'length' && actualNewLength < oldLength && actualNewLength >= 0) {
      // Use batching to prevent UI freeze on large array truncation
      engine._b++;
      try {
        let ks = engine.pendingTriggers.get(meta);
        if (!ks) engine.pendingTriggers.set(meta, ks = new Set());

        // Queue 'length' and ITERATE triggers
        ks.add('length');
        ks.add(ITERATE);

        // CRITICAL: Iterate only over existing dependency keys in meta.d (O(D) not O(N))
        // This prevents DoS on large arrays by only triggering indices that have active watchers
        for (const [key, depSet] of meta.d) {
          // Skip if this key is not a numeric index
          if (typeof key !== 'string') continue;
          const idx = Number(key);
          // Check if this is a numeric array index that was deleted
          if (Number.isInteger(idx) && idx >= actualNewLength && idx < oldLength && depSet.size > 0) {
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
      engine.triggerEffects(meta, ITERATE);
    }
    return true;
  },

  // CRITICAL SECURITY FIX: Prevent prototype pollution via Object.setPrototypeOf
  setPrototypeOf() {
    throw new Error('Reflex: Cannot set prototype (prototype pollution prevention)');
  },

  // CRITICAL FIX (Issue #2): Restore prototype for instanceof checks
  // Previously returned null to prevent prototype pollution, but this breaks:
  //   state.items instanceof Array → false (should be true)
  //   state.date instanceof Date → false (should be true)
  //
  // Security is maintained through multiple layers:
  // 1. The 'get' trap blocks access to 'constructor', '__proto__', 'prototype', etc.
  // 2. The 'set' trap blocks setting these dangerous properties
  // 3. The 'defineProperty' trap blocks defining these properties
  // 4. The 'setPrototypeOf' trap prevents prototype chain manipulation
  //
  // By returning the real prototype, instanceof works correctly while security
  // is enforced by the other traps that block dangerous property access.
  getPrototypeOf(o) {
    return Object.getPrototypeOf(o);
  },

  // CRITICAL SECURITY FIX #8: Inconsistent Sandbox Visibility
  // The 'has' trap ensures ("__proto__" in obj) returns false consistently
  // With white-list security, we hide prototype-related properties
  has(o, k) {
    // Hide prototype-related properties from 'in' operator
    if (isProtoProperty(k)) {
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

    // SECURITY: White-list security is now handled by createMembrane()
    // The membrane wraps objects before they're exposed to expressions,
    // blocking prototype chain access (constructor, __proto__, etc.)
    // through its own property + safe methods whitelist approach.

    const engine = meta.engine;
    engine.trackDependency(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[META] as ReactiveMeta;
    const engine = meta.engine;

    // SECURITY: Block setting prototype-related properties (defense in depth)
    const kStr = String(k);
    if (kStr === '__proto__' || kStr === 'constructor' || kStr === 'prototype') {
      throw new Error(
        `Reflex Security: Cannot set property "${kStr}". ` +
        `This could lead to prototype pollution attacks.`
      );
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
  // the 'set' trap check, allowing prototype pollution
  defineProperty(o, k, desc) {
    if (isProtoProperty(k)) {
      throw new Error(
        `Reflex Security: Cannot define property "${String(k)}". ` +
        `This could lead to prototype pollution attacks.`
      );
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

  // CRITICAL FIX (Issue #2): Restore prototype for instanceof checks
  // Previously returned null to prevent prototype pollution, but this breaks:
  //   state.obj instanceof SomeClass → false (should be true)
  //
  // Security is maintained through multiple layers:
  // 1. The 'get' trap blocks access to 'constructor', '__proto__', 'prototype', etc.
  // 2. The 'set' trap blocks setting these dangerous properties
  // 3. The 'defineProperty' trap blocks defining these properties
  // 4. The 'setPrototypeOf' trap prevents prototype chain manipulation
  //
  // By returning the real prototype, instanceof works correctly while security
  // is enforced by the other traps that block dangerous property access.
  getPrototypeOf(o) {
    return Object.getPrototypeOf(o);
  },

  // CRITICAL SECURITY FIX #8: Inconsistent Sandbox Visibility
  // The 'has' trap ensures ("__proto__" in obj) returns false consistently
  // With white-list security, we hide prototype-related properties
  has(o, k) {
    // Hide prototype-related properties from 'in' operator
    if (isProtoProperty(k)) {
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

    // SECURITY: White-list security is now handled by createMembrane()

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

    // SECURITY: White-list security is now handled by createMembrane()

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

    // CRITICAL FIX (Issue #1): Native Object Crash Prevention
    // Native objects like Date, RegExp, WeakMap, WeakSet, and Promise rely on internal slots
    // (e.g., [[DateValue]], [[RegExpMatcher]], [[WeakMapData]]) that are tied to the original object.
    // When wrapped in a Proxy, methods like date.getTime() throw:
    //   "TypeError: this is not a Date object"
    // because the Proxy doesn't have these internal slots.
    //
    // Solution: Skip proxying these native objects entirely. Users can still store them in
    // reactive state, but the objects themselves won't be reactive (which is fine since
    // their internal state is typically immutable or accessed via methods).
    //
    // Note: Date methods are immutable (getTime() reads internal slot, setTime() creates new Date),
    // so there's no benefit to proxying them anyway.
    if (t instanceof Date) return t;
    if (t instanceof RegExp) return t;
    if (typeof WeakMap !== 'undefined' && t instanceof WeakMap) return t;
    if (typeof WeakSet !== 'undefined' && t instanceof WeakSet) return t;
    if (typeof Promise !== 'undefined' && t instanceof Promise) return t;
    // Also skip Error objects - their stack traces and messages are internal
    if (t instanceof Error) return t;

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
   * CRITICAL FIX (SEC-2026-003 Issue #6): Recursive Stack Overflow in toRawDeep
   *
   * VULNERABILITY: Previous implementation used recursion which crashes on deeply nested objects.
   * A JSON tree with 5000+ depth (from an API or deeply nested state) causes:
   * "RangeError: Maximum call stack size exceeded"
   *
   * FIX: Rewrite to use iterative stack-based approach (similar to _trv and _clone).
   * This can handle arbitrary depth without stack overflow.
   *
   * Recursively unwraps all reactive proxies in a nested object structure.
   * This is essential for:
   * - Array operations: state.items.includes(item) when item is raw and state.items contains proxies
   * - Object comparison: JSON.stringify(toRawDeep(state)) for debugging/serialization
   * - API calls: Sending raw data to external APIs that can't handle proxies
   * - Testing: Comparing expected vs actual state in unit tests
   *
   * Unlike toRaw() which only unwraps one level, toRawDeep() recursively processes:
   * - Arrays: Unwraps all elements
   * - Objects: Unwraps all property values
   * - Maps: Unwraps all keys and values
   * - Sets: Unwraps all values
   *
   * Performance: Uses iterative approach to avoid stack overflow on deeply nested structures.
   * Cycle-safe: Tracks seen objects to handle circular references.
   *
   * CRITICAL FIX (Audit Issue #5): Graceful Failure for Node Limit
   * When the node limit is exceeded:
   * - Logs a warning (instead of throwing an error)
   * - Returns the partially-processed structure or raw fallback
   * - Prevents application crashes in data-heavy dashboards
   *
   * Use the `force: true` option to disable the limit for valid use cases like
   * exporting large datasets.
   *
   * @param v - Value to deeply unwrap (may be a nested reactive structure)
   * @param options - Optional configuration
   * @param options.force - If true, disable the node limit (use for large dataset export)
   * @returns A deeply unwrapped copy with all proxies replaced by their raw targets
   *
   * @example
   * // Array comparison with mixed proxy/raw items
   * const rawItem = { id: 1, name: 'Test' };
   * state.items.push(rawItem);
   * console.log(toRawDeep(state.items).includes(rawItem)); // true
   *
   * @example
   * // Safe JSON serialization
   * const snapshot = JSON.stringify(app.toRawDeep(app.s));
   *
   * @example
   * // Force processing of large datasets (use with caution)
   * const largeExport = app.toRawDeep(state.bigData, { force: true });
   */
  toRawDeep<T>(v: T, options?: { force?: boolean }): T {
    // Primitives and null/undefined pass through
    if (v == null || typeof v !== 'object') return v;

    // First, unwrap the top-level proxy if it is one
    const topRaw = this.toRaw(v);

    // Track seen objects to handle circular references
    const seen = new Map<object, any>();

    // CRITICAL FIX (SEC-FINAL-004 Issue #4): DoS Protection via Node Limit
    //
    // Without a limit, toRawDeep can freeze the main thread when processing
    // massive recursive structures (e.g., large JSON payloads, deeply nested state).
    // Limit to 100,000 nodes to prevent UI freezing while supporting most use cases.
    //
    // CRITICAL FIX (Audit Issue #5): Graceful Failure
    // - Use `force: true` to disable the limit for large dataset exports
    // - When limit is exceeded without force, warn and return partial result
    const MAX_NODES = 100000;
    const forceNoLimit = options?.force === true;
    let nodeCount = 0;
    let limitExceeded = false;

    // ITERATIVE APPROACH: Two-pass stack-based processing (no recursion)
    // Pass 1: Create result shells and build seen map
    // Pass 2: Fill in the values using the seen map

    // Pass 1: Build structure shells
    const stack = [topRaw];
    while (stack.length > 0) {
      const obj = stack.pop()!;

      if (obj == null || typeof obj !== 'object') continue;
      if (seen.has(obj)) continue;

      // CRITICAL FIX (Audit Issue #5): Graceful Failure for Node Limit
      //
      // PREVIOUS BUG: Throwing an error crashed the entire application when
      // toRawDeep was used in logging, telemetry, or reactivity hooks.
      //
      // FIX: Warn and stop processing, returning the partial result.
      // - The `seen` map contains all nodes processed so far
      // - Unprocessed nodes will fall back to their raw targets
      // - Use `force: true` to disable the limit for large exports
      //
      // This ensures:
      // 1. Application doesn't crash on large datasets
      // 2. Partial results are still usable (better than nothing)
      // 3. Warning alerts developers to potential issues
      // 4. `force` option available for legitimate large dataset needs
      if (!forceNoLimit && ++nodeCount > MAX_NODES) {
        if (!limitExceeded) {
          limitExceeded = true;
          console.warn(
            `Reflex: toRawDeep exceeded maximum node limit (${MAX_NODES}).\n` +
            `Processing stopped to prevent UI freeze. Partial result returned.\n\n` +
            `Options:\n` +
            `  1. Use toRaw() for single-level unwrapping\n` +
            `  2. Use toRawDeep(value, { force: true }) to process all nodes\n` +
            `  3. Restructure data to reduce nesting depth\n\n` +
            `Note: force: true may cause performance issues with very large structures.`
          );
        }
        // Stop processing this branch - it will use raw fallback in Pass 2
        continue;
      }

      // Unwrap proxy if needed
      const unwrapped = this.toRaw(obj);

      // Skip non-plain objects (Date, RegExp, etc.)
      if (unwrapped instanceof Date || unwrapped instanceof RegExp ||
          unwrapped instanceof Error || unwrapped instanceof Promise ||
          (typeof WeakMap !== 'undefined' && unwrapped instanceof WeakMap) ||
          (typeof WeakSet !== 'undefined' && unwrapped instanceof WeakSet) ||
          (typeof File !== 'undefined' && unwrapped instanceof File) ||
          (typeof Blob !== 'undefined' && unwrapped instanceof Blob)) {
        seen.set(obj, unwrapped);
        continue;
      }

      // Create result shell based on type
      if (Array.isArray(unwrapped)) {
        const result: any[] = [];
        seen.set(obj, result);
        // Queue children for processing
        for (let i = 0; i < unwrapped.length; i++) {
          stack.push(unwrapped[i]);
        }
      } else if (unwrapped instanceof Map) {
        const result = new Map();
        seen.set(obj, result);
        // Queue children for processing
        unwrapped.forEach((value, key) => {
          stack.push(key);
          stack.push(value);
        });
      } else if (unwrapped instanceof Set) {
        const result = new Set();
        seen.set(obj, result);
        // Queue children for processing
        unwrapped.forEach(value => {
          stack.push(value);
        });
      } else {
        // Plain object
        const result: Record<string, any> = {};
        seen.set(obj, result);
        // Queue children for processing
        for (const key in unwrapped) {
          if (Object.prototype.hasOwnProperty.call(unwrapped, key)) {
            stack.push(unwrapped[key]);
          }
        }
      }
    }

    // Pass 2: Fill in values using the seen map
    const fillStack = [topRaw];
    const filled = new Set();

    while (fillStack.length > 0) {
      const obj = fillStack.pop()!;

      if (obj == null || typeof obj !== 'object') continue;
      if (filled.has(obj)) continue;
      filled.add(obj);

      const unwrapped = this.toRaw(obj);
      const result = seen.get(obj);

      if (!result) continue;

      // CRITICAL FIX (Audit Issue #1): Map Key Consistency in toRawDeep
      //
      // PREVIOUS BUG: Pass 1 stores shells using the original object (potentially a Proxy) as key:
      //   seen.set(obj, result)  // obj may be a Proxy
      // Pass 2 looked up using the RAW target:
      //   seen.get(this.toRaw(child))  // returns undefined if child was stored as Proxy
      //
      // This caused seen.get() to return undefined, and the fallback returned the raw target
      // instead of the cloned shell. Result: mixed graph of shells and raw targets.
      //
      // FIX: Use the original value (which may be a Proxy) as the lookup key in Pass 2,
      // matching how it was stored in Pass 1. Only fall back to raw if not found.
      if (Array.isArray(unwrapped)) {
        for (let i = 0; i < unwrapped.length; i++) {
          const child = unwrapped[i];
          if (child != null && typeof child === 'object') {
            // CRITICAL FIX: Look up using original value (child), not toRaw(child)
            result[i] = seen.get(child) ?? this.toRaw(child);
            fillStack.push(child);
          } else {
            result[i] = child;
          }
        }
      } else if (unwrapped instanceof Map) {
        unwrapped.forEach((value, key) => {
          // CRITICAL FIX: Look up using original values, not toRaw versions
          const processedKey = (key != null && typeof key === 'object') ? (seen.get(key) ?? this.toRaw(key)) : key;
          const processedValue = (value != null && typeof value === 'object') ? (seen.get(value) ?? this.toRaw(value)) : value;
          result.set(processedKey, processedValue);
          if (key != null && typeof key === 'object') fillStack.push(key);
          if (value != null && typeof value === 'object') fillStack.push(value);
        });
      } else if (unwrapped instanceof Set) {
        unwrapped.forEach(value => {
          // CRITICAL FIX: Look up using original value, not toRaw version
          const processedValue = (value != null && typeof value === 'object') ? (seen.get(value) ?? this.toRaw(value)) : value;
          result.add(processedValue);
          if (value != null && typeof value === 'object') fillStack.push(value);
        });
      } else {
        // Plain object
        for (const key in unwrapped) {
          if (Object.prototype.hasOwnProperty.call(unwrapped, key)) {
            const child = unwrapped[key];
            if (child != null && typeof child === 'object') {
              // CRITICAL FIX: Look up using original value (child), not toRaw(child)
              result[key] = seen.get(child) ?? this.toRaw(child);
              fillStack.push(child);
            } else {
              result[key] = child;
            }
          }
        }
      }
    }

    return seen.get(topRaw) as T ?? topRaw as T;
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
        let rawArgs = args.map(arg => self.toRaw(arg));

        // TASK 13.4: Wrap callbacks for sort/findIndex/find/filter/etc.
        // When calling on raw target, callbacks receive raw objects.
        // But developers expect to work with reactive proxies in their comparators/predicates.
        // We wrap the callback to pass reactive proxies to the developer's function.
        const callbackMethods = { sort: 0, findIndex: 0, find: 0, filter: 0, every: 0, some: 0, map: 0, forEach: 0, reduce: 0, reduceRight: 0 };
        if (m in callbackMethods && typeof rawArgs[0] === 'function') {
          const originalCallback = rawArgs[0];
          if (m === 'sort') {
            // sort(comparator) - comparator receives (a, b)
            rawArgs[0] = (a, b) => {
              const wrappedA = (a !== null && typeof a === 'object') ? self._wrap(a) : a;
              const wrappedB = (b !== null && typeof b === 'object') ? self._wrap(b) : b;
              return originalCallback(wrappedA, wrappedB);
            };
          } else if (m === 'reduce' || m === 'reduceRight') {
            // reduce/reduceRight(callback, initialValue) - callback receives (acc, value, index, array)
            rawArgs[0] = (acc, value, index, arr) => {
              const wrappedValue = (value !== null && typeof value === 'object') ? self._wrap(value) : value;
              return originalCallback(acc, wrappedValue, index, t);
            };
          } else {
            // findIndex, find, filter, every, some, map, forEach - callback receives (value, index, array)
            rawArgs[0] = (value, index, arr) => {
              const wrappedValue = (value !== null && typeof value === 'object') ? self._wrap(value) : value;
              return originalCallback(wrappedValue, index, t);
            };
          }
        }

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

        // CRITICAL FIX (SEC-2026-003 Issue #4): Reactivity Blindness for push/pop
        //
        // VULNERABILITY: push/pop trigger ITERATE and length, but NOT specific indices.
        // Result: {{ list[2] }} doesn't update when list.push(item) adds item at index 2.
        //
        // FIX: For push, trigger the new indices that were added.
        //      For pop, trigger the index that was removed.
        //
        // Example: list = [1, 2]; list.push(3, 4) → trigger indices "2" and "3"
        if (m === 'push' && rawArgs.length > 0) {
          // Push adds items starting at oldLength
          // Trigger all new indices: oldLength, oldLength+1, ..., oldLength+N-1
          for (let i = 0; i < rawArgs.length; i++) {
            const newIndex = String(oldLength + i);
            // Only trigger if there are watchers on this index (O(1) lookup)
            if (meta.d.has(newIndex)) {
              ks.add(newIndex);
            }
          }
        } else if (m === 'pop' && oldLength > 0) {
          // Pop removes the last item (index oldLength - 1)
          const removedIndex = String(oldLength - 1);
          if (meta.d.has(removedIndex)) {
            ks.add(removedIndex);
          }
        }

        // CRITICAL FIX: Array Mutation Index Blindness
        // For reorder methods, trigger updates for specific indices that have watchers.
        // This ensures {{ list[0] }} updates when array is sorted, reversed, etc.
        //
        // CRITICAL FIX (Issue #9): O(D) not O(N) for shift/unshift
        // We iterate over meta.d (dependencies) not over all array indices.
        // This means shift/unshift on a 100k array only triggers watchers for
        // indices that are actually being observed (e.g., {{ list[0] }}).
        // If only 5 indices are watched, we trigger exactly 5 updates, not 100k.
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

        // CRITICAL FIX (Audit Issue #2): Iterator Protocol Violation
        //
        // PREVIOUS BUG: Reused the same result object { done, value } for every next() call.
        // This violates the Iterator protocol because consumers that store iterator results
        // see all stored results mutated to the last value.
        //
        // Example of broken behavior:
        //   const it = map.values();
        //   const [a, b] = [it.next(), it.next()];
        //   // a.value === b.value === lastValue (WRONG!)
        //
        // The ES6 Iterator protocol requires each next() call to return a NEW object.
        // While reusing objects reduces GC pressure, correctness MUST take precedence.
        //
        // FIX: Allocate a new result object for each next() call.
        // Performance impact is minimal for typical use cases (< 10k items).
        // For large datasets, use forEach() or toRaw() + native iteration.

        return {
          [Symbol.iterator]() { return this; },
          next() {
            const n = it.next();
            if (n.done) return { done: true, value: undefined };

            // CRITICAL FIX #6: Iteration Allocation Storm
            // Only wrap values that need wrapping (objects). Primitives pass through.
            // This eliminates wrapper allocation overhead for primitive-heavy collections
            if (isMap) {
              if (m === 'keys' || m === 'values') {
                const val = n.value;
                // CRITICAL FIX (Audit Issue #2): Return NEW object for each next() call
                return { done: false, value: (val !== null && typeof val === 'object') ? self._wrap(val) : val };
              }
              // TASK 13.6: Map entries iteration - correctness over performance
              // For entries/default iteration, create a NEW array for each iteration
              // This is critical for correctness with spread operator and Array.from()
              //
              // CRITICAL FIX (Task 14 Issue #6): Performance Documentation
              // This creates O(n) array allocations for n entries, which can cause:
              // - Frame drops in 60fps rendering with large datasets (>1000 items)
              // - Major GC pauses in long-running dashboards
              // - Memory pressure in data visualizations
              //
              // WHY THIS IS UNAVOIDABLE FOR CORRECTNESS:
              // If we reused arrays, [...map.entries()] would return an array where
              // all entries point to the SAME [k, v] array containing the last value.
              //
              // PERFORMANCE WORKAROUNDS (choose based on use case):
              //
              // 1. Use forEach for callback-based iteration (O(1) allocation):
              //    map.forEach((value, key) => { /* process */ });
              //
              // 2. Use get() with known keys (O(k) for k keys):
              //    for (const key of knownKeys) { const value = map.get(key); }
              //
              // 3. Use raw Map from toRaw() for read-only bulk operations:
              //    const rawMap = app.toRaw(state.myMap);
              //    for (const [k, v] of rawMap) { /* read-only processing */ }
              //    // WARNING: Changes won't trigger reactivity!
              //
              // 4. Use Arrays instead of Maps for large reactive datasets:
              //    Arrays have lower iteration overhead per element
              //
              const [k, v] = n.value;
              const wrappedK = (k !== null && typeof k === 'object') ? self._wrap(k) : k;
              const wrappedV = (v !== null && typeof v === 'object') ? self._wrap(v) : v;
              // CRITICAL FIX (Audit Issue #2): Return NEW object and array for each next() call
              return { done: false, value: [wrappedK, wrappedV] };
            }
            const val = n.value;
            // CRITICAL FIX (Audit Issue #2): Return NEW object for each next() call
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
      // TASK 13.6: Optimized forEach - Direct Callback Invocation
      // Performance optimization: Pass wrapped values directly to callback
      // WITHOUT creating intermediate arrays or entry objects.
      //
      // Previous allocation storm: Creating [k, v] arrays for each entry
      // New approach: Wrap and pass directly - O(1) allocation overhead for objects only
      //
      // Primitives pass through without wrapping (fast path)
      // Objects get wrapped lazily (only when accessed)
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
