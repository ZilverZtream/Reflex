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
  const onEnd = (e) => {
    if (e.target !== el || cleaned) return;
    cleanup();
    if (done) done();
  };

  // Use renderer's requestAnimationFrame if available, otherwise use global
  const raf = renderer?.requestAnimationFrame ?? requestAnimationFrame;

  // Next frame: start transition
  raf(() => {
    if (cleaned) return; // Transition was cancelled before it started

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

    if (timeout > 50) {
      timeoutId = setTimeout(() => {
        if (cleaned) return;
        cleanup();
        if (done) done();
      }, timeout) as any;
    } else {
      // No transition defined, complete immediately
      cleanup();
      if (done) done();
    }
  });
}

/**
 * Check if an element has a strict parent that doesn't allow wrapper elements.
 * Strict parents include: table, tbody, thead, tfoot, tr, select, optgroup, ul, ol, dl, picture
 *
 * @param marker - The comment marker element to check
 * @returns true if the parent is strict and doesn't allow wrapper elements
 */
function hasStrictParent(marker: Comment): boolean {
  let parent = marker.parentElement;
  if (!parent) return false;

  const tag = parent.tagName;
  // Elements that have strict child requirements
  return tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' ||
         tag === 'TR' || tag === 'SELECT' || tag === 'OPTGROUP' ||
         tag === 'UL' || tag === 'OL' || tag === 'DL' || tag === 'PICTURE';
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
   * The stack stores {node, scope} pairs to process.
   * Each node's children are pushed in reverse order to maintain left-to-right processing.
   */
  _w(n, o) {
    // Explicit stack prevents recursive call stack overflow
    const stack = [{ node: n, scope: o }];

    while (stack.length > 0) {
      const { node, scope } = stack.pop();
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
                  this._comp(c, t, scope);
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
   * Process bindings on an element.
   */
  _bnd(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans'); // For m-show transitions

    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        this._ev(n, nm.slice(1), v, o);
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
          // Register element in $refs
          this._refs[v] = n;
          // Also assign to state if the variable exists there
          // This allows direct access via state.myRef instead of $refs.myRef
          if (v in this.s) {
            this.s[v] = n;
          }
          this._reg(n, () => {
            // CRITICAL: Set to null before deleting to break references
            // This prevents memory leaks from "Detached DOM Nodes"
            this._refs[v] = null;
            delete this._refs[v];
            // Also null out state variable if it exists
            if (v in this.s) {
              this.s[v] = null;
            }
          });
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
        if (ok && !cur && !leaving) {
          if (isTemplate) {
            // For <template> tags, insert content instead of the element itself
            const cloned = el.cloneNode(true) as HTMLTemplateElement;
            cloned.removeAttribute('m-if');
            cloned.removeAttribute('m-trans');

            // Clone all content nodes from the template
            const contentNodes = Array.from(cloned.content.childNodes).map(node => node.cloneNode(true));

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
            const cloned = el.cloneNode(true);
            cloned.removeAttribute('m-if');
            cloned.removeAttribute('m-trans');
            cm.after(cloned);

          if (isSyncComp) {
            // For sync components, track the returned instance
            cur = this._comp(cloned, tagLower, o);
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
            // For async components, we need to find all nodes between marker and end
            // For now, remove all siblings after the marker until we hit another comment/marker
            // Remove all content from async component (marker, fallback, or loaded component)
            let node = cm.nextSibling;
            while (node) {
              const next = node.nextSibling;
              // Stop if we hit another structural directive marker
              if (node.nodeType === 8 && ((node as Comment).nodeValue?.startsWith('if') ||
                  (node as Comment).nodeValue?.startsWith('for'))) {
                break;
              }
              this._kill(node);
              (node as ChildNode).remove();
              // For async, remove only one element/marker set
              if (node.nodeType === 1 || (node as Comment).nodeValue?.startsWith('async:')) {
                break;
              }
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
    const listFn = this._fn(r);
    const keyIsProp = !!kAttr && /^[a-zA-Z_$][\w$]*$/.test(kAttr);
    const keyFn = (!kAttr || keyIsProp) ? null : this._fn(kAttr);

    // Use renderer for DOM operations (supports both web and virtual targets)
    const cm = this._ren.createComment('for');
    this._ren.replaceWith(el, cm);
    const tpl = el.cloneNode(true);
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
      const seenKeys = new Set();

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
            const clonedTpl = tpl.cloneNode(true) as HTMLTemplateElement;
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
              const singleRoot = elementNodes[0].cloneNode(true) as Element;
              this._scopeMap.set(singleRoot, scope);
              this._bnd(singleRoot, scope);
              this._w(singleRoot, scope);
              return singleRoot;
            } else if (isStrictParent) {
              // CRITICAL FIX: For strict parents, NEVER use wrapper elements
              // Instead, use comment-based anchors and manage nodes in a flat array
              // Create a virtual container object to track all nodes
              const nodes = contentNodes.map(node => node.cloneNode(true));

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

              // Process bindings and walk each child element
              nodes.forEach(child => {
                if (child.nodeType === 1) {
                  this._bnd(child as Element, scope);
                  this._w(child as Element, scope);
                }
              });

              return container;
            } else {
              // Multi-root or mixed content - use wrapper for reconciliation (non-strict parents only)
              // Create a wrapper using a custom element to contain template content
              // This acts as an "invisible" wrapper for reconciliation
              // Using 'rfx-tpl' custom element to avoid conflicts with normal element queries
              const wrapper = this._ren.createElement('rfx-tpl');
              wrapper.style.display = 'contents'; // Make wrapper invisible in layout

              // Clone and append all content nodes
              contentNodes.forEach(childNode => {
                wrapper.appendChild(childNode.cloneNode(true));
              });

              this._scopeMap.set(wrapper, scope);

              // Process bindings and walk each child element
              const children = Array.from(wrapper.childNodes);
              children.forEach(child => {
                if (child.nodeType === 1) {
                  this._bnd(child as Element, scope);
                  this._w(child as Element, scope);
                }
              });

              return wrapper;
            }
          } else {
            // Non-template elements: existing logic
            const node = tpl.cloneNode(true);
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
              this._w(node, scope);
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
    const fn = this._fn(exp);
    let prev;
    const isUrlAttr = att === 'href' || att === 'src' || att === 'action' ||
                      att === 'formaction' || att === 'xlink:href';

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
    const initialClass = att === 'class' ? el.className : null;
    const initialStyle = att === 'style' ? el.getAttribute('style') || '' : null;

    // Track previous style keys for cleanup (fixes "stale style" bug)
    // When style object changes, we need to explicitly remove old properties
    let prevStyleKeys = null;

    const e = this.createEffect(() => {
      try {
        let v = fn(this.s, o);

        // SECURITY FIX: Validate URL protocols using allowlist instead of blocklist
        // Only allow known-safe protocols (http, https, mailto, tel, etc.) and relative URLs
        // Blocklist approach can be bypassed with HTML entities like jav&#x09;ascript:alert(1)
        if (isUrlAttr && v != null && typeof v === 'string') {
          // Allow relative URLs and safe protocols
          const isSafe = RELATIVE_URL_RE.test(v) || SAFE_URL_RE.test(v);
          if (!isSafe) {
            console.warn('Reflex: Blocked unsafe URL protocol in', att + ':', v);
            v = 'about:blank';
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
            // Track current keys to remove stale ones
            const currentKeys = new Set(Object.keys(v));

            // Clear previous keys that aren't in the new object
            if (prevStyleKeys) {
              for (const key of prevStyleKeys) {
                if (!currentKeys.has(key)) {
                  // Convert camelCase to kebab-case for CSS property names
                  const cssProp = key.replace(/([A-Z])/g, '-$1').toLowerCase();
                  (el as HTMLElement).style.setProperty(cssProp, '');
                }
              }
            }

            // Apply new styles
            for (const key in v) {
              const val = v[key];
              const cssProp = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              if (val != null && val !== false) {
                (el as HTMLElement).style.setProperty(cssProp, String(val));
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
          el[att] = v ?? '';
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

        if (self.cfg.sanitize) {
          // Use configured DOMPurify instance (not global variable)
          const purify = self.cfg.domPurify;
          if (purify && typeof purify.sanitize === 'function') {
            html = purify.sanitize(html);
          } else {
            // Check if we're in development mode
            const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

            if (isDev) {
              // DEVELOPMENT: Warn loudly but allow rendering for prototyping
              console.error(
                '⚠️ SECURITY WARNING: m-html is rendering unsanitized HTML in development mode!\n' +
                'This is DANGEROUS and should NEVER be used in production.\n' +
                'Configure DOMPurify: app.configure({ domPurify: DOMPurify })\n' +
                'Install: npm install dompurify'
              );
              // Allow rendering in development for prototyping
            } else {
              // PRODUCTION: Fail hard to prevent XSS vulnerabilities
              throw new Error(
                'Reflex: SECURITY ERROR - m-html requires DOMPurify in production.\n' +
                'Configure it with: app.configure({ domPurify: DOMPurify })\n' +
                'Install: npm install dompurify\n' +
                'Or disable sanitization (UNSAFE): app.configure({ sanitize: false })'
              );
            }
          }
        }

        if (html !== prev) { prev = html; el.innerHTML = html; }
      } catch (err) {
        self._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Show/hide: m-show="expr"
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
              el.style.display = d;
              this._runTrans(el, trans, 'enter', () => { transitioning = false; });
            } else {
              this._runTrans(el, trans, 'leave', () => {
                el.style.display = 'none';
                transitioning = false;
              });
            }
          } else {
            el.style.display = next;
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
    const isNum = type === 'number' || type === 'range';
    const isMultiSelect = type === 'select-multiple';
    const isLazy = modifiers.includes('lazy');

    const e = this.createEffect(() => {
      try {
        const v = fn(this.s, o);
        if (isChk) {
          // Handle checkbox array binding
          if (Array.isArray(v)) {
            // CRITICAL FIX: Checkbox values are always strings, but array might contain
            // numbers or other types. Use type coercion to match values correctly.
            // Example: array [1, 2] should match <input value="1">
            el.checked = v.some(item => String(item) === el.value);
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

    const up = () => {
      let v;
      if (isChk) {
        // Handle checkbox array binding
        const currentValue = fn(this.s, o);
        if (Array.isArray(currentValue)) {
          // Toggle value in array with proper type coercion
          const arr = [...currentValue];
          // CRITICAL FIX: Use type coercion to find matching value
          // Checkbox values are strings, but array might contain numbers
          const idx = arr.findIndex(item => String(item) === el.value);
          if (el.checked && idx === -1) {
            // Try to preserve the original type if the array has a consistent type
            // If array contains numbers and value is numeric, push as number
            let valueToAdd = el.value;
            if (arr.length > 0 && typeof arr[0] === 'number' && !isNaN(Number(el.value))) {
              valueToAdd = Number(el.value);
            }
            arr.push(valueToAdd);
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
        v = el.value === '' ? null : parseFloat(el.value);
      } else if (isMultiSelect) {
        // For multi-select, return array of selected values
        // Fallback for environments without selectedOptions (e.g., happy-dom)
        if (el.selectedOptions) {
          v = Array.from(el.selectedOptions).map(opt => opt.value);
        } else {
          v = Array.from(el.options)
            .filter(opt => opt.selected)
            .map(opt => opt.value);
        }
      } else v = el.value;

      const paths = exp.split('.'), end = paths.pop();

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
      t[end] = v;
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

    this._reg(el, () => {
      el.removeEventListener(evt, up);
      if (evt !== 'change' && !isLazy) {
        el.removeEventListener('change', up);
      }
    });
  },

  /**
   * Event binding: @event.mod1.mod2="expr"
   */
  _ev(el, evt, exp, o) {
    const [nm, ...mod] = evt.split('.');
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
        const now = Date.now();
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
      this._reg(el, () => target.removeEventListener(nm, handler, opts));
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

    // Use direct binding for .stop and .self (delegation won't work for these)
    if (mod.includes('stop') || mod.includes('self')) {
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
      this._dh.set(nm, new WeakMap());
      this._dr.addEventListener(nm, e => this._hdl(e, nm));
    }
    this._dh.get(nm).set(el, { f: fn, o, m: mod });
  },

  /**
   * Delegated event handler
   */
  _hdl(e, nm) {
    let t = e.target;
    while (t && t !== this._dr) {
      const h = this._dh.get(nm)?.get(t);
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

        if (m.includes('once')) this._dh.get(nm).delete(t);
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
   */
  _cls(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(x => this._cls(x)).filter(Boolean).join(' ');
    if (typeof v === 'object') return Object.keys(v).filter(k => v[k]).join(' ');
    return String(v);
  },

  /**
   * Convert style binding value to string
   */
  _sty(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      let s = '';
      for (const k in v) {
        const val = v[k];
        if (val != null && val !== false) {
          // Convert camelCase to kebab-case (e.g., fontSize -> font-size)
          const prop = k.replace(/([A-Z])/g, '-$1').toLowerCase();
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
