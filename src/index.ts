/**
 * Reflex - The Direct Reactive Engine
 *
 * Zero Dependencies, Zero Build, Zero VDOM
 *
 * A lightweight reactive framework that compiles templates directly
 * to DOM operations without a virtual DOM intermediate.
 *
 * Now with pluggable renderer architecture for multi-platform support:
 * - Web (DOMRenderer) - Zero-cost direct DOM manipulation
 * - Native (VirtualRenderer) - Abstract VDOM for iOS/Android
 * - Test (VirtualRenderer) - Fast, deterministic testing
 *
 * @example
 * // ESM (Web target - default)
 * import { Reflex } from 'reflex';
 * const app = new Reflex({ count: 0 });
 *
 * // Non-web target (Native/Test)
 * import { Reflex } from 'reflex';
 * import { VirtualRenderer } from 'reflex/renderers';
 * const renderer = new VirtualRenderer();
 * const app = new Reflex({ count: 0 }, { renderer });
 * app.mount(renderer.getRoot());
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
  SAFE_URL_RE,
  RELATIVE_URL_RE
} from './core/symbols.js';

// Renderer exports (for pluggable architecture)
export { DOMRenderer, runTransition as runDOMTransition, SafeHTML } from './renderers/dom.js';
export { VirtualRenderer, createVirtualRenderer } from './renderers/virtual.js';
export type {
  IRendererAdapter,
  IRendererMixin,
  VNode,
  TransitionConfig,
  RendererOptions
} from './renderers/types.js';
