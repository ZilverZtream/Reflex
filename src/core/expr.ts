/**
 * Reflex Core - Expression Compiler
 *
 * SECURITY (SEC-FINAL-005): Standard mode with `new Function()` has been REMOVED.
 * All expression compilation now requires the SafeExprParser which operates at
 * the AST level and prevents code injection attacks.
 *
 * ## Required Configuration
 *
 * ```javascript
 * import { Reflex } from 'reflex';
 * import { SafeExprParser } from 'reflex/csp';
 *
 * const app = new Reflex({ count: 0 });
 * app.configure({ parser: new SafeExprParser() });
 * ```
 *
 * The parser is MANDATORY. Reflex will throw an error if you attempt to use
 * expressions without configuring a parser first.
 */

/**
 * Expression cache with LRU (Least Recently Used) eviction strategy.
 * Uses Map's insertion order to track access recency.
 * When cache is full, removes the least recently accessed entry.
 * This prevents cache thrashing that would cause compilation storms.
 */
export class ExprCache {
  declare max: number;
  declare cache: Map<string, any>;

  constructor(maxSize = 1000) {
    this.max = maxSize;
    this.cache = new Map();
  }

  get(key: string) {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by deleting and re-inserting
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set<T>(key: string, value: T): T {
    // If key exists, delete it first so re-insertion moves it to end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      // LRU eviction: remove oldest (first) entry
      // Map maintains insertion order, so first key is least recently used
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
    return value;
  }

  has(key: string) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Expression compiler mixin for Reflex class.
 */
export const ExprMixin = {
  /**
   * Compile an expression string to an evaluator function.
   *
   * SECURITY (SEC-FINAL-005): All expression compilation now goes through the AST parser.
   * Standard mode with `new Function()` has been completely eliminated to remove the RCE vector.
   *
   * @param {string} exp - Expression to compile
   * @param {boolean} isH - Is handler mode (no return value expected)
   * @returns {Function} Evaluator (state, context, $event, $el) => result
   */
  _fn(exp, isH = false) {
    // Force usage of the AST Parser
    if (!this._parser) {
      throw new Error("Reflex Security: You must configure a parser. See docs.");
    }
    return this._parser.compile(exp, this, isH);
  },

  /**
   * $dispatch helper: dispatch custom event from element
   */
  _dispatch(event, detail, el) {
    const e = new CustomEvent(event, { detail, bubbles: true, cancelable: true });
    (el || this._dr).dispatchEvent(e);
    return e;
  },

  /**
   * Clear the expression cache
   */
  clearCache() {
    this._ec.clear();
    return this;
  }
};
