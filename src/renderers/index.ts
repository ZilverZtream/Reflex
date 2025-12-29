/**
 * Reflex Renderers - Pluggable Rendering Engines
 *
 * This module exports the renderer adapters and types for the
 * pluggable renderer architecture.
 *
 * @example
 * // Web target (default)
 * import { Reflex } from 'reflex';
 * const app = new Reflex({ count: 0 });
 *
 * @example
 * // Non-web target
 * import { Reflex } from 'reflex';
 * import { VirtualRenderer } from 'reflex/renderers';
 * const renderer = new VirtualRenderer({ debug: true });
 * const app = new Reflex({ count: 0 }, { renderer });
 *
 * @module reflex/renderers
 */

// Type exports
export type {
  IRendererAdapter,
  IRendererMixin,
  VNode,
  TransitionConfig,
  RendererOptions
} from './types.js';

// DOM Renderer (web target)
export { DOMRenderer, runTransition, SafeHTML } from './dom.js';

// Virtual Renderer (non-web targets)
export { VirtualRenderer, createVirtualRenderer } from './virtual.js';
