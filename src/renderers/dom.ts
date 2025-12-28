/**
 * DOM Renderer - Zero-Cost Browser DOM Adapter
 *
 * This renderer provides a thin abstraction over the browser DOM APIs.
 * Designed for maximum performance:
 * - Direct method calls (no virtual dispatch overhead)
 * - Methods are designed to inline during minification
 * - No runtime overhead compared to direct DOM manipulation
 *
 * Use this renderer for web targets (default).
 */

import type { IRendererAdapter, TransitionConfig, VNode } from './types.js';

/**
 * CSS Transition helper for enter/leave animations.
 * Follows Vue/Alpine naming convention:
 * - {name}-enter-from, {name}-enter-active, {name}-enter-to
 * - {name}-leave-from, {name}-leave-active, {name}-leave-to
 *
 * @param el - The element to animate
 * @param name - Transition name (e.g., 'fade', 'slide')
 * @param type - 'enter' or 'leave'
 * @param done - Callback when transition completes
 * @param reflex - Optional Reflex instance to register cleanup in lifecycle registry
 */
export function runTransition(el: Element, name: string, type: 'enter' | 'leave', done?: () => void, reflex?: any) {
  const from = `${name}-${type}-from`;
  const active = `${name}-${type}-active`;
  const to = `${name}-${type}-to`;

  // Add initial classes
  el.classList.add(from, active);

  // Force reflow to ensure initial state is applied
  (el as HTMLElement).offsetHeight; // eslint-disable-line no-unused-expressions

  // Track cleanup state to prevent double execution
  let cleaned = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  // Cleanup function to cancel transition
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    // Clear timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Remove event listeners
    el.removeEventListener('transitionend', onEnd);
    el.removeEventListener('animationend', onEnd);

    // Remove transition classes
    el.classList.remove(from, active, to);
  };

  // Register cleanup in element's lifecycle registry if Reflex instance provided
  if (reflex && typeof reflex._reg === 'function') {
    reflex._reg(el, cleanup);
  }

  // End handler
  const onEnd = (e: Event) => {
    if ((e as TransitionEvent).target !== el || cleaned) return;
    cleanup();
    if (done) done();
  };

  // Next frame: start transition
  requestAnimationFrame(() => {
    if (cleaned) return; // Transition was cancelled before it started

    el.classList.remove(from);
    el.classList.add(to);

    // Listen for transition end
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);

    // Fallback timeout (in case transitionend doesn't fire)
    const style = getComputedStyle(el);
    const duration = parseFloat(style.transitionDuration) || parseFloat(style.animationDuration) || 0;
    const delay = parseFloat(style.transitionDelay) || parseFloat(style.animationDelay) || 0;
    const timeout = (duration + delay) * 1000 + 50; // Add 50ms buffer

    if (timeout > 50) {
      timeoutId = setTimeout(() => {
        if (cleaned) return;
        cleanup();
        if (done) done();
      }, timeout);
    } else {
      // No transition defined, complete immediately
      cleanup();
      if (done) done();
    }
  });
}

/**
 * DOM Renderer implementation.
 *
 * All methods are designed to be as thin as possible for zero-cost abstraction.
 * The minifier should be able to inline most of these calls.
 */
export const DOMRenderer: IRendererAdapter = {
  isBrowser: true,

  createComment(text: string): Comment {
    return document.createComment(text);
  },

  createElement(tagName: string): Element {
    // SVG elements require the SVG namespace
    // CRITICAL FIX: Expanded allowlist to include all common SVG elements
    // This prevents rendering bugs where SVG elements become HTMLUnknownElement
    const svgTags = new Set([
      // Core SVG
      'svg', 'g', 'defs', 'symbol', 'use', 'foreignObject',
      // Shapes
      'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
      // Text
      'text', 'tspan', 'textPath',
      // Gradients & Patterns
      'linearGradient', 'radialGradient', 'stop', 'pattern',
      // Clipping & Masking
      'clipPath', 'mask',
      // Markers
      'marker',
      // Images & Media
      'image', 'switch',
      // Animation
      'animate', 'animateTransform', 'animateMotion', 'set',
      // Filters
      'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
      'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feFlood',
      'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
      'feOffset', 'feSpecularLighting', 'feTile', 'feTurbulence',
      'feDistantLight', 'fePointLight', 'feSpotLight',
      // Metadata
      'desc', 'title', 'metadata',
      // Scripting
      'script', 'style',
      // Additional elements
      'view', 'cursor'
    ]);

    const tag = tagName.toLowerCase();
    if (svgTags.has(tag)) {
      return document.createElementNS('http://www.w3.org/2000/svg', tagName);
    }
    return document.createElement(tagName);
  },

  createTextNode(text: string): Text {
    return document.createTextNode(text);
  },

  createTemplate(): HTMLTemplateElement {
    return document.createElement('template');
  },

  cloneNode<T extends Node>(node: T, deep = true): T {
    return node.cloneNode(deep) as T;
  },

  replaceWith(oldNode: Node, newNode: Node): void {
    (oldNode as ChildNode).replaceWith(newNode);
  },

  insertBefore(parent: Node, newNode: Node, refNode: Node | null): void {
    parent.insertBefore(newNode, refNode);
  },

  insertAfter(refNode: Node, newNode: Node): void {
    (refNode as ChildNode).after(newNode);
  },

  appendChild(parent: Node, child: Node): void {
    parent.appendChild(child);
  },

  removeChild(node: Node): void {
    (node as ChildNode).remove();
  },

  getAttribute(node: Element, name: string): string | null {
    return node.getAttribute(name);
  },

  setAttribute(node: Element, name: string, value: string): void {
    node.setAttribute(name, value);
  },

  removeAttribute(node: Element, name: string): void {
    node.removeAttribute(name);
  },

  addEventListener(
    node: Element,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void {
    node.addEventListener(event, handler, options);
  },

  removeEventListener(
    node: Element,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void {
    node.removeEventListener(event, handler, options);
  },

  dispatchEvent(node: Element, event: string, detail?: any): void {
    node.dispatchEvent(new CustomEvent(event, { detail, bubbles: true }));
  },

  setTextContent(node: Text, text: string): void {
    node.nodeValue = text;
  },

  setInnerHTML(node: Element, html: string): void {
    node.innerHTML = html;
  },

  getAttributes(node: Element): NamedNodeMap {
    return node.attributes;
  },

  querySelector(node: Element, selector: string): Element | null {
    return node.querySelector(selector);
  },

  querySelectorAll(node: Element, selector: string): NodeListOf<Element> {
    return node.querySelectorAll(selector);
  },

  contains(parent: Node, child: Node): boolean {
    return parent.contains(child);
  },

  runTransition(node: Element, config: TransitionConfig, reflex?: any): void {
    runTransition(node, config.name, config.type, config.done, reflex);
  },

  requestAnimationFrame(callback: FrameRequestCallback): number {
    return requestAnimationFrame(callback);
  },

  cancelAnimationFrame(handle: number): void {
    cancelAnimationFrame(handle);
  },

  getComputedStyle(node: Element): CSSStyleDeclaration {
    return getComputedStyle(node);
  },

  getRoot(): Document {
    return document;
  }
};

export default DOMRenderer;
