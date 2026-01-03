/**
 * Reflex Core - Shared Symbols and Constants
 *
 * This module defines all internal symbols and constants used across the library.
 * Centralizing these prevents redeclaration conflicts and ensures consistency.
 *
 * SECURITY MODEL: White-List Only ("Iron Membrane" 2.0)
 *
 * This module implements a strict white-list security model that:
 * 1. ALLOWS: Own data properties (user's data via hasOwnProperty)
 * 2. ALLOWS: Safe standard methods (map, filter, etc. from SAFE_METHODS)
 * 3. ALLOWS: Well-known symbols (iterators, toPrimitive)
 * 4. DENIES: Everything else (prototype chain, unknown globals, future features)
 *
 * This approach is fundamentally more secure than blacklisting because:
 * - New dangerous properties added to JavaScript won't be allowed
 * - Browser extensions and polyfills can't add exploitable accessors
 * - The default action is DENY, not ALLOW
 */

// === INTERNAL SYMBOLS ===
// Using Symbol.for() for symbols that need to be shared across module boundaries
// Using Symbol() for truly private symbols

/** Metadata marker - stores reactive metadata on objects */
export const META = Symbol.for('rx.meta');

/** Iterate symbol - triggers when collection is iterated */
export const ITERATE = Symbol.for('rx.iterate');

/** Skip symbol - marks objects that should not be made reactive */
export const SKIP = Symbol.for('rx.skip');

// === EFFECT FLAGS (Bitwise for performance) ===
/** Effect is active */
export const ACTIVE = 1;
/** Effect is currently running */
export const RUNNING = 2;
/** Job is queued in scheduler */
export const QUEUED = 4;

// === RESERVED WORDS ===
// JavaScript reserved words and safe globals that should not be treated as state variables
export const RESERVED = {
  __proto__: null,
  true: 1, false: 1, null: 1, undefined: 1, NaN: 1, Infinity: 1,
  if: 1, else: 1, for: 1, while: 1, do: 1, switch: 1, case: 1,
  break: 1, continue: 1, return: 1, try: 1, catch: 1, finally: 1,
  throw: 1, new: 1, delete: 1, typeof: 1, instanceof: 1, in: 1, of: 1,
  void: 1, await: 1, async: 1, yield: 1, function: 1, class: 1,
  extends: 1, super: 1, this: 1, var: 1, let: 1, const: 1,
  Math: 1, Date: 1, console: 1, window: 1, document: 1,
  Array: 1, Object: 1, Number: 1, String: 1, Boolean: 1, JSON: 1,
  Promise: 1, Symbol: 1, BigInt: 1, Map: 1, Set: 1, RegExp: 1, Error: 1,
  parseInt: 1, parseFloat: 1, isNaN: 1, isFinite: 1,
  $event: 1,
  // Magic properties (available in all expressions)
  $refs: 1, $dispatch: 1, $nextTick: 1, $el: 1
};

// === ARRAY MUTATING METHODS ===
// Methods that mutate arrays and require special handling
export const ARRAY_MUTATORS = {
  __proto__: null,
  push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1
};

// Methods that reorder array elements (need to trigger all index updates)
export const REORDER_METHODS = {
  __proto__: null,
  splice: 1, sort: 1, reverse: 1, shift: 1, unshift: 1, fill: 1, copyWithin: 1
};

// === COLLECTION METHODS ===
// Map/Set methods that need special reactive handling
export const COLLECTION_METHODS = {
  __proto__: null,
  get: 1, has: 1, forEach: 1, keys: 1, values: 1, entries: 1, set: 1, add: 1, delete: 1, clear: 1
};

// === SECURITY CONSTANTS ===

// SECURITY FIX: Use allowlist instead of blocklist for URL protocols
// Blocklist approach (blocking javascript:, vbscript:, data:) can be bypassed with:
// - HTML entity encoding: jav&#x09;ascript:alert(1)
// - Unicode escapes: \u006a\u0061\u0076\u0061script:alert(1)
// - Case variations and whitespace: JAvasCRIPT:alert(1)
//
// Allowlist is safer: only permit known-safe protocols
// Safe protocols: http, https, mailto, tel, sms, ftp, ftps
// Relative URLs (starting with /, ./, ../) are also safe
export const SAFE_URL_RE = /^\s*(https?|mailto|tel|sms|ftps?):/i;
// CRITICAL FIX: Relative URL regex was too permissive - it matched [a-z0-9] which allowed
// protocol URIs like "javascript:alert(1)" to pass (starts with 'j').
// Now only matches: /, ./, ../, #anchor, ?query, or paths without colons
// This prevents protocol bypass while allowing all valid relative URLs
export const RELATIVE_URL_RE = /^\s*(\/|\.\/|\.\.\/|#|\?|[a-z0-9][^:]*$)/i;

// === REGEX PATTERNS ===
// Identifier extraction pattern for expression parsing
export const ID_RE = /(?:^|[^.\w$])([a-zA-Z_$][\w$]*)/g;

// === THE IRON MEMBRANE 2.0: White-List Only Proxy Sandbox ===

/**
 * Safe standard object/array methods that are allowed through the membrane.
 * This is the ONLY source of method access - prototype chain is blocked.
 */
const SAFE_METHODS: { [key: string]: 1 } = {
  __proto__: null,
  // Array methods (non-mutating)
  map: 1, filter: 1, reduce: 1, reduceRight: 1, forEach: 1, find: 1, findIndex: 1,
  findLast: 1, findLastIndex: 1, some: 1, every: 1, indexOf: 1, lastIndexOf: 1,
  includes: 1, slice: 1, concat: 1, join: 1, flat: 1, flatMap: 1, at: 1,
  toReversed: 1, toSorted: 1, toSpliced: 1, with: 1,
  // Array methods (mutating) - needed for reactive updates
  push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1,
  // String methods
  charAt: 1, charCodeAt: 1, codePointAt: 1, substring: 1, substr: 1, slice: 1,
  toLowerCase: 1, toUpperCase: 1, toLocaleLowerCase: 1, toLocaleUpperCase: 1,
  trim: 1, trimStart: 1, trimEnd: 1, trimLeft: 1, trimRight: 1,
  split: 1, replace: 1, replaceAll: 1, match: 1, matchAll: 1,
  search: 1, startsWith: 1, endsWith: 1, padStart: 1, padEnd: 1, repeat: 1,
  normalize: 1, localeCompare: 1, at: 1,
  // Object methods (safe subset)
  toString: 1, valueOf: 1, hasOwnProperty: 1, toLocaleString: 1,
  // Number methods
  toFixed: 1, toPrecision: 1, toExponential: 1,
  // Date methods
  getTime: 1, getFullYear: 1, getMonth: 1, getDate: 1, getDay: 1,
  getHours: 1, getMinutes: 1, getSeconds: 1, getMilliseconds: 1,
  getUTCFullYear: 1, getUTCMonth: 1, getUTCDate: 1, getUTCDay: 1,
  getUTCHours: 1, getUTCMinutes: 1, getUTCSeconds: 1, getUTCMilliseconds: 1,
  getTimezoneOffset: 1, toISOString: 1, toJSON: 1,
  toLocaleDateString: 1, toLocaleTimeString: 1, toLocaleString: 1,
  toDateString: 1, toTimeString: 1, toUTCString: 1,
  setTime: 1, setFullYear: 1, setMonth: 1, setDate: 1,
  setHours: 1, setMinutes: 1, setSeconds: 1, setMilliseconds: 1,
  setUTCFullYear: 1, setUTCMonth: 1, setUTCDate: 1,
  setUTCHours: 1, setUTCMinutes: 1, setUTCSeconds: 1, setUTCMilliseconds: 1,
  // Map/Set methods
  keys: 1, values: 1, entries: 1, get: 1, has: 1, set: 1, add: 1, delete: 1, clear: 1, size: 1,
  // RegExp methods
  test: 1, exec: 1,
  // Length property (needed for arrays/strings)
  length: 1
} as any;

/**
 * WeakMap to cache membranes for objects to avoid creating duplicate proxies
 */
const membraneCache = new WeakMap<object, any>();

/**
 * Creates an unbypassable security membrane around an object using Proxy.
 * This implements the WHITE-LIST ONLY security model.
 *
 * The membrane:
 * - ALLOWS: Own data properties (via hasOwnProperty - NOT 'in' operator)
 * - ALLOWS: Safe standard methods (from SAFE_METHODS whitelist)
 * - ALLOWS: Well-known symbols (iterators, toPrimitive)
 * - DENIES: Everything else (prototype chain, constructor, __proto__, etc.)
 *
 * This approach implicitly blocks dangerous properties because they are
 * inherited (constructor, __proto__, prototype) not own properties.
 *
 * @param {any} target - Object to wrap in the membrane
 * @returns {Proxy} Proxied object with security enforcement
 */
export function createMembrane(target: any): any {
  // Don't wrap primitives or null/undefined
  if (target == null || typeof target !== 'object') {
    return target;
  }

  // Return cached membrane if it exists
  const cached = membraneCache.get(target);
  if (cached) {
    return cached;
  }

  const membrane = new Proxy(target, {
    get(obj, key) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // 1. ALLOW: Well-Known Symbols (Iterators, toPrimitive)
      // These are needed for for...of loops and type coercion
      if (typeof key === 'symbol') {
        if (key === Symbol.iterator || key === Symbol.asyncIterator || key === Symbol.toPrimitive) {
          return Reflect.get(obj, key);
        }
        // Block all other symbols (Symbol.toStringTag manipulation, etc.)
        return undefined;
      }

      // 2. ALLOW: Own Data Properties (The User's Data)
      // CRITICAL: MUST use hasOwnProperty, NOT 'in' operator
      // This implicitly blocks constructor, __proto__, prototype because they are inherited
      if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
        const value = Reflect.get(obj, key);

        // Recursively wrap objects in the membrane
        if (value != null && typeof value === 'object') {
          return createMembrane(value);
        }

        // Wrap functions to ensure return values are also protected
        if (typeof value === 'function') {
          return createFunctionWrapper(value, obj);
        }

        return value;
      }

      // 3. ALLOW: Safe Standard Methods (map, filter, etc.)
      // Only allow if the method exists on the target AND is in our safe list
      if (SAFE_METHODS[keyStr] && typeof obj[key] === 'function') {
        const value = obj[key];

        // CRITICAL FIX: Native objects with internal slots (Date, Map, Set, WeakMap)
        // require methods to be bound to the original object, not the Proxy.
        // Otherwise we get "TypeError: this is not a Date object"
        const isNativeWithInternalSlots = (
          obj instanceof Date ||
          obj instanceof Map ||
          obj instanceof Set ||
          obj instanceof WeakMap ||
          obj instanceof WeakSet ||
          obj instanceof RegExp ||
          obj instanceof ArrayBuffer ||
          obj instanceof DataView ||
          (typeof SharedArrayBuffer !== 'undefined' && obj instanceof SharedArrayBuffer) ||
          ArrayBuffer.isView(obj) // TypedArrays (Uint8Array, Int32Array, etc.)
        );

        if (isNativeWithInternalSlots) {
          // Bind method to original target and wrap return values
          return function(...args: any[]) {
            const result = value.apply(obj, args);
            // Recursively wrap object/function return values
            if (result != null && (typeof result === 'object' || typeof result === 'function')) {
              return createMembrane(result);
            }
            return result;
          };
        }

        // For non-native objects, wrap the function
        return createFunctionWrapper(value, obj);
      }

      // 4. DENY: Everything else
      // This blocks prototype chain traversal, unknown globals, and future browser features
      return undefined;
    },

    // CRITICAL SECURITY: The 'has' trap prevents dangerous global access in 'with' blocks.
    //
    // When using 'with(proxy) { someVar }', JavaScript checks has(proxy, 'someVar').
    // - If has() returns FALSE, JavaScript looks for 'someVar' in outer/global scope
    // - If has() returns TRUE, JavaScript calls get(proxy, 'someVar')
    //
    // Strategy:
    // 1. Return TRUE for own properties (normal behavior)
    // 2. Return TRUE for safe methods (allow method calls)
    // 3. Return FALSE for everything else (allow safe global scope lookup)
    has(obj, key) {
      // Special handling for Symbol.unscopables (used by with statement)
      if (key === Symbol.unscopables) {
        return Reflect.has(obj, key);
      }

      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Own properties are visible
      if (Object.prototype.hasOwnProperty.call(obj, keyStr)) {
        return true;
      }

      // Safe methods are visible
      if (SAFE_METHODS[keyStr] && typeof obj[key] === 'function') {
        return true;
      }

      // Everything else is hidden - allows safe global scope lookup
      return false;
    },

    // Block set trap for dangerous properties (defense in depth)
    set(obj, key, value) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Block setting prototype-related properties
      if (keyStr === '__proto__' || keyStr === 'constructor' || keyStr === 'prototype') {
        throw new Error(
          `Reflex Security: Cannot set property "${keyStr}". ` +
          `This could lead to prototype pollution attacks.`
        );
      }

      return Reflect.set(obj, key, value);
    },

    // Block defineProperty for dangerous properties
    defineProperty(obj, key, descriptor) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      if (keyStr === '__proto__' || keyStr === 'constructor' || keyStr === 'prototype') {
        throw new Error(
          `Reflex Security: Cannot define property "${keyStr}". ` +
          `This could lead to prototype pollution attacks.`
        );
      }

      return Reflect.defineProperty(obj, key, descriptor);
    },

    // Block deleteProperty for system properties
    deleteProperty(obj, key) {
      return Reflect.deleteProperty(obj, key);
    },

    // Block getPrototypeOf to prevent prototype chain manipulation
    getPrototypeOf() {
      // Return null to hide the prototype chain
      return null;
    },

    // Block setPrototypeOf to prevent prototype chain manipulation
    setPrototypeOf() {
      throw new Error(
        'Reflex Security: Cannot set prototype. ' +
        'This could lead to prototype pollution attacks.'
      );
    }
  });

  // Cache the membrane
  membraneCache.set(target, membrane);

  return membrane;
}

/**
 * Creates a wrapped function that ensures return values are protected by the membrane.
 *
 * @param {Function} fn - Function to wrap
 * @param {any} thisArg - The 'this' context for the function
 * @returns {Function} Wrapped function
 */
function createFunctionWrapper(fn: Function, thisArg: any): Function {
  return function(...args: any[]) {
    const result = fn.apply(thisArg, args);

    // Recursively wrap object/function return values
    if (result != null && (typeof result === 'object' || typeof result === 'function')) {
      return createMembrane(result);
    }

    return result;
  };
}

// === ELEMENT MEMBRANE: DOM Security ===

/**
 * Safe DOM properties and methods that are allowed on $el
 */
const SAFE_DOM_PROPS: { [key: string]: 1 } = {
  __proto__: null,
  // Element properties
  id: 1, className: 1, tagName: 1, nodeName: 1, nodeType: 1,
  textContent: 1, innerHTML: 1, innerText: 1, value: 1,
  checked: 1, disabled: 1, selected: 1, hidden: 1,
  // Attributes
  getAttribute: 1, setAttribute: 1, removeAttribute: 1, hasAttribute: 1,
  getAttributeNode: 1, setAttributeNode: 1,
  // Classes
  classList: 1,
  // Style
  style: 1,
  // Dataset
  dataset: 1,
  // Dimensions
  clientWidth: 1, clientHeight: 1, offsetWidth: 1, offsetHeight: 1,
  scrollWidth: 1, scrollHeight: 1, scrollLeft: 1, scrollTop: 1,
  getBoundingClientRect: 1,
  // Safe child access (children elements only, not document)
  children: 1, childNodes: 1, firstChild: 1, lastChild: 1,
  firstElementChild: 1, lastElementChild: 1,
  nextSibling: 1, previousSibling: 1, nextElementSibling: 1, previousElementSibling: 1,
  // Query methods
  querySelector: 1, querySelectorAll: 1,
  getElementsByTagName: 1, getElementsByClassName: 1,
  // Events
  addEventListener: 1, removeEventListener: 1, dispatchEvent: 1,
  // DOM manipulation
  appendChild: 1, removeChild: 1, insertBefore: 1, replaceChild: 1,
  remove: 1, cloneNode: 1,
  // Focus
  focus: 1, blur: 1,
  // Other safe props
  contains: 1, matches: 1, closest: 1
} as any;

/**
 * WeakMap to cache element membranes to avoid creating duplicate proxies
 */
const elementMembraneCache = new WeakMap<object, any>();

/**
 * Creates a security membrane around a DOM element ($el) using WHITE-LIST ONLY approach.
 *
 * CRITICAL SECURITY: Without this wrapper, expressions can escape to window:
 * {{ $el.ownerDocument.defaultView.alert('pwned') }}
 *
 * This wrapper ONLY allows properties in SAFE_DOM_PROPS.
 * Everything else (ownerDocument, parentNode, getRootNode, etc.) returns undefined.
 *
 * @param {Element} element - DOM element to wrap
 * @returns {Proxy} Proxied element with security enforcement
 */
export function createElementMembrane(element: any): any {
  // Don't wrap non-elements
  if (!element || typeof element !== 'object') {
    return element;
  }

  // Return cached membrane if it exists
  const cached = elementMembraneCache.get(element);
  if (cached) {
    return cached;
  }

  const membrane = new Proxy(element, {
    get(el, key) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // ONLY allow properties in the safe whitelist
      if (!SAFE_DOM_PROPS[keyStr]) {
        // Silently return undefined for non-whitelisted properties
        return undefined;
      }

      // Get the value
      const value = Reflect.get(el, key);

      // If it's a function, bind it to the original element
      if (typeof value === 'function') {
        return function(...args: any[]) {
          const result = value.apply(el, args);

          // Recursively wrap returned elements to maintain protection
          if (result && result instanceof Element) {
            return createElementMembrane(result);
          }

          // Wrap collections
          if (result instanceof HTMLCollection || result instanceof NodeList) {
            return new Proxy(result, {
              get(collection, idx) {
                const item = Reflect.get(collection, idx);
                if (item instanceof Element) {
                  return createElementMembrane(item);
                }
                return item;
              }
            });
          }

          return result;
        };
      }

      // Recursively wrap returned elements to maintain protection
      if (value && value instanceof Element) {
        return createElementMembrane(value);
      }

      // Wrap collections
      if (value instanceof HTMLCollection || value instanceof NodeList) {
        return new Proxy(value, {
          get(collection, idx) {
            const item = Reflect.get(collection, idx);
            if (item instanceof Element) {
              return createElementMembrane(item);
            }
            return item;
          }
        });
      }

      // For style, classList, dataset, etc., return directly (they're safe)
      return value;
    },

    set(el, key, value) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Only allow setting whitelisted properties
      if (!SAFE_DOM_PROPS[keyStr]) {
        throw new Error(
          `Reflex Security: Cannot set property "${keyStr}" on $el`
        );
      }

      return Reflect.set(el, key, value);
    },

    has(el, key) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Only show whitelisted properties
      return !!SAFE_DOM_PROPS[keyStr] && Reflect.has(el, key);
    }
  });

  // Cache the membrane
  elementMembraneCache.set(element, membrane);

  return membrane;
}
