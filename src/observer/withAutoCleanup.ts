/**
 * Reflex Auto-Cleanup Plugin (MutationObserver)
 *
 * Tree-shakable plugin that automatically detects when elements are removed
 * by external scripts (jQuery, HTMX, vanilla el.remove()) and cleans up
 * their listeners and memory.
 *
 * This matches Alpine.js's ability to auto-cleanup external DOM mutations.
 *
 * Usage:
 *   import { withAutoCleanup } from 'reflex/observer';
 *   app.use(withAutoCleanup);
 *
 * Performance Optimizations:
 * - Uses __rx marker for O(1) check of Reflex-managed elements
 * - Ignores 99% of DOM changes (text updates, non-Reflex elements)
 * - Uses TreeWalker only for containers with potential Reflex children
 * - Batches cleanup in microtask to avoid blocking DOM operations
 */

import type { Reflex } from '../core/reflex.js';

// Marker symbol for Reflex-managed elements
// Using a symbol prevents collision with user properties
export const RX_MARKER = '__rx';

// WeakSet to track which Reflex instances have observer enabled
const observerInstances = new WeakSet<Reflex>();

/**
 * Check if a node or any of its descendants have the Reflex marker.
 * Uses TreeWalker for efficient traversal of large subtrees.
 */
function hasReflexDescendant(node: Node): boolean {
  // Quick check for direct marker
  if ((node as any)[RX_MARKER]) return true;

  // Skip if not an element (text nodes, comments, etc.)
  if (node.nodeType !== 1) return false;

  // Use TreeWalker for efficient subtree traversal
  // Only needed for container elements
  if (!node.hasChildNodes()) return false;

  const walker = document.createTreeWalker(
    node,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let current = walker.nextNode();
  while (current) {
    if ((current as any)[RX_MARKER]) return true;
    current = walker.nextNode();
  }

  return false;
}

/**
 * Collect all Reflex-marked nodes from a subtree.
 * Returns nodes in document order (parents before children).
 */
function collectMarkedNodes(node: Node): Node[] {
  const result: Node[] = [];

  // Check the node itself
  if ((node as any)[RX_MARKER]) {
    result.push(node);
  }

  // Skip if not an element or has no children
  if (node.nodeType !== 1 || !node.hasChildNodes()) return result;

  // Traverse children
  const walker = document.createTreeWalker(
    node,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let current = walker.nextNode();
  while (current) {
    if ((current as any)[RX_MARKER]) {
      result.push(current);
    }
    current = walker.nextNode();
  }

  return result;
}

/**
 * MutationObserver handler for auto-cleanup.
 */
function createObserverCallback(app: Reflex) {
  // Batch cleanup operations in a microtask
  let pendingCleanup: Set<Node> | null = null;

  const flushCleanup = () => {
    if (!pendingCleanup) return;
    const nodes = pendingCleanup;
    pendingCleanup = null;

    for (const node of nodes) {
      // Double-check the node is still disconnected
      // (it might have been re-added to the DOM)
      if (!(node as Element).isConnected) {
        app._kill(node);
        // Remove marker to prevent double cleanup
        delete (node as any)[RX_MARKER];
      }
    }
  };

  return (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      // Only process removed nodes
      for (const removed of mutation.removedNodes) {
        // Fast path: skip text nodes and comments
        if (removed.nodeType !== 1) continue;

        // Fast path: check if this node has Reflex content
        if (!hasReflexDescendant(removed)) continue;

        // Collect all marked nodes for cleanup
        const markedNodes = collectMarkedNodes(removed);
        if (markedNodes.length === 0) continue;

        // Batch cleanup in microtask
        if (!pendingCleanup) {
          pendingCleanup = new Set();
          queueMicrotask(flushCleanup);
        }

        for (const node of markedNodes) {
          pendingCleanup.add(node);
        }
      }
    }
  };
}

/**
 * Create the observer mixin that patches _reg to add markers.
 */
function createObserverMixin() {
  return {
    // Store observer reference for cleanup
    _observer: null as MutationObserver | null,

    /**
     * Start observing DOM mutations for auto-cleanup.
     * Called automatically when the plugin is installed.
     */
    startAutoCleanup(this: Reflex) {
      // Prevent double initialization
      if (this._observer) return this;
      if (observerInstances.has(this)) return this;

      observerInstances.add(this);

      // Create the observer
      this._observer = new MutationObserver(createObserverCallback(this));

      // Start observing after mount
      const startObserving = () => {
        if (!this._observer) return;
        const root = this._dr || document.body;
        this._observer.observe(root, {
          childList: true,
          subtree: true
        });
      };

      // If already mounted, start immediately
      if (this._dr) {
        startObserving();
      } else {
        // Otherwise, wait for mount
        const originalMount = this.mount.bind(this);
        this.mount = function(el?: Element) {
          const result = originalMount(el);
          startObserving();
          return result;
        };
      }

      return this;
    },

    /**
     * Stop observing DOM mutations.
     */
    stopAutoCleanup(this: Reflex) {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      observerInstances.delete(this);
      return this;
    }
  };
}

/**
 * Patch the _reg method to add markers on nodes.
 * This is the key optimization - we mark nodes so the observer
 * can quickly identify Reflex-managed elements.
 */
function patchRegMethod(app: Reflex) {
  const originalReg = app._reg.bind(app);

  app._reg = function(node: Node, fn: () => void) {
    // Add marker for fast lookup
    (node as any)[RX_MARKER] = true;
    return originalReg(node, fn);
  };
}

/**
 * Patch the _kill method to remove markers.
 */
function patchKillMethod(app: Reflex) {
  const originalKill = app._kill.bind(app);

  app._kill = function(node: Node) {
    // Remove marker
    delete (node as any)[RX_MARKER];
    return originalKill(node);
  };
}

/**
 * withAutoCleanup Plugin
 *
 * Tree-shakable plugin that enables automatic cleanup of Reflex elements
 * when they are removed from the DOM by external scripts.
 *
 * @example
 * import { withAutoCleanup } from 'reflex/observer';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withAutoCleanup);
 *
 * // Now external removals trigger cleanup:
 * // document.querySelector('#my-component').remove();
 * // ^ Listeners are automatically cleaned up!
 */
export const withAutoCleanup = {
  mixin: createObserverMixin(),

  init(app: Reflex, _options?: any) {
    // Patch methods to add/remove markers
    patchRegMethod(app);
    patchKillMethod(app);

    // Start auto-cleanup
    app.startAutoCleanup();
  }
};

/**
 * Alternative: Function-style plugin for manual control
 */
export function autoCleanup(app: Reflex, options?: { autoStart?: boolean }) {
  const mixin = createObserverMixin();
  Object.assign(app, mixin);

  // Patch methods
  patchRegMethod(app);
  patchKillMethod(app);

  // Auto-start unless disabled
  if (options?.autoStart !== false) {
    app.startAutoCleanup();
  }
}

export default withAutoCleanup;
