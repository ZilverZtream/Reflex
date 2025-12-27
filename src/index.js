/**
 * Reflex - The Direct Reactive Engine
 *
 * Zero Dependencies, Zero Build, Zero VDOM
 *
 * A lightweight reactive framework that compiles templates directly
 * to DOM operations without a virtual DOM intermediate.
 *
 * @example
 * // ESM
 * import { Reflex } from 'reflex';
 * const app = new Reflex({ count: 0 });
 *
 * // CSP-safe mode
 * import { SafeExprParser } from 'reflex/csp';
 * app.configure({ cspSafe: true, parser: new SafeExprParser() });
 *
 * @module reflex
 */

// Core exports
export { Reflex } from './core/reflex.js';

// Utility exports
export { computeLIS, reconcileKeyedList } from './core/reconcile.js';
export { runTransition } from './core/compiler.js';
export { ExprCache } from './core/expr.js';

// Symbol exports (for advanced usage)
export {
  META,
  ITERATE,
  SKIP,
  ACTIVE,
  RUNNING,
  QUEUED,
  RESERVED,
  UNSAFE_PROPS,
  UNSAFE_URL_RE,
  UNSAFE_EXPR_RE
} from './core/symbols.js';
