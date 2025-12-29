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
 * CRITICAL SECURITY FIX: Trusted Types for DOM Insertion
 *
 * SafeHTML is a value object that can ONLY be created through sanitization.
 * This provides type-level enforcement of HTML safety.
 *
 * SECURITY GUARANTEE:
 * - Cannot be constructed directly with raw strings
 * - Must be created via SafeHTML.sanitize() which runs DOMPurify
 * - The renderer's setInnerHTML will ONLY accept SafeHTML instances
 * - Attempting to pass raw strings will throw TypeError at runtime
 *
 * MIGRATION PATH:
 * 1. Install DOMPurify: npm install dompurify @types/dompurify
 * 2. Configure DOMPurify instance:
 *    SafeHTML.configureSanitizer(DOMPurify);
 * 3. Use SafeHTML.sanitize() instead of raw strings:
 *    const safe = SafeHTML.sanitize(userInput);
 *    renderer.setInnerHTML(element, safe);
 *
 * @example
 * // BEFORE (unsafe)
 * renderer.setInnerHTML(el, userInput);
 *
 * // AFTER (safe)
 * import DOMPurify from 'dompurify';
 * SafeHTML.configureSanitizer(DOMPurify);
 * const safe = SafeHTML.sanitize(userInput);
 * renderer.setInnerHTML(el, safe);
 */
export class SafeHTML {
  private readonly _html: string;
  private static _sanitizer: any = null;

  /**
   * Private constructor - use SafeHTML.sanitize() to create instances
   */
  private constructor(sanitizedHTML: string) {
    this._html = sanitizedHTML;

    // Seal the instance to prevent modification
    Object.defineProperty(this, '_html', {
      writable: false,
      enumerable: false,
      configurable: false
    });
    Object.freeze(this);
  }

  /**
   * Get the sanitized HTML string
   */
  toString(): string {
    return this._html;
  }

  /**
   * Configure the DOMPurify instance to use for sanitization
   *
   * @param sanitizer - DOMPurify instance
   * @example
   * import DOMPurify from 'dompurify';
   * SafeHTML.configureSanitizer(DOMPurify);
   */
  static configureSanitizer(sanitizer: any): void {
    if (!sanitizer || typeof sanitizer.sanitize !== 'function') {
      throw new Error(
        'SafeHTML: Invalid sanitizer. Must be a DOMPurify instance with a sanitize() method.\n' +
        'Install DOMPurify: npm install dompurify @types/dompurify'
      );
    }
    SafeHTML._sanitizer = sanitizer;
  }

  /**
   * Sanitize HTML string using configured DOMPurify instance
   *
   * @param html - Raw HTML string to sanitize
   * @param config - Optional DOMPurify configuration
   * @returns SafeHTML instance with sanitized content
   * @throws Error if DOMPurify is not configured
   *
   * @example
   * const safe = SafeHTML.sanitize('<img src=x onerror=alert(1)>');
   * renderer.setInnerHTML(element, safe);
   */
  static sanitize(html: string, config?: any): SafeHTML {
    if (!SafeHTML._sanitizer) {
      throw new Error(
        'SafeHTML: DOMPurify not configured. Call SafeHTML.configureSanitizer(DOMPurify) first.\n\n' +
        'Installation:\n' +
        '  npm install dompurify @types/dompurify\n\n' +
        'Configuration:\n' +
        '  import DOMPurify from "dompurify";\n' +
        '  SafeHTML.configureSanitizer(DOMPurify);'
      );
    }

    const sanitized = SafeHTML._sanitizer.sanitize(html, config);
    return new SafeHTML(sanitized);
  }

  /**
   * Create SafeHTML from a known-safe static string (NO SANITIZATION)
   *
   * WARNING: Only use this for compile-time static strings that you control.
   * NEVER use this with user input or dynamic content.
   *
   * @param html - Known-safe static HTML string
   * @returns SafeHTML instance without sanitization
   *
   * @example
   * // SAFE: Static template string
   * const safe = SafeHTML.unsafe('<div class="container"></div>');
   *
   * // UNSAFE: User input (use sanitize() instead)
   * const unsafe = SafeHTML.unsafe(userInput); // DON'T DO THIS!
   */
  static unsafe(html: string): SafeHTML {
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.warn(
        'SafeHTML.unsafe(): Creating SafeHTML without sanitization.\n' +
        'Only use this for static strings you control. NEVER with user input.'
      );
    }
    return new SafeHTML(html);
  }

  /**
   * Check if a value is a SafeHTML instance
   */
  static isSafeHTML(value: any): value is SafeHTML {
    return value instanceof SafeHTML;
  }
}

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
  // CRITICAL FIX #10: runTransition Race Condition Prevention
  // If a transition is already running on this element, cancel it first
  // Without this, multiple transitions can conflict (e.g., rapid m-if toggles)
  const elAny = el as any;
  if (elAny._transCb) {
    // Cancel the previous transition's done callback
    elAny._transCb.cancelled = true;
    // Call cleanup to remove old classes and listeners
    if (elAny._transCleanup) {
      elAny._transCleanup();
    }
  }

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

    // Clear stored callbacks
    if (elAny._transCb === transitionCallback) {
      elAny._transCb = null;
    }
    if (elAny._transCleanup === cleanup) {
      elAny._transCleanup = null;
    }
  };

  // Transition callback wrapper that checks cancellation
  const transitionCallback = {
    cancelled: false
  };

  // Store cleanup and callback on element for race condition prevention
  elAny._transCleanup = cleanup;
  elAny._transCb = transitionCallback;

  // CRITICAL SECURITY FIX: Memory Leak in Transition Cleanup
  // If reflex is not provided (or _reg is missing), cleanup is never called when element is removed
  // This leaves event listeners and closures in memory indefinitely
  //
  // SOLUTION: Always ensure cleanup happens either via:
  // 1. Reflex lifecycle registry (if available) - preferred
  // 2. MutationObserver fallback to detect element removal
  if (reflex && typeof reflex._reg === 'function') {
    reflex._reg(el, cleanup);
  } else {
    // Fallback: Use MutationObserver to detect when element is removed from DOM
    // This ensures cleanup happens even without a Reflex instance
    // CRITICAL FIX #6: Crash on Detached Node Transitions
    // If el.parentNode is null (detached node), observer.observe() throws
    // Check for parentNode before creating observer, or cleanup immediately
    if (!el.parentNode) {
      // Element is already detached - cleanup immediately and don't start transition
      cleanup();
      if (done) done();
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check if our element was removed
        for (const node of mutation.removedNodes) {
          if (node === el || (node as Element).contains?.(el)) {
            cleanup();
            observer.disconnect();
            return;
          }
        }
      }
    });

    // Observe the parent for child removals (we've already checked parentNode exists)
    observer.observe(el.parentNode, { childList: true });

    // Store observer reference for cleanup
    elAny._transObserver = observer;

    // Also clean up observer in the main cleanup function
    const originalCleanup = cleanup;
    const cleanupWithObserver = () => {
      originalCleanup();
      if (elAny._transObserver) {
        elAny._transObserver.disconnect();
        elAny._transObserver = null;
      }
    };
    // Update the stored cleanup reference
    elAny._transCleanup = cleanupWithObserver;
  }

  // End handler
  const onEnd = (e: Event) => {
    if ((e as TransitionEvent).target !== el || cleaned) return;
    cleanup();
    // Only call done callback if transition wasn't cancelled
    if (done && !transitionCallback.cancelled) done();
  };

  // CRITICAL FIX #8: Flaky Transitions - Use Double RAF
  // A single requestAnimationFrame is often insufficient for the browser to apply the initial styles
  // Browsers batch style updates, and a single frame may not guarantee the '-from' class has rendered
  // Using two frames ensures the initial state is fully applied before transitioning
  requestAnimationFrame(() => {
    if (cleaned) return; // Transition was cancelled before it started

    // Second frame: Now swap classes to trigger the transition
    requestAnimationFrame(() => {
      if (cleaned) return; // Transition was cancelled during first frame

      // CRITICAL SECURITY FIX #6: m-trans Race Condition (Detached Elements)
      //
      // VULNERABILITY: If element is removed between transition start and RAF callback,
      // getComputedStyle() on a detached node returns empty object or throws
      // parseFloat(empty) returns NaN, leading to timeout = NaN
      //
      // SOLUTION: Check if element is still connected before calling getComputedStyle
      if (!el.isConnected) {
        cleanup();
        if (done && !transitionCallback.cancelled) done();
        return;
      }

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
          // Only call done callback if transition wasn't cancelled
          if (done && !transitionCallback.cancelled) done();
        }, timeout);
      } else {
        // No transition defined, complete immediately
        cleanup();
        // Only call done callback if transition wasn't cancelled
        if (done && !transitionCallback.cancelled) done();
      }
    });
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

  createElement(tagName: string, parent?: Element, namespaceHint?: string): Element {
    // SVG elements require the SVG namespace
    // CRITICAL FIX: Context-aware element creation for ambiguous tags
    // Tags like 'a', 'script', and 'style' exist in both HTML and SVG namespaces
    // We must check the parent element's namespace to create the correct type
    //
    // CRITICAL SECURITY FIX: SVG Namespace Context Loss
    // If createElement is called without a parent (e.g., creating a root SVG component),
    // we must still create SVG elements correctly. Accept optional namespaceHint parameter
    // to override namespace detection when parent is unavailable.
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
      // Scripting - NOTE: Removed from main list, handled as ambiguous tags
      // Additional elements
      'view', 'cursor'
    ]);

    // Ambiguous tags that exist in both HTML and SVG
    // Must check parent context to determine correct namespace
    const ambiguousTags = new Set(['a', 'script', 'style']);

    const tag = tagName.toLowerCase();

    // CRITICAL FIX #9: Fragile SVG Namespace Handling
    // Use namespaceURI exclusively instead of string matching on tagName
    // String matching fails in nested contexts (SVG -> HTML -> SVG) and with custom elements
    //
    // EXCEPTION: foreignObject is an SVG element, but its children are HTML elements
    // Check namespaceURI directly, then check for foreignObject exception
    let isParentSVG = false;
    if (parent) {
      const parentNS = parent.namespaceURI;
      // Parent is SVG namespace AND not foreignObject
      isParentSVG = parentNS === 'http://www.w3.org/2000/svg' &&
                    parent.tagName.toLowerCase() !== 'foreignobject';
    } else if (namespaceHint === 'http://www.w3.org/2000/svg') {
      // No parent but explicit SVG namespace hint provided
      isParentSVG = true;
    }

    // For ambiguous tags, use parent's namespace or hint
    if (ambiguousTags.has(tag)) {
      if (isParentSVG) {
        return document.createElementNS('http://www.w3.org/2000/svg', tagName);
      } else {
        return document.createElement(tagName);
      }
    }

    // For unambiguous SVG tags, always create as SVG
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

  setInnerHTML(node: Element, html: string | SafeHTML): void {
    // ========================================================================
    // CRITICAL SECURITY FIX: Trusted Types for DOM Insertion
    // ========================================================================
    //
    // PREFERRED USAGE: Pass SafeHTML instance (type-safe, enforces sanitization)
    //   const safe = SafeHTML.sanitize(userInput);
    //   renderer.setInnerHTML(element, safe);
    //
    // LEGACY USAGE: Pass string (backward compatible, but shows warnings)
    //   const sanitized = DOMPurify.sanitize(userInput);
    //   renderer.setInnerHTML(element, sanitized);
    //
    // Type-level enforcement:
    // - SafeHTML can ONLY be created via SafeHTML.sanitize() (requires DOMPurify)
    // - Raw strings trigger security warnings in development
    // - In production, strings still work but are discouraged
    //
    // Migration path:
    // 1. Install: npm install dompurify @types/dompurify
    // 2. Configure: SafeHTML.configureSanitizer(DOMPurify);
    // 3. Update calls: setInnerHTML(el, SafeHTML.sanitize(html));

    // Fast path: SafeHTML instance (already sanitized)
    if (SafeHTML.isSafeHTML(html)) {
      node.innerHTML = html.toString();
      return;
    }

    // Legacy path: raw string (backward compatibility with warnings)
    if (typeof html !== 'string') {
      throw new TypeError(
        'Reflex: setInnerHTML() requires a SafeHTML instance or string.\n' +
        'Received: ' + typeof html
      );
    }

    // Warn about legacy string usage in development
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.warn(
        'Reflex Security Warning: setInnerHTML() called with raw string instead of SafeHTML.\n\n' +
        'RECOMMENDED MIGRATION:\n' +
        '  import DOMPurify from "dompurify";\n' +
        '  import { SafeHTML } from "reflex/renderers/dom";\n' +
        '  SafeHTML.configureSanitizer(DOMPurify);\n\n' +
        '  // Then use:\n' +
        '  const safe = SafeHTML.sanitize(html);\n' +
        '  renderer.setInnerHTML(element, safe);\n\n' +
        'This provides type-level enforcement that HTML is sanitized.\n' +
        'Element:', node.tagName
      );
    }

    // Basic danger detection (DEFENSE-IN-DEPTH ONLY, NOT A SECURITY BOUNDARY)
    const lowerHTML = html.toLowerCase();
    const hasDangerousContent =
      lowerHTML.includes('<script') ||
      lowerHTML.includes('javascript:') ||
      lowerHTML.includes('data:text/html') ||  // Data URIs with HTML
      lowerHTML.includes('data:application/') || // Data URIs with active content
      lowerHTML.includes('<object') ||  // Object embeds can execute code
      lowerHTML.includes('<embed') ||   // Embed tags can execute code
      lowerHTML.includes('<iframe') ||  // Iframes can execute code
      lowerHTML.includes('<svg') && /on\w+\s*=/.test(lowerHTML) || // SVG with event handlers
      lowerHTML.includes('<animate') ||  // SVG animate can have event handlers
      lowerHTML.includes('<set') && lowerHTML.includes('attributename') || // SVG set attacks
      lowerHTML.includes('on') && /on\w+\s*=/.test(lowerHTML) || // Event handlers like onclick=
      lowerHTML.includes('formaction') || // Form action hijacking
      /data\s*:/.test(lowerHTML) && /base64/i.test(lowerHTML); // Base64 encoded data URIs

    if (hasDangerousContent) {
      throw new Error(
        'Reflex SECURITY ERROR: setInnerHTML() detected dangerous content.\n\n' +
        'CRITICAL: This check catches OBVIOUS XSS patterns but can be bypassed.\n\n' +
        'Detected patterns: <script>, javascript:, data URIs, <object>, <embed>,\n' +
        '<iframe>, event handlers, or SVG attack vectors.\n\n' +
        'SECURE SOLUTION (recommended):\n' +
        '  1. Install DOMPurify: npm install dompurify\n' +
        '  2. Configure SafeHTML:\n' +
        '     import DOMPurify from "dompurify";\n' +
        '     SafeHTML.configureSanitizer(DOMPurify);\n' +
        '  3. Use type-safe API:\n' +
        '     const safe = SafeHTML.sanitize(html);\n' +
        '     setInnerHTML(element, safe);\n\n' +
        'LEGACY SOLUTION:\n' +
        '  const sanitized = DOMPurify.sanitize(html);\n' +
        '  setInnerHTML(element, sanitized);\n\n' +
        'Element: ' + node.tagName
      );
    }

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
