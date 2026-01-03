/**
 * Reflex Core - Structural Directives
 *
 * Handles m-if, m-for, m-show, m-effect, and custom directives.
 */

import { META, ITERATE, SKIP } from '../symbols.js';
import { resolveDuplicateKey, reconcileKeyedList } from '../reconcile.js';
import {
  createFlatScope,
  isFlatScope,
  getFlatScopeValue,
  setFlatScopeValue,
  type FlatScope,
  type FlatScopeIds
} from '../scope-registry.js';
import { getStableKey, hasStrictParent, sortRefsByDOM, findScopedMRefs } from './utils.js';

/**
 * DirectivesMixin for Reflex class.
 * Provides structural directive implementations.
 */
export const DirectivesMixin = {
  /**
   * m-if directive: conditional rendering with transitions
   */
  _dir_if(this: any, el: Element, o: any): void {
    const fn = this._fn(el.getAttribute('m-if'));
    const trans = el.getAttribute('m-trans');
    // Use renderer for DOM operations (supports both web and virtual targets)
    const cm = this._ren.createComment('if');
    this._ren.replaceWith(el, cm);
    let cur: any, leaving = false;

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
            const contentNodes = Array.from(cloned.content.childNodes).map((node: Node) => this._cloneNode(node, true));

            // Insert all content nodes after the marker
            let insertPoint = cm as any;
            contentNodes.forEach((node: Node) => {
              insertPoint.after(node);
              insertPoint = node as ChildNode;
            });

            // Track all nodes for removal (array for template, single element otherwise)
            cur = contentNodes.length === 1 ? contentNodes[0] : contentNodes;

            // Process bindings and walk each inserted node
            // CRITICAL FIX: Recursive Directives via Effects
            // Queue walks instead of calling _w directly to prevent stack overflow
            // when m-if toggles cause nested effects to trigger more _w calls
            contentNodes.forEach((node: Node) => {
              if (node.nodeType === 1) {
                this._bnd(node as Element, o);
                this._queueWalk(node as Element, o);
              }
            });
            this._flushWalkQueue();

            // Run enter transition on content nodes
            if (trans && contentNodes.length > 0) {
              contentNodes.forEach((node: Node) => {
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
            // CRITICAL FIX: Recursive Directives via Effects
            // Queue walk instead of direct call to prevent stack overflow
            if (cur) {
              const compScope = this._scopeMap.get(cur) || o;
              this._queueWalk(cur, compScope);
              this._flushWalkQueue();
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
              // CRITICAL FIX: Recursive Directives via Effects
              // Queue walk instead of direct call to prevent stack overflow
              this._queueWalk(cur, o);
              this._flushWalkQueue();
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
  _dir_for(this: any, el: Element, o: any): void {
    const ex = el.getAttribute('m-for');
    const kAttr = el.getAttribute('m-key');
    if (!ex) return;
    const match = ex.match(/^\s*(.*?)\s+in\s+(.*$)/);
    if (!match) return;

    const [_, l, r] = match;
    const parts = l.replace(/[()]/g, '').split(',').map((s: string) => s.trim());
    const alias = parts[0], idxAlias = parts[1];

    // CRITICAL FIX #10: Scope Shadowing of Built-ins
    // If the user aliases a variable to a built-in name (e.g., "toString"),
    // it shadows the prototype method, causing crashes or unpredictable behavior
    // when Reflex internals or expressions call scope.toString()
    //
    // CRITICAL FIX (Task 14 Issue #10): Expanded Reserved Word List
    // The previous list was incomplete and missed:
    // - Function.prototype methods: call, apply, bind
    // - Object.prototype methods: __lookupGetter__, __lookupSetter__, __defineGetter__, __defineSetter__
    // - Reflex internal names: watch (used by Object.prototype.watch in legacy Firefox)
    // - Other dangerous names that could interfere with scope lookups
    //
    // This comprehensive list prevents obscure runtime errors when users accidentally
    // use reserved names in m-for expressions like: m-for="watch in watches"
    const reservedNames = [
      // Object.prototype methods
      'toString', 'valueOf', 'toLocaleString', 'hasOwnProperty',
      'isPrototypeOf', 'propertyIsEnumerable', 'constructor', '__proto__',
      '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',

      // Function.prototype methods (could interfere with method calls)
      'call', 'apply', 'bind',

      // Legacy browser properties (Object.prototype.watch in old Firefox)
      'watch', 'unwatch',

      // Common property names that could cause issues
      'prototype', 'length', 'name', 'arguments', 'caller',

      // Symbols and special properties
      'toJSON', 'then', 'catch', 'finally'
    ];

    if (reservedNames.includes(alias)) {
      console.error(
        `Reflex: Invalid m-for alias "${alias}". This name shadows a JavaScript built-in.\n` +
        `Reserved names include: ${reservedNames.slice(0, 10).join(', ')}, ...\n` +
        `Use a different variable name (e.g., "${alias}Item" instead of "${alias}").`
      );
      return;
    }
    if (idxAlias && reservedNames.includes(idxAlias)) {
      console.error(
        `Reflex: Invalid m-for index alias "${idxAlias}". This name shadows a JavaScript built-in.\n` +
        `Reserved names include: ${reservedNames.slice(0, 10).join(', ')}, ...\n` +
        `Use a different variable name (e.g., "i" or "idx" instead of "${idxAlias}").`
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

    // TASK 11 FIX: Capture content element's m-if for single-root templates
    // This is needed for shouldKeep to re-evaluate visibility on updates
    let contentIfFn: any = null;
    if (isTemplate) {
      const tplContent = (tpl as HTMLTemplateElement).content;
      const elementChildren = Array.from(tplContent.childNodes).filter((n: Node) => n.nodeType === 1);
      if (elementChildren.length === 1) {
        const contentEl = elementChildren[0] as Element;
        const contentMIfExpr = contentEl.getAttribute('m-if');
        if (contentMIfExpr) {
          contentIfFn = this._fn(contentMIfExpr);
        }
      }
    }

    let rows = new Map();     // key -> { node, oldIdx }
    let oldKeys: any[] = [];         // Track key order for LIS

    // TASK 12.10: Scoped Ref Storage
    // Track refs at the m-for level instead of scanning global _refs on every update
    // This eliminates O(N) ref scans where N is total refs in the component
    // Structure: Map<refName, Set<Element>> - refs belonging to this m-for instance
    const forRefs: Map<string, Set<Element>> = new Map();

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
      const nodesToWalk: { node: Element; scope: any }[] = [];

      // Configure reconciliation with Reflex-specific logic
      const config = {
        getKey: (item: any, index: number, scope: any) => {
          let key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn!(this.s, scope)) : index;
          // TASK 13.5: Convert object keys to stable unique IDs
          // This prevents "[object Object]" collisions when objects are used as keys
          key = getStableKey(key);
          // Handle duplicate keys to prevent ghost nodes
          return resolveDuplicateKey(seenKeys, key, index);
        },

        createScope: (item: any, index: number) => {
          // Process item (make reactive if needed)
          let processedItem = item;
          if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
            processedItem = this._r(processedItem);
          }

          // BREAKING CHANGE: Use FlatScope with unique IDs instead of ScopeContainer parent chains
          // This eliminates prototype chain traversal and prevents prototype pollution attacks

          // Allocate unique IDs for this loop's variables
          const aliasId = this._scopeRegistry.allocate(alias);
          const indexId = idxAlias ? this._scopeRegistry.allocate(idxAlias) : null;

          // Store values in flat registry
          this._scopeRegistry.set(aliasId, processedItem);
          if (indexId) {
            this._scopeRegistry.set(indexId, index);
          }

          // Build the IDs map for this scope
          const ids: FlatScopeIds = { [alias]: aliasId };
          if (idxAlias && indexId) {
            ids[idxAlias] = indexId;
          }

          // Get parent scope's IDs if parent is a FlatScope
          let parentIds: FlatScopeIds | null = null;
          if (o && isFlatScope(o)) {
            // Merge parent's IDs with parent's parentIds for full chain access
            parentIds = { ...o._parentIds, ...o._ids };
          }

          // Create the FlatScope object
          const scope = createFlatScope(this._scopeRegistry, ids, parentIds);

          // TASK 9.2: Register FlatScope for reactive dependency tracking
          // This allows text effects ({{ item }}) to properly track dependencies
          // and re-run when scope values change via updateNode
          this._mf.set(scope, {
            r: scope as any,
            v: 0,
            d: new Map(),
            engine: this as any
          });

          // Return the FlatScope (it's frozen and immutable)
          return scope;
        },

        // CRITICAL FIX: Destroy scope IDs when node creation fails
        // Called by reconciler when createNode returns null or shouldKeep returns false
        // This prevents memory leaks from orphaned scope IDs
        destroyScope: (scope: FlatScope) => {
          if (scope && isFlatScope(scope)) {
            for (const varName in scope._ids) {
              const id = scope._ids[varName];
              if (id) {
                this._scopeRegistry.delete(id);
              }
            }
          }
        },

        createNode: (item: any, index: number) => {
          const scope = config.createScope(item, index);

          // TASK 11 FIX: Helper to clean up scope when item is skipped
          // When createNode returns null, we must clean up the scope's registry entries
          // to prevent memory leaks
          const cleanupScope = () => {
            if (scope && isFlatScope(scope)) {
              for (const varName in scope._ids) {
                const id = scope._ids[varName];
                if (id) {
                  this._scopeRegistry.delete(id);
                }
              }
            }
          };

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
              // Clean up scope entries before returning null
              cleanupScope();
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
            const elementNodes = contentNodes.filter((node: Node) => node.nodeType === 1);

            // CRITICAL FIX: Detect strict parents (table, select, ul, etc.)
            // These elements have strict child requirements and reject wrapper elements
            const isStrictParent = hasStrictParent(cm);

            if (elementNodes.length === 1) {
              // Single root element - ALWAYS use it directly without wrapper
              // This works for both strict and non-strict parents
              const singleRoot = this._cloneNode(elementNodes[0], true) as Element;

              // TASK 11 FIX: Use pre-captured contentIfFn to check m-if
              // The walker (_w) only processes children, not the node itself.
              // So m-if on the root element would never be evaluated.
              // We use the pre-captured contentIfFn and remove the attribute.
              if (contentIfFn) {
                // Remove m-if so _w doesn't try to process it again
                singleRoot.removeAttribute('m-if');
                try {
                  if (!contentIfFn(this.s, scope)) {
                    cleanupScope(); // Clean up before returning null
                    return null; // m-if is false, skip this item
                  }
                } catch (err) {
                  this._handleError(err, scope);
                  cleanupScope(); // Clean up before returning null
                  return null;
                }
              }

              // TASK 5: Register with GC for automatic cleanup
              this._registerScopeWithGC(singleRoot, scope);
              this._bnd(singleRoot, scope);
              // CRITICAL FIX: Defer _w call to prevent stack overflow
              nodesToWalk.push({ node: singleRoot, scope });
              return singleRoot;
            } else if (isStrictParent) {
              // CRITICAL FIX: For strict parents, NEVER use wrapper elements
              // Instead, use comment-based anchors and manage nodes in a flat array
              // Create a virtual container object to track all nodes

              // TASK 11 FIX: Filter content nodes by evaluating m-if on each element
              // The walker only processes children, not nodes themselves.
              // For multi-root strict parents, we must evaluate m-if on each content node.
              const nodes: any[] = [];
              for (const contentNode of contentNodes) {
                const cloned = this._cloneNode(contentNode, true);
                if (cloned.nodeType === 1) {
                  const nodeEl = cloned as Element;
                  const nodeIfExpr = nodeEl.getAttribute('m-if');
                  if (nodeIfExpr) {
                    // Remove m-if so _w doesn't try to process it again
                    nodeEl.removeAttribute('m-if');
                    const nodeIfFn = this._fn(nodeIfExpr);
                    try {
                      if (!nodeIfFn(this.s, scope)) {
                        // m-if is false, skip this node
                        continue;
                      }
                    } catch (err) {
                      this._handleError(err, scope);
                      continue;
                    }
                  }
                }
                nodes.push(cloned);
              }

              // TASK 9.1: Ghost Row Memory Leak Fix
              // If the virtual container is empty (0 nodes), insert a placeholder comment
              // This ensures we always have a physical DOM anchor for GC registration
              // Without this, empty containers (e.g., m-if="false" on all items) leak memory
              let anchor = nodes[0];
              if (!anchor) {
                // Create a placeholder comment that will serve as the GC anchor
                anchor = this._ren.createComment('empty-container');
                nodes.push(anchor);
              }

              // TASK 8.2: GC Anchor Strategy
              // Assign the first child DOM node as the "Anchor" for GC registration
              // When the browser garbage collects the anchor (first <tr>, <option>, etc.),
              // FinalizationRegistry will trigger cleanup for the entire virtual container
              const container = {
                _isVirtualContainer: true,
                _nodes: nodes,
                _anchor: anchor, // TASK 9.1: Guaranteed to exist (either first child or placeholder)
                parentNode: null, // Will be set on insertion
                remove: function() {
                  // Remove all tracked nodes
                  this._nodes.forEach((node: any) => {
                    if (node.parentNode) node.remove();
                  });
                }
              } as any;

              // TASK 8.2: Register with GC using the anchor node
              // The anchor (first child) is a real DOM node that the browser can track
              // When it's collected, our GC callback will clean up the scope
              this._registerScopeWithGC(container, scope);

              // Process bindings and defer walk to prevent stack overflow
              nodes.forEach((child: Node) => {
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

              // TASK 11 FIX: Clone content nodes and evaluate m-if before appending
              for (const childNode of contentNodes) {
                const cloned = this._cloneNode(childNode, true);
                if (cloned.nodeType === 1) {
                  const nodeEl = cloned as Element;
                  const nodeIfExpr = nodeEl.getAttribute('m-if');
                  if (nodeIfExpr) {
                    // Remove m-if so _w doesn't try to process it again
                    nodeEl.removeAttribute('m-if');
                    const nodeIfFn = this._fn(nodeIfExpr);
                    try {
                      if (!nodeIfFn(this.s, scope)) {
                        // m-if is false, skip this node
                        continue;
                      }
                    } catch (err) {
                      this._handleError(err, scope);
                      continue;
                    }
                  }
                }
                wrapper.appendChild(cloned);
              }

              // TASK 5: Register with GC for automatic cleanup
              this._registerScopeWithGC(wrapper, scope);

              // Process bindings and defer walk to prevent stack overflow
              const children = Array.from(wrapper.childNodes);
              children.forEach((child: Node) => {
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
              // TASK 5: Register with GC for automatic cleanup
              this._registerScopeWithGC(inst, scope);
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
              // TASK 5: Register with GC for automatic cleanup
              this._registerScopeWithGC(tracked, scope);
              tempMarker.remove();
              return tracked;
            } else {
              // TASK 5: Register with GC for automatic cleanup
              this._registerScopeWithGC(node, scope);
              this._bnd(node, scope);
              // CRITICAL FIX: Defer _w call to prevent stack overflow
              nodesToWalk.push({ node, scope });
              return node;
            }
          }
        },

        updateNode: (node: any, item: any, index: number) => {
          const scope = this._scopeMap.get(node);
          if (scope && isFlatScope(scope)) {
            let processedItem = item;
            if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
              processedItem = this._r(processedItem);
            }

            // BREAKING CHANGE: Use flat scope registry for updates
            // Update values directly in the registry using the pre-allocated IDs
            setFlatScopeValue(scope, alias, processedItem);

            // TASK 9.2: Trigger effects that depend on this scope variable
            // This ensures text bindings ({{ item }}) re-run when the item changes
            const meta = this._mf.get(scope);
            if (meta) {
              this.triggerEffects(meta, alias);
            }

            // CRITICAL FIX: Ensure index updates trigger reactivity
            // When list order changes, child text nodes using {{ index }} must update
            if (idxAlias) {
              const currentIndex = getFlatScopeValue(scope, idxAlias);
              if (!currentIndex.found || currentIndex.value !== index) {
                setFlatScopeValue(scope, idxAlias, index);
                // TASK 9.2: Also trigger effects for index changes
                if (meta) {
                  this.triggerEffects(meta, idxAlias);
                }
              }
            }

            // NOTE: With flat scope resolution, nested scopes don't need explicit refresh
            // because they share the same registry and access parent values via parentIds.
            // The registry update above is immediately visible to all scopes that reference
            // these IDs, eliminating the need for parent chain traversal.
          }
        },

        removeNode: (node: any) => {
          // TASK 5: Manual cleanup with GC safety net
          //
          // This function still performs immediate cleanup for optimal performance,
          // but the GC-driven engine provides a safety net:
          //
          // - If removeNode is called: Immediate cleanup (best case)
          // - If removeNode is NOT called: GC cleanup when node is collected (fallback)
          //
          // Result: Even if this function is never called (e.g., innerHTML = ''),
          // the FinalizationRegistry will eventually clean up scope IDs automatically.

          // Clean up flat scope registry entries (immediate cleanup)
          const scope = this._scopeMap.get(node);
          if (scope && isFlatScope(scope)) {
            // Delete all IDs registered in this scope from the registry
            for (const varName in scope._ids) {
              const id = scope._ids[varName];
              if (id) {
                this._scopeRegistry.delete(id);
              }
            }

            // Note: We don't unregister from _gcRegistry because:
            // 1. It requires an unregister token which we didn't provide
            // 2. The GC callback is idempotent (delete on non-existent ID is safe)
            // 3. It's fine to let GC cleanup run even after manual cleanup
          }

          // CRITICAL FIX: Handle virtual containers (for strict parents like <table>)
          if (node._isVirtualContainer) {
            // Kill and remove all nodes in the virtual container
            node._nodes.forEach((n: any) => {
              this._kill(n);
              if (n.parentNode) n.remove();
            });
          } else {
            this._kill(node);
            node.remove();
          }
        },

        // Optional: Check if item should be kept (for m-if filtering)
        // TASK 11 FIX: Check both template m-if (ifFn) AND content element m-if (contentIfFn)
        shouldKeep: (ifFn || contentIfFn) ? (item: any, index: number, scope: any) => {
          try {
            // Check template-level m-if first
            if (ifFn && !ifFn(this.s, scope)) {
              return false;
            }
            // Then check content element's m-if
            if (contentIfFn && !contentIfFn(this.s, scope)) {
              return false;
            }
            return true;
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

      // CRITICAL FIX #5: m-ref Array Order Desync in Nested Structures
      // After DOM reconciliation reorders nodes, m-ref arrays must be updated to match
      // Without this fix, refs[0] points to the wrong element after sorting
      //
      // PREVIOUS BUG: Only checked root node of each row for m-ref
      // This failed when m-ref is on a child element:
      // <div m-for="item in items"><span m-ref="spans"></span></div>
      // The span refs would not be reordered because we only checked the div
      //
      // NEW FIX: Check root node AND all descendants for m-ref elements
      // Build a map of {refElement -> {rowNode, index}} to track which row each ref belongs to
      //
      // TASK 12.10: Scoped Ref Storage - Eliminate O(N) ref scans
      // Instead of scanning all global refs (this._refs), we now:
      // 1. Collect refs from this m-for's rows using querySelectorAll
      // 2. Only process refs that belong to this m-for instance
      // This reduces O(rows × totalRefs) to O(rows × forSpecificRefs)
      const refArraysToUpdate = new Map(); // refName -> array of {node, index}

      // TASK 12.10: First pass - collect refs from this m-for's DOM tree only
      // Clear forRefs from previous iteration
      forRefs.clear();

      result.keys.forEach((key: any, index: number) => {
        const rowData = result.rows.get(key);
        if (!rowData) return;

        const rowNode = rowData.node;
        if (!rowNode || rowNode.nodeType !== 1) return;

        // TASK 12.10: Find all m-ref elements within this row
        // This is O(1) per row (browser's querySelectorAll is highly optimized)
        // vs O(totalRefs) of scanning all global refs
        const refElements: Element[] = [];

        // CRITICAL FIX (Audit Issue #4): Use scoped m-ref collection
        //
        // PREVIOUS BUG: querySelectorAll('[m-ref]') selected ALL descendants with m-ref,
        // including those inside nested m-for loops. This caused:
        // 1. Outer loop to manage/sort refs belonging to inner loops
        // 2. Sorting conflicts between parent and child loops
        // 3. O(N) performance degradation in deep trees
        //
        // FIX: Use findScopedMRefs which stops traversal at nested m-for/m-if boundaries.
        // This ensures each m-for only manages its own direct refs, not refs from nested loops.
        const scopedRefs = findScopedMRefs(rowNode as Element);
        refElements.push(...scopedRefs);

        // Register each ref element in our scoped storage and update map
        for (const refElement of refElements) {
          const refName = refElement.getAttribute('m-ref');
          if (!refName) continue;

          // Track in forRefs (scoped to this m-for)
          if (!forRefs.has(refName)) {
            forRefs.set(refName, new Set());
          }
          forRefs.get(refName)!.add(refElement);

          // Add to refArraysToUpdate
          if (!refArraysToUpdate.has(refName)) {
            refArraysToUpdate.set(refName, []);
          }
          refArraysToUpdate.get(refName).push({ node: refElement, index });
        }
      });

      // TASK 12.3: Rebuild each affected ref array in DOM order
      // Use DOM-based sorting with compareDocumentPosition instead of loop index
      // This ensures correct order for interleaved loops (multiple m-for on same container)
      refArraysToUpdate.forEach((nodeList: any[], refName: string) => {
        // Extract nodes (we'll sort by DOM position, not loop index)
        const orderedNodes = nodeList.map((item: any) => item.node);

        // TASK 12.3: Sort nodes by DOM document position
        // This handles interleaved loops correctly where loop index would fail
        sortRefsByDOM(orderedNodes);

        // TASK 8.4: Stable Reference Reconciliation
        // BREAKING CHANGE: Mutate the existing array instead of reassigning
        // This preserves object identity (===) across re-renders
        // Benefits:
        // - Watchers on the array reference don't fire unnecessarily
        // - Custom properties on the array object are preserved
        // - Aligns with Vue/React ref behavior
        //
        // CRITICAL FIX: For nested m-for, only reorder THIS m-for's refs
        // without clobbering refs from sibling m-for loops
        const targetArray = this._refs[refName];
        if (Array.isArray(targetArray)) {
          if (orderedNodes.length === 0) return;

          // Find positions of our nodes in the target array
          const indices = orderedNodes.map((n: Element) => targetArray.indexOf(n));
          const validIndices = indices.filter((i: number) => i !== -1);

          if (validIndices.length === 0) {
            // None of our nodes are in targetArray yet - they're new
            // Don't modify (the m-ref binding already pushed them)
            return;
          }

          if (validIndices.length !== orderedNodes.length) {
            // Some nodes are missing - partial state, skip sync
            return;
          }

          const minIdx = Math.min(...validIndices);
          const maxIdx = Math.max(...validIndices);

          // Check if nodes are in a contiguous block and in correct order
          const isContiguous = maxIdx - minIdx + 1 === orderedNodes.length;
          let needsUpdate = !isContiguous;

          if (isContiguous && !needsUpdate) {
            for (let i = 0; i < orderedNodes.length; i++) {
              if (targetArray[minIdx + i] !== orderedNodes[i]) {
                needsUpdate = true;
                break;
              }
            }
          }

          if (needsUpdate) {
            // Remove our nodes from their current positions (iterate backwards)
            const sortedIndices = [...validIndices].sort((a: number, b: number) => b - a);
            for (const idx of sortedIndices) {
              targetArray.splice(idx, 1);
            }
            // Insert orderedNodes at the minIdx position
            targetArray.splice(minIdx, 0, ...orderedNodes);
          }

          // TASK 12.3: Post-process - sort the entire array by DOM position
          // This ensures interleaved refs from different loops are in correct order
          sortRefsByDOM(targetArray);
        } else {
          // First time: create the array
          this._refs[refName] = orderedNodes;
        }

        // TASK 9.2: Synchronize Reactive m-ref State
        // After DOM reconciliation, state.refs must match the new order
        // Without this, state.refs[0] points to the wrong element after sorting
        // Use property access instead of 'in' operator for better proxy compatibility
        const stateArray = this.s[refName];
        if (stateArray && Array.isArray(stateArray)) {
          // CRITICAL FIX: For nested m-for, handle refs carefully to avoid clobbering
          // refs from sibling m-for loops.
          //
          // Example: allItems = [A1, B1, B2, A2] where A1,A2 are from Group A's inner m-for
          // and B1, B2 are from Group B's inner m-for. When Group A syncs, we need to
          // move [A1, A2] to be contiguous at the earliest position, resulting in
          // [A1, A2, B1, B2].

          if (orderedNodes.length === 0) return;

          // Find positions of our nodes in the state array
          const indices = orderedNodes.map((n: Element) => stateArray.indexOf(n));
          const validIndices = indices.filter((i: number) => i !== -1);

          if (validIndices.length === 0) {
            // None of our nodes are in stateArray yet - they're new
            // Don't sync (the m-ref binding already pushed them)
            return;
          }

          if (validIndices.length !== orderedNodes.length) {
            // Some nodes are missing - partial state, skip sync
            return;
          }

          const minIdx = Math.min(...validIndices);
          const maxIdx = Math.max(...validIndices);

          // Check if nodes are in a contiguous block and in correct order
          const isContiguous = maxIdx - minIdx + 1 === orderedNodes.length;
          let needsUpdate = !isContiguous;

          if (isContiguous && !needsUpdate) {
            // Check if the contiguous block is in correct order
            for (let i = 0; i < orderedNodes.length; i++) {
              if (stateArray[minIdx + i] !== orderedNodes[i]) {
                needsUpdate = true;
                break;
              }
            }
          }

          if (needsUpdate) {
            // Get the raw array to avoid triggering reactivity during manipulation
            const rawArr = this.toRaw(stateArray);

            // Remove all our nodes from their current positions (iterate backwards)
            const sortedIndices = [...validIndices].sort((a: number, b: number) => b - a);
            for (const idx of sortedIndices) {
              rawArr.splice(idx, 1);
            }

            // Insert orderedNodes at the minIdx position (where the first one was)
            // This preserves refs from other m-for loops
            rawArr.splice(minIdx, 0, ...orderedNodes);

            // TASK 12.3: Post-process - sort by DOM position for interleaved refs
            sortRefsByDOM(rawArr);

            // CRITICAL FIX: Global Ref Array Thrashing
            // Previous implementation: stateArray.splice(0, stateArray.length, ...raw)
            // This replaces the entire array, triggering watchers on ALL indices
            // even when only one item moved.
            //
            // NEW: Do targeted updates - only modify positions that actually changed
            // This reduces reactivity triggers from O(N) to O(changed items)
            let changedCount = 0;
            for (let i = 0; i < rawArr.length; i++) {
              if (stateArray[i] !== rawArr[i]) {
                stateArray[i] = rawArr[i];
                changedCount++;
              }
            }
            // Handle length changes (items removed from end)
            if (stateArray.length > rawArr.length) {
              stateArray.length = rawArr.length;
            }
            // If nothing actually changed in content, skip triggering length
            // This prevents unnecessary reactivity when array is already correct
          }
        }
      });
    });

    eff.o = o;
    this._reg(cm, () => {
      // Kill effects and REMOVE nodes from DOM
      // This is critical for m-if + m-for combinations where
      // removing the m-for comment marker must also remove list items
      rows.forEach(({ node }: { node: any }) => {
        // CRITICAL FIX: Handle virtual containers (for strict parents like <table>)
        if (node._isVirtualContainer) {
          node._nodes.forEach((n: any) => {
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
   * Show/hide: m-show="expr"
   *
   * CRITICAL FIX #9: m-show should respect CSS classes and media queries
   *
   * Previous implementation used setProperty('display', value, 'important') which
   * permanently overrode CSS classes and media queries, breaking responsive layouts.
   *
   * TASK 12.4: Fix CSS class conflict
   * The issue: m-show="true" sets el.style.display = ''. If a class has display: none,
   * the element remains hidden because CSS wins over empty inline style.
   *
   * New approach:
   * - When hiding: Set display: none (sufficient for most cases)
   * - When showing: Remove inline display property, check computed style.
   *   If still none due to CSS class, force display: 'revert' or 'block'.
   * - This ensures m-show="true" always makes element visible
   */
  _show(this: any, el: Element, exp: string, o: any, trans: string | null): void {
    const fn = this._fn(exp);
    const d = (el as HTMLElement).style.display === 'none' ? '' : (el as HTMLElement).style.display;
    let prev: string | undefined, transitioning = false;

    // TASK 12.4: Helper to ensure element is visible
    // Handles CSS class conflicts by checking computed style and forcing display if needed
    const forceShow = (element: HTMLElement) => {
      // First, remove any inline display style
      element.style.removeProperty('display');

      // Check computed style - if CSS class is hiding it, we need to override
      const computed = getComputedStyle(element);
      if (computed.display === 'none') {
        // CSS class is hiding the element - force it visible
        // Use 'revert' if supported (returns to user-agent stylesheet default)
        // Otherwise fall back to 'block' which works for most elements
        element.style.display = 'revert';

        // Check if 'revert' worked (some browsers don't support it)
        const afterRevert = getComputedStyle(element);
        if (afterRevert.display === 'none') {
          // 'revert' didn't work, use 'block' as safe fallback
          element.style.display = 'block';
        }
      } else if (d && d !== element.style.display) {
        // Restore original display type if it was set
        element.style.display = d;
      }
    };

    const e = this.createEffect(() => {
      try {
        const show = !!fn(this.s, o);
        const next = show ? 'show' : 'none'; // Changed from display value to semantic state

        if (next !== prev && !transitioning) {
          if (trans && prev !== undefined) {
            transitioning = true;
            if (show) {
              // TASK 12.4: Use forceShow for transition enter
              forceShow(el as HTMLElement);
              this._runTrans(el, trans, 'enter', () => { transitioning = false; });
            } else {
              this._runTrans(el, trans, 'leave', () => {
                // Hide element
                (el as HTMLElement).style.display = 'none';
                transitioning = false;
              });
            }
          } else {
            // TASK 12.4: Handle show/hide without transitions
            if (!show) {
              // Hide element
              (el as HTMLElement).style.display = 'none';
            } else {
              // Show element - handle CSS class conflict
              forceShow(el as HTMLElement);
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
   * m-effect directive: run side effects when dependencies change
   *
   * IMPORTANT: Properly handles cleanup functions returned by effects.
   * When dependencies change, the previous cleanup is called before
   * the effect runs again. This prevents resource leaks.
   */
  _effect(this: any, el: Element, exp: string, o: any): void {
    // Use handler mode to get proper `this` binding from with(s){}
    const fn = this._fn(exp, true);
    const self = this;

    // Track the current cleanup function
    let currentCleanup: (() => void) | null = null;

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
  _applyDir(this: any, el: Element, name: string, value: string, mods: string[], o: any): boolean {
    const dir = this._cd.get(name);
    if (!dir) return false;

    const fn = this._fn(value);
    const self = this;

    // Track the current cleanup function
    let currentCleanup: (() => void) | null = null;

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
  }
};
