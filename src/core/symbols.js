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
  __lookupSetter__: 1
});
UNSAFE_PROPS['__proto__'] = 1; // Must use bracket notation to avoid syntax error

// Dangerous URL protocols that could execute JavaScript
export const UNSAFE_URL_RE = /^\s*(javascript|vbscript|data):/i;

// Dangerous patterns in expressions that could bypass reserved word checks
// Matches ["constructor"], ['constructor'], [`constructor`], same for __proto__, and Function() calls
export const UNSAFE_EXPR_RE = /\[["'`]constructor["'`]\]|\[["'`]__proto__["'`]\]|\.constructor\s*\(|Function\s*\(/i;

// === REGEX PATTERNS ===
// Identifier extraction pattern for expression parsing
export const ID_RE = /(?:^|[^.\w$])([a-zA-Z_$][\w$]*)/g;
