/**
 * Reflex Core - DOM Walker
 *
 * Handles DOM tree walking and node registration.
 */

import { isFlatScope } from '../scope-registry.js';
import { cloneNodeWithProps } from './utils.js';

/**
 * WalkerMixin for Reflex class.
 * Provides DOM walking and scope registration methods.
 */
export const WalkerMixin = {
  /**
   * Register a node with the GC-driven cleanup system (TASK 5).
   * TASK 8.2: GC Anchor Strategy for Virtual Containers
   *
   * BREAKING CHANGE: Automatic memory management via FinalizationRegistry
   *
   * When a DOM node with a FlatScope is garbage collected, the GC registry
   * automatically cleans up the scope's IDs from the ScopeRegistry.
   *
   * This method:
   * 1. Stores the scope in _scopeMap (WeakMap - doesn't prevent GC)
   * 2. Registers the node with _gcRegistry for automatic cleanup
   * 3. Extracts scope IDs from the FlatScope for cleanup
   * 4. TASK 8.2: For virtual containers, uses the anchor (first child) for GC tracking
   *
   * Why this works:
   * - _scopeMap is a WeakMap, so it doesn't prevent the node from being GC'd
   * - When the node is GC'd, FinalizationRegistry fires and deletes the IDs
   * - Even document.body.innerHTML = '' will eventually self-clean via GC
   * - TASK 8.2: Virtual containers use their first child as an anchor for GC tracking
   *
   * @param node - The DOM node (or virtual container) to register
   * @param scope - The FlatScope associated with this node
   */
  _registerScopeWithGC(this: any, node: any, scope: any): void {
    // Store the scope in WeakMap (doesn't prevent GC)
    this._scopeMap.set(node, scope);

    // Register with GC for automatic cleanup (only for FlatScope)
    if (isFlatScope(scope)) {
      // Extract all scope IDs that need cleanup when node is GC'd
      const scopeIds = Object.values(scope._ids);

      // TASK 8.2: GC Anchor Strategy
      // For virtual containers, use the anchor node (first child) instead of the container itself
      // The anchor is a real DOM node that the browser can track for garbage collection
      let target = node;
      if (node._isVirtualContainer && node._anchor) {
        // Use the anchor node. When the first <tr> or <option> dies, the virtual container is dead.
        target = node._anchor;
      }

      // TASK 8.2 & 9.1: Now we register ALL nodes, including virtual containers (via their anchors)
      // The old code skipped virtual containers, which caused memory leaks for tables
      // TASK 9.1: Accept both element nodes (nodeType === 1) and comment nodes (nodeType === 8)
      // Comment nodes are used as placeholder anchors for empty virtual containers
      if (target && (target.nodeType === 1 || target.nodeType === 8)) {
        // Register the target (real DOM node) with GC
        // When the node is collected, the callback will delete these IDs from registry
        this._gcRegistry.register(target, scopeIds);
      }
    }
  },

  /**
   * Walk the DOM tree and process nodes.
   * Uses iterative walking with explicit stack to prevent stack overflow.
   * This approach handles deeply nested DOM structures (10,000+ levels) safely.
   *
   * CRITICAL FIX #6: Component stack overflow prevention
   * Instead of calling _comp recursively (which calls _w, which calls _comp...),
   * we now queue component work onto the same stack as DOM nodes.
   *
   * TASK 12.2: DoS Prevention - Depth Guard
   * Structural directives (m-if, m-for) call _w recursively. Deeply nested
   * components with these directives can still cause "Maximum call stack exceeded".
   * This depth guard throws a specific error at 1000 levels to prevent browser crash.
   *
   * The stack stores work items that can be:
   * - { node, scope }: Regular DOM walking
   * - { comp, tag, scope }: Component to render
   */

  /**
   * CRITICAL FIX: Recursive Directives via Effects
   *
   * Queue a walk operation for iterative processing instead of direct recursion.
   * This prevents stack overflow when m-if/m-for toggles cause nested effects.
   *
   * The pattern: Instead of calling _w directly inside effects:
   *   this._w(node, scope)  // BAD: causes recursion
   *
   * We queue the work and process iteratively:
   *   this._queueWalk(node, scope)  // Queue
   *   this._flushWalkQueue()        // Process iteratively
   */
  _walkQueue: null as { node: any, scope: any }[] | null,
  _walkQueueProcessing: false,

  // TASK 13.2: Track nodes that have been queued for walking to prevent re-walking
  // This is critical for slot content which should only be walked with parent scope,
  // not re-walked when the component instance is walked with component scope
  _walkedNodes: null as WeakSet<Node> | null,

  _queueWalk(this: any, node: any, scope: any): void {
    if (!this._walkQueue) {
      this._walkQueue = [];
    }
    // TASK 13.2: Only queue if not already queued/walked
    if (!this._walkedNodes) {
      this._walkedNodes = new WeakSet();
    }
    if (this._walkedNodes.has(node)) {
      // Node was already queued/walked - skip to prevent re-walking with wrong scope
      return;
    }
    this._walkedNodes.add(node);
    this._walkQueue.push({ node, scope });
  },

  _flushWalkQueue(this: any): void {
    // Prevent re-entrant processing
    if (this._walkQueueProcessing || !this._walkQueue || this._walkQueue.length === 0) {
      return;
    }

    this._walkQueueProcessing = true;
    try {
      // Process queue iteratively - items may be added during processing
      while (this._walkQueue.length > 0) {
        const item = this._walkQueue.shift()!;
        this._w(item.node, item.scope);
      }
    } finally {
      this._walkQueueProcessing = false;
    }
  },

  _w(this: any, n: Node, o: any): void {
    // TASK 12.2: Depth guard to prevent DoS via deeply nested components
    // Initialize depth counter if not set
    if (this._walkDepth === undefined) {
      this._walkDepth = 0;
    }

    // Check depth limit
    const MAX_RENDER_DEPTH = 1000;
    if (++this._walkDepth > MAX_RENDER_DEPTH) {
      this._walkDepth = 0; // Reset to prevent permanent lock-out
      throw new Error(
        `Reflex: Max Render Depth Exceeded (${MAX_RENDER_DEPTH} levels).\n\n` +
        'This usually indicates:\n' +
        '  1. Infinite loop in m-if/m-for conditions\n' +
        '  2. Circular component references\n' +
        '  3. Maliciously nested DOM structure (DoS attack)\n\n' +
        'Solutions:\n' +
        '  - Check m-if/m-for expressions for infinite loops\n' +
        '  - Verify components don\'t recursively include themselves\n' +
        '  - Simplify deeply nested component hierarchies'
      );
    }

    try {
    // Explicit stack prevents recursive call stack overflow
    const stack: any[] = [{ node: n, scope: o }];

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
          // TASK 13.2: Skip nodes that were already walked (e.g., slot content walked with parent scope)
          // This prevents slot content from being re-walked with the wrong (component) scope
          if (this._walkedNodes && this._walkedNodes.has(c)) {
            c = next;
            continue;
          }

          const mIgnore = (c as Element).getAttribute('m-ignore');
          if (mIgnore === null) {
            const tag = (c as Element).tagName;
            const mIf = (c as Element).getAttribute('m-if');
            const mFor = (c as Element).getAttribute('m-for');

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
          const nv = (c as Text).nodeValue;
          if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
            this._txt(c as Text, scope);
          }
        }
        c = next;
      }
    }
    } finally {
      // Decrement depth counter when exiting the walk
      this._walkDepth--;
    }
  },

  /**
   * Clone a node while preserving node state from WeakMap.
   * TASK 6: Delegates to the standalone cloneNodeWithProps helper with _nodeState WeakMap.
   */
  _cloneNode(this: any, node: Node, deep = true): Node {
    return cloneNodeWithProps(node, deep, this._nodeState);
  }
};
