/**
 * Reflex Core - Compiler and Directives
 *
 * Handles DOM walking, template compilation, and directive processing.
 * Includes:
 * - DOM tree walking with m-if/m-for structural directives
 * - Attribute bindings (:attr="expr")
 * - Event handlers (@event="expr")
 * - Two-way binding (m-model)
 * - Text interpolation ({{ expr }})
 * - Transitions (m-trans)
 *
 * RENDERER ABSTRACTION:
 * This module uses a pluggable renderer architecture. All DOM operations
 * go through `this._ren` (the renderer adapter) to support:
 * - Web targets (DOMRenderer - zero-cost browser DOM)
 * - Native targets (VirtualRenderer - abstract VDOM)
 * - Test environments (Mock rendering)
 */

import { META, ITERATE, SKIP, UNSAFE_PROPS, SAFE_URL_RE, RELATIVE_URL_RE } from './symbols.js';
import { computeLIS, resolveDuplicateKey, reconcileKeyedList } from './reconcile.js';
import type { IRendererAdapter } from '../renderers/types.js';

// Basic HTML entity escaping for when DOMPurify is unavailable
const escapeHTML = s => s.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/**
 * Get the raw (unwrapped) value from a reactive proxy.
 * If the value is not a proxy, returns the value as-is.
 * This is needed for object identity comparison since the same object
 * might be accessed via different proxy wrappers.
 */
const getRawValue = (v: any): any => {
  if (v !== null && typeof v === 'object') {
    const meta = v[META];
    if (meta && meta.r) {
      return meta.r; // Return the raw target
    }
  }
  return v;
};

/**
 * Clone a node while preserving custom properties like _rx_value_ref.
 *
 * CRITICAL FIX: Data Loss in Cloned Nodes
 * node.cloneNode(true) only copies attributes, not custom properties.
 * This causes _rx_value_ref (which stores object references for checkbox/radio values)
 * to be lost when m-if, m-for, or components clone template nodes.
 *
 * This helper recursively walks the cloned tree and copies _rx_value_ref from
 * corresponding source nodes, ensuring object identity is preserved.
 *
 * @param {Node} node - The node to clone
 * @param {boolean} deep - Whether to clone children (default: true)
 * @returns {Node} The cloned node with properties preserved
 */
export function cloneNodeWithProps(node: any, deep = true): any {
  const cloned = node.cloneNode(deep);

  // Copy _rx_value_ref if it exists on the source node
  if (node._rx_value_ref !== undefined) {
    cloned._rx_value_ref = node._rx_value_ref;
  }

  // If deep cloning, recursively copy _rx_value_ref for all descendants
  if (deep && node.childNodes && node.childNodes.length > 0) {
    const copyPropsRecursive = (source: any, target: any) => {
      // Handle both Element and DocumentFragment
      const sourceChildren = source.childNodes;
      const targetChildren = target.childNodes;

      if (sourceChildren && targetChildren && sourceChildren.length === targetChildren.length) {
        for (let i = 0; i < sourceChildren.length; i++) {
          const srcChild = sourceChildren[i];
          const tgtChild = targetChildren[i];

          // Copy _rx_value_ref if present
          if (srcChild._rx_value_ref !== undefined) {
            tgtChild._rx_value_ref = srcChild._rx_value_ref;
          }

          // Recursively process children
          if (srcChild.childNodes && srcChild.childNodes.length > 0) {
            copyPropsRecursive(srcChild, tgtChild);
          }
        }
      }
    };

    copyPropsRecursive(node, cloned);
  }

  return cloned;
}

/**
 * Parse a property path that may contain both dot notation and bracket notation.
 * Examples:
 *   'foo.bar' -> ['foo', 'bar']
 *   'foo[0]' -> ['foo', '0']
 *   'list[0].name' -> ['list', '0', 'name']
 *   'grid[1][2]' -> ['grid', '1', '2']
 *   'data[0].items[5]' -> ['data', '0', 'items', '5']
 *
 * CRITICAL FIX #3: m-model Bracket Notation Support
 * Previous implementation used simple exp.split('.') which failed on array indices
 * This parser handles both dot notation and bracket notation correctly
 */
function parsePath(exp: string): string[] {
  const paths: string[] = [];
  let current = '';
  let i = 0;

  while (i < exp.length) {
    const char = exp[i];

    if (char === '.') {
      // Dot notation - push current segment and reset
      if (current) {
        paths.push(current);
        current = '';
      }
      i++;
    } else if (char === '[') {
      // Bracket notation - push current segment if any
      if (current) {
        paths.push(current);
        current = '';
      }

      // Find the closing bracket
      i++; // Skip opening bracket
      let bracketContent = '';
      while (i < exp.length && exp[i] !== ']') {
        bracketContent += exp[i];
        i++;
      }

      // Remove quotes if present (for string indices like ["key"])
      if ((bracketContent.startsWith('"') && bracketContent.endsWith('"')) ||
          (bracketContent.startsWith("'") && bracketContent.endsWith("'"))) {
        bracketContent = bracketContent.slice(1, -1);
      }

      paths.push(bracketContent);
      i++; // Skip closing bracket
    } else {
      // Regular character - add to current segment
      current += char;
      i++;
    }
  }

  // Push final segment if any
  if (current) {
    paths.push(current);
  }

  return paths;
}

/**
 * CSS Transition helper for enter/leave animations.
 * Follows Vue/Alpine naming convention:
 * - {name}-enter-from, {name}-enter-active, {name}-enter-to
 * - {name}-leave-from, {name}-leave-active, {name}-leave-to
 *
 * This function supports both direct DOM usage and the pluggable renderer.
 * When a Reflex instance with a renderer is provided, it uses the renderer's
 * animation frame and computed style methods.
 *
 * @param el - The element to animate
 * @param name - Transition name (e.g., 'fade', 'slide')
 * @param type - 'enter' or 'leave'
 * @param done - Callback when transition completes
 * @param reflex - Optional Reflex instance to register cleanup in lifecycle registry
 */
export function runTransition(el, name, type, done, reflex?) {
  // CRITICAL FIX: Transition Race Condition Prevention
  // If a transition is already running on this element, cancel it first
  // Example: m-if toggles from false->true (leave starts) then true->false (enter starts)
  // Without cancellation, the leave's done callback would fire and remove the element!
  if (el._transCb) {
    // Cancel the previous transition's done callback
    el._transCb.cancelled = true;
    // Call cleanup to remove old classes and listeners
    if (el._transCleanup) {
      el._transCleanup();
    }
  }

  const from = `${name}-${type}-from`;
  const active = `${name}-${type}-active`;
  const to = `${name}-${type}-to`;

  // Get renderer from reflex instance if available
  const renderer: IRendererAdapter | undefined = reflex?._ren;

  // Add initial classes
  el.classList.add(from, active);

  // Force reflow to ensure initial state is applied (browser only)
  if (typeof el.offsetHeight !== 'undefined') {
    el.offsetHeight; // eslint-disable-line no-unused-expressions
  }

  // Track cleanup state to prevent double execution
  let cleaned = false;
  let timeoutId = null;

  // CRITICAL FIX: Track transition completion to prevent early cutoff
  // transitionend fires for EVERY property (opacity, transform, etc.)
  // We must wait for all properties to finish, not just the first one
  // CRITICAL FIX: Use performance.now() instead of Date.now() for monotonic time
  // Date.now() can jump backwards/forwards due to NTP sync, causing transitions to hang/skip
  // performance.now() is monotonic and unaffected by system time adjustments
  let expectedEndTime = 0;

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
    if (el._transCb === transitionCallback) {
      el._transCb = null;
    }
    if (el._transCleanup === cleanup) {
      el._transCleanup = null;
    }
  };

  // Store cleanup for cancellation
  el._transCleanup = cleanup;

  // Create transition callback wrapper that can be cancelled
  const transitionCallback = {
    cancelled: false,
    done: done
  };
  el._transCb = transitionCallback;

  // Register cleanup in element's lifecycle registry if Reflex instance provided
  if (reflex && typeof reflex._reg === 'function') {
    reflex._reg(el, cleanup);
  }

  // End handler
  const onEnd = (e) => {
    if (e.target !== el || cleaned) return;

    // CRITICAL FIX: Only complete if we've reached the expected end time
    // This prevents early completion when multiple properties are transitioning
    // Example: opacity 0.2s, transform 1s - don't complete at 0.2s!
    // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
    const now = performance.now();
    if (now < expectedEndTime) {
      // Not all properties have finished yet, wait for more events
      return;
    }

    cleanup();
    // Only call done if this transition wasn't cancelled
    if (!transitionCallback.cancelled && done) {
      done();
    }
  };

  // Use renderer's requestAnimationFrame if available, otherwise use global
  const raf = renderer?.requestAnimationFrame ?? requestAnimationFrame;

  // CRITICAL FIX #8: Flaky Transitions - Use Double RAF
  // A single requestAnimationFrame is often insufficient for the browser to apply the initial styles
  // Browsers batch style updates, and a single frame may not guarantee the '-from' class has rendered
  // Using two frames ensures the initial state is fully applied before transitioning
  raf(() => {
    if (cleaned || transitionCallback.cancelled) return; // Transition was cancelled before it started

    // Second frame: Now swap classes to trigger the transition
    raf(() => {
      if (cleaned || transitionCallback.cancelled) return; // Transition was cancelled during first frame

      el.classList.remove(from);
      el.classList.add(to);

      // Listen for transition end
      el.addEventListener('transitionend', onEnd);
      el.addEventListener('animationend', onEnd);

      // Use renderer's getComputedStyle if available, otherwise use global
      const getStyle = renderer?.getComputedStyle ?? getComputedStyle;

      // Fallback timeout (in case transitionend doesn't fire)
      const style = getStyle(el);
      const duration = parseFloat(style.transitionDuration) || parseFloat(style.animationDuration) || 0;
      const delay = parseFloat(style.transitionDelay) || parseFloat(style.animationDelay) || 0;
      const timeout = (duration + delay) * 1000 + 50; // Add 50ms buffer

      // Set expected end time for transition completion check
      // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
      expectedEndTime = performance.now() + (duration + delay) * 1000;

      if (timeout > 50) {
        timeoutId = setTimeout(() => {
          if (cleaned || transitionCallback.cancelled) return;
          cleanup();
          if (!transitionCallback.cancelled && done) {
            done();
          }
        }, timeout) as any;
      } else {
        // No transition defined, complete immediately
        cleanup();
        if (!transitionCallback.cancelled && done) {
          done();
        }
      }
    });
  });
}

/**
 * Check if an element has a strict parent that doesn't allow wrapper elements.
 * Strict parents include: table, tbody, thead, tfoot, tr, select, optgroup, ul, ol, dl, picture, SVG elements
 *
 * CRITICAL FIX #4: Broken SVG Rendering in m-for
 * SVG elements are now treated as strict parents. Inserting non-SVG wrapper elements
 * (like <rfx-tpl>) inside SVG breaks the render tree. Browsers may tolerate it visually
 * via display:contents, but strict SVG parsers reject foreign XHTML elements.
 *
 * @param marker - The comment marker element to check
 * @returns true if the parent is strict and doesn't allow wrapper elements
 */
function hasStrictParent(marker: Comment): boolean {
  let parent = marker.parentElement;
  if (!parent) return false;

  const tag = parent.tagName;
  const tagUpper = tag.toUpperCase();

  // Elements that have strict child requirements
  const isStrictHTML = tagUpper === 'TABLE' || tagUpper === 'TBODY' || tagUpper === 'THEAD' || tagUpper === 'TFOOT' ||
                       tagUpper === 'TR' || tagUpper === 'SELECT' || tagUpper === 'OPTGROUP' ||
                       tagUpper === 'UL' || tagUpper === 'OL' || tagUpper === 'DL' || tagUpper === 'PICTURE';

  // SVG elements that should not contain non-SVG wrapper elements
  // Check namespace to handle both svg elements and HTML elements with same name
  const isSVGContext = parent.namespaceURI === 'http://www.w3.org/2000/svg' &&
                       tagUpper !== 'FOREIGNOBJECT'; // foreignObject allows HTML children

  return isStrictHTML || isSVGContext;
}

/**
 * Compiler mixin for Reflex class.
 */
export const CompilerMixin = {
  /**
   * Walk the DOM tree and process nodes.
   * Uses iterative walking with explicit stack to prevent stack overflow.
   * This approach handles deeply nested DOM structures (10,000+ levels) safely.
   *
   * CRITICAL FIX #6: Component stack overflow prevention
   * Instead of calling _comp recursively (which calls _w, which calls _comp...),
   * we now queue component work onto the same stack as DOM nodes.
   *
   * The stack stores work items that can be:
   * - { node, scope }: Regular DOM walking
   * - { comp, tag, scope }: Component to render
   */
  _w(n, o) {
    // Explicit stack prevents recursive call stack overflow
    const stack = [{ node: n, scope: o }];

    while (stack.length > 0) {
      const item = stack.pop();

      // Handle component rendering work item
      if (item.comp) {
        // CRITICAL FIX #7: Uncaught Exceptions in Component setup
        // Wrap component initialization in try-catch to prevent walker crash
        // Without this, a single error in setup() crashes the entire DOM walking process
        try {
          const inst = this._compNoRecurse(item.comp, item.tag, item.scope);
          // Queue the component instance for walking
          if (inst) {
            stack.push({ node: inst, scope: this._scopeMap.get(inst) || item.scope });
          }
        } catch (err) {
          // Handle the error gracefully via global error handler
          // This allows the rest of the DOM to render correctly
          this._handleError(err, item.scope);
          // Mark the component element so user can see something went wrong
          if (item.comp && item.comp.nodeType === 1) {
            item.comp.setAttribute('data-error', 'Component failed to initialize');
            item.comp.textContent = `[Component error: ${item.tag}]`;
          }
        }
        continue;
      }

      // Handle regular DOM node walking
      const { node, scope } = item;
      let c = node.firstChild;

      while (c) {
        const next = c.nextSibling;
        const nt = c.nodeType;

        // Element node (1)
        if (nt === 1) {
          const mIgnore = c.getAttribute('m-ignore');
          if (mIgnore === null) {
            const tag = c.tagName;
            const mIf = c.getAttribute('m-if');
            const mFor = c.getAttribute('m-for');

            // Process structural directives on <template> tags
            // Templates without structural directives remain inert (not processed)
            if (tag === 'TEMPLATE' && !mIf && !mFor) {
              // Skip templates without structural directives
            } else {
              // CRITICAL: When both m-for and m-if are on same element,
              // m-for has higher priority (Vue/Alpine semantics)
              // Process m-for first, m-if will be applied to each cloned item
              if (mFor !== null) {
                this._dir_for(c, scope);
              } else if (mIf !== null) {
                this._dir_if(c, scope);
              } else {
                const t = tag.toLowerCase();
                if (this._cp.has(t)) {
                  // CRITICAL FIX #6: Queue component for iterative processing
                  // Instead of calling _comp (which recurses), queue it on the stack
                  stack.push({ comp: c, tag: t, scope: scope });
                } else if (this._acp.has(t)) {
                  // Async component: lazy-load the handler
                  this._asyncComp(c, t, scope);
                } else {
                  this._bnd(c, scope);
                  // Push child for processing instead of recursive call
                  stack.push({ node: c, scope: scope });
                }
              }
            }
          }
        } else if (nt === 3) {
          // Text node with interpolation
          const nv = c.nodeValue;
          if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
            this._txt(c, scope);
          }
        }
        c = next;
      }
    }
  },

  /**
   * Clone a node while preserving custom properties like _rx_value_ref.
   * Delegates to the standalone cloneNodeWithProps helper.
   */
  _cloneNode(node, deep = true) {
    return cloneNodeWithProps(node, deep);
  },

  /**
   * Process bindings on an element.
   */
  _bnd(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans'); // For m-show transitions

    // CRITICAL FIX: Pre-set object value reference for checkboxes/radios
    // Attributes are processed in reverse order, so m-model runs before :value.
    // We need to eagerly evaluate and store the object reference BEFORE any effects run.
    // This ensures m-model can find _rx_value_ref when setting initial checked state.
    if ((n.type === 'checkbox' || n.type === 'radio') && n.hasAttribute(':value')) {
      const valueExp = n.getAttribute(':value');
      if (valueExp) {
        try {
          const fn = this._fn(valueExp);
          const initialValue = fn(this.s, o);
          if (initialValue !== null && typeof initialValue === 'object') {
            (n as any)._rx_value_ref = initialValue;
          }
        } catch (e) {
          // Ignore errors - effect will handle it
        }
      }
    }

    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        // CRITICAL FIX: Event Modifier Separation
        // Extract modifiers here (like m-model) for consistency and clarity
        // @click.stop.prevent becomes eventName="click", modifiers=["stop", "prevent"]
        const parts = nm.slice(1).split('.');
        const eventName = parts[0];
        const modifiers = parts.slice(1);
        this._ev(n, eventName, v, o, modifiers);
      } else if (nm.startsWith('m-')) {
        if (nm.startsWith('m-model')) {
          // Extract modifiers from m-model (e.g., m-model.lazy)
          const modifiers = nm.split('.').slice(1);
          this._mod(n, v, o, modifiers);
        } else if (nm === 'm-text') this._at(n, 'textContent', v, o);
        else if (nm === 'm-html') this._html(n, v, o);
        else if (nm === 'm-show') this._show(n, v, o, trans);
        else if (nm === 'm-effect') this._effect(n, v, o);
        else if (nm === 'm-ref') {
          // CRITICAL FIX: m-ref in loops (array ref support)
          // If used inside m-for, every row would overwrite the same ref variable.
          // Solution: If the ref is initialized as an array, push to it instead of replacing.
          // Example: <div m-for="item in items" m-ref="itemRefs">
          //   - state.itemRefs = [] (initialized as array)
          //   - Each element gets pushed to the array
          //   - Cleanup removes the element from the array

          // Check if this ref should be an array (for m-for usage)
          const isArrayRef = v in this.s && Array.isArray(this.s[v]);

          if (isArrayRef) {
            // Array mode: push element to array
            this.s[v].push(n);
            // Also add to $refs as array
            if (!Array.isArray(this._refs[v])) {
              this._refs[v] = [];
            }
            this._refs[v].push(n);

            // CRITICAL FIX: Preserve DOM order for ref arrays
            // While swap-and-pop is O(1) vs splice's O(N), DOM order MUST be preserved
            // Developers rely on refs[i].focus() to focus items in visual order
            // Correctness trumps performance: use splice() to maintain order
            this._reg(n, () => {
              const stateArray = this.s[v];
              const refsArray = this._refs[v];

              if (Array.isArray(stateArray)) {
                const idx = stateArray.indexOf(n);
                if (idx !== -1) {
                  const raw = this.toRaw(stateArray);
                  // Use splice to preserve order
                  raw.splice(idx, 1);
                }
              }
              if (Array.isArray(refsArray)) {
                const idx = refsArray.indexOf(n);
                if (idx !== -1) {
                  // Use splice to preserve order for non-reactive array too
                  refsArray.splice(idx, 1);
                }
              }
            });
          } else {
            // Single mode: replace ref (original behavior)
            this._refs[v] = n;
            if (v in this.s) {
              this.s[v] = n;
            }
            this._reg(n, () => {
              // CRITICAL: Set to null before deleting to break references
              // This prevents memory leaks from "Detached DOM Nodes"
              this._refs[v] = null;
              delete this._refs[v];
              if (v in this.s) {
                this.s[v] = null;
              }
            });
          }
        } else {
          // Check for custom directives: m-name.mod1.mod2="value"
          const parts = nm.slice(2).split('.');
          const dirName = parts[0];
          const mods = parts.slice(1);
          this._applyDir(n, dirName, v, mods, o);
        }
      }
    }
  },

  /**
   * m-if directive: conditional rendering with transitions
   */
  _dir_if(el, o) {
    const fn = this._fn(el.getAttribute('m-if'));
    const trans = el.getAttribute('m-trans');
    // Use renderer for DOM operations (supports both web and virtual targets)
    const cm = this._ren.createComment('if');
    this._ren.replaceWith(el, cm);
    let cur, leaving = false;

    // Check if the element is a template or component
    const tag = el.tagName;
    const tagLower = tag.toLowerCase();
    const isTemplate = tag === 'TEMPLATE';
    const isSyncComp = this._cp.has(tagLower);
    const isAsyncComp = this._acp.has(tagLower);

    const e = this.createEffect(() => {
      try {
        const ok = !!fn(this.s, o);
        // CRITICAL FIX #1: m-if Toggle "Zombie" State
        // When toggling True -> False (leaving=true) -> True, we must handle re-entry
        // Without this fix, the enter block is skipped because !leaving is false,
        // and the leave block is skipped because ok is true.
        // Result: The old transition completes and removes the element permanently.
        // Fix: If we need to enter while leaving, cancel the leaving transition first.
        if (ok && !cur && leaving) {
          // We're in the middle of leaving, but now we need to enter again
          // The leaving flag will be cleared by the transition cancellation
          // Reset leaving so we can re-enter
          leaving = false;
        }

        if (ok && !cur && !leaving) {
          if (isTemplate) {
            // For <template> tags, insert content instead of the element itself
            const cloned = this._cloneNode(el, true) as HTMLTemplateElement;
            cloned.removeAttribute('m-if');
            cloned.removeAttribute('m-trans');

            // Clone all content nodes from the template
            const contentNodes = Array.from(cloned.content.childNodes).map(node => this._cloneNode(node, true));

            // Insert all content nodes after the marker
            let insertPoint = cm;
            contentNodes.forEach(node => {
              insertPoint.after(node);
              insertPoint = node as ChildNode;
            });

            // Track all nodes for removal (array for template, single element otherwise)
            cur = contentNodes.length === 1 ? contentNodes[0] : contentNodes;

            // Process bindings and walk each inserted node
            contentNodes.forEach(node => {
              if (node.nodeType === 1) {
                this._bnd(node as Element, o);
                this._w(node as Element, o);
              }
            });

            // Run enter transition on content nodes
            if (trans && contentNodes.length > 0) {
              contentNodes.forEach(node => {
                if (node.nodeType === 1) {
                  this._runTrans(node as Element, trans, 'enter', null);
                }
              });
            }
          } else {
            // Non-template elements: existing logic
            const cloned = this._cloneNode(el, true);
            cloned.removeAttribute('m-if');
            cloned.removeAttribute('m-trans');
            cm.after(cloned);

          if (isSyncComp) {
            // CRITICAL FIX #2: m-if on Components Recursion Bomb
            // Use _compNoRecurse instead of _comp to prevent stack overflow
            // _comp calls _w which calls _comp... causing recursion with nested components
            // _compNoRecurse + manual _w prevents the recursion bomb
            cur = this._compNoRecurse(cloned, tagLower, o);
            // Manually walk the component instance to attach bindings
            if (cur) {
              const compScope = this._scopeMap.get(cur) || o;
              this._w(cur, compScope);
            }
          } else if (isAsyncComp) {
            // For async components, track the marker that _asyncComp creates
            // _asyncComp replaces cloned with marker (+ optional fallback)
            this._asyncComp(cloned, tagLower, o);
            // The marker is now at cloned's position (cm.nextSibling)
            cur = cm.nextSibling;
          } else {
            // Check if cloned element has m-for directive
            const hasMFor = cloned.getAttribute('m-for');

            if (hasMFor) {
              // CRITICAL FIX: Handle m-if + m-for composition
              // When an element has both m-if and m-for, we've removed m-if
              // but the clone still has m-for. We need to process m-for directly
              // on this element, not just walk its children.
              cur = cloned;
              this._bnd(cur, o);
              // Process m-for directive directly
              this._dir_for(cloned, o);
              // After _dir_for, the element is replaced with a comment + list
              // Update cur to point to the m-for comment marker
              cur = cm.nextSibling;
            } else {
              // Normal case: no structural directives on the clone
              cur = cloned;
              this._bnd(cur, o);
              this._w(cur, o);
            }
          }
          // Run enter transition (skip for templates, already handled above)
          if (trans && cur && !isTemplate) this._runTrans(cur, trans, 'enter', null);
          }
        } else if (!ok && cur && !leaving) {
          // Handle removal of template content (array of nodes) or single element
          if (isTemplate && Array.isArray(cur)) {
            // Remove all nodes from template content
            if (trans) {
              leaving = true;
              let completed = 0;
              const total = cur.filter((n: any) => n.nodeType === 1).length;
              const onComplete = () => {
                completed++;
                if (completed >= total) leaving = false;
              };

              cur.forEach((node: any) => {
                if (node.nodeType === 1) {
                  this._runTrans(node, trans, 'leave', () => {
                    this._kill(node);
                    if (node.parentNode) node.remove();
                    onComplete();
                  });
                } else {
                  this._kill(node);
                  if (node.parentNode) node.remove();
                }
              });
            } else {
              cur.forEach((node: any) => {
                this._kill(node);
                if (node.parentNode) node.remove();
              });
            }
            cur = null;
          } else if (isAsyncComp) {
            // CRITICAL FIX: Remove ALL nodes from async component (handles fragments)
            // Previous code broke after first element, leaking remaining fragment nodes
            // Now continues removing until hitting another structural directive marker
            let node = cm.nextSibling;
            let foundAsyncMarker = false;
            while (node) {
              const next = node.nextSibling;
              // Stop if we hit another structural directive marker (but not our own async marker)
              if (node.nodeType === 8 && !foundAsyncMarker &&
                  ((node as Comment).nodeValue?.startsWith('if') ||
                   (node as Comment).nodeValue?.startsWith('for'))) {
                break;
              }
              // Track if we found our async marker
              if (node.nodeType === 8 && (node as Comment).nodeValue?.startsWith('async:')) {
                foundAsyncMarker = true;
              }
              // Stop if we found the async marker and now hit another one (adjacent async components)
              if (foundAsyncMarker && node.nodeType === 8 &&
                  (node as Comment).nodeValue?.startsWith('async:') &&
                  node !== cm.nextSibling) {
                break;
              }
              this._kill(node);
              (node as ChildNode).remove();
              node = next;
            }
            cur = null;
          } else if (trans) {
            // Run leave transition before removing
            leaving = true;
            const node = cur;
            this._runTrans(node, trans, 'leave', () => {
              this._kill(node);
              node.remove();
              leaving = false;
            });
            cur = null;
          } else {
            this._kill(cur);
            cur.remove();
            cur = null;
          }
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(cm, e.kill);
  },

  /**
   * m-for directive: keyed list rendering with LIS-optimized reconciliation.
   *
   * Uses reconcileKeyedList from reconcile.ts to eliminate code duplication.
   * See src/core/reconcile.js for algorithm details.
   */
  _dir_for(el, o) {
    const ex = el.getAttribute('m-for');
    const kAttr = el.getAttribute('m-key');
    const match = ex.match(/^\s*(.*?)\s+in\s+(.*$)/);
    if (!match) return;

    const [_, l, r] = match;
    const parts = l.replace(/[()]/g, '').split(',').map(s => s.trim());
    const alias = parts[0], idxAlias = parts[1];

    // CRITICAL FIX #10: Scope Shadowing of Built-ins
    // If the user aliases a variable to a built-in name (e.g., "toString"),
    // it shadows the prototype method, causing crashes or unpredictable behavior
    // when Reflex internals or expressions call scope.toString()
    const reservedNames = ['toString', 'valueOf', 'toLocaleString', 'hasOwnProperty',
                           'isPrototypeOf', 'propertyIsEnumerable', 'constructor', '__proto__'];
    if (reservedNames.includes(alias)) {
      console.error(
        `Reflex: Invalid m-for alias "${alias}". This name shadows a JavaScript built-in.\n` +
        `Reserved names: ${reservedNames.join(', ')}\n` +
        `Use a different variable name (e.g., "${alias}Item" instead of "${alias}").`
      );
      return;
    }
    if (idxAlias && reservedNames.includes(idxAlias)) {
      console.error(
        `Reflex: Invalid m-for index alias "${idxAlias}". This name shadows a JavaScript built-in.\n` +
        `Reserved names: ${reservedNames.join(', ')}\n` +
        `Use a different variable name (e.g., "i" or "index" instead of "${idxAlias}").`
      );
      return;
    }
    const listFn = this._fn(r);
    const keyIsProp = !!kAttr && /^[a-zA-Z_$][\w$]*$/.test(kAttr);
    const keyFn = (!kAttr || keyIsProp) ? null : this._fn(kAttr);

    // Use renderer for DOM operations (supports both web and virtual targets)
    const cm = this._ren.createComment('for');
    this._ren.replaceWith(el, cm);
    const tpl = this._cloneNode(el, true);
    tpl.removeAttribute('m-for');
    tpl.removeAttribute('m-key');

    // Check if element has m-if (for m-for + m-if combination)
    const mIfExpr = tpl.getAttribute('m-if');
    const ifFn = mIfExpr ? this._fn(mIfExpr) : null;

    // Check if the element is a template or component
    const tag = el.tagName;
    const isTemplate = tag === 'TEMPLATE';
    const isSyncComp = this._cp.has(tag.toLowerCase());
    const isAsyncComp = this._acp.has(tag.toLowerCase());

    let rows = new Map();     // key -> { node, oldIdx }
    let oldKeys = [];         // Track key order for LIS

    const eff = this.createEffect(() => {
      const list = listFn(this.s, o) || [];
      const listMeta = list[META] || this._mf.get(list);
      if (listMeta) this.trackDependency(listMeta, ITERATE);

      const raw = Array.isArray(list) ? this.toRaw(list) : Array.from(list);

      // CRITICAL FIX: Track seen keys to detect and handle duplicates
      // When users provide data with duplicate keys (e.g., two items with id: 1),
      // the reconciler would corrupt the DOM by overwriting nodes in the Map.
      // We detect duplicates and use a fallback key strategy to prevent crashes.
      // CRITICAL: Use Map (not Set) to track duplicate counters for stable keys
      const seenKeys = new Map();

      // CRITICAL FIX: Stack Overflow Prevention in m-for
      // Collect nodes that need walking instead of calling _w immediately
      // This prevents recursive stack buildup for large lists with nested structure
      // After reconciliation, we process all walks iteratively
      const nodesToWalk = [];

      // Configure reconciliation with Reflex-specific logic
      const config = {
        getKey: (item, index, scope) => {
          let key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, scope)) : index;
          // Handle duplicate keys to prevent ghost nodes
          return resolveDuplicateKey(seenKeys, key, index);
        },

        createScope: (item, index) => {
          let processedItem = item;
          if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
            processedItem = this._r(processedItem);
          }

          // CRITICAL FIX: Use Object.create for scope inheritance (PERFORMANCE)
          // Object.create is fast in V8; Object.setPrototypeOf is a de-optimization operation
          // setPrototypeOf forces V8 to throw away optimizations for that object
          // In a loop with 1000 items, setPrototypeOf creates a massive performance bottleneck
          const base = o ? Object.create(o) : {};
          base[alias] = processedItem;
          if (idxAlias) base[idxAlias] = index;

          return this._r(base);
        },

        createNode: (item, index) => {
          const scope = config.createScope(item, index);

          // CRITICAL: Handle m-if on the same element as m-for
          // Evaluate m-if in the loop item's scope and skip if false
          if (ifFn) {
            let shouldRender = false;
            try {
              shouldRender = !!ifFn(this.s, scope);
            } catch (err) {
              this._handleError(err, scope);
            }
            if (!shouldRender) {
              // Return null to indicate this item should not be rendered
              return null;
            }
          }

          if (isTemplate) {
            // For <template> tags, clone content instead of the element itself
            const clonedTpl = this._cloneNode(tpl, true) as HTMLTemplateElement;
            if (mIfExpr) {
              clonedTpl.removeAttribute('m-if');
            }

            // OPTIMIZATION: Check if template has only one element child (single root)
            // If so, use that element directly without wrapper to fix CSS selectors like ul > li
            const contentNodes = Array.from(clonedTpl.content.childNodes);
            const elementNodes = contentNodes.filter(node => node.nodeType === 1);

            // CRITICAL FIX: Detect strict parents (table, select, ul, etc.)
            // These elements have strict child requirements and reject wrapper elements
            const isStrictParent = hasStrictParent(cm);

            if (elementNodes.length === 1) {
              // Single root element - ALWAYS use it directly without wrapper
              // This works for both strict and non-strict parents
              const singleRoot = this._cloneNode(elementNodes[0], true) as Element;
              this._scopeMap.set(singleRoot, scope);
              this._bnd(singleRoot, scope);
              // CRITICAL FIX: Defer _w call to prevent stack overflow
              nodesToWalk.push({ node: singleRoot, scope });
              return singleRoot;
            } else if (isStrictParent) {
              // CRITICAL FIX: For strict parents, NEVER use wrapper elements
              // Instead, use comment-based anchors and manage nodes in a flat array
              // Create a virtual container object to track all nodes
              const nodes = contentNodes.map(node => this._cloneNode(node, true));

              // Create a container object that acts as a virtual node for reconciliation
              // This object stores all nodes but isn't inserted into the DOM
              const container = {
                _isVirtualContainer: true,
                _nodes: nodes,
                parentNode: null, // Will be set on insertion
                remove: function() {
                  // Remove all tracked nodes
                  this._nodes.forEach((node: any) => {
                    if (node.parentNode) node.remove();
                  });
                }
              } as any;

              this._scopeMap.set(container, scope);

              // Process bindings and defer walk to prevent stack overflow
              nodes.forEach(child => {
                if (child.nodeType === 1) {
                  this._bnd(child as Element, scope);
                  // CRITICAL FIX: Defer _w call to prevent stack overflow
                  nodesToWalk.push({ node: child as Element, scope });
                }
              });

              return container;
            } else {
              // Multi-root or mixed content - use wrapper for reconciliation (non-strict parents only)
              // Create a wrapper using a custom element to contain template content
              // This acts as an "invisible" wrapper for reconciliation
              // Using 'rfx-tpl' custom element to avoid conflicts with normal element queries
              // CRITICAL FIX: Pass parent context for SVG awareness (fixes SVG link hijack)
              const wrapper = this._ren.createElement('rfx-tpl', cm.parentElement);
              wrapper.style.display = 'contents'; // Make wrapper invisible in layout

              // Clone and append all content nodes
              contentNodes.forEach(childNode => {
                wrapper.appendChild(this._cloneNode(childNode, true));
              });

              this._scopeMap.set(wrapper, scope);

              // Process bindings and defer walk to prevent stack overflow
              const children = Array.from(wrapper.childNodes);
              children.forEach(child => {
                if (child.nodeType === 1) {
                  this._bnd(child as Element, scope);
                  // CRITICAL FIX: Defer _w call to prevent stack overflow
                  nodesToWalk.push({ node: child as Element, scope });
                }
              });

              return wrapper;
            }
          } else {
            // Non-template elements: existing logic
            const node = this._cloneNode(tpl, true);
            // Remove m-if since we've already processed it
            if (mIfExpr) {
              node.removeAttribute('m-if');
            }

            if (isSyncComp) {
              // For sync components, we need to insert the node first,
              // call _comp which replaces it, then track the instance
              const tempMarker = this._ren.createComment('comp');
              this._ren.insertAfter(cm, tempMarker);
              tempMarker.after(node);
              const inst = this._comp(node, tag.toLowerCase(), scope);
              this._scopeMap.set(inst, scope);
              tempMarker.remove();
              return inst;
            } else if (isAsyncComp) {
              // For async components, insert and let _asyncComp handle it
              const tempMarker = this._ren.createComment('async');
              this._ren.insertAfter(cm, tempMarker);
              tempMarker.after(node);
              this._asyncComp(node, tag.toLowerCase(), scope);
              // For async, we track the marker's next sibling (fallback or loaded component)
              const tracked = tempMarker.nextSibling || node;
              this._scopeMap.set(tracked, scope);
              tempMarker.remove();
              return tracked;
            } else {
              this._scopeMap.set(node, scope);
              this._bnd(node, scope);
              // CRITICAL FIX: Defer _w call to prevent stack overflow
              nodesToWalk.push({ node, scope });
              return node;
            }
          }
        },

        updateNode: (node, item, index) => {
          const scope = this._scopeMap.get(node);
          if (scope) {
            let processedItem = item;
            if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
              processedItem = this._r(processedItem);
            }
            scope[alias] = processedItem;
            // CRITICAL FIX: Ensure index updates trigger reactivity
            // When list order changes, child text nodes using {{ index }} must update
            // Force reactivity by deleting then re-setting to trigger proxy set trap
            if (idxAlias) {
              if (scope[idxAlias] !== index) {
                // Use delete + set pattern to ensure reactive notification
                delete scope[idxAlias];
                scope[idxAlias] = index;
              }
            }

            // CRITICAL FIX #8: Nested m-for Scope Staleness (Iterative Version)
            // When parent scopes update, child scopes (nested loops) need to refresh
            // Child scopes are created via Object.create(parentScope), so they should
            // see changes through the prototype chain. However, reactive proxies may
            // not properly propagate notifications through prototypes in all cases.
            // Force a refresh by triggering reactivity on the parent scope.
            //
            // PERFORMANCE FIX: Use iterative traversal instead of recursion
            // to prevent stack overflow on deeply nested structures (1000+ levels)
            const refreshNestedScopes = (startNode) => {
              if (!startNode || startNode.nodeType !== 1) return;

              // Use stack-based iteration to avoid call stack overflow
              const stack = [startNode];

              while (stack.length > 0) {
                const node = stack.pop();
                if (!node || node.nodeType !== 1) continue;

                let child = node.firstChild;
                while (child) {
                  if (child.nodeType === 1) {
                    const childScope = this._scopeMap.get(child);
                    // Check if this child scope has our scope as its prototype
                    if (childScope && Object.getPrototypeOf(childScope) === scope) {
                      // Trigger a reactivity refresh by accessing a property
                      // This forces the reactive system to re-track dependencies
                      // Use a safe property that won't interfere with user code
                      const _dummy = childScope[alias];
                    }
                    // Push child onto stack for iterative processing
                    stack.push(child);
                  }
                  child = child.nextSibling;
                }
              }
            };
            refreshNestedScopes(node);
          }
        },

        removeNode: (node) => {
          // CRITICAL FIX: Handle virtual containers (for strict parents like <table>)
          if (node._isVirtualContainer) {
            // Kill and remove all nodes in the virtual container
            node._nodes.forEach(n => {
              this._kill(n);
              if (n.parentNode) n.remove();
            });
          } else {
            this._kill(node);
            node.remove();
          }
        },

        // Optional: Check if item should be kept (for m-if filtering)
        shouldKeep: ifFn ? (item, index, scope) => {
          try {
            return !!ifFn(this.s, scope);
          } catch (err) {
            this._handleError(err, scope);
            return false;
          }
        } : null
      };

      // Use centralized reconciliation logic
      const result = reconcileKeyedList({
        oldRows: rows,
        oldKeys: oldKeys,
        rawList: raw,
        config: config,
        engine: this,
        marker: cm
      });

      rows = result.rows;
      oldKeys = result.keys;

      // CRITICAL FIX: Process deferred walks iteratively to prevent stack overflow
      // All nodes created during reconciliation are now walked in a flat loop
      // This prevents O(N) stack depth for large lists with nested structure
      for (const { node, scope } of nodesToWalk) {
        this._w(node, scope);
      }

      // CRITICAL FIX #4: m-ref Array Order Desync
      // After DOM reconciliation reorders nodes, m-ref arrays must be updated to match
      // Without this fix, refs[0] points to the wrong element after sorting
      // Rebuild all affected ref arrays in the new DOM order
      const refArraysToUpdate = new Map(); // refName -> Set of nodes in this list

      // Find all ref arrays that contain nodes from this list
      result.keys.forEach((key, index) => {
        const rowData = result.rows.get(key);
        if (!rowData) return;

        const node = rowData.node;
        // Check all ref arrays to see if this node is in any of them
        for (const refName in this._refs) {
          const refValue = this._refs[refName];
          if (Array.isArray(refValue) && refValue.includes(node)) {
            if (!refArraysToUpdate.has(refName)) {
              refArraysToUpdate.set(refName, []);
            }
            refArraysToUpdate.get(refName).push({ node, index });
          }
        }
      });

      // Rebuild each affected ref array in DOM order
      refArraysToUpdate.forEach((nodeList, refName) => {
        // Sort by index to get DOM order
        nodeList.sort((a, b) => a.index - b.index);
        const orderedNodes = nodeList.map(item => item.node);

        // CRITICAL FIX: Do NOT clobber user state arrays
        // Only update this._refs (internal reference storage)
        // Modifying this.s[refName] destroys custom properties and causes data loss
        // Example: app.s.myRefs.customProp = 'meta' would be lost
        // Users should manage reactive state explicitly if needed
        this._refs[refName] = orderedNodes;

        // REMOVED: Automatic state array clobbering
        // if (refName in this.s && Array.isArray(this.s[refName])) {
        //   const raw = this.toRaw(this.s[refName]);
        //   raw.length = 0;
        //   raw.push(...orderedNodes);
        // }
      });
    });

    eff.o = o;
    this._reg(cm, () => {
      // Kill effects and REMOVE nodes from DOM
      // This is critical for m-if + m-for combinations where
      // removing the m-for comment marker must also remove list items
      rows.forEach(({ node }) => {
        // CRITICAL FIX: Handle virtual containers (for strict parents like <table>)
        if (node._isVirtualContainer) {
          node._nodes.forEach(n => {
            this._kill(n);
            if (n.parentNode) n.remove();
          });
        } else {
          this._kill(node);
          if (node.parentNode) {
            node.remove();
          }
        }
      });
      eff.kill();
    });
  },

  /**
   * Text interpolation: {{ expr }}
   */
  _txt(n, o) {
    const raw = n.nodeValue;
    if (raw.startsWith('{{') && raw.endsWith('}}') && raw.indexOf('{{', 2) < 0) {
      const fn = this._fn(raw.slice(2, -2));
      let prev;
      const e = this.createEffect(() => {
        try {
          const v = fn(this.s, o);
          const next = v == null ? '' : String(v);
          if (next !== prev) { prev = next; n.nodeValue = next; }
        } catch (err) {
          this._handleError(err, o);
        }
      });
      e.o = o;
      this._reg(n, e.kill);
      return;
    }
    const pts = raw.split(/(\{\{.*?\}\})/g).map(x =>
      x.startsWith('{{') ? this._fn(x.slice(2, -2)) : x
    );
    let prev;
    const e = this.createEffect(() => {
      try {
        let out = '';
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          out += typeof p === 'function' ? (p(this.s, o) ?? '') : p;
        }
        if (out !== prev) { prev = out; n.nodeValue = out; }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(n, e.kill);
  },

  /**
   * Attribute binding: :attr="expr"
   */
  _at(el, att, exp, o) {
    // CRITICAL SECURITY FIX #2: XSS via Dynamic Attribute Binding
    // Block event handler attributes (onclick, onload, onmouseover, etc.)
    // Without this check, :onclick="malicious" or :[userAttr]="code" bypasses expression security
    // The browser's DOM event system executes the attribute value as JavaScript
    const attrLower = att.toLowerCase();
    if (attrLower.startsWith('on')) {
      throw new Error(
        `Reflex: SECURITY ERROR - Cannot bind event handler attribute '${att}'.\n` +
        `Event handlers must use @ syntax (e.g., @click="handler") for security.\n` +
        `This prevents XSS attacks via dynamic attribute names.`
      );
    }

    const fn = this._fn(exp);
    let prev;
    // CRITICAL SECURITY FIX: Validate URL attributes
    // CRITICAL FIX: Remove srcdoc from URL validation - it contains HTML, not URLs
    // srcdoc requires HTML sanitization (DOMPurify), not URL validation
    // data (object/embed) can point to javascript: URIs or malicious content
    const isUrlAttr = att === 'href' || att === 'src' || att === 'action' ||
                      att === 'formaction' || att === 'xlink:href' || att === 'data';
    // srcdoc requires separate HTML sanitization
    const isSrcdoc = att === 'srcdoc';

    // Handle kebab-case to camelCase conversion for SVG attributes
    // e.g., :view-box -> viewBox
    let attrName = att;
    if (att.includes('-')) {
      attrName = att.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    // SVG attributes that should always use setAttribute (not property access)
    // These are read-only properties that return SVGAnimated* objects
    const isSVGAttr = attrName === 'viewBox' || attrName === 'preserveAspectRatio' ||
                      attrName === 'transform' || attrName === 'gradientTransform' ||
                      attrName === 'patternTransform';

    // Cache initial static class/style to preserve when binding dynamic values
    // This prevents the "class wipeout" bug where :class overwrites static classes
    // CRITICAL FIX: During hydration, skip initial class/style capture since those values
    // come from server-side rendering, not static markup. Capturing them causes duplication.
    const initialClass = (att === 'class' && !this._hydrateMode) ? el.className : null;
    const initialStyle = (att === 'style' && !this._hydrateMode) ? el.getAttribute('style') || '' : null;

    // Track previous style keys for cleanup (fixes "stale style" bug)
    // When style object changes, we need to explicitly remove old properties
    let prevStyleKeys = null;

    const e = this.createEffect(() => {
      try {
        let v = fn(this.s, o);

        // SECURITY FIX: Validate URL protocols using allowlist instead of blocklist
        // Only allow known-safe protocols (http, https, mailto, tel, etc.) and relative URLs
        // CRITICAL: Decode HTML entities BEFORE checking regex to prevent bypass attacks
        // Attack: :href="'j&#97;vascript:alert(1)'"
        //   - Regex sees: j&#97;vascript: (passes as unrecognized protocol)
        //   - Browser sees: javascript:alert(1) (executes!)
        if (isUrlAttr && v != null && typeof v === 'string') {
          // Decode HTML entities by using a temporary DOM element
          // This catches ALL entity forms: &#97; &#x61; &amp; etc.
          // CRITICAL FIX #5: SSR Attribute Binding XSS Bypass
          // Browsers decode entities even without semicolons: &#106avascript: -> javascript:
          // The SSR fallback must match browser behavior to prevent bypasses
          let decodedUrl = v;
          try {
            // Create a temporary element to decode entities
            const decoder = document.createElement('textarea');
            decoder.innerHTML = v;
            decodedUrl = decoder.value;
          } catch (e) {
            // If DOM is not available (SSR), do manual decoding of common entities
            // CRITICAL: Make semicolon optional (;?) to match browser lenient parsing
            // Browsers decode &#106avascript: as javascript: even without semicolon
            decodedUrl = v
              .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
              .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&apos;/g, "'")
              .replace(/&nbsp;/g, '\u00A0')
              // Decode more named entities to match browser behavior
              .replace(/&colon;/g, ':')
              .replace(/&sol;/g, '/')
              .replace(/&quest;/g, '?')
              .replace(/&equals;/g, '=')
              .replace(/&num;/g, '#');
          }

          // Check the DECODED URL against our allowlist
          const isSafe = RELATIVE_URL_RE.test(decodedUrl) || SAFE_URL_RE.test(decodedUrl);
          if (!isSafe) {
            console.warn('Reflex: Blocked unsafe URL protocol in', att + ':', v, '(decoded:', decodedUrl + ')');
            v = 'about:blank';
          }
        }

        // CRITICAL FIX: srcdoc validation - requires HTML sanitization, not URL validation
        // srcdoc attribute contains HTML content that can execute scripts
        // Apply DOMPurify sanitization similar to m-html
        if (isSrcdoc && v != null && typeof v === 'string') {
          const purify = this.cfg.domPurify;
          if (purify && typeof purify.sanitize === 'function') {
            v = purify.sanitize(v);
          } else if (Object.prototype.hasOwnProperty.call(this.cfg, 'sanitize') && this.cfg.sanitize === false) {
            // Explicit opt-out - warn but allow (developer responsibility)
            console.warn(
              'Reflex Security Warning: srcdoc binding without sanitization.\n' +
              'This can lead to XSS if srcdoc contains user-provided content.\n' +
              'Configure DOMPurify: app.configure({ domPurify: DOMPurify })'
            );
          } else {
            // Default behavior: require DOMPurify for srcdoc (fail closed)
            throw new Error(
              'Reflex SECURITY ERROR: srcdoc attribute requires DOMPurify for safe HTML.\n' +
              'srcdoc accepts HTML content that can execute scripts.\n\n' +
              'Solution:\n' +
              '  1. Install DOMPurify: npm install dompurify\n' +
              '  2. Configure: app.configure({ domPurify: DOMPurify })\n' +
              '  3. Import: import DOMPurify from \'dompurify\'\n\n' +
              'Alternative (for trusted HTML only):\n' +
              '  - Explicitly opt-out: { sanitize: false } (UNSAFE)\n\n' +
              'Do NOT use srcdoc with user-provided content without DOMPurify.'
            );
          }
        }

        if (att === 'class') {
          const dynamicClass = this._cls(v);
          // Merge static class with dynamic class to prevent wipeout
          const next = initialClass && dynamicClass
            ? `${initialClass} ${dynamicClass}`
            : (initialClass || dynamicClass);
          if (next !== prev) { prev = next; el.className = next; }
        } else if (att === 'style') {
          // CRITICAL FIX: Handle object-style bindings to prevent "stale style" bug
          // When style changes from { color: 'red' } to { background: 'blue' },
          // we must explicitly clear 'color' or it persists forever
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            // CRITICAL FIX: Zombie Styles - Clear ALL styles when transitioning from string to object
            // If prevStyleKeys is null, we were previously using cssText (string mode)
            // We must clear all inline styles before applying the object styles
            if (prevStyleKeys === null) {
              // Clear all inline styles to prevent zombie styles from string mode
              el.style.cssText = '';
            }

            // Track current keys to remove stale ones
            const currentKeys = new Set(Object.keys(v));

            // Clear previous keys that aren't in the new object
            if (prevStyleKeys) {
              for (const key of prevStyleKeys) {
                if (!currentKeys.has(key)) {
                  // Handle CSS variables (--custom-props) and regular properties
                  const cssProp = key.startsWith('--')
                    ? key
                    : key.replace(/([A-Z])/g, '-$1').toLowerCase();
                  (el as HTMLElement).style.setProperty(cssProp, '');
                }
              }
            }

            // Apply new styles
            for (const key in v) {
              const val = v[key];
              // CRITICAL FIX: CSS Variables (--custom-props) must use setProperty
              // CSS custom properties cannot be set via property assignment:
              // - el.style['--bg'] = 'red' FAILS (returns undefined, doesn't set)
              // - el.style.setProperty('--bg', 'red') WORKS
              // For regular properties, convert camelCase to kebab-case
              // For CSS variables (already start with --), preserve as-is
              const cssProp = key.startsWith('--')
                ? key
                : key.replace(/([A-Z])/g, '-$1').toLowerCase();

              if (val != null && val !== false) {
                // CRITICAL FIX: !important Style Failure
                // setProperty doesn't parse !important from value string
                // We must detect it and pass as the 3rd argument
                let strVal = String(val);

                // CRITICAL SECURITY FIX: CSS Injection via url() in style properties
                // CSS properties that accept URLs (backgroundImage, borderImage, etc.) can execute
                // JavaScript in older browsers or when used with javascript: URIs
                // We must validate URLs inside url() functions
                // CRITICAL: Include 'background' shorthand to prevent bypass attacks
                const urlSensitiveProps = ['background', 'background-image', 'border-image', 'border-image-source',
                  'list-style-image', 'content', 'cursor', 'mask', 'mask-image', '-webkit-mask-image'];

                if (urlSensitiveProps.includes(cssProp)) {
                  // Extract URLs from url() functions: url("...") or url('...') or url(...)
                  const urlMatches = strVal.matchAll(/url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi);
                  for (const match of urlMatches) {
                    const url = match[2];
                    // Validate the URL using the same logic as href/src attributes
                    const isSafe = RELATIVE_URL_RE.test(url) || SAFE_URL_RE.test(url);
                    if (!isSafe) {
                      console.warn(
                        `Reflex: Blocked unsafe URL in style property "${key}": ${url}\n` +
                        'Only http://, https://, mailto:, tel:, sms:, and relative URLs are allowed.\n' +
                        'To prevent CSS injection attacks, dangerous protocols are blocked.'
                      );
                      // Replace the entire url() with a safe placeholder
                      strVal = strVal.replace(match[0], 'none');
                    }
                  }
                }

                const hasImportant = strVal.includes('!important');
                if (hasImportant) {
                  // Remove !important from value and pass as priority argument
                  const cleanVal = strVal.replace(/\s*!important\s*$/, '').trim();
                  (el as HTMLElement).style.setProperty(cssProp, cleanVal, 'important');
                } else {
                  (el as HTMLElement).style.setProperty(cssProp, strVal);
                }
              } else {
                (el as HTMLElement).style.setProperty(cssProp, '');
              }
            }

            // Update tracked keys
            prevStyleKeys = currentKeys;
          } else {
            // String-style binding: use cssText (original behavior)
            const dynamicStyle = this._sty(v);
            // Merge static style with dynamic style to prevent fragmentation
            const next = initialStyle && dynamicStyle
              ? `${initialStyle}${dynamicStyle}`
              : (initialStyle || dynamicStyle);
            if (next !== prev) { prev = next; el.style.cssText = next; }
            // Clear tracked keys since we're using cssText
            prevStyleKeys = null;
          }
        } else if (isSVGAttr) {
          // SVG attributes must use setAttribute with proper camelCase
          const next = v === null || v === false ? null : String(v);
          if (next !== prev) {
            prev = next;
            next === null ? el.removeAttribute(attrName) : el.setAttribute(attrName, next);
          }
        } else if (att in el && !isSVGAttr) {
          // CRITICAL FIX: Read-Only Property Crash
          // Many DOM properties are read-only (e.g., input.list, video.duration, element.clientTop)
          // In strict mode (ES modules), assigning to read-only properties throws TypeError
          // Use try-catch to gracefully fall back to setAttribute for read-only properties
          try {
            // CRITICAL FIX: Object Identity for Checkbox/Radio Values
            // When binding :value="obj" to a checkbox or radio, the DOM stringifies objects to "[object Object]"
            // This makes it impossible to match objects in m-model array binding since all objects become identical strings
            // Solution: Store the original object reference as _rx_value_ref for later retrieval by m-model
            if (att === 'value' && v !== null && typeof v === 'object' &&
                (el.type === 'checkbox' || el.type === 'radio')) {
              (el as any)._rx_value_ref = v;
            }
            el[att] = v ?? '';
          } catch (err) {
            // Property is read-only, fall back to setAttribute
            const next = v === null || v === false ? null : String(v ?? '');
            if (next !== prev) {
              prev = next;
              next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
            }
          }
        } else {
          // ARIA boolean attributes need explicit "true"/"false" string values
          // They should not be removed when value is false
          const isAriaBoolAttr = att.startsWith('aria-') && (
            att === 'aria-expanded' || att === 'aria-pressed' || att === 'aria-checked' ||
            att === 'aria-selected' || att === 'aria-hidden' || att === 'aria-disabled' ||
            att === 'aria-grabbed' || att === 'aria-busy' || att === 'aria-invalid' ||
            att === 'aria-readonly' || att === 'aria-required' || att === 'aria-current' ||
            att === 'aria-haspopup' || att === 'aria-modal'
          );

          let next;
          if (isAriaBoolAttr && typeof v === 'boolean') {
            next = String(v);  // Convert boolean to "true" or "false" string
          } else {
            next = v === null || v === false ? null : String(v);
          }

          if (next !== prev) {
            prev = next;
            next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
          }
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * HTML binding: m-html="expr"
   *
   * CRITICAL SECURITY NOTE:
   * m-html is DANGEROUS and can lead to XSS attacks if used with untrusted content.
   *
   * Requirements:
   * 1. DOMPurify must be configured: app.configure({ domPurify: DOMPurify })
   * 2. Never use m-html with user-provided content
   * 3. Consider using m-text instead for user content
   *
   * Without DOMPurify, m-html will THROW AN ERROR to prevent silent XSS vulnerabilities.
   */
  _html(el, exp, o) {
    const fn = this._fn(exp);
    let prev;
    const self = this;
    const e = this.createEffect(() => {
      try {
        const v = fn(self.s, o);
        let html = v == null ? '' : String(v);

        // CRITICAL SECURITY FIX #1: Regex-based HTML Sanitization Bypass
        // ALWAYS require DOMPurify for m-html (fail closed by default)
        // Regex-based sanitization has been removed as it's fundamentally insecure
        const purify = self.cfg.domPurify;
        if (purify && typeof purify.sanitize === 'function') {
          html = purify.sanitize(html);
        } else if (Object.prototype.hasOwnProperty.call(self.cfg, 'sanitize') && self.cfg.sanitize === false) {
          // CRITICAL SECURITY FIX: Prototype Pollution Prevention
          // Use hasOwnProperty to ensure 'sanitize' is a direct property of cfg, not inherited
          // This prevents bypass via: Object.prototype.sanitize = false
          // Explicit opt-out of sanitization (UNSAFE - developer takes responsibility)
          // Only warn once per instance to avoid console spam
          if (!self._htmlWarningShown) {
            self._htmlWarningShown = true;
            console.error(
              'Reflex SECURITY ERROR: m-html is being used without sanitization.\n' +
              'This is a CRITICAL XSS vulnerability if used with user-provided content.\n' +
              'You have explicitly disabled sanitization with { sanitize: false }.\n' +
              'NEVER use m-html with user-provided content in this mode.\n\n' +
              'To fix: app.configure({ domPurify: DOMPurify }) // remove sanitize: false\n' +
              'Install: npm install dompurify\n' +
              'See: https://github.com/cure53/DOMPurify'
            );
          }
        } else {
          // Default behavior: require DOMPurify (fail closed)
          throw new Error(
            'Reflex SECURITY ERROR: m-html requires DOMPurify for safe HTML rendering.\n' +
            'Regex-based sanitization is insecure and has been removed.\n\n' +
            'Solution:\n' +
            '  1. Install DOMPurify: npm install dompurify\n' +
            '  2. Configure: app.configure({ domPurify: DOMPurify })\n' +
            '  3. Import: import DOMPurify from \'dompurify\'\n\n' +
            'Alternative (for trusted HTML only):\n' +
            '  - Use m-text for user content (safer)\n' +
            '  - Explicitly opt-out: { sanitize: false } (UNSAFE)\n\n' +
            'Do NOT use m-html with user-provided content without DOMPurify.'
          );
        }

        // CRITICAL FIX: Destructive innerHTML Hydration Prevention
        // During hydration (this._hydrateMode), compare current innerHTML with new value
        // Only update if they differ to prevent destroying iframe state, focus, etc.
        // CRITICAL FIX: Normalize HTML before comparison to avoid false mismatches
        // Browsers normalize HTML (add quotes, reorder attributes, lowercase tags)
        // Example: <div class='foo'> becomes <div class="foo">
        // Without normalization, we'd destroy and re-parse identical HTML
        if (self._hydrateMode) {
          // Normalize both HTMLs by parsing them through the browser
          // This ensures we compare apples to apples
          const currentHTML = el.innerHTML;

          // Fast path: if strings match exactly, skip normalization
          if (currentHTML === html) {
            prev = html;
            return;
          }

          // Normalize new HTML by creating a temporary element
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = html;
          const normalizedNew = tempDiv.innerHTML;

          if (currentHTML === normalizedNew) {
            // Content matches after normalization - skip the destructive innerHTML write
            prev = html;
            return;
          }
        }

        if (html !== prev) {
          prev = html;
          // CRITICAL FIX: m-html Memory Leak - Clean up child resources before innerHTML
          // innerHTML blindly replaces DOM content without cleanup, leaking:
          // - Reactive effects attached to child elements
          // - Event listeners registered via _reg
          // - Component instances and their resources
          // We must call _kill on all children to clean up Reflex resources
          let child = el.firstChild;
          while (child) {
            const next = child.nextSibling;
            if (child.nodeType === 1) {
              // Kill all Reflex resources attached to this element tree
              this._kill(child);
            }
            child = next;
          }
          el.innerHTML = html;
        }
      } catch (err) {
        self._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Show/hide: m-show="expr"
   *
   * CRITICAL FIX #9: m-show should respect CSS classes and media queries
   *
   * Previous implementation used setProperty('display', value, 'important') which
   * permanently overrode CSS classes and media queries, breaking responsive layouts.
   *
   * New approach:
   * - When hiding: Set display: none without !important (sufficient for most cases)
   * - When showing: Remove the inline display style entirely, letting CSS take over
   * - This allows CSS classes and media queries to work correctly
   * - If CSS already has display: none, that will be respected
   */
  _show(el, exp, o, trans) {
    const fn = this._fn(exp);
    const d = el.style.display === 'none' ? '' : el.style.display;
    let prev, transitioning = false;

    const e = this.createEffect(() => {
      try {
        const show = !!fn(this.s, o);
        const next = show ? d : 'none';

        if (next !== prev && !transitioning) {
          if (trans && prev !== undefined) {
            transitioning = true;
            if (show) {
              // CRITICAL FIX #9: Remove inline display to let CSS take over
              // This allows CSS classes and media queries to control the display type
              if (d) {
                el.style.display = d;
              } else {
                el.style.display = '';
              }
              this._runTrans(el, trans, 'enter', () => { transitioning = false; });
            } else {
              this._runTrans(el, trans, 'leave', () => {
                // Hide element - use regular style property (no !important)
                el.style.display = 'none';
                transitioning = false;
              });
            }
          } else {
            // CRITICAL FIX #9: Don't use !important to allow CSS to work
            if (next === 'none') {
              // Hide element
              el.style.display = 'none';
            } else if (next) {
              // Show with specific display type
              el.style.display = next;
            } else {
              // Show and let CSS control display type
              el.style.display = '';
            }
          }
          prev = next;
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Two-way binding: m-model="expr"
   */
  _mod(el, exp, o, modifiers = []) {
    const fn = this._fn(exp);
    const type = (el.type || '').toLowerCase();
    const isChk = type === 'checkbox';
    const isRadio = type === 'radio';
    // CRITICAL FIX #8: Support .number modifier on text inputs
    // Previous bug: Only checked type === 'number' || type === 'range'
    // This ignored the .number modifier on text inputs (m-model.number on type="text")
    // Fix: Also check if 'number' modifier is present
    const isNum = type === 'number' || type === 'range' || modifiers.includes('number');
    const isMultiSelect = type === 'select-multiple';
    const isLazy = modifiers.includes('lazy');
    // CRITICAL FIX #5: m-model File Input Crash
    // File inputs have a read-only .value property (security restriction)
    // Attempting to set it throws an error or fails silently
    // For file inputs, we can only read .files, not set .value
    const isFile = type === 'file';
    if (isFile) {
      // CRITICAL FIX: Prevent warning spam by only logging once per element
      // Use WeakSet to track which elements have been warned
      if (!this._fileInputsWarned.has(el)) {
        this._fileInputsWarned.add(el);
        console.warn(
          'Reflex: m-model is not supported on file inputs (security restriction).\n' +
          'Use @change="handler" and access el.files instead.'
        );
      }
      return; // Skip m-model binding for file inputs
    }
    // CRITICAL FIX: Unsupported contenteditable
    // Elements with contenteditable="true" use innerText/innerHTML, not value
    const isContentEditable = el.contentEditable === 'true';

    const e = this.createEffect(() => {
      try {
        // CRITICAL FIX #5: Dynamic Type Switching Protection
        // Check if the input has dynamically changed to type="file"
        // File inputs have read-only .value, so setting it throws InvalidStateError
        const currentType = (el.type || '').toLowerCase();
        if (currentType === 'file') {
          // Type changed to file - skip value assignment to prevent crash
          // The initial isFile check above prevents initial binding, but this
          // prevents crashes when type changes dynamically via :type binding
          return;
        }

        const v = fn(this.s, o);
        if (isContentEditable) {
          // contenteditable elements use innerText (or innerHTML if .html modifier is used)
          const useHTML = modifiers.includes('html');
          let next = v == null ? '' : String(v);
          if (useHTML) {
            // CRITICAL SECURITY FIX #1: Require DOMPurify for m-model.html (fail closed)
            // Regex-based sanitization has been removed as it's fundamentally insecure
            const purify = this.cfg.domPurify;
            if (purify && typeof purify.sanitize === 'function') {
              next = purify.sanitize(next);
              if (el.innerHTML !== next) el.innerHTML = next;
            } else if (Object.prototype.hasOwnProperty.call(this.cfg, 'sanitize') && this.cfg.sanitize === false) {
              // CRITICAL SECURITY FIX: Prototype Pollution Prevention
              // Use hasOwnProperty to ensure 'sanitize' is a direct property of cfg, not inherited
              // This prevents bypass via: Object.prototype.sanitize = false
              // Explicit opt-out - NEVER use with user content
              console.error(
                'Reflex SECURITY ERROR: m-model.html used without sanitization.\n' +
                'This is extremely dangerous with user-provided content.'
              );
              if (el.innerHTML !== next) el.innerHTML = next;
            } else {
              // Default behavior: require DOMPurify (fail closed)
              throw new Error(
                'Reflex: SECURITY ERROR - m-model.html requires DOMPurify.\n' +
                'Configure it with: app.configure({ domPurify: DOMPurify })\n' +
                'Install: npm install dompurify\n' +
                'Or disable sanitization (UNSAFE): app.configure({ sanitize: false })'
              );
            }
          } else {
            if (el.innerText !== next) el.innerText = next;
          }
        } else if (isChk) {
          // Handle checkbox array binding
          if (Array.isArray(v)) {
            // CRITICAL FIX: Object Identity for Checkbox Values
            // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
            // which makes all objects appear identical. Use _rx_value_ref to get the original object.
            const elValue = (el as any)._rx_value_ref !== undefined ? (el as any)._rx_value_ref : el.value;
            // Unwrap reactive proxy to get the raw object for identity comparison
            const rawElValue = getRawValue(elValue);
            el.checked = v.some(item => {
              // For objects, use identity comparison on raw (unwrapped) values
              // This handles cases where both are reactive proxies of the same object
              if (item !== null && typeof item === 'object') {
                const rawItem = getRawValue(item);
                return rawItem === rawElValue;
              }
              // For primitives, use type coercion to match DOM string values
              // Example: array [1, 2] should match <input value="1">
              return String(item) === String(elValue);
            });
          } else {
            el.checked = !!v;
          }
        } else if (isRadio) {
          // Radio button: check if value matches model
          el.checked = String(v) === String(el.value);
        } else if (isMultiSelect) {
          // For multi-select, v should be an array of selected values
          const selectedValues = Array.isArray(v) ? v : [];
          // Update the selected options
          // CRITICAL FIX: DOM option.value is always a string, but model data might contain numbers
          // Use String() conversion to handle type coercion (e.g., [1, 2] should match <option value="1">)
          const options = el.options;
          for (let i = 0; i < options.length; i++) {
            options[i].selected = selectedValues.some(val => String(val) === options[i].value);
          }
        } else if (isNum) {
          // For number inputs, avoid cursor jumping by comparing loosely
          // Allow "1." to equal "1" to prevent interrupting user input
          const next = v == null ? '' : String(v);
          if (el.value !== next && parseFloat(el.value) !== v) {
            el.value = next;
          }
        } else {
          const next = v == null ? '' : String(v);
          if (el.value !== next) el.value = next;
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);

    // CRITICAL FIX: IME Composition Support (Chinese/Japanese/Korean input)
    // Track composition state to prevent updates during IME composition
    // Without this, input events fire on every keystroke (e.g., "h", "ha", "han")
    // causing state updates that abort the composition, making it impossible to type
    let isComposing = false;

    const up = () => {
      // CRITICAL: Skip update if IME composition is in progress
      if (isComposing) return;

      let v;
      if (isContentEditable) {
        // contenteditable elements use innerText (or innerHTML if .html modifier is used)
        const useHTML = modifiers.includes('html');
        v = useHTML ? el.innerHTML : el.innerText;
      } else if (isChk) {
        // Handle checkbox array binding
        const currentValue = fn(this.s, o);
        if (Array.isArray(currentValue)) {
          // Toggle value in array with proper type coercion
          const arr = [...currentValue];
          // CRITICAL FIX: Object Identity for Checkbox Values
          // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
          // Use _rx_value_ref to get the original object reference
          const elValue = (el as any)._rx_value_ref !== undefined ? (el as any)._rx_value_ref : el.value;
          const isObjectValue = elValue !== null && typeof elValue === 'object';
          // Unwrap reactive proxy for identity comparison
          const rawElValue = getRawValue(elValue);

          // CRITICAL FIX #7: Object Identity Failure - Don't use String() for object comparison
          // String([{id:1}]) returns "[object Object]" for all objects, making them all match
          // Use strict equality for objects, type coercion only for primitives
          const idx = arr.findIndex(item => {
            // If both are objects, use identity comparison on raw (unwrapped) values
            if (item !== null && typeof item === 'object') {
              const rawItem = getRawValue(item);
              return rawItem === rawElValue;
            }
            // For primitives, use type coercion to match DOM string values
            return String(item) === String(elValue);
          });
          if (el.checked && idx === -1) {
            // CRITICAL FIX: For object values, use the original object reference
            // This ensures the model array contains the actual object, not "[object Object]"
            if (isObjectValue) {
              arr.push(elValue);
            } else {
              // Try to preserve the original type if the array has a consistent type
              // If array contains numbers and value is numeric, push as number
              let valueToAdd: any = elValue;

              // CRITICAL FIX: Type inference for empty arrays
              // If array is empty, we can't infer from arr[0], so check if value is numeric
              let shouldCoerceToNumber = false;
              if (arr.length > 0) {
                // Array has values - use first element's type
                shouldCoerceToNumber = typeof arr[0] === 'number';
              } else {
                // Empty array - infer type from checkbox value itself
                // If the value is a valid number string, coerce to number
                // CRITICAL FIX #3: Checkbox Leading Zero Data Corruption
                // Don't coerce values with leading zeros or special formatting
                // "01" should remain "01", not become 1
                // Check: String(Number(value)) must equal the trimmed value
                const trimmed = String(elValue).trim();
                if (trimmed !== '' && !isNaN(Number(trimmed))) {
                  // Valid number, but check if coercion would lose information
                  // "01" -> Number("01") = 1 -> String(1) = "1" ≠ "01" (don't coerce)
                  // "1" -> Number("1") = 1 -> String(1) = "1" = "1" ✓ (coerce)
                  shouldCoerceToNumber = String(Number(trimmed)) === trimmed;
                } else {
                  shouldCoerceToNumber = false;
                }
              }

              if (shouldCoerceToNumber) {
                // CRITICAL FIX #9: Loose Number Conversion - Empty string becomes 0
                // Number("") and Number(" ") return 0, which is valid (not NaN)
                // But empty/whitespace checkbox values should be ignored, not converted to 0
                // Check for empty/whitespace strings BEFORE numeric conversion
                const trimmed = String(elValue).trim();
                if (trimmed === '') {
                  // Empty or whitespace value - skip adding to numeric array
                  console.warn(
                    `Reflex: Skipping empty checkbox value for numeric array binding.`
                  );
                  return;
                }
                // Now check for valid numeric conversion
                const numValue = Number(elValue);
                if (!isNaN(numValue)) {
                  valueToAdd = numValue;
                } else {
                  // Value is not numeric - warn and skip adding it to numeric array
                  console.warn(
                    `Reflex: Cannot add non-numeric value "${elValue}" to numeric array. ` +
                    'Skipping to prevent NaN pollution.'
                  );
                  // Don't add the value - keep the array unchanged
                  return;
                }
              }
              arr.push(valueToAdd);
            }
          } else if (!el.checked && idx !== -1) {
            arr.splice(idx, 1);
          }
          v = arr;
        } else {
          v = el.checked;
        }
      } else if (isRadio) {
        v = el.value;
      } else if (isNum) {
        // Handle badInput state
        if (el.validity && el.validity.badInput) {
          return; // Don't update if input is invalid
        }
        // CRITICAL FIX: Preserve intermediate number formats during typing
        // Don't parse values like "1.", "-", "0." that users type mid-input
        // These are valid intermediate states that should not update state
        // until the user finishes typing a complete number
        const raw = el.value;
        if (raw === '' || raw === null) {
          v = null;
        } else if (raw === '-' || raw.endsWith('.') || raw.endsWith('e') || raw.endsWith('e-') || raw.endsWith('e+')) {
          // Intermediate typing state - don't update state to prevent cursor jump
          return;
        } else {
          v = parseFloat(raw);
        }
      } else if (isMultiSelect) {
        // For multi-select, return array of selected values
        // CRITICAL FIX: Preserve number types (like checkbox array binding)
        // DOM values are always strings, but the model might contain numbers
        // Check the original array type and coerce if needed
        const currentValue = fn(this.s, o);

        // CRITICAL FIX: Empty Multi-Select Type Trap
        // If the array is empty, we can't infer type from currentValue[0]
        // Instead, check if ALL option values are numeric to infer the type
        // CRITICAL SECURITY FIX #8: m-model Type Confusion
        //
        // VULNERABILITY: Type inference from DOM options allows attackers to change model type
        // by injecting DOM options (e.g., via a separate vulnerability or SSR injection)
        // Example: model is initialized as string[], but DOM options are numeric, so type changes to number[]
        //
        // SOLUTION: Respect the initialization type of the model variable
        // Only infer from DOM if the model type is truly unknown (not initialized)
        // Default to strings to be safe (source of truth is the model, not the view)
        let shouldCoerceToNumber = false;

        if (Array.isArray(currentValue) && currentValue.length > 0) {
          // Array has values - use first element's type (TRUSTED source)
          shouldCoerceToNumber = typeof currentValue[0] === 'number';
        }
        // REMOVED: Do NOT infer type from DOM options for empty arrays
        // Empty array means no type information - default to strings (safer)
        // If user wants numbers, they should initialize with [0] or explicitly type cast

        // Fallback for environments without selectedOptions (e.g., happy-dom)
        let selectedValues;
        if (el.selectedOptions) {
          selectedValues = Array.from(el.selectedOptions).map(opt => opt.value);
        } else {
          selectedValues = Array.from(el.options)
            .filter(opt => opt.selected)
            .map(opt => opt.value);
        }

        // Coerce to numbers if the original array contained numbers or all options are numeric
        // CRITICAL FIX #8: Data Integrity - Whitespace Coercion to Zero
        // Number(" ") returns 0, which passes !isNaN check but corrupts data
        // Check for empty/whitespace strings BEFORE numeric conversion
        if (shouldCoerceToNumber) {
          v = selectedValues.map(val => {
            const trimmed = val.trim();
            // Empty or whitespace-only values should remain as strings, not become 0
            if (trimmed === '') return val;
            // Valid numeric conversion
            return !isNaN(Number(val)) ? Number(val) : val;
          });
        } else {
          v = selectedValues;
        }
      } else v = el.value;

      // CRITICAL FIX #3: Parse path with bracket notation support
      // Previous: exp.split('.') failed on paths like "list[0]" or "grid[1][2]"
      // Now: parsePath() handles both dot notation and bracket notation correctly
      const paths = parsePath(exp);
      const end = paths.pop();

      // Security: prevent prototype pollution
      if (UNSAFE_PROPS[end]) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', end);
        return;
      }

      let t = o && paths[0] in o ? o : this.s;
      for (const p of paths) {
        if (UNSAFE_PROPS[p]) {
          console.warn('Reflex: Blocked attempt to traverse unsafe property:', p);
          return;
        }
        if (t[p] == null) t[p] = {};
        else if (typeof t[p] !== 'object') {
          console.warn('Reflex: Cannot set nested property on non-object value at path:', p);
          return;
        }
        t = t[p];
      }

      // CRITICAL FIX #4: Scope Shadowing in m-model
      // When m-model is used inside m-for, the loop creates child scopes via Object.create(parent)
      // Simple assignment `t[end] = v` would create a shadow property on the child scope
      // instead of updating the parent, breaking two-way binding.
      // Solution: Walk up the prototype chain to find the owner of the property
      let owner = t;
      while (owner && !Object.prototype.hasOwnProperty.call(owner, end)) {
        const proto = Object.getPrototypeOf(owner);
        // Stop if we've reached the top of the chain or hit null/non-object
        if (!proto || typeof proto !== 'object') break;
        owner = proto;
      }
      // If we found an owner in the prototype chain that has this property, update it there
      // Otherwise, create the property on the current object (t)
      if (owner && Object.prototype.hasOwnProperty.call(owner, end)) {
        owner[end] = v;
      } else {
        t[end] = v;
      }
    };

    // IME composition event handlers
    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => {
      isComposing = false;
      // Trigger update after composition completes
      up();
    };

    // Determine event type based on element type and .lazy modifier
    let evt;
    if (isLazy) {
      evt = 'change'; // .lazy always uses 'change'
    } else {
      evt = isChk || isRadio || el.tagName === 'SELECT' ? 'change' : 'input';
    }

    el.addEventListener(evt, up);
    // Also listen to 'change' for inputs (unless already using it)
    if (evt !== 'change' && !isLazy) {
      el.addEventListener('change', up);
    }

    // Add IME composition listeners for text inputs
    if (evt === 'input' && !isChk && !isRadio) {
      el.addEventListener('compositionstart', onCompositionStart);
      el.addEventListener('compositionend', onCompositionEnd);
    }

    this._reg(el, () => {
      el.removeEventListener(evt, up);
      if (evt !== 'change' && !isLazy) {
        el.removeEventListener('change', up);
      }
      // Clean up IME composition listeners
      if (evt === 'input' && !isChk && !isRadio) {
        el.removeEventListener('compositionstart', onCompositionStart);
        el.removeEventListener('compositionend', onCompositionEnd);
      }
    });
  },

  /**
   * Event binding: @event.mod1.mod2="expr"
   * @param el - Element to bind event to
   * @param nm - Event name (e.g., "click")
   * @param exp - Expression to evaluate
   * @param o - Scope object
   * @param mod - Array of modifiers (e.g., ["stop", "prevent"])
   */
  _ev(el, nm, exp, o, mod = []) {
    let fn = this._fn(exp, true);

    // Parse debounce/throttle timing from modifiers
    const getDelay = (prefix) => {
      for (const m of mod) {
        if (m.startsWith(prefix)) return parseInt(m.slice(prefix.length), 10) || 300;
        const match = m.match(/^(\d+)(ms)?$/);
        if (match && mod.includes(prefix.slice(0, -1))) return parseInt(match[1], 10);
      }
      return mod.includes(prefix.slice(0, -1)) ? 300 : 0;
    };

    // Track timer IDs for cleanup to prevent memory leaks
    const timers: { debounce?: number | null; throttle?: number | null } = {};

    // Debounce modifier: @input.debounce.300ms="search"
    const debounceDelay = getDelay('debounce.');
    if (debounceDelay || mod.includes('debounce')) {
      const delay = debounceDelay || 300;
      const origFn = fn;
      timers.debounce = null;
      fn = (s, c, e) => {
        if (timers.debounce !== null) clearTimeout(timers.debounce);
        timers.debounce = setTimeout(() => {
          timers.debounce = null;
          origFn(s, c, e);
        }, delay) as any;
      };
      // Register cleanup to prevent memory leaks
      this._reg(el, () => {
        if (timers.debounce !== null) {
          clearTimeout(timers.debounce);
          timers.debounce = null;
        }
      });
    }

    // Throttle modifier: @scroll.throttle.100ms="onScroll"
    const throttleDelay = getDelay('throttle.');
    if (throttleDelay || mod.includes('throttle')) {
      const delay = throttleDelay || 300;
      const origFn = fn;
      let last = 0;
      timers.throttle = null;
      fn = (s, c, e) => {
        // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
        const now = performance.now();
        if (now - last >= delay) {
          last = now;
          origFn(s, c, e);
        }
      };
    }

    // Window/Document modifiers: @keydown.window="handleKey"
    if (mod.includes('window') || mod.includes('document')) {
      // SSR/Node.js compatibility: use renderer to get target
      let target;
      if (this._ren.isBrowser) {
        // Browser mode: use actual window/document
        target = mod.includes('window') ? window : document;
      } else {
        // Virtual/SSR mode: bind to the virtual root
        // VirtualRenderer doesn't have a 'window', but 'root' captures events
        target = this._ren.getRoot();
      }
      const self = this;
      const handler = (e) => {
        if (mod.includes('prevent')) e.preventDefault();
        if (mod.includes('stop')) e.stopPropagation();
        try {
          fn(self.s, o, e, el);
        } catch (err) {
          self._handleError(err, o);
        }
      };
      const opts: AddEventListenerOptions | undefined = mod.includes('once') ? { once: true } : undefined;
      target.addEventListener(nm, handler, opts);

      // CRITICAL LIFECYCLE FIX #9: Event Listener Leak (Window/Document)
      //
      // VULNERABILITY: If element is removed by external code (jQuery, D3, innerHTML=''),
      // the Reflex cleanup mechanism (_kill) is never triggered, leaking window/document listeners
      //
      // SOLUTION: Use FinalizationRegistry (modern browsers) to detect when element is GC'd
      // This ensures cleanup even if _kill is never called
      const cleanup = () => target.removeEventListener(nm, handler, opts);
      this._reg(el, cleanup);

      // Modern browsers: Use FinalizationRegistry for automatic cleanup
      if (typeof FinalizationRegistry !== 'undefined') {
        if (!this._globalListenerRegistry) {
          this._globalListenerRegistry = new FinalizationRegistry((cleanupFn) => {
            cleanupFn();
          });
        }
        // Register the element for cleanup when it's garbage collected
        this._globalListenerRegistry.register(el, cleanup);
      }

      return;
    }

    // Outside modifier: @click.outside="closeModal"
    if (mod.includes('outside')) {
      // SSR/Node.js compatibility: use renderer to get document root
      const docTarget = this._ren.isBrowser ? document : this._ren.getRoot();
      const self = this;
      const handler = (e) => {
        if (!el.contains(e.target) && e.target !== el) {
          if (mod.includes('prevent')) e.preventDefault();
          if (mod.includes('stop')) e.stopPropagation();
          try {
            fn(self.s, o, e, el);
          } catch (err) {
            self._handleError(err, o);
          }
        }
      };
      docTarget.addEventListener(nm, handler);
      this._reg(el, () => docTarget.removeEventListener(nm, handler));
      return;
    }

    // CRITICAL FIX: Non-bubbling events (focus, blur, scroll on some elements)
    // These events don't bubble, so they never reach the root listener
    // Must use direct binding instead of delegation
    const nonBubblingEvents = ['focus', 'blur', 'load', 'unload', 'scroll', 'mouseenter', 'mouseleave'];
    const isNonBubbling = nonBubblingEvents.includes(nm);

    // Use direct binding for .stop, .self, and non-bubbling events (delegation won't work for these)
    if (mod.includes('stop') || mod.includes('self') || isNonBubbling) {
      const self = this;
      const handler = (e) => {
        if (mod.includes('self') && e.target !== el) return;
        if (mod.includes('prevent')) e.preventDefault();
        if (mod.includes('stop')) e.stopPropagation();

        // Check key modifiers
        if (e.key) {
          if (mod.includes('enter') && e.key !== 'Enter') return;
          if (mod.includes('esc') && e.key !== 'Escape') return;
          if (mod.includes('space') && e.key !== ' ') return;
          if (mod.includes('tab') && e.key !== 'Tab') return;
        }
        if (mod.includes('ctrl') && !e.ctrlKey) return;
        if (mod.includes('alt') && !e.altKey) return;
        if (mod.includes('shift') && !e.shiftKey) return;
        if (mod.includes('meta') && !e.metaKey) return;

        try {
          fn(self.s, o, e, el);
        } catch (err) {
          self._handleError(err, o);
        }
      };

      const opts = mod.includes('once') ? { once: true } : undefined;
      el.addEventListener(nm, handler, opts);
      this._reg(el, () => el.removeEventListener(nm, handler, opts));
      return;
    }

    // Default: use event delegation
    if (!this._dh.has(nm)) {
      // CRITICAL FIX: Store handler function reference for removal during unmount
      const handler = (e) => this._hdl(e, nm);
      const eventData = { handlers: new WeakMap(), listener: handler };
      this._dh.set(nm, eventData);
      this._dr.addEventListener(nm, handler);
    }
    this._dh.get(nm).handlers.set(el, { f: fn, o, m: mod });
  },

  /**
   * Delegated event handler
   */
  _hdl(e, nm) {
    let t = e.target;
    while (t && t !== this._dr) {
      const h = this._dh.get(nm)?.handlers?.get(t);
      if (h) {
        const { f, o, m } = h;
        if (m.includes('self') && e.target !== t) { t = t.parentNode; continue; }

        // Check key modifiers
        // Key-specific modifiers (enter, esc, etc.)
        if (e.key) {
          if (m.includes('enter') && e.key !== 'Enter') { t = t.parentNode; continue; }
          if (m.includes('esc') && e.key !== 'Escape') { t = t.parentNode; continue; }
          if (m.includes('space') && e.key !== ' ') { t = t.parentNode; continue; }
          if (m.includes('tab') && e.key !== 'Tab') { t = t.parentNode; continue; }
        }
        // System key modifiers (ctrl, alt, shift, meta) - work with any event type
        if (m.includes('ctrl') && !e.ctrlKey) { t = t.parentNode; continue; }
        if (m.includes('alt') && !e.altKey) { t = t.parentNode; continue; }
        if (m.includes('shift') && !e.shiftKey) { t = t.parentNode; continue; }
        if (m.includes('meta') && !e.metaKey) { t = t.parentNode; continue; }

        if (m.includes('prevent')) e.preventDefault();
        if (m.includes('stop')) e.stopPropagation();

        // Wrap handler in try-catch for error handling
        try {
          f(this.s, o, e, t);
        } catch (err) {
          this._handleError(err, o);
        }

        if (m.includes('once')) this._dh.get(nm).handlers.delete(t);
        if (e.cancelBubble) return;
      }
      t = t.parentNode;
    }
  },

  /**
   * m-effect directive: run side effects when dependencies change
   *
   * IMPORTANT: Properly handles cleanup functions returned by effects.
   * When dependencies change, the previous cleanup is called before
   * the effect runs again. This prevents resource leaks.
   */
  _effect(el, exp, o) {
    // Use handler mode to get proper `this` binding from with(s){}
    const fn = this._fn(exp, true);
    const self = this;

    // Track the current cleanup function
    let currentCleanup = null;

    const e = this.createEffect(() => {
      // Call previous cleanup before running effect again
      if (typeof currentCleanup === 'function') {
        try {
          currentCleanup();
        } catch (err) {
          self._handleError(err, o);
        }
        currentCleanup = null;
      }

      try {
        const result = fn(self.s, o, null, el);
        // If effect returns a function, it's a cleanup callback
        if (typeof result === 'function') {
          currentCleanup = result;
        }
      } catch (err) {
        self._handleError(err, o);
      }
    });
    e.o = o;

    // Register final cleanup when element is removed
    this._reg(el, () => {
      if (typeof currentCleanup === 'function') {
        try {
          currentCleanup();
        } catch (err) {
          self._handleError(err, o);
        }
      }
      e.kill();
    });
  },

  /**
   * Apply custom directive
   *
   * IMPORTANT: Properly handles cleanup functions returned by directives.
   * When the directive value changes, the previous cleanup is called before
   * the directive runs again. This prevents resource leaks like accumulated
   * event listeners.
   */
  _applyDir(el, name, value, mods, o) {
    const dir = this._cd.get(name);
    if (!dir) return false;

    const fn = this._fn(value);
    const self = this;

    // Track the current cleanup function
    let currentCleanup = null;

    const e = this.createEffect(() => {
      // Call previous cleanup before running directive again
      if (typeof currentCleanup === 'function') {
        try {
          currentCleanup();
        } catch (err) {
          console.warn('Reflex: Error in directive cleanup:', err);
        }
        currentCleanup = null;
      }

      const binding = {
        value: fn(self.s, o),
        expression: value,
        modifiers: mods
      };
      const cleanup = dir(el, binding, self);
      if (typeof cleanup === 'function') {
        currentCleanup = cleanup;
      }
    });
    e.o = o;

    // Register final cleanup when element is removed
    this._reg(el, () => {
      if (typeof currentCleanup === 'function') {
        try {
          currentCleanup();
        } catch (err) {
          console.warn('Reflex: Error in directive cleanup:', err);
        }
      }
      e.kill();
    });
    return true;
  },

  /**
   * Convert class binding value to string
   *
   * CRITICAL: Array check MUST come before object check!
   * In JavaScript, Array.isArray([]) === true AND typeof [] === 'object'
   * If we check typeof first, arrays would be treated as objects:
   * - ['btn', 'active'] would become 'for (const k in arr)' → k='0', k='1'
   * - Result: class="0 1" instead of class="btn active"
   */
  _cls(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    // CRITICAL: Check Array BEFORE object to prevent array indices becoming class names
    if (Array.isArray(v)) return v.map(x => this._cls(x)).filter(Boolean).join(' ');
    // Object map: { btn: true, active: false } → 'btn'
    if (typeof v === 'object') return Object.keys(v).filter(k => v[k]).join(' ');
    return String(v);
  },

  /**
   * Sanitize CSS string to prevent javascript: URL injection
   * CRITICAL SECURITY FIX #4: CSS Injection via String Interpolation
   *
   * VULNERABILITY: Regex parsing of CSS is fragile and can be bypassed:
   * - Escaped sequences: background-image: u\rl(javascript:alert(1))
   * - Comment injection: url("javascript:alert(1) /*")
   * - Expression() for IE: style="width: expression(alert(1))"
   *
   * SOLUTION: Enhanced validation with CSS escape sequence handling
   */
  _sanitizeStyleString(cssText) {
    if (!cssText) return '';

    // CRITICAL: Detect and block CSS escape sequences in URLs
    // CSS allows backslash escapes like u\rl, java\script, etc.
    // We need to normalize these before validation
    const normalizeCSS = (css) => {
      // Remove CSS escape sequences: \XX (hex) and \X (single char)
      // This prevents u\rl(javascript:...) bypass
      return css.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (match, char) => {
        // If it's a hex escape, convert it
        if (/^[0-9a-f]{1,6}$/i.test(char.trim())) {
          return String.fromCharCode(parseInt(char.trim(), 16));
        }
        // Single character escape
        return char;
      });
    };

    const normalized = normalizeCSS(cssText);

    // Block dangerous CSS features entirely
    const dangerousPatterns = [
      /javascript:/i,           // javascript: protocol
      /data:/i,                 // data: URLs (can contain scripts)
      /vbscript:/i,             // VBScript (IE legacy)
      /expression\s*\(/i,       // CSS expression() (IE)
      /-moz-binding/i,          // XBL binding (Firefox)
      /behavior\s*:/i,          // IE behavior
      /@import/i,               // CSS @import (can load external malicious CSS)
      /\/\*.*\*\//              // CSS comments (can be used to hide attacks)
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(normalized) || pattern.test(cssText)) {
        console.error(
          `Reflex Security: BLOCKED dangerous CSS pattern in style binding.\n` +
          `Pattern: ${pattern}\n` +
          'CSS injection attempt prevented. Use object-style bindings for dynamic styles.'
        );
        return ''; // Return empty string to block the entire style
      }
    }

    // Validate url() functions
    // Match url() with proper handling of quotes and escapes
    const urlMatches = Array.from(normalized.matchAll(/url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi));

    let sanitized = cssText;
    for (const match of urlMatches) {
      const url = match[2];
      // Validate the URL using the same logic as href/src attributes
      const isSafe = RELATIVE_URL_RE.test(url) || SAFE_URL_RE.test(url);
      if (!isSafe) {
        console.error(
          `Reflex Security: BLOCKED unsafe URL in style binding: ${url}\n` +
          'Only http://, https://, mailto:, tel:, sms:, and relative URLs are allowed.\n' +
          'CSS injection attempt prevented.'
        );
        // Replace the entire url() with 'none'
        sanitized = sanitized.replace(match[0], 'none');
      }
    }

    return sanitized;
  },

  /**
   * Convert style binding value to string
   * CRITICAL FIX: Support Arrays (consistent with _cls)
   * CRITICAL SECURITY FIX: Validate URLs in string-based style bindings
   */
  _sty(v) {
    if (!v) return '';
    if (typeof v === 'string') {
      // CRITICAL SECURITY FIX: String path must also be sanitized
      // Previously only object bindings were validated, allowing bypass via:
      // :style="'background-image: url(javascript:alert(1))'"
      return this._sanitizeStyleString(v);
    }
    // CRITICAL: Check Array BEFORE object (same as _cls)
    // Arrays are objects, so typeof [] === 'object', but we need special handling
    if (Array.isArray(v)) {
      // Recursively process array elements and merge styles
      return v.map(x => this._sty(x)).filter(Boolean).join('');
    }
    if (typeof v === 'object') {
      let s = '';
      for (const k in v) {
        const val = v[k];
        if (val != null && val !== false) {
          // Handle CSS variables (--custom-props) - preserve as-is
          // For regular properties, convert camelCase to kebab-case
          const prop = k.startsWith('--')
            ? k
            : k.replace(/([A-Z])/g, '-$1').toLowerCase();
          s += prop + ':' + val + ';';
        }
      }
      return s;
    }
    return String(v);
  },

  /**
   * Run transition with renderer abstraction.
   *
   * Checks if the renderer has a runTransition method (e.g., VirtualRenderer).
   * If yes, uses the renderer's implementation (instant for tests/SSR).
   * If no, falls back to the internal runTransition (browser animations).
   *
   * This allows:
   * - VirtualRenderer to "skip" animations instantly (essential for fast unit tests)
   * - DOMRenderer to play animations smoothly in the browser
   * - Custom renderers to implement their own animation systems
   *
   * @param el - The element to animate
   * @param name - Transition name (e.g., 'fade', 'slide')
   * @param type - 'enter' or 'leave'
   * @param done - Callback when transition completes
   */
  _runTrans(el, name, type, done) {
    if (this._ren.runTransition) {
      // Use renderer's transition implementation (instant for virtual, animated for DOM)
      this._ren.runTransition(el, { name, type, done }, this);
    } else {
      // Fallback to internal runTransition function
      runTransition(el, name, type, done, this);
    }
  }
};
