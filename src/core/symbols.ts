/**
 * Reflex Core - Shared Symbols and Constants
 *
 * This module defines all internal symbols and constants used across the library.
 * Centralizing these prevents redeclaration conflicts and ensures consistency.
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

// Dangerous property names that could lead to prototype pollution
export const UNSAFE_PROPS = Object.assign(Object.create(null), {
  constructor: 1,
  prototype: 1,
  __defineGetter__: 1,
  __defineSetter__: 1,
  __lookupGetter__: 1,
  __lookupSetter__: 1,
  // CRITICAL SECURITY FIX: Block access to __rfx_app to prevent app state leak
  // Without this, templates can access the entire internal state via {{ $el.__rfx_app.s.secretToken }}
  __rfx_app: 1
});
UNSAFE_PROPS['__proto__'] = 1; // Must use bracket notation to avoid syntax error

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

// SECURITY WARNING: Regex-based validation CANNOT fully protect against malicious code.
// This provides basic defense-in-depth, but determined attackers can bypass regex.
// For production apps handling untrusted user input, use CSP-safe mode instead.
//
// PRIMARY SECURITY: The createMembrane() function (below) provides runtime enforcement
// via Proxy traps. This regex is DEFENSE-IN-DEPTH only - it catches obvious attacks
// at compile-time to fail fast, but the membrane is the real security boundary.
//
// Dangerous patterns in expressions that could bypass reserved word checks:
// - ["constructor"], ['constructor'], [`constructor`] - bracket notation access
// - .constructor() - direct constructor calls
// - Function() - Function constructor calls (use word boundary to avoid false positives)
// - String concatenation: "con" + "structor" or template literals
// - Computed property access: obj[variable] where variable = "constructor"
// - eval(), setTimeout(), setInterval() with string arguments
// - Indirect eval: (0,eval), window.eval, globalThis.eval
// - .bind, .call, .apply on Function
export const UNSAFE_EXPR_RE = /\[["'`]constructor["'`]\]|\[["'`]__proto__["'`]\]|\.constructor\s*\(|\bFunction\s*\(|\beval\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bimport\s*\(|[\+\-]\s*["'`]constructor|["'`]\s*\+\s*["'`]con|\(0\s*,\s*eval\)|globalThis|\.bind\s*\(|\.call\s*\(|\.apply\s*\(/i;

// === REGEX PATTERNS ===
// Identifier extraction pattern for expression parsing
export const ID_RE = /(?:^|[^.\w$])([a-zA-Z_$][\w$]*)/g;

// === SECURITY UTILITIES ===

/**
 * Normalize Unicode escapes in a string to detect bypass attempts.
 * JavaScript's `new Function()` parses \uXXXX and \xXX escapes AFTER
 * our regex check, so we need to decode them first.
 *
 * @param {string} str - Expression string to normalize
 * @returns {string} Normalized string with Unicode escapes decoded
 */
export function normalizeUnicodeEscapes(str: string): string {
  // Decode \uXXXX escapes (4 hex digits)
  let result = str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Decode \xXX escapes (2 hex digits)
  result = result.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Also handle Unicode escapes in template literals: \u{XXXXX}
  result = result.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  return result;
}

// === THE IRON MEMBRANE: Unbypassable Proxy Sandbox ===

/**
 * List of dangerous global properties that should be blocked
 * CRITICAL SECURITY FIX: Extended to include data exfiltration vectors
 * Without blocking these, expressions can access sensitive browser APIs:
 * - fetch, XMLHttpRequest: Send user data to attacker server
 * - localStorage, sessionStorage: Steal stored credentials
 * - indexedDB: Access persistent app data
 * - WebSocket: Establish persistent connection to attacker
 * - navigator: Fingerprint user's browser/device
 */
const DANGEROUS_GLOBALS = {
  __proto__: null,
  // Global object access
  global: 1,
  globalThis: 1,
  window: 1,
  self: 1,
  top: 1,
  parent: 1,
  frames: 1,
  // Code execution
  eval: 1,
  Function: 1,
  setTimeout: 1,
  setInterval: 1,
  setImmediate: 1,
  import: 1,
  // CRITICAL FIX #1: Reflection APIs that enable RCE
  // Reflect.construct can invoke Function constructor to bypass sandbox
  // Example exploit: {{ Reflect.construct(Function, ["alert(1)"])() }}
  Reflect: 1,
  // DOM access
  location: 1,
  document: 1,
  // Network/Storage APIs (data exfiltration vectors)
  fetch: 1,
  XMLHttpRequest: 1,
  WebSocket: 1,
  // CRITICAL FIX #10: Additional network APIs
  EventSource: 1,  // Server-Sent Events (data exfiltration)
  // Browser APIs
  navigator: 1,
  history: 1,
  screen: 1,
  // CRITICAL FIX #10: Additional exfiltration vectors
  sendBeacon: 1,   // Beacon API (data exfiltration)
  // Storage APIs
  localStorage: 1,
  sessionStorage: 1,
  indexedDB: 1,
  // Additional dangerous APIs
  requestAnimationFrame: 1,
  requestIdleCallback: 1,
  postMessage: 1,
  open: 1,
  close: 1,
  alert: 1,
  confirm: 1,
  prompt: 1,
  // CRITICAL FIX #10: Internationalization and WebAssembly
  // These can be used for side-channel attacks or code execution
  Intl: 1,         // Internationalization API (timing attacks)
  WebAssembly: 1,  // WebAssembly (arbitrary code execution)
  // CRITICAL FIX #10: Worker APIs
  importScripts: 1 // Worker importScripts (code execution in workers)
};

/**
 * Safe standard object/array methods that are allowed
 */
const SAFE_METHODS = {
  __proto__: null,
  // Array methods
  map: 1, filter: 1, reduce: 1, forEach: 1, find: 1, findIndex: 1, some: 1, every: 1,
  indexOf: 1, lastIndexOf: 1, includes: 1, slice: 1, concat: 1, join: 1, flat: 1, flatMap: 1,
  // String methods
  charAt: 1, charCodeAt: 1, substring: 1, substr: 1, toLowerCase: 1, toUpperCase: 1,
  trim: 1, trimStart: 1, trimEnd: 1, split: 1, replace: 1, replaceAll: 1, match: 1,
  search: 1, startsWith: 1, endsWith: 1, padStart: 1, padEnd: 1, repeat: 1,
  // Object methods
  toString: 1, valueOf: 1, hasOwnProperty: 1,
  // Number methods
  toFixed: 1, toPrecision: 1, toExponential: 1,
  // Date methods
  getTime: 1, getFullYear: 1, getMonth: 1, getDate: 1, getDay: 1,
  getHours: 1, getMinutes: 1, getSeconds: 1, getMilliseconds: 1,
  toISOString: 1, toLocaleDateString: 1, toLocaleTimeString: 1,
  // Common safe methods
  push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1,
  keys: 1, values: 1, entries: 1, get: 1, has: 1, set: 1, add: 1, delete: 1, clear: 1,
  // Length property
  length: 1
};

/**
 * WeakMap to cache membranes for objects to avoid creating duplicate proxies
 */
const membraneCache = new WeakMap<object, any>();

/**
 * Creates an unbypassable security membrane around an object using Proxy.
 * This replaces fragile regex validation with runtime enforcement.
 *
 * The membrane:
 * - Blocks access to dangerous properties (constructor, __proto__, prototype, global, etc.)
 * - Allows access to safe properties that exist in the target
 * - Allows safe standard methods (map, filter, etc.)
 * - Recursively wraps returned objects in the membrane
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
      // Convert symbol keys to strings for checking
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Get the value first to check its type
      const value = Reflect.get(obj, key);

      // CRITICAL DENY LIST: Block dangerous properties ONLY if they lead to exploitable objects
      // Allow constructor on built-in types (Array, String, etc.) but block on plain objects
      if (keyStr === 'constructor') {
        // Allow constructor on arrays and other built-in types
        if (Array.isArray(obj) || typeof obj === 'string' || obj instanceof String ||
            obj instanceof Number || obj instanceof Boolean || obj instanceof Date ||
            obj instanceof RegExp || obj instanceof Map || obj instanceof Set) {
          // Built-in types - allow constructor but wrap it to prevent chaining
          // CRITICAL FIX #2: Wrap built-in constructors to block .constructor chain
          // Without this, ({}).constructor.constructor("code")() bypasses the sandbox
          // Wrapping prevents access to the constructor's constructor property
          return createMembrane(value);
        }
        // Block constructor on plain objects and functions - this is the attack vector
        throw new Error(
          `Reflex Security: Access to property "constructor" is forbidden. ` +
          `This could lead to code injection or prototype pollution attacks.`
        );
      }

      // Block other dangerous proto-related properties
      if (keyStr === '__proto__' || keyStr === 'prototype' ||
          keyStr === '__defineGetter__' || keyStr === '__defineSetter__' ||
          keyStr === '__lookupGetter__' || keyStr === '__lookupSetter__') {
        throw new Error(
          `Reflex Security: Access to property "${keyStr}" is forbidden. ` +
          `This could lead to code injection or prototype pollution attacks.`
        );
      }

      // Check if property exists in the target
      const hasProperty = key in obj;

      // If property doesn't exist and isn't a safe method, return undefined
      if (!hasProperty && !SAFE_METHODS[keyStr]) {
        return undefined;
      }

      // CRITICAL FIX #2: Block dangerous global values even if accessed indirectly
      // Check the actual value, not just the property name
      // This blocks: obj.prop where prop's value is Function, even if prop is named "foo"
      if (value != null && typeof value === 'function') {
        // Check if this function IS a dangerous global constructor
        if (typeof globalThis !== 'undefined') {
          const dangerousFunctions = [
            Function, eval, setTimeout, setInterval, setImmediate,
            globalThis, typeof window !== 'undefined' ? window : null,
            typeof global !== 'undefined' ? global : null,
            Reflect, Intl, WebAssembly
          ].filter(f => f != null);

          if (dangerousFunctions.includes(value)) {
            throw new Error(
              `Reflex Security: Access to dangerous global function is forbidden. ` +
              `Property "${keyStr}" references a global constructor or function that could enable code execution.`
            );
          }
        }
      }

      // Block if the property NAME is a known dangerous global
      // Only block if it's actually the dangerous global, not just a property with that name
      if (value != null && DANGEROUS_GLOBALS[keyStr]) {
        // If it's actually a global object, block it
        if (typeof globalThis !== 'undefined' && (value === globalThis ||
            value === (typeof window !== 'undefined' ? window : null) ||
            value === (typeof global !== 'undefined' ? global : null) ||
            value === Function || value === eval ||
            value === setTimeout || value === setInterval ||
            value === Reflect || value === Intl || value === WebAssembly)) {
          throw new Error(
            `Reflex Security: Access to global "${keyStr}" is forbidden.`
          );
        }
      }

      // RECURSION: If the value is an object/function, wrap it in the membrane
      // This is critical to prevent chained property access attacks
      if (value != null && (typeof value === 'object' || typeof value === 'function')) {
        return createMembrane(value);
      }

      return value;
    },

    // CRITICAL SECURITY: The 'has' trap prevents dangerous global access in 'with' blocks.
    //
    // When using 'with(proxy) { someVar }', JavaScript checks has(proxy, 'someVar').
    // - If has() returns FALSE, JavaScript looks for 'someVar' in outer/global scope
    // - If has() returns TRUE, JavaScript calls get(proxy, 'someVar')
    //
    // Strategy:
    // 1. Return TRUE for properties that exist in the object (normal behavior)
    // 2. Return TRUE for unsafe properties to force them through 'get' where we block them
    // 3. Return FALSE for safe properties that don't exist (allow global scope lookup)
    has(obj, key) {
      // Special handling for Symbol.unscopables (used by with statement)
      if (key === Symbol.unscopables) {
        return Reflect.has(obj, key);
      }

      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // If property exists in object, return true (normal behavior)
      if (Reflect.has(obj, keyStr)) {
        return true;
      }

      // Block dangerous properties by returning true (forces 'get' trap where we throw)
      if (UNSAFE_PROPS[keyStr] || DANGEROUS_GLOBALS[keyStr]) {
        return true;
      }

      // Allow safe globals by returning false (allows outer scope lookup)
      return false;
    },

    // Block set trap to prevent prototype pollution via assignment
    set(obj, key, value) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);
      if (UNSAFE_PROPS[keyStr] || DANGEROUS_GLOBALS[keyStr]) {
        throw new Error(
          `Reflex Security: Cannot set property "${keyStr}". ` +
          `This could lead to code injection or prototype pollution attacks.`
        );
      }
      return Reflect.set(obj, key, value);
    },

    // Block defineProperty to prevent property descriptor manipulation
    defineProperty(obj, key, descriptor) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);
      if (UNSAFE_PROPS[keyStr] || DANGEROUS_GLOBALS[keyStr]) {
        throw new Error(
          `Reflex Security: Cannot define property "${keyStr}". ` +
          `This could lead to code injection or prototype pollution attacks.`
        );
      }
      return Reflect.defineProperty(obj, key, descriptor);
    },

    // Block deleteProperty to prevent removing security checks
    deleteProperty(obj, key) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);
      if (UNSAFE_PROPS[keyStr] || DANGEROUS_GLOBALS[keyStr]) {
        throw new Error(
          `Reflex Security: Cannot delete property "${keyStr}". ` +
          `This could lead to code injection or prototype pollution attacks.`
        );
      }
      return Reflect.deleteProperty(obj, key);
    },

    // Block getPrototypeOf to prevent prototype chain manipulation
    getPrototypeOf(obj) {
      // Return null to hide the prototype chain
      return null;
    },

    // Block setPrototypeOf to prevent prototype chain manipulation
    setPrototypeOf() {
      throw new Error(
        'Reflex Security: Cannot set prototype. ' +
        'This could lead to code injection or prototype pollution attacks.'
      );
    }
  });

  // Cache the membrane
  membraneCache.set(target, membrane);

  return membrane;
}

/**
 * Dangerous DOM properties that allow access to window/document/global scope
 * These must be blocked on $el to prevent sandbox escape
 */
const DANGEROUS_DOM_PROPS = {
  __proto__: null,
  // Access to document/window
  ownerDocument: 1,
  defaultView: 1,
  contentWindow: 1,
  contentDocument: 1,
  // Parent traversal (can reach document)
  parentNode: 1,
  parentElement: 1,
  getRootNode: 1,
  // Access to Reflex app instance
  __rfx_app: 1,
  // Network APIs
  fetch: 1,
  XMLHttpRequest: 1,
  WebSocket: 1,
  // Global scope
  window: 1,
  document: 1,
  globalThis: 1
};

/**
 * Safe DOM properties and methods that are allowed on $el
 */
const SAFE_DOM_PROPS = {
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
};

/**
 * WeakMap to cache element membranes to avoid creating duplicate proxies
 */
const elementMembraneCache = new WeakMap<object, any>();

/**
 * Creates a security membrane around a DOM element ($el) to prevent sandbox escape.
 *
 * CRITICAL SECURITY: The standard expression compiler passes $el raw to new Function(),
 * which allows access to ownerDocument.defaultView (window), enabling full RCE:
 * {{ $el.ownerDocument.defaultView.alert('pwned') }}
 *
 * This wrapper blocks dangerous DOM properties while allowing safe operations.
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

      // CRITICAL: Block dangerous DOM properties that lead to window/document
      if (DANGEROUS_DOM_PROPS[keyStr]) {
        if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
          console.error(
            `Reflex Security: Blocked access to dangerous $el property: ${keyStr}\n` +
            `This property can be used to escape the sandbox and access window/document.\n` +
            `Attack vector: {{ $el.${keyStr}... }}`
          );
        }
        return undefined;
      }

      // Block dangerous properties from UNSAFE_PROPS
      if (UNSAFE_PROPS[keyStr]) {
        if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
          console.error(
            `Reflex Security: Blocked access to unsafe property on $el: ${keyStr}`
          );
        }
        return undefined;
      }

      // Get the value
      const value = Reflect.get(el, key);

      // If it's a function, bind it to the original element
      if (typeof value === 'function') {
        return function(...args: any[]) {
          return value.apply(el, args);
        };
      }

      // Recursively wrap returned elements to maintain protection
      if (value && typeof value === 'object') {
        // If it's a DOM element or collection, wrap it
        if (value instanceof Element || value instanceof HTMLCollection || value instanceof NodeList) {
          // For collections, wrap each item
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
          // Single element
          return createElementMembrane(value);
        }
        // For style, classList, dataset, etc., wrap in basic membrane
        if (keyStr === 'style' || keyStr === 'classList' || keyStr === 'dataset') {
          return value; // These are safe to use directly
        }
      }

      return value;
    },

    set(el, key, value) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Block setting dangerous properties
      if (DANGEROUS_DOM_PROPS[keyStr] || UNSAFE_PROPS[keyStr]) {
        throw new Error(
          `Reflex Security: Cannot set dangerous property on $el: ${keyStr}`
        );
      }

      return Reflect.set(el, key, value);
    },

    has(el, key) {
      const keyStr = typeof key === 'symbol' ? key.toString() : String(key);

      // Hide dangerous properties from 'in' operator
      if (DANGEROUS_DOM_PROPS[keyStr] || UNSAFE_PROPS[keyStr]) {
        return false;
      }

      return Reflect.has(el, key);
    }
  });

  // Cache the membrane
  elementMembraneCache.set(element, membrane);

  return membrane;
}
