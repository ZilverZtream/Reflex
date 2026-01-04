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

// CRITICAL FIX (Issue #5): Import SafeHTML from the dedicated core module
// Import for local use AND re-export for backwards compatibility
import { SafeHTML } from '../core/safe-html.js';

// TRIFECTA PROTOCOL: Import centralized sink validation
import { validateSink, getBlockReason } from '../core/sinks.js';

// Re-export for backwards compatibility with code that imports from renderers/dom.js
export { SafeHTML };

/**
 * SECURITY FIX (Audit Issue #2): Dangerous Tag Whitelist
 *
 * These tags can execute code or load external resources in dangerous ways:
 * - script: Direct JavaScript execution
 * - base: Hijacks relative URLs for the entire document
 * - object/embed/applet: Plugin execution, can bypass CSP
 * - meta: Can redirect via refresh, set CSP, etc.
 * - link: Can load external stylesheets (data exfiltration)
 * - iframe: Embed external content (handled separately with sandbox)
 *
 * NOTE: We allow iframe creation but enforce sandbox attribute in setAttribute.
 */
const DANGEROUS_TAGS = /^(script|base|object|embed|applet)$/i;

/**
 * Tags that require special handling but aren't outright blocked.
 * These are allowed but with additional security enforcement.
 */
const RESTRICTED_TAGS = /^(meta|link|iframe)$/i;

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

  // Declare onEnd handler early so cleanup can reference it
  let onEnd: ((e: Event) => void) | null = null;

  // Cleanup function to cancel transition
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    // Clear timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Remove event listeners (if onEnd was set)
    if (onEnd) {
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
    }

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
            // Call done callback when element is removed
            if (done && !transitionCallback.cancelled) done();
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

  // End handler - assign to the pre-declared variable
  onEnd = (e: Event) => {
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
    // SECURITY FIX (Audit Issue #2): Block dangerous tag creation
    // These tags can execute code even without innerHTML - e.g., appending a text
    // node to a script tag executes the code immediately.
    //
    // ATTACK VECTOR: Dynamic component with user-controlled tag name
    //   const el = renderer.createElement(userInput);
    //   renderer.appendChild(el, renderer.createTextNode('alert("XSS")'));
    //   // If userInput === 'script', this executes XSS
    if (DANGEROUS_TAGS.test(tagName)) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(`Reflex Security: Blocked dangerous tag <${tagName}>. ` +
          `Script, base, object, embed, and applet tags are not allowed.`);
      }
      // Return a safe div element instead - this prevents the attack while
      // allowing the render to continue (fail-safe, not fail-open)
      return document.createElement('div');
    }

    // Log warning for restricted tags (meta, link, iframe) in dev mode
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      if (RESTRICTED_TAGS.test(tagName)) {
        console.info(`Reflex Security: Creating restricted tag <${tagName}>. ` +
          `Additional security enforcement will be applied.`);
      }
    }

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
      // Metadata (NOTE: 'title' moved to ambiguousTags - exists in both HTML and SVG)
      'desc', 'metadata',
      // Scripting - NOTE: Removed from main list, handled as ambiguous tags
      // Additional elements
      'view', 'cursor'
    ]);

    // Ambiguous tags that exist in both HTML and SVG
    // Must check parent context to determine correct namespace
    //
    // CRITICAL FIX (SEC-2026-003 Issue #4): Added 'title' to ambiguous tags
    //
    // VULNERABILITY: <title> was only in svgTags, causing createElement('title')
    // to ALWAYS return an SVGTitleElement, even when used for the HTML page title.
    //
    // Impact:
    //   - Appending SVGTitleElement to <head> is invalid HTML
    //   - Breaks SEO (search engines expect HTMLTitleElement)
    //   - Screen readers may not announce page title correctly
    //   - document.title getter/setter may not work as expected
    //
    // FIX: Move 'title' to ambiguousTags so it checks parent namespace:
    //   - Inside <svg> → creates SVGTitleElement (for SVG accessible name)
    //   - Inside <head> or other HTML → creates HTMLTitleElement
    const ambiguousTags = new Set(['a', 'script', 'style', 'title']);

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
    // === THE TRIFECTA GATE ===
    // Intercepts Runtime Bindings AND Compiled Code
    // This is the final firewall for all attribute writes.
    if (!validateSink(name, value)) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(`Reflex Security: ${getBlockReason(name, value)}`);
      }
      return; // Silently drop the write (Sink-Based Denial)
    }

    // Handle null values by removing the attribute
    if (value === null) {
      node.removeAttribute(name);
      return;
    }

    // SECURITY FIX (Audit Issue #5): Reverse Tabnabbing Protection
    // When target="_blank" is set, the opened page gets a reference to your
    // app via window.opener and can redirect your app to a phishing site.
    // Automatically add rel="noopener noreferrer" to prevent this attack.
    if (name === 'target' && value === '_blank') {
      const currentRel = (node.getAttribute('rel') || '').toLowerCase();
      if (!currentRel.includes('noopener')) {
        const newRel = (currentRel + ' noopener noreferrer').trim();
        node.setAttribute('rel', newRel);
      }
    }

    // SECURITY FIX (Audit Issue #7): Iframe Sandboxing
    // Iframes act as windows to other contexts. Best practice is to enforce
    // least privilege by adding sandbox by default. We set a reasonable default
    // that allows scripts but restricts navigation.
    if (node.tagName === 'IFRAME' && name === 'src') {
      if (!node.hasAttribute('sandbox')) {
        // Default sandbox: allow scripts and same-origin for functionality,
        // but prevent navigation and form submission to protect parent frame
        node.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
          console.info(`Reflex Security: Auto-applied sandbox="allow-scripts allow-same-origin" ` +
            `to iframe. Set sandbox attribute explicitly to customize.`);
        }
      }
    }

    node.setAttribute(name, value);
  },

  /**
   * Set a DOM property directly (for .src, .href, etc.).
   * Also validates against dangerous sinks.
   */
  setProperty(node: Element, name: string, value: any): void {
    // === THE TRIFECTA GATE ===
    // Intercepts direct property access (el.src, el.href, etc.)
    if (!validateSink(name, value)) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(`Reflex Security: ${getBlockReason(name, value)}`);
      }
      return; // Silently drop the write (Sink-Based Denial)
    }

    (node as any)[name] = value;
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

  setInnerHTML(node: Element, html: SafeHTML | string, options?: { force?: boolean }): void {
    // CRITICAL SECURITY FIX (SEC-2026-003 Issue #2): Strict SafeHTML Enforcement
    //
    // VULNERABILITY: Regex blacklists are bypassable via HTML entity encoding:
    //   - Input: '<button formaction="&#106;avascript:alert(1)">X</button>'
    //   - Regex /javascript:/i does NOT match "&#106;avascript:"
    //   - Browser decodes &#106; to 'j' BEFORE executing, triggering XSS
    //
    // SOLUTION: Only SafeHTML instances are accepted by default.
    // Use { force: true } ONLY for legacy migrations where you have a custom sanitizer.
    //
    // MIGRATION:
    //   1. Install DOMPurify: npm install dompurify @types/dompurify
    //   2. Configure once: SafeHTML.configureSanitizer(DOMPurify);
    //   3. Sanitize input: renderer.setInnerHTML(el, SafeHTML.sanitize(userInput));
    //   4. For trusted static HTML: SafeHTML.unsafe(trustedStaticString)
    //   5. For legacy sanitizers: renderer.setInnerHTML(el, html, { force: true })

    // Handle SafeHTML instances (preferred path)
    if (SafeHTML.isSafeHTML(html)) {
      node.innerHTML = html.toString();
      return;
    }

    // Handle raw strings with force option for legacy migrations
    if (typeof html === 'string') {
      if (options?.force) {
        // SECURITY WARNING: force=true bypasses SafeHTML validation
        // The caller is responsible for ensuring content is properly sanitized
        if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
          console.warn(
            `Reflex Security: setInnerHTML() called with force=true.\n` +
            `This bypasses SafeHTML validation. Ensure content is properly sanitized.`
          );
        }
        node.innerHTML = html;
        return;
      }

      throw new TypeError(
        `Reflex Security: setInnerHTML() no longer accepts raw strings.\n` +
        `Received: string\n\n` +
        `BREAKING CHANGE (SEC-2026-003): Raw strings are rejected to prevent XSS.\n` +
        `The previous regex-based blacklist was bypassable via HTML entity encoding.\n\n` +
        `Options:\n` +
        `  1. Use SafeHTML.sanitize(html) for user content\n` +
        `  2. Use SafeHTML.unsafe(staticString) for trusted static strings\n` +
        `  3. Use { force: true } for legacy sanitizers (NOT recommended)\n\n` +
        `Example: renderer.setInnerHTML(el, SafeHTML.sanitize(html));`
      );
    }

    // Handle other types
    throw new TypeError(
      `Reflex Security: setInnerHTML() requires SafeHTML instance.\n` +
      `Received: ${typeof html}\n\n` +
      `Use SafeHTML.sanitize() or SafeHTML.unsafe() to create SafeHTML instances.`
    );
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
