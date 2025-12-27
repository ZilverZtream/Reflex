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

import { META } from '../core/symbols.js';

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

// Dangerous property names that could lead to prototype pollution
const UNSAFE_PROPS = Object.assign(Object.create(null), {
  constructor: 1, prototype: 1, __defineGetter__: 1, __defineSetter__: 1,
  __lookupGetter__: 1, __lookupSetter__: 1
});
UNSAFE_PROPS['__proto__'] = 1;

// Dangerous method names that should be blocked on any object
const UNSAFE_METHODS = Object.assign(Object.create(null), {
  ...UNSAFE_OBJECT_METHODS,
  // Additional dangerous methods that could be used for sandbox escape
  eval: 1,
  Function: 1
});

/**
 * CSP-Safe Expression Parser
 *
 * Implements a recursive descent parser supporting:
 * - Literals: strings, numbers, booleans, null, undefined
 * - Identifiers with context/state lookup
 * - Property access: dot notation and bracket notation
 * - Function calls with arguments
 * - Binary operators: +, -, *, /, %, ==, ===, !=, !==, <, >, <=, >=, &&, ||, ??
 * - Unary operators: !, -, typeof
 * - Ternary operator: condition ? then : else
 * - Array literals: [a, b, c]
 * - Object literals: { key: value }
 * - Magic properties: $event, $el, $refs, $dispatch, $nextTick
 */
export class SafeExprParser {
  declare pos: number;
  declare expr: string;

  constructor() {
    this.pos = 0;
    this.expr = '';
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
    return this.parseExpression();
  }

  parseExpression() {
    return this.parseTernary();
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
    let left = this.parseComparison();
    while (true) {
      this.skipWhitespace();
      if (this.matchStr('===')) left = { type: 'binary', op: '===', left, right: this.parseComparison() };
      else if (this.matchStr('!==')) left = { type: 'binary', op: '!==', left, right: this.parseComparison() };
      else if (this.matchStr('==')) left = { type: 'binary', op: '==', left, right: this.parseComparison() };
      else if (this.matchStr('!=')) left = { type: 'binary', op: '!=', left, right: this.parseComparison() };
      else break;
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
  isIdentStart(c) { return c && /[a-zA-Z_$]/.test(c); }
  isIdentPart(c) { return c && /[\w$]/.test(c); }

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
        if (UNSAFE_PROPS[name]) {
          console.warn('Reflex: Blocked access to unsafe property:', name);
          return undefined;
        }
        // Magic properties
        if (name === '$event') return $event;
        if (name === '$el') return $el;
        if (name === '$refs') return reflex._refs;
        if (name === '$dispatch') return reflex._dispatch.bind(reflex);
        if (name === '$nextTick') return reflex.nextTick.bind(reflex);
        // Context lookup
        if (context && name in context) {
          const meta = context[META] || reflex._mf.get(context);
          if (meta) reflex.trackDependency(meta, name);
          return context[name];
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
        if (UNSAFE_PROPS[prop]) {
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
        return callee.apply(thisArg, args);
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
          default: return undefined;
        }
      }

      case 'unary': {
        const arg = this._evaluate(node.arg, state, context, $event, $el, reflex);
        switch (node.op) {
          case '!': return !arg;
          case '-': return -arg;
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
          obj[key] = this._evaluate(prop.value, state, context, $event, $el, reflex);
        }
        return obj;
      }

      default:
        return undefined;
    }
  }
}
