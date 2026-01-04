/**
 * Reflex CSP-Safe Expression Parser
 *
 * A recursive descent parser that evaluates expressions without using
 * `new Function()` or `eval()`, making it compliant with strict
 * Content Security Policy (CSP) environments.
 *
 * SECURITY MODEL: White-List Only
 *
 * This parser implements strict white-list security:
 * 1. ALLOWS: Own data properties (via hasOwnProperty)
 * 2. ALLOWS: Safe standard methods (from SAFE_METHODS whitelist)
 * 3. ALLOWS: Safe globals (Math, Date, Array, etc. from SAFE_GLOBALS)
 * 4. DENIES: Everything else (prototype chain, dangerous properties)
 *
 * This module is NOT bundled with the core Reflex library to reduce
 * bundle size. Only load this if you need CSP-safe mode.
 *
 * @example
 * import { SafeExprParser } from 'reflex/csp';
 * const app = new Reflex().configure({
 *   cspSafe: true,
 *   parser: new SafeExprParser()
 * });
 */

import { META, createElementMembrane } from '../core/symbols.js';
import {
  isFlatScope,
  getFlatScopeValue,
  type FlatScope
} from '../core/scope-registry.js';

// Symbol for identifying ScopeContainer instances
const SCOPE_CONTAINER_MARKER = Symbol.for('reflex.ScopeContainer');

// Prototype-related properties that should be blocked when setting in ScopeContainer
// NOTE: Cannot use object literal with __proto__ - it's special syntax, not a property
const SCOPE_PROTO_PROPS: { [key: string]: 1 } = Object.create(null);
SCOPE_PROTO_PROPS['constructor'] = 1;
SCOPE_PROTO_PROPS['__proto__'] = 1;
SCOPE_PROTO_PROPS['prototype'] = 1;

const isScopeProtoProperty = (k: string): boolean => {
  return SCOPE_PROTO_PROPS[k] === 1;
};

/**
 * ScopeContainer - Secure scope storage that prevents prototype pollution
 *
 * SECURITY CRITICAL:
 * This class replaces Object.create() for scope inheritance to prevent
 * prototype chain attacks. All scope data is stored in a Map, isolating
 * it from the JavaScript prototype chain.
 *
 * The returned object is a Proxy that intercepts property access,
 * allowing it to work with JavaScript's `with` statement while still
 * providing security guarantees.
 */
export interface ScopeContainerAPI {
  /** Check if a name exists in this scope or any parent scope */
  has(name: string): boolean;
  /** Get a value from this scope or any parent scope */
  get(name: string): any;
  /** Set a value in this scope (never writes to parent) */
  set(name: string, value: any): void;
  /** Delete a value from this scope */
  delete(name: string): boolean;
  /** Get all keys in this scope (not including parent) */
  keys(): IterableIterator<string>;
  /** Get the parent scope */
  getParent(): ScopeContainerAPI | null;
  /** Marker symbol access */
  readonly [key: symbol]: any;
}

// Type that combines the API with arbitrary property access
export type ScopeContainerInstance = ScopeContainerAPI & { [key: string]: any };

/**
 * ScopeContainer factory - creates a secure scope with Proxy-based property access
 *
 * The returned object is a Proxy that:
 * - Intercepts property gets/sets and delegates to internal Map
 * - Looks up parent scope for missing properties
 * - Uses WHITE-LIST ONLY approach - only serves from internal Map
 * - Works with JavaScript's `with` statement for expression evaluation
 */
export class ScopeContainer {
  // Private constructor - use ScopeContainer.create() or new ScopeContainer()
  private _data: Map<string, any>;
  private _parent: ScopeContainerInstance | null;

  constructor(parent: ScopeContainerInstance | null = null) {
    this._data = new Map();
    this._parent = parent;

    // Return a Proxy that intercepts property access
    // This allows the scope to work with JavaScript's `with` statement
    return new Proxy(this, {
      get(target, prop, receiver) {
        // Symbol access (including our marker)
        if (typeof prop === 'symbol') {
          if (prop === SCOPE_CONTAINER_MARKER) return true;
          return undefined;
        }

        // API methods
        if (prop === 'has') return target.has.bind(target);
        if (prop === 'get') return target.get.bind(target);
        if (prop === 'set') return target.set.bind(target);
        if (prop === 'delete') return target.delete.bind(target);
        if (prop === 'keys') return target.keys.bind(target);
        if (prop === 'getParent') return target.getParent.bind(target);

        // WHITE-LIST ONLY: Property lookup - check own data first, then parent chain
        // No prototype chain traversal, no dangerous property access
        if (target._data.has(prop)) {
          return target._data.get(prop);
        }
        if (target._parent) {
          // Parent is also a Proxy, so direct property access works
          return (target._parent as any)[prop];
        }

        // DENY: Everything not in internal data
        return undefined;
      },

      set(target, prop, value, receiver) {
        if (typeof prop === 'symbol') return false;

        // SECURITY: Block setting prototype-related properties
        if (isScopeProtoProperty(prop)) {
          throw new Error(`Cannot set dangerous property '${prop}' - prototype pollution attack blocked`);
        }

        // Store in internal Map (safe - no prototype pollution possible)
        target._data.set(prop, value);
        return true;
      },

      has(target, prop) {
        if (typeof prop === 'symbol') {
          return prop === SCOPE_CONTAINER_MARKER;
        }

        if (target._data.has(prop)) return true;
        if (target._parent) return prop in target._parent;
        return false;
      },

      deleteProperty(target, prop) {
        if (typeof prop === 'symbol') return false;
        return target._data.delete(prop);
      },

      ownKeys(target) {
        return [...target._data.keys()];
      },

      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (target._data.has(prop)) {
          return {
            value: target._data.get(prop),
            writable: true,
            enumerable: true,
            configurable: true
          };
        }
        return undefined;
      },

      // Block prototype manipulation
      setPrototypeOf(target, proto) {
        throw new Error(
          'Reflex Security: Cannot change prototype of ScopeContainer.'
        );
      },

      defineProperty(target, prop, descriptor) {
        if (typeof prop === 'symbol') return false;
        // SECURITY: Block defining prototype-related properties
        if (isScopeProtoProperty(prop)) {
          throw new Error(`Cannot define dangerous property '${prop}' - prototype pollution attack blocked`);
        }
        // Store in internal Map
        if ('value' in descriptor) {
          target._data.set(prop, descriptor.value);
        }
        return true;
      }
    }) as any;
  }

  /**
   * Check if a name exists in this scope or any parent scope
   */
  has(name: string): boolean {
    if (this._data.has(name)) return true;
    if (this._parent) return this._parent.has(name);
    return false;
  }

  /**
   * Get a value from this scope or any parent scope
   */
  get(name: string): any {
    if (this._data.has(name)) return this._data.get(name);
    if (this._parent) return this._parent.get(name);
    return undefined;
  }

  /**
   * Set a value in this scope (never writes to parent)
   */
  set(name: string, value: any): void {
    // SECURITY: Block setting prototype-related properties
    if (isScopeProtoProperty(name)) {
      throw new Error(`Cannot set dangerous property '${name}' - prototype pollution attack blocked`);
    }
    this._data.set(name, value);
  }

  /**
   * Delete a value from this scope
   */
  delete(name: string): boolean {
    return this._data.delete(name);
  }

  /**
   * Get all keys in this scope (not including parent)
   */
  keys(): IterableIterator<string> {
    return this._data.keys();
  }

  /**
   * Get the parent scope
   */
  getParent(): ScopeContainerInstance | null {
    return this._parent;
  }

  /**
   * Static method to check if an object is a ScopeContainer
   */
  static isScopeContainer(obj: any): obj is ScopeContainerInstance {
    return obj !== null &&
           typeof obj === 'object' &&
           obj[SCOPE_CONTAINER_MARKER] === true;
  }

  /**
   * Create a ScopeContainer from a plain object (migration helper)
   */
  static fromObject(obj: Record<string, any>, parent: ScopeContainerInstance | null = null): ScopeContainerInstance {
    const container = new ScopeContainer(parent) as ScopeContainerInstance;
    for (const key of Object.keys(obj)) {
      // SECURITY: Skip dangerous properties with dev warning
      if (isScopeProtoProperty(key)) {
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
          console.warn(`Reflex Security: Skipping dangerous property '${key}' in ScopeContainer.fromObject()`);
        }
        continue;
      }
      container.set(key, obj[key]);
    }
    return container;
  }
}

// Safe globals accessible in expressions (WHITE-LIST)
// CRITICAL FIX (Issue #6): Safe globals for expression evaluation
const SAFE_GLOBALS: { [key: string]: any } = {
  __proto__: null,
  Math, Date, Array, Number, String, Boolean, JSON,
  Promise, Symbol, BigInt, Map, Set, WeakMap, WeakSet, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
  true: true, false: false, null: null, undefined: undefined,
  // Console for logging (safe, read-only)
  console: typeof console !== 'undefined' ? console : undefined
};

// Create a safe Object wrapper that only exposes safe methods
const SAFE_OBJECT = {
  keys: Object.keys,
  values: Object.values,
  entries: Object.entries,
  fromEntries: Object.fromEntries,
  hasOwn: Object.hasOwn || ((obj: any, prop: string) => Object.prototype.hasOwnProperty.call(obj, prop)),
  is: Object.is
};

// Add safe Object to SAFE_GLOBALS
SAFE_GLOBALS['Object'] = SAFE_OBJECT;

// Safe methods whitelist for objects (same as in symbols.ts)
const SAFE_METHODS: { [key: string]: 1 } = {
  __proto__: null,
  // Array methods
  map: 1, filter: 1, reduce: 1, reduceRight: 1, forEach: 1, find: 1, findIndex: 1,
  findLast: 1, findLastIndex: 1, some: 1, every: 1, indexOf: 1, lastIndexOf: 1,
  includes: 1, slice: 1, concat: 1, join: 1, flat: 1, flatMap: 1, at: 1,
  toReversed: 1, toSorted: 1, toSpliced: 1, with: 1,
  push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1,
  // String methods
  charAt: 1, charCodeAt: 1, codePointAt: 1, substring: 1, substr: 1,
  toLowerCase: 1, toUpperCase: 1, toLocaleLowerCase: 1, toLocaleUpperCase: 1,
  trim: 1, trimStart: 1, trimEnd: 1, trimLeft: 1, trimRight: 1,
  split: 1, replace: 1, replaceAll: 1, match: 1, matchAll: 1,
  search: 1, startsWith: 1, endsWith: 1, padStart: 1, padEnd: 1, repeat: 1,
  normalize: 1, localeCompare: 1,
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
  toLocaleDateString: 1, toLocaleTimeString: 1,
  toDateString: 1, toTimeString: 1, toUTCString: 1,
  setTime: 1, setFullYear: 1, setMonth: 1, setDate: 1,
  setHours: 1, setMinutes: 1, setSeconds: 1, setMilliseconds: 1,
  setUTCFullYear: 1, setUTCMonth: 1, setUTCDate: 1,
  setUTCHours: 1, setUTCMinutes: 1, setUTCSeconds: 1, setUTCMilliseconds: 1,
  // Map/Set methods
  keys: 1, values: 1, entries: 1, get: 1, has: 1, set: 1, add: 1, delete: 1, clear: 1,
  // Promise methods (CRITICAL FIX: Issue #5 - Promises were unusable)
  then: 1, catch: 1, finally: 1,
  // RegExp methods
  test: 1, exec: 1,
  // Length property
  length: 1
} as any;

/**
 * Safe Accessor Properties - getters/setters that are safe to access.
 * These are typically on prototypes and return primitive values or safe objects.
 */
const SAFE_ACCESSORS: { [key: string]: 1 } = {
  __proto__: null,
  // Map/Set size property (getter on prototype)
  size: 1
} as any;

/**
 * CRITICAL FIX (Audit Issue #5): Safe DOM Properties for Assignment
 *
 * DOM element properties like `value`, `checked`, `textContent` are inherited
 * from prototypes (HTMLInputElement.prototype, etc.), not own properties.
 * The strict hasOwnProperty check was blocking standard DOM interactivity:
 *   @click="$el.value = ''"        // Failed: value not own property
 *   @input="user.name = $el.value" // Failed: can't read $el.value
 *
 * This whitelist allows assignment to these standard DOM properties while
 * still blocking dangerous prototype chain properties.
 *
 * Security considerations:
 * - innerHTML is included but MUST be used with DOMPurify sanitization
 * - outerHTML is intentionally excluded (can replace entire elements)
 * - Dangerous properties (__proto__, constructor, prototype) are still blocked
 */
const SAFE_DOM_PROPERTIES: { [key: string]: 1 } = {
  __proto__: null,

  // Form element properties (HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement)
  value: 1,
  checked: 1,
  selected: 1,
  disabled: 1,
  readOnly: 1,
  required: 1,
  multiple: 1,
  placeholder: 1,
  min: 1,
  max: 1,
  step: 1,
  pattern: 1,
  maxLength: 1,
  minLength: 1,
  selectionStart: 1,
  selectionEnd: 1,
  defaultValue: 1,
  defaultChecked: 1,
  indeterminate: 1,

  // Content properties (safe for assignment)
  textContent: 1,
  innerText: 1,
  // SECURITY FIX (Issue #3): innerHTML and outerHTML removed to prevent XSS
  // Users were bypassing sanitization with: <button @click="$el.innerHTML = '<img src=x onerror=alert(1)>'">
  // These properties are now strictly blocked in assignment operations

  // Attributes that are commonly set
  id: 1,
  name: 1,
  title: 1,
  lang: 1,
  dir: 1,
  tabIndex: 1,
  accessKey: 1,
  draggable: 1,
  hidden: 1,
  contentEditable: 1,
  spellcheck: 1,

  // Style and class
  className: 1,
  classList: 1,  // For classList.add/remove/toggle

  // Dataset (data-* attributes)
  dataset: 1,

  // Media elements
  src: 1,
  href: 1,
  currentTime: 1,
  volume: 1,
  muted: 1,
  playbackRate: 1,
  autoplay: 1,
  loop: 1,
  controls: 1,
  poster: 1,

  // Canvas
  width: 1,
  height: 1,

  // Scroll properties
  scrollTop: 1,
  scrollLeft: 1,

  // Focus management
  autofocus: 1
} as any;

/**
 * CSP-Safe Expression Parser
 *
 * Implements a recursive descent parser supporting:
 * - Literals: strings, numbers, booleans, null, undefined
 * - Identifiers with context/state lookup
 * - Property access: dot notation and bracket notation
 * - Function calls with arguments
 * - Binary operators: +, -, *, /, %, ==, ===, !=, !==, <, >, <=, >=, &&, ||, ??, in
 * - Unary operators: !, -, typeof
 * - Ternary operator: condition ? then : else
 * - Array literals: [a, b, c]
 * - Object literals: { key: value }
 * - Magic properties: $event, $el, $refs, $dispatch, $nextTick
 */
// CRITICAL SECURITY: Maximum recursion depth to prevent stack overflow DoS
const MAX_RECURSION_DEPTH = 50;

export class SafeExprParser {
  declare pos: number;
  declare expr: string;
  declare depth: number;

  constructor() {
    this.pos = 0;
    this.expr = '';
    this.depth = 0;
  }

  /**
   * Compile an expression to an evaluator function.
   *
   * @param {string} exp - Expression string
   * @param {Reflex} reflex - Reflex instance (for _tk, _mf, _refs, etc.)
   * @returns {Function} Evaluator (state, context, $event, $el) => result
   */
  compile(exp: string, reflex: any) {
    const ast = this.parse(exp);
    return (state: any, context: any, $event: any, $el: any) => {
      try {
        return this._evaluate(ast, state, context, $event, $el, reflex);
      } catch (err: any) {
        // CRITICAL SECURITY: Rethrow security violations instead of swallowing them
        if (err instanceof TypeError && err.message && err.message.includes('Reflex Security:')) {
          throw err;
        }
        console.warn('Reflex: Expression evaluation error:', exp, err);
        return undefined;
      }
    };
  }

  /**
   * Parse an expression into an AST.
   */
  parse(expr: string) {
    this.expr = expr.trim();
    this.pos = 0;
    this.depth = 0;
    return this.parseExpression();
  }

  parseExpression(): any {
    // CRITICAL SECURITY: Prevent stack overflow DoS via deeply nested expressions
    if (++this.depth > MAX_RECURSION_DEPTH) {
      throw new Error(
        `Reflex Security: Expression exceeds maximum nesting depth (${MAX_RECURSION_DEPTH}).`
      );
    }
    try {
      return this.parseAssignment();
    } finally {
      this.depth--;
    }
  }

  // CRITICAL FIX (Audit Issue #2): Assignment Expression Support
  // Without this, interactive expressions like @click="count = 5" fail with "Unexpected token"
  // Assignment has lower precedence than ternary, so we parse it first
  parseAssignment(): any {
    const left = this.parseTernary();
    this.skipWhitespace();

    // Check for assignment operators: =, +=, -=, *=, /=, %=
    const assignOps = ['+=', '-=', '*=', '/=', '%=', '='];
    for (const op of assignOps) {
      if (this.matchStr(op)) {
        const right = this.parseAssignment(); // Right-associative
        return { type: 'assignment', op, left, right };
      }
    }

    return left;
  }

  parseTernary(): any {
    const condition = this.parseOr();
    this.skipWhitespace();
    if (this.peek() === '?') {
      this.pos++;
      this.skipWhitespace();
      const consequent = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ':') throw new Error("Expected ':' in ternary");
      this.pos++;
      this.skipWhitespace();
      const alternate = this.parseExpression();
      return { type: 'ternary', condition, consequent, alternate };
    }
    return condition;
  }

  parseOr(): any {
    let left = this.parseAnd();
    while (this.matchStr('||')) {
      left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd(): any {
    let left = this.parseNullishCoalescing();
    while (this.matchStr('&&')) {
      left = { type: 'binary', op: '&&', left, right: this.parseNullishCoalescing() };
    }
    return left;
  }

  parseNullishCoalescing(): any {
    let left = this.parseEquality();
    while (this.matchStr('??')) {
      left = { type: 'binary', op: '??', left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality(): any {
    let left = this.parseRelational();
    while (true) {
      this.skipWhitespace();
      if (this.matchStr('===')) left = { type: 'binary', op: '===', left, right: this.parseRelational() };
      else if (this.matchStr('!==')) left = { type: 'binary', op: '!==', left, right: this.parseRelational() };
      else if (this.matchStr('==')) left = { type: 'binary', op: '==', left, right: this.parseRelational() };
      else if (this.matchStr('!=')) left = { type: 'binary', op: '!=', left, right: this.parseRelational() };
      else break;
    }
    return left;
  }

  parseRelational(): any {
    let left = this.parseComparison();
    while (true) {
      this.skipWhitespace();
      if (this.matchStr('in ') || (this.matchStr('in') && (this.peek() === '(' || this.peek() === '[' || this.peek() === '{' || !this.isIdentPart(this.peek())))) {
        left = { type: 'binary', op: 'in', left, right: this.parseComparison() };
      } else break;
    }
    return left;
  }

  parseComparison(): any {
    let left = this.parseAdditive();
    while (true) {
      this.skipWhitespace();
      if (this.matchStr('<=')) left = { type: 'binary', op: '<=', left, right: this.parseAdditive() };
      else if (this.matchStr('>=')) left = { type: 'binary', op: '>=', left, right: this.parseAdditive() };
      else if (this.peek() === '<' && this.expr[this.pos + 1] !== '<') {
        this.pos++;
        left = { type: 'binary', op: '<', left, right: this.parseAdditive() };
      } else if (this.peek() === '>' && this.expr[this.pos + 1] !== '>') {
        this.pos++;
        left = { type: 'binary', op: '>', left, right: this.parseAdditive() };
      } else break;
    }
    return left;
  }

  parseAdditive(): any {
    let left = this.parseMultiplicative();
    while (true) {
      this.skipWhitespace();
      if (this.peek() === '+') {
        this.pos++;
        left = { type: 'binary', op: '+', left, right: this.parseMultiplicative() };
      } else if (this.peek() === '-') {
        this.pos++;
        left = { type: 'binary', op: '-', left, right: this.parseMultiplicative() };
      } else break;
    }
    return left;
  }

  parseMultiplicative(): any {
    let left = this.parseUnary();
    while (true) {
      this.skipWhitespace();
      if (this.peek() === '*') {
        this.pos++;
        left = { type: 'binary', op: '*', left, right: this.parseUnary() };
      } else if (this.peek() === '/') {
        this.pos++;
        left = { type: 'binary', op: '/', left, right: this.parseUnary() };
      } else if (this.peek() === '%') {
        this.pos++;
        left = { type: 'binary', op: '%', left, right: this.parseUnary() };
      } else break;
    }
    return left;
  }

  parseUnary(): any {
    this.skipWhitespace();
    if (this.peek() === '!') {
      this.pos++;
      return { type: 'unary', op: '!', arg: this.parseUnary() };
    }
    if (this.peek() === '-' && !this.isDigit(this.expr[this.pos + 1])) {
      this.pos++;
      return { type: 'unary', op: '-', arg: this.parseUnary() };
    }
    if (this.peek() === '+' && !this.isDigit(this.expr[this.pos + 1])) {
      this.pos++;
      return { type: 'unary', op: '+', arg: this.parseUnary() };
    }
    if (this.matchStr('typeof ')) {
      return { type: 'unary', op: 'typeof', arg: this.parseUnary() };
    }

    // CRITICAL FIX (Audit Issue #2): Prefix Update Expressions (++count, --index)
    // Without this, @click="++count" fails with parse error
    if (this.matchStr('++')) {
      return { type: 'update', op: '++', arg: this.parseUnary(), prefix: true };
    }
    if (this.matchStr('--')) {
      return { type: 'update', op: '--', arg: this.parseUnary(), prefix: true };
    }

    return this.parsePostfix();
  }

  parsePostfix(): any {
    let obj = this.parsePrimary();
    while (true) {
      this.skipWhitespace();
      if (this.peek() === '.') {
        this.pos++;
        this.skipWhitespace();
        const prop = this.parseIdentifier();
        if (!prop) throw new Error("Expected property name after '.'");
        obj = { type: 'member', object: obj, property: prop, computed: false };
      } else if (this.peek() === '[') {
        this.pos++;
        const prop = this.parseExpression();
        this.skipWhitespace();
        if (this.peek() !== ']') throw new Error("Expected ']'");
        this.pos++;
        obj = { type: 'member', object: obj, property: prop, computed: true };
      } else if (this.peek() === '(') {
        this.pos++;
        const args = this.parseArguments();
        obj = { type: 'call', callee: obj, arguments: args };
      } else if (this.matchStr('++')) {
        // CRITICAL FIX (Audit Issue #2): Postfix Update Expression (count++)
        // Without this, @click="count++" fails with parse error
        obj = { type: 'update', op: '++', arg: obj, prefix: false };
      } else if (this.matchStr('--')) {
        // CRITICAL FIX (Audit Issue #2): Postfix Update Expression (count--)
        obj = { type: 'update', op: '--', arg: obj, prefix: false };
      } else {
        break;
      }
    }
    return obj;
  }

  parseArguments(): any[] {
    const args: any[] = [];
    this.skipWhitespace();
    if (this.peek() !== ')') {
      args.push(this.parseExpression());
      while (this.peek() === ',') {
        this.pos++;
        args.push(this.parseExpression());
      }
    }
    if (this.peek() !== ')') throw new Error("Expected ')'");
    this.pos++;
    return args;
  }

  parsePrimary(): any {
    this.skipWhitespace();
    const c = this.peek();

    // Parenthesized expression
    if (c === '(') {
      this.pos++;
      const expr = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ')') throw new Error("Expected ')'");
      this.pos++;
      return expr;
    }

    // Array literal
    if (c === '[') {
      this.pos++;
      const elements: any[] = [];
      this.skipWhitespace();
      if (this.peek() !== ']') {
        elements.push(this.parseExpression());
        while (this.peek() === ',') {
          this.pos++;
          this.skipWhitespace();
          if (this.peek() === ']') break;
          elements.push(this.parseExpression());
        }
      }
      if (this.peek() !== ']') throw new Error("Expected ']'");
      this.pos++;
      return { type: 'array', elements };
    }

    // Object literal
    if (c === '{') {
      this.pos++;
      const properties: any[] = [];
      this.skipWhitespace();
      if (this.peek() !== '}') {
        properties.push(this.parseObjectProperty());
        while (this.peek() === ',') {
          this.pos++;
          this.skipWhitespace();
          if (this.peek() === '}') break;
          properties.push(this.parseObjectProperty());
        }
      }
      if (this.peek() !== '}') throw new Error("Expected '}'");
      this.pos++;
      return { type: 'object', properties };
    }

    // String literal
    if (c === '"' || c === "'" || c === '`') {
      return this.parseString();
    }

    // Number literal
    if (this.isDigit(c) || (c === '-' && this.isDigit(this.expr[this.pos + 1]))) {
      return this.parseNumber();
    }

    // Identifier or keyword
    const id = this.parseIdentifier();
    if (id) {
      if (id === 'true') return { type: 'literal', value: true };
      if (id === 'false') return { type: 'literal', value: false };
      if (id === 'null') return { type: 'literal', value: null };
      if (id === 'undefined') return { type: 'literal', value: undefined };
      if (id === 'NaN') return { type: 'literal', value: NaN };
      if (id === 'Infinity') return { type: 'literal', value: Infinity };
      return { type: 'identifier', name: id };
    }

    throw new Error('Unexpected token: ' + c);
  }

  parseObjectProperty(): any {
    this.skipWhitespace();
    let key;
    if (this.peek() === '"' || this.peek() === "'") {
      key = this.parseString().value;
    } else if (this.peek() === '[') {
      this.pos++;
      key = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ']') throw new Error("Expected ']'");
      this.pos++;
      this.skipWhitespace();
      if (this.peek() !== ':') throw new Error("Expected ':'");
      this.pos++;
      const value = this.parseExpression();
      return { computed: true, key, value };
    } else {
      key = this.parseIdentifier();
    }
    this.skipWhitespace();
    if (this.peek() === ':') {
      this.pos++;
      const value = this.parseExpression();
      return { computed: false, key, value };
    }
    // Shorthand property
    return { computed: false, key, value: { type: 'identifier', name: key }, shorthand: true };
  }

  parseString(): any {
    const quote = this.peek();
    this.pos++;
    let value = '';
    while (this.pos < this.expr.length && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.pos++;
        const esc = this.peek();
        if (esc === 'n') value += '\n';
        else if (esc === 't') value += '\t';
        else if (esc === 'r') value += '\r';
        else if (esc === '\\') value += '\\';
        else if (esc === quote) value += quote;
        else value += esc;
        this.pos++;
      } else {
        value += this.peek();
        this.pos++;
      }
    }
    if (this.peek() !== quote) throw new Error('Unterminated string');
    this.pos++;
    return { type: 'literal', value };
  }

  parseNumber(): any {
    let num = '';
    if (this.peek() === '-') { num += '-'; this.pos++; }
    while (this.isDigit(this.peek())) { num += this.peek(); this.pos++; }
    if (this.peek() === '.') {
      num += '.'; this.pos++;
      while (this.isDigit(this.peek())) { num += this.peek(); this.pos++; }
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      num += this.peek(); this.pos++;
      if (this.peek() === '+' || this.peek() === '-') { num += this.peek(); this.pos++; }
      while (this.isDigit(this.peek())) { num += this.peek(); this.pos++; }
    }
    return { type: 'literal', value: parseFloat(num) };
  }

  parseIdentifier(): string | null {
    const start = this.pos;
    if (!this.isIdentStart(this.peek())) return null;
    while (this.isIdentPart(this.peek())) this.pos++;
    return this.expr.slice(start, this.pos);
  }

  skipWhitespace(): void {
    while (this.pos < this.expr.length && /\s/.test(this.peek())) this.pos++;
  }

  peek(): string { return this.expr[this.pos]; }

  matchStr(s: string): boolean {
    this.skipWhitespace();
    if (this.expr.slice(this.pos, this.pos + s.length) === s) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  isDigit(c: string): boolean { return c >= '0' && c <= '9'; }

  isIdentStart(c: string): boolean {
    if (!c) return false;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
      return true;
    }
    return /[\p{ID_Start}$_]/u.test(c);
  }

  isIdentPart(c: string): boolean {
    if (!c) return false;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$') {
      return true;
    }
    return /[\p{ID_Continue}$\u200c\u200d]/u.test(c);
  }

  /**
   * Evaluate an AST node using WHITE-LIST ONLY security model.
   */
  _evaluate(node: any, state: any, context: any, $event: any, $el: any, reflex: any): any {
    if (!node) return undefined;

    switch (node.type) {
      case 'literal':
        return node.value;

      case 'identifier': {
        const name = node.name;

        // Magic properties
        if (name === '$event') return $event;
        if (name === '$el') return createElementMembrane($el);
        if (name === '$refs') return reflex._refs;
        if (name === '$dispatch') return reflex._dispatch.bind(reflex);
        if (name === '$nextTick') return reflex.nextTick.bind(reflex);

        // Context Lookup (FlatScope, ScopeContainer, or Reactive Proxy)
        if (context) {
          if (isFlatScope(context)) {
            const result = getFlatScopeValue(context, name);
            if (result.found) {
              const value = result.value;
              if (value !== null && typeof value === 'object') {
                const meta = value[META] || reflex._mf.get(value);
                if (meta) reflex.trackDependency(meta, name);
              }
              return value;
            }
          } else if (ScopeContainer.isScopeContainer(context)) {
            if (context.has(name)) {
              const value = context.get(name);
              if (value !== null && typeof value === 'object') {
                const meta = value[META] || reflex._mf.get(value);
                if (meta) reflex.trackDependency(meta, name);
              }
              return value;
            }
          } else if (context[META] || reflex._mf.get(context)) {
            // CRITICAL FIX (Audit Issue #5): Support reactive proxies as context
            // Components create scopes via this._r(scopeRaw) which returns a reactive proxy.
            // Previously, this would throw a security error because reactive proxies
            // are neither FlatScope nor ScopeContainer. Now we detect reactive proxies
            // by checking for META symbol and look up properties directly on the proxy.
            // Security is maintained because:
            // 1. The reactive proxy's get trap enforces own-property checks
            // 2. Prototype-related properties are blocked by the proxy handlers
            if (Object.prototype.hasOwnProperty.call(context, name)) {
              const value = context[name];
              if (value !== null && typeof value === 'object') {
                const meta = value[META] || reflex._mf.get(value);
                if (meta) reflex.trackDependency(meta, name);
              }
              // Track dependency on the context itself for reactivity
              const contextMeta = context[META] || reflex._mf.get(context);
              if (contextMeta) reflex.trackDependency(contextMeta, name);
              return value;
            }
          } else if (typeof context === 'object' && Object.keys(context).length === 0) {
            // Allow empty plain objects as equivalent to no context
          } else {
            throw new TypeError(
              `Reflex Security: BREAKING CHANGE - Context must be a FlatScope, ScopeContainer, ` +
              `or reactive proxy. Plain objects are no longer allowed for security reasons.`
            );
          }
        }

        // State Lookup (Only Own Properties - WHITE-LIST approach)
        if (state && Object.prototype.hasOwnProperty.call(state, name)) {
          return state[name];
        }

        // Global Lookup (Strict Whitelist Only)
        if (Object.prototype.hasOwnProperty.call(SAFE_GLOBALS, name)) {
          return SAFE_GLOBALS[name];
        }

        // Default: Undefined (Safe)
        return undefined;
      }

      case 'member': {
        const obj = this._evaluate(node.object, state, context, $event, $el, reflex);
        if (obj == null) return undefined;
        const prop = node.computed
          ? this._evaluate(node.property, state, context, $event, $el, reflex)
          : node.property;

        // WHITE-LIST ONLY: Check if property is own, safe method, safe accessor, or safe DOM property
        // This blocks prototype chain traversal implicitly
        // CRITICAL FIX (Audit Issue #5): Include SAFE_DOM_PROPERTIES to allow DOM interactivity
        if (!Object.prototype.hasOwnProperty.call(obj, prop) &&
            !SAFE_METHODS[prop] &&
            !SAFE_ACCESSORS[prop] &&
            !SAFE_DOM_PROPERTIES[prop]) {
          return undefined;
        }

        const meta = obj[META] || reflex._mf.get(obj);
        if (meta) reflex.trackDependency(meta, prop);
        return obj[prop];
      }

      case 'call': {
        let callee, thisArg;
        if (node.callee.type === 'member') {
          thisArg = this._evaluate(node.callee.object, state, context, $event, $el, reflex);
          if (thisArg == null) return undefined;
          const prop = node.callee.computed
            ? this._evaluate(node.callee.property, state, context, $event, $el, reflex)
            : node.callee.property;

          // WHITE-LIST ONLY: Only allow own properties, safe methods, safe accessors, or safe DOM properties
          // CRITICAL FIX (Audit Issue #5): Include SAFE_DOM_PROPERTIES for DOM method calls
          if (!Object.prototype.hasOwnProperty.call(thisArg, prop) &&
              !SAFE_METHODS[prop] &&
              !SAFE_ACCESSORS[prop] &&
              !SAFE_DOM_PROPERTIES[prop]) {
            return undefined;
          }

          callee = thisArg[prop];
        } else {
          callee = this._evaluate(node.callee, state, context, $event, $el, reflex);
          thisArg = undefined;
        }
        if (typeof callee !== 'function') return undefined;
        const args = node.arguments.map((a: any) => this._evaluate(a, state, context, $event, $el, reflex));

        const result = callee.apply(thisArg, args);

        // Wrap returned objects in a protective membrane
        if (result !== null && typeof result === 'object') {
          return this._wrapResult(result);
        }

        return result;
      }

      case 'binary': {
        const left = () => this._evaluate(node.left, state, context, $event, $el, reflex);
        const right = () => this._evaluate(node.right, state, context, $event, $el, reflex);
        switch (node.op) {
          case '+': return left() + right();
          case '-': return left() - right();
          case '*': return left() * right();
          case '/': return left() / right();
          case '%': return left() % right();
          case '===': return left() === right();
          case '!==': return left() !== right();
          case '==': return left() == right();
          case '!=': return left() != right();
          case '<': return left() < right();
          case '>': return left() > right();
          case '<=': return left() <= right();
          case '>=': return left() >= right();
          case '&&': return left() && right();
          case '||': return left() || right();
          case '??': { const l = left(); return l != null ? l : right(); }
          case 'in': {
            const prop = left();
            const obj = right();
            if (obj == null || typeof obj !== 'object') return false;
            // WHITE-LIST: Only check own properties, not prototype chain
            return Object.prototype.hasOwnProperty.call(obj, prop);
          }
          default: return undefined;
        }
      }

      case 'unary': {
        const arg = this._evaluate(node.arg, state, context, $event, $el, reflex);
        switch (node.op) {
          case '!': return !arg;
          case '-': return -arg;
          case '+': return +arg;
          case 'typeof': return typeof arg;
          default: return undefined;
        }
      }

      case 'ternary': {
        const cond = this._evaluate(node.condition, state, context, $event, $el, reflex);
        return cond
          ? this._evaluate(node.consequent, state, context, $event, $el, reflex)
          : this._evaluate(node.alternate, state, context, $event, $el, reflex);
      }

      case 'array':
        return node.elements.map((e: any) => this._evaluate(e, state, context, $event, $el, reflex));

      case 'object': {
        const obj: { [key: string]: any } = {};
        for (const prop of node.properties) {
          const key = prop.computed
            ? this._evaluate(prop.key, state, context, $event, $el, reflex)
            : prop.key;
          // CRITICAL FIX (Audit Issue #2): Prevent prototype pollution via computed keys
          // Even though object literals seem "safe by construction", computed keys like
          // { ["__proto__"]: { polluted: true } } can pollute the created object's prototype
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            throw new Error(`Reflex Security: Prototype pollution via object literal key '${key}'`);
          }
          obj[key] = this._evaluate(prop.value, state, context, $event, $el, reflex);
        }
        return obj;
      }

      case 'assignment': {
        // CRITICAL FIX (Audit Issue #2): Assignment Expression Evaluation
        // Supports: count = 5, count += 3, user.name = 'Bob'
        // SECURITY: Only allow assignment to own properties (WHITE-LIST ONLY)
        const rightValue = this._evaluate(node.right, state, context, $event, $el, reflex);

        if (node.left.type === 'identifier') {
          // Simple identifier assignment: count = 5
          const name = node.left.name;

          // SECURITY: Cannot assign to magic properties
          if (name.startsWith('$')) {
            throw new Error(`Reflex Security: Cannot assign to magic property '${name}'`);
          }

          // Resolve target: context first, then state
          let target = null;
          if (context) {
            if (isFlatScope(context)) {
              const result = getFlatScopeValue(context, name);
              if (result.found) {
                target = context;
              }
            } else if (ScopeContainer.isScopeContainer(context)) {
              if (context.has(name)) {
                target = context;
              }
            } else if (context[META] || reflex._mf.get(context)) {
              // CRITICAL FIX (Audit Issue #5): Support reactive proxies as context
              // Components create scopes via this._r(scopeRaw) which returns a reactive proxy
              if (Object.prototype.hasOwnProperty.call(context, name)) {
                target = context;
              }
            }
          }
          if (!target && state && Object.prototype.hasOwnProperty.call(state, name)) {
            target = state;
          }
          if (!target) {
            // Create in state if not found (similar to JavaScript semantics)
            target = state || context;
          }

          // Apply assignment operator
          if (node.op === '=') {
            target[name] = rightValue;
          } else if (node.op === '+=') {
            target[name] = (target[name] || 0) + rightValue;
          } else if (node.op === '-=') {
            target[name] = (target[name] || 0) - rightValue;
          } else if (node.op === '*=') {
            target[name] = (target[name] || 0) * rightValue;
          } else if (node.op === '/=') {
            target[name] = (target[name] || 0) / rightValue;
          } else if (node.op === '%=') {
            target[name] = (target[name] || 0) % rightValue;
          }
          return target[name];
        } else if (node.left.type === 'member') {
          // Member assignment: user.name = 'Bob', arr[0] = 5
          const obj = this._evaluate(node.left.object, state, context, $event, $el, reflex);
          if (obj == null) {
            throw new Error('Reflex: Cannot set property on null or undefined');
          }

          const prop = node.left.computed
            ? this._evaluate(node.left.property, state, context, $event, $el, reflex)
            : node.left.property;

          // CRITICAL FIX (Audit Issue #3): Enforce whitelist for inherited properties
          // The previous logic only blocked __proto__/constructor/prototype but allowed
          // assignment to ANY other inherited property (e.g., toString, valueOf, DOM methods).
          // This contradicts the strict whitelist used in the 'get' trap.
          // Now: inherited properties must be in SAFE_DOM_PROPERTIES to allow assignment.

          // SECURITY FIX (Issue #3): Explicitly block innerHTML/outerHTML assignments
          // Prevent XSS bypass: <button @click="$el.innerHTML = '<img src=x onerror=alert(1)>'">
          if (typeof prop === 'string' && (prop === 'innerHTML' || prop === 'outerHTML')) {
            throw new Error(
              `Reflex Security: Cannot assign to '${prop}' - XSS risk. ` +
              `Use m-html directive with SafeHTML.sanitize() instead.`
            );
          }

          if (!Object.prototype.hasOwnProperty.call(obj, prop)) {
            // For non-own properties, check the whitelist
            if (typeof prop === 'string') {
              // Always block dangerous prototype properties
              if (prop === '__proto__' || prop === 'constructor' || prop === 'prototype') {
                throw new Error(`Reflex Security: Cannot assign to dangerous property '${prop}'`);
              }
              // For inherited properties, only allow if in SAFE_DOM_PROPERTIES whitelist
              // This aligns assignment behavior with the strict read behavior
              if (!SAFE_DOM_PROPERTIES[prop]) {
                throw new Error(`Reflex Security: Cannot assign to non-whitelisted inherited property '${prop}'`);
              }
            }
          }

          // Apply assignment operator
          if (node.op === '=') {
            obj[prop] = rightValue;
          } else if (node.op === '+=') {
            obj[prop] = (obj[prop] || 0) + rightValue;
          } else if (node.op === '-=') {
            obj[prop] = (obj[prop] || 0) - rightValue;
          } else if (node.op === '*=') {
            obj[prop] = (obj[prop] || 0) * rightValue;
          } else if (node.op === '/=') {
            obj[prop] = (obj[prop] || 0) / rightValue;
          } else if (node.op === '%=') {
            obj[prop] = (obj[prop] || 0) % rightValue;
          }
          return obj[prop];
        } else {
          throw new Error('Reflex: Invalid assignment target');
        }
      }

      case 'update': {
        // CRITICAL FIX (Audit Issue #2): Update Expression Evaluation
        // Supports: count++, ++count, index--, --index
        // SECURITY: Only allow update on own properties (WHITE-LIST ONLY)
        if (node.arg.type === 'identifier') {
          // Simple identifier update: count++
          const name = node.arg.name;

          // SECURITY: Cannot update magic properties
          if (name.startsWith('$')) {
            throw new Error(`Reflex Security: Cannot update magic property '${name}'`);
          }

          // Resolve target: context first, then state
          let target = null;
          if (context) {
            if (isFlatScope(context)) {
              const result = getFlatScopeValue(context, name);
              if (result.found) {
                target = context;
              }
            } else if (ScopeContainer.isScopeContainer(context)) {
              if (context.has(name)) {
                target = context;
              }
            } else if (context[META] || reflex._mf.get(context)) {
              // CRITICAL FIX (Audit Issue #5): Support reactive proxies as context
              // Components create scopes via this._r(scopeRaw) which returns a reactive proxy
              if (Object.prototype.hasOwnProperty.call(context, name)) {
                target = context;
              }
            }
          }
          if (!target && state && Object.prototype.hasOwnProperty.call(state, name)) {
            target = state;
          }
          if (!target) {
            // Create in state if not found (initialized to 0 for ++ and --)
            target = state || context;
            target[name] = 0;
          }

          const oldValue = target[name] || 0;
          if (node.op === '++') {
            target[name] = oldValue + 1;
          } else if (node.op === '--') {
            target[name] = oldValue - 1;
          }

          // Return old value for postfix, new value for prefix
          return node.prefix ? target[name] : oldValue;
        } else if (node.arg.type === 'member') {
          // Member update: obj.count++, arr[0]--
          const obj = this._evaluate(node.arg.object, state, context, $event, $el, reflex);
          if (obj == null) {
            throw new Error('Reflex: Cannot update property on null or undefined');
          }

          const prop = node.arg.computed
            ? this._evaluate(node.arg.property, state, context, $event, $el, reflex)
            : node.arg.property;

          // SECURITY: Only allow update on own properties (WHITE-LIST ONLY)
          if (!Object.prototype.hasOwnProperty.call(obj, prop)) {
            // Allow creating new own properties, but not setting prototype chain properties
            if (typeof prop === 'string' && (prop === '__proto__' || prop === 'constructor' || prop === 'prototype')) {
              throw new Error(`Reflex Security: Cannot update dangerous property '${prop}'`);
            }
          }

          const oldValue = obj[prop] || 0;
          if (node.op === '++') {
            obj[prop] = oldValue + 1;
          } else if (node.op === '--') {
            obj[prop] = oldValue - 1;
          }

          // Return old value for postfix, new value for prefix
          return node.prefix ? obj[prop] : oldValue;
        } else {
          throw new Error('Reflex: Invalid update target');
        }
      }

      default:
        return undefined;
    }
  }

  /**
   * Wraps a result object in a protective membrane.
   */
  private _wrapResult(result: any): any {
    return new Proxy(result, {
      get(target, key) {
        // WHITE-LIST: Only allow own properties, safe methods, safe accessors, or safe DOM properties
        // CRITICAL FIX (Audit Issue #5): Include SAFE_DOM_PROPERTIES
        if (typeof key === 'string') {
          if (!Object.prototype.hasOwnProperty.call(target, key) &&
              !SAFE_METHODS[key] &&
              !SAFE_ACCESSORS[key] &&
              !SAFE_DOM_PROPERTIES[key]) {
            return undefined;
          }
        }
        const value = target[key];
        if (value !== null && typeof value === 'object') {
          // Recursively wrap nested objects
          return new Proxy(value, this);
        }
        return value;
      },
      set() {
        throw new Error('Reflex Security: Cannot modify properties on function return values');
      }
    });
  }
}
