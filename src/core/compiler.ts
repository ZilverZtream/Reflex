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
import { ScopeContainer } from '../csp/SafeExprParser.js';
// CRITICAL FIX (Issue #5): Import SafeHTML from dedicated module instead of DOM renderer
// This decouples the core compiler from browser-specific code, allowing it to work
// in non-browser environments (React Native, Edge workers) when using VirtualRenderer
import { SafeHTML } from './safe-html.js';
// CRITICAL FIX (Issue #6): Import queueMicrotaskSafe to avoid global polyfill side-effects
import { queueMicrotaskSafe } from './scheduler.js';
import {
  ScopeRegistry,
  createFlatScope,
  isFlatScope,
  getFlatScopeValue,
  setFlatScopeValue,
  type FlatScope,
  type FlatScopeIds
} from './scope-registry.js';
import type { IRendererAdapter } from '../renderers/types.js';

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
 * TASK 13.5: WeakMap-based ID generator for object keys in m-for.
 *
 * When using objects as keys (e.g., :key="item" where item is an object),
 * String(item) returns "[object Object]" which is identical for all objects.
 * This causes key collisions and DOM corruption.
 *
 * Solution: Assign unique numeric IDs to objects using a WeakMap.
 * The WeakMap ensures IDs are garbage collected when objects are no longer referenced.
 */
const objectKeyMap = new WeakMap<object, number>();
let objectKeyUid = 0;

/**
 * Convert a key to a stable, unique string representation.
 * For objects, uses the WeakMap-based ID generator.
 * For primitives, uses String() directly.
 *
 * CRITICAL FIX (Task 14 Issue #3): Key Collision Prevention
 * The previous format `__obj_${id}` could collide with user-provided string keys.
 * Example: If a user's data has { id: "__obj_0" }, it would collide with the
 * auto-generated key for the first object, causing DOM corruption.
 *
 * Solution: Use a more unique prefix that includes:
 * 1. A distinctive marker that's unlikely to appear in user data
 * 2. A non-printable character (U+200B zero-width space) for extra uniqueness
 * 3. The "reflex" namespace to claim ownership
 *
 * New format: `\u200B__rfx_obj__${id}` (starts with zero-width space)
 * This is practically impossible to accidentally match with user data.
 */
const OBJECT_KEY_PREFIX = '\u200B__rfx_obj__';

function getStableKey(key: any): string | number | symbol {
  if (key === null || key === undefined) {
    return String(key);
  }

  // For objects, use WeakMap-based unique ID
  if (typeof key === 'object') {
    // Get raw value first to ensure identity comparison works correctly
    const rawKey = getRawValue(key);
    if (typeof rawKey === 'object' && rawKey !== null) {
      let id = objectKeyMap.get(rawKey);
      if (id === undefined) {
        id = objectKeyUid++;
        objectKeyMap.set(rawKey, id);
      }
      return `${OBJECT_KEY_PREFIX}${id}`;
    }
  }

  // For primitives, use direct value (no conversion to string for better Map keys)
  return key;
}

/**
 * Clone a node while preserving node state (valueRef) from WeakMap.
 *
 * TASK 6: THE "PHANTOM STATE" MANDATE
 * BREAKING CHANGE: State is NO LONGER stored on DOM nodes (el._rx_value_ref).
 * All state is stored in a closure-protected WeakMap<Element, NodeState>.
 *
 * CRITICAL FIX: Data Loss in Cloned Nodes
 * node.cloneNode(true) only copies attributes, not WeakMap entries.
 * This helper recursively walks the cloned tree and copies nodeState from
 * corresponding source nodes, ensuring object identity is preserved.
 *
 * Security Impact: Malicious scripts can NO LONGER access or spoof internal
 * state because it doesn't exist on the DOM - it lives in a closure-protected WeakMap.
 *
 * @param {Node} node - The node to clone
 * @param {boolean} deep - Whether to clone children (default: true)
 * @param {WeakMap} nodeState - Optional WeakMap to copy state from (if available)
 * @returns {Node} The cloned node with state preserved in WeakMap
 */
export function cloneNodeWithProps(node: any, deep = true, nodeState?: WeakMap<Element, any>): any {
  const cloned = node.cloneNode(deep);

  // TASK 6: Copy node state from WeakMap if provided
  if (nodeState && node.nodeType === 1) { // Element node
    const state = nodeState.get(node);
    if (state && state.valueRef !== undefined) {
      // Copy state to the cloned node
      nodeState.set(cloned, { valueRef: state.valueRef });
    }
  }

  // If deep cloning, recursively copy node state for all descendants
  if (deep && node.childNodes && node.childNodes.length > 0) {
    const copyStateRecursive = (source: any, target: any) => {
      // Handle both Element and DocumentFragment
      const sourceChildren = source.childNodes;
      const targetChildren = target.childNodes;

      if (sourceChildren && targetChildren && sourceChildren.length === targetChildren.length) {
        for (let i = 0; i < sourceChildren.length; i++) {
          const srcChild = sourceChildren[i];
          const tgtChild = targetChildren[i];

          // TASK 6: Copy node state from WeakMap
          if (nodeState && srcChild.nodeType === 1) {
            const childState = nodeState.get(srcChild);
            if (childState && childState.valueRef !== undefined) {
              nodeState.set(tgtChild, { valueRef: childState.valueRef });
            }
          }

          // Recursively process children
          if (srcChild.childNodes && srcChild.childNodes.length > 0) {
            copyStateRecursive(srcChild, tgtChild);
          }
        }
      }
    };

    copyStateRecursive(node, cloned);
  }

  return cloned;
}

/**
 * TASK 8.1: Path Segment AST for Dynamic Resolution
 *
 * Represents a single segment in a property access path.
 * Distinguishes between static properties and dynamic expressions.
 *
 * Examples:
 *   user.name → [{ key: 'user', type: 'prop' }, { key: 'name', type: 'prop' }]
 *   users[id] → [{ key: 'users', type: 'prop' }, { key: 'id', type: 'dynamic' }]
 *   users['admin'] → [{ key: 'users', type: 'prop' }, { key: 'admin', type: 'prop' }]
 */
interface PathSegment {
  key: string;
  type: 'prop' | 'dynamic';
}

/**
 * Parse a property path that may contain both dot notation and bracket notation.
 *
 * TASK 8.1: Dynamic Path Resolution
 * This parser now returns typed segments that distinguish between:
 * - Static properties: user.name or users['admin'] (quotes indicate literal)
 * - Dynamic expressions: users[id] or data[currentIndex] (no quotes = evaluate)
 *
 * Examples:
 *   'foo.bar' → [{ key: 'foo', type: 'prop' }, { key: 'bar', type: 'prop' }]
 *   'foo[0]' → [{ key: 'foo', type: 'prop' }, { key: '0', type: 'prop' }]
 *   'list[index]' → [{ key: 'list', type: 'prop' }, { key: 'index', type: 'dynamic' }]
 *   'users[id].name' → [{ key: 'users', type: 'prop' }, { key: 'id', type: 'dynamic' }, { key: 'name', type: 'prop' }]
 *   "data['key']" → [{ key: 'data', type: 'prop' }, { key: 'key', type: 'prop' }]
 *
 * CRITICAL FIX #3: m-model Bracket Notation Support
 * Previous implementation used simple exp.split('.') which failed on array indices
 * This parser handles both dot notation and bracket notation correctly
 */
function parsePath(exp: string): PathSegment[] {
  const paths: PathSegment[] = [];
  let current = '';
  let i = 0;

  while (i < exp.length) {
    const char = exp[i];

    if (char === '.') {
      // Dot notation - push current segment and reset
      if (current) {
        paths.push({ key: current, type: 'prop' });
        current = '';
      }
      i++;
    } else if (char === '[') {
      // Bracket notation - push current segment if any
      if (current) {
        paths.push({ key: current, type: 'prop' });
        current = '';
      }

      // Find the closing bracket
      i++; // Skip opening bracket
      let bracketContent = '';
      while (i < exp.length && exp[i] !== ']') {
        bracketContent += exp[i];
        i++;
      }

      // TASK 8.1: Determine if bracket content is literal (quoted) or dynamic
      // Quoted strings like ["key"] or ['key'] are treated as literal properties
      // Unquoted expressions like [id] or [currentIndex] are dynamic (must be evaluated)
      let segmentType: 'prop' | 'dynamic' = 'dynamic'; // Default to dynamic
      let segmentKey = bracketContent;

      if ((bracketContent.startsWith('"') && bracketContent.endsWith('"')) ||
          (bracketContent.startsWith("'") && bracketContent.endsWith("'"))) {
        // Quoted string - treat as literal property access
        segmentKey = bracketContent.slice(1, -1);
        segmentType = 'prop';
      } else if (/^\d+$/.test(bracketContent)) {
        // Pure numeric index like [0] or [123] - treat as literal property (array index)
        segmentType = 'prop';
      }
      // Otherwise: unquoted variable name like [id] or [currentKey] - dynamic

      paths.push({ key: segmentKey, type: segmentType });
      i++; // Skip closing bracket
    } else {
      // Regular character - add to current segment
      current += char;
      i++;
    }
  }

  // Push final segment if any
  if (current) {
    paths.push({ key: current, type: 'prop' });
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

      // CRITICAL FIX (Issue #7): Parse all comma-separated duration values and use the maximum
      // Previously: parseFloat("0.5s, 1s") returned 0.5, cutting off the animation early
      // When an element has multiple transitions (e.g., opacity 0.5s, transform 1s),
      // the browser reports "0.5s, 1s" but parseFloat only gets the first value.
      //
      // Solution: Split by comma, parse each value, and use the maximum.
      const parseMaxDuration = (str: string): number => {
        if (!str) return 0;
        return Math.max(...str.split(',').map(s => {
          const val = parseFloat(s.trim());
          return isNaN(val) ? 0 : val;
        }));
      };

      const duration = parseMaxDuration(style.transitionDuration) || parseMaxDuration(style.animationDuration) || 0;
      const delay = parseMaxDuration(style.transitionDelay) || parseMaxDuration(style.animationDelay) || 0;
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
 * TASK 12.3: Sort ref array by DOM document order using compareDocumentPosition.
 *
 * DOM-Based Sort: This ensures the array matches the visual DOM order 100%.
 * Do NOT sort based on loop index - this fails for interleaved loops
 * (e.g., multiple m-for targeting the same tbody via display: contents).
 *
 * The reconciliation assumes refs from a loop are contiguous. Splicing destroys
 * the order of interleaved loops. This function restores correct DOM order.
 *
 * @param refArray - Array of DOM elements to sort in-place
 */
function sortRefsByDOM(refArray: Element[]): void {
  if (!refArray || refArray.length <= 1) return;

  // Sort using compareDocumentPosition
  // Node.DOCUMENT_POSITION_FOLLOWING (4): b follows a in document order
  refArray.sort((a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    // If b follows a, a should come first (return -1)
    // If a follows b (DOCUMENT_POSITION_PRECEDING = 2), b should come first (return 1)
    return (position & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });
}

/**
 * Compiler mixin for Reflex class.
 */
export const CompilerMixin = {
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
  _registerScopeWithGC(node, scope) {
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

  _queueWalk(node: any, scope: any) {
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

  _flushWalkQueue() {
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

  _w(n, o) {
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
          // TASK 13.2: Skip nodes that were already walked (e.g., slot content walked with parent scope)
          // This prevents slot content from being re-walked with the wrong (component) scope
          if (this._walkedNodes && this._walkedNodes.has(c)) {
            c = next;
            continue;
          }

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
    } finally {
      // Decrement depth counter when exiting the walk
      this._walkDepth--;
    }
  },

  /**
   * Clone a node while preserving node state from WeakMap.
   * TASK 6: Delegates to the standalone cloneNodeWithProps helper with _nodeState WeakMap.
   */
  _cloneNode(node, deep = true) {
    return cloneNodeWithProps(node, deep, this._nodeState);
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
    // TASK 6: Eagerly evaluate and store the object reference in WeakMap BEFORE any effects run.
    // This ensures m-model can find the valueRef when setting initial checked state.
    if ((n.type === 'checkbox' || n.type === 'radio') && n.hasAttribute(':value')) {
      const valueExp = n.getAttribute(':value');
      if (valueExp) {
        try {
          const fn = this._fn(valueExp);
          const initialValue = fn(this.s, o);
          if (initialValue !== null && typeof initialValue === 'object') {
            // TASK 6: Store in WeakMap instead of DOM property
            const state = this._nodeState.get(n) || {};
            state.valueRef = initialValue;
            this._nodeState.set(n, state);
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

          // TASK 8.4: Check if this ref should be an array (for m-for usage)
          // Auto-detect array mode by checking:
          // 1. If state[refName] is already an array (user pre-initialized)
          // 2. If _refs[refName] is already an array (second+ item in loop)
          // 3. If scope is a loop scope (has loop variables like item, index)
          // Use property access instead of 'in' operator for proxy compatibility
          const isArrayRef = (this.s[v] && Array.isArray(this.s[v])) ||
                             Array.isArray(this._refs[v]) ||
                             (o && isFlatScope(o) && Object.keys(o._ids).length > 0);

          if (isArrayRef) {
            // Array mode: push element to array
            // TASK 8.4: Initialize arrays if they don't exist
            if (!Array.isArray(this._refs[v])) {
              this._refs[v] = [];
            }
            // TASK 9.2: Ensure state array exists for synchronization
            if (!this.s[v] || !Array.isArray(this.s[v])) {
              this.s[v] = [];
            }
            this.s[v].push(n);
            this._refs[v].push(n);

            // CRITICAL FIX (Issue #1): O(N²) Unmount Performance Fix for m-ref Arrays
            //
            // PROBLEM: When unmounting a list of N items (e.g., navigating away from a page
            // with 5,000 items), _kill runs for every item. Each cleanup callback uses
            // splice() which is O(N) because it shifts all subsequent elements.
            // N calls × O(N) splice = O(N²) complexity.
            //
            // SOLUTION: Use batched removal with Set for O(1) marking + single O(N) filter.
            // Instead of immediately splicing, we mark elements for removal in a Set.
            // On the next microtask, we filter out all marked elements in one pass.
            // This converts O(N²) to O(N) for bulk unmounts.
            //
            // CORRECTNESS: DOM order is still preserved because:
            // 1. filter() preserves relative order of remaining elements
            // 2. The microtask runs synchronously after all unmount callbacks complete
            // 3. Developers accessing refs during unmount will still see correct order
            //    (elements are only removed after all callbacks have run)
            this._reg(n, () => {
              const stateArray = this.s[v];
              const refsArray = this._refs[v];

              // Initialize batch removal sets if they don't exist
              if (!this._refBatchRemoval) {
                this._refBatchRemoval = new Map();
              }

              // Get or create the batch for this ref name
              let batch = this._refBatchRemoval.get(v);
              if (!batch) {
                batch = { stateSet: new Set(), refsSet: new Set(), scheduled: false };
                this._refBatchRemoval.set(v, batch);
              }

              // Mark element for removal (O(1))
              if (Array.isArray(stateArray)) {
                batch.stateSet.add(n);
              }
              if (Array.isArray(refsArray)) {
                batch.refsSet.add(n);
              }

              // Schedule batch removal if not already scheduled
              if (!batch.scheduled) {
                batch.scheduled = true;
                queueMicrotaskSafe(() => {
                  // Apply batch removal (single O(N) filter)
                  if (batch.stateSet.size > 0 && Array.isArray(this.s[v])) {
                    const raw = this.toRaw(this.s[v]);
                    // Filter in place to avoid creating new array
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < raw.length; readIdx++) {
                      if (!batch.stateSet.has(raw[readIdx])) {
                        raw[writeIdx++] = raw[readIdx];
                      }
                    }
                    raw.length = writeIdx;
                  }

                  if (batch.refsSet.size > 0 && Array.isArray(this._refs[v])) {
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < this._refs[v].length; readIdx++) {
                      if (!batch.refsSet.has(this._refs[v][readIdx])) {
                        this._refs[v][writeIdx++] = this._refs[v][readIdx];
                      }
                    }
                    this._refs[v].length = writeIdx;
                  }

                  // Clear the batch
                  this._refBatchRemoval.delete(v);
                });
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
            // CRITICAL FIX: Recursive Directives via Effects
            // Queue walks instead of calling _w directly to prevent stack overflow
            // when m-if toggles cause nested effects to trigger more _w calls
            contentNodes.forEach(node => {
              if (node.nodeType === 1) {
                this._bnd(node as Element, o);
                this._queueWalk(node as Element, o);
              }
            });
            this._flushWalkQueue();

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
      const elementChildren = Array.from(tplContent.childNodes).filter(n => n.nodeType === 1);
      if (elementChildren.length === 1) {
        const contentEl = elementChildren[0] as Element;
        const contentMIfExpr = contentEl.getAttribute('m-if');
        if (contentMIfExpr) {
          contentIfFn = this._fn(contentMIfExpr);
        }
      }
    }

    let rows = new Map();     // key -> { node, oldIdx }
    let oldKeys = [];         // Track key order for LIS

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
      const nodesToWalk = [];

      // Configure reconciliation with Reflex-specific logic
      const config = {
        getKey: (item, index, scope) => {
          let key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, scope)) : index;
          // TASK 13.5: Convert object keys to stable unique IDs
          // This prevents "[object Object]" collisions when objects are used as keys
          key = getStableKey(key);
          // Handle duplicate keys to prevent ghost nodes
          return resolveDuplicateKey(seenKeys, key, index);
        },

        createScope: (item, index) => {
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
        destroyScope: (scope) => {
          if (scope && isFlatScope(scope)) {
            for (const varName in scope._ids) {
              const id = scope._ids[varName];
              if (id) {
                this._scopeRegistry.delete(id);
              }
            }
          }
        },

        createNode: (item, index) => {
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
            const elementNodes = contentNodes.filter(node => node.nodeType === 1);

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
                  const el = cloned as Element;
                  const nodeIfExpr = el.getAttribute('m-if');
                  if (nodeIfExpr) {
                    // Remove m-if so _w doesn't try to process it again
                    el.removeAttribute('m-if');
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

              // TASK 11 FIX: Clone content nodes and evaluate m-if before appending
              for (const childNode of contentNodes) {
                const cloned = this._cloneNode(childNode, true);
                if (cloned.nodeType === 1) {
                  const el = cloned as Element;
                  const nodeIfExpr = el.getAttribute('m-if');
                  if (nodeIfExpr) {
                    // Remove m-if so _w doesn't try to process it again
                    el.removeAttribute('m-if');
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

        updateNode: (node, item, index) => {
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

        removeNode: (node) => {
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
        // TASK 11 FIX: Check both template m-if (ifFn) AND content element m-if (contentIfFn)
        shouldKeep: (ifFn || contentIfFn) ? (item, index, scope) => {
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

      result.keys.forEach((key, index) => {
        const rowData = result.rows.get(key);
        if (!rowData) return;

        const rowNode = rowData.node;
        if (!rowNode || rowNode.nodeType !== 1) return;

        // TASK 12.10: Find all m-ref elements within this row
        // This is O(1) per row (browser's querySelectorAll is highly optimized)
        // vs O(totalRefs) of scanning all global refs
        const refElements: Element[] = [];

        // Check if root node has m-ref
        const rootRefName = (rowNode as Element).getAttribute?.('m-ref');
        if (rootRefName) {
          refElements.push(rowNode as Element);
        }

        // Find descendant m-ref elements
        if (rowNode.querySelectorAll) {
          const descendants = (rowNode as Element).querySelectorAll('[m-ref]');
          refElements.push(...Array.from(descendants));
        }

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
      refArraysToUpdate.forEach((nodeList, refName) => {
        // Extract nodes (we'll sort by DOM position, not loop index)
        const orderedNodes = nodeList.map(item => item.node);

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
          const indices = orderedNodes.map(n => targetArray.indexOf(n));
          const validIndices = indices.filter(i => i !== -1);

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
            const sortedIndices = [...validIndices].sort((a, b) => b - a);
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
          const indices = orderedNodes.map(n => stateArray.indexOf(n));
          const validIndices = indices.filter(i => i !== -1);

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
            const raw = this.toRaw(stateArray);

            // Remove all our nodes from their current positions (iterate backwards)
            const sortedIndices = [...validIndices].sort((a, b) => b - a);
            for (const idx of sortedIndices) {
              raw.splice(idx, 1);
            }

            // Insert orderedNodes at the minIdx position (where the first one was)
            // This preserves refs from other m-for loops
            raw.splice(minIdx, 0, ...orderedNodes);

            // TASK 12.3: Post-process - sort by DOM position for interleaved refs
            sortRefsByDOM(raw);

            // CRITICAL FIX: Global Ref Array Thrashing
            // Previous implementation: stateArray.splice(0, stateArray.length, ...raw)
            // This replaces the entire array, triggering watchers on ALL indices
            // even when only one item moved.
            //
            // NEW: Do targeted updates - only modify positions that actually changed
            // This reduces reactivity triggers from O(N) to O(changed items)
            let changedCount = 0;
            for (let i = 0; i < raw.length; i++) {
              if (stateArray[i] !== raw[i]) {
                stateArray[i] = raw[i];
                changedCount++;
              }
            }
            // Handle length changes (items removed from end)
            if (stateArray.length > raw.length) {
              stateArray.length = raw.length;
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
    //
    // TASK 12.5: Whitelist safe "on" attributes
    // The naive attr.startsWith('on') blocks valid attributes like 'only', 'once', 'loading="lazy"'
    // Whitelist known-safe attributes that happen to start with "on"
    const SAFE_ON_ATTRS = new Set([
      'only',       // Common boolean/value attribute
      'once',       // Playback attribute for audio/video
      'on',         // Some frameworks use this
      'one',        // Generic attribute
      'online',     // Network status attribute
      // NOTE: Event handlers like 'onerror', 'onclick', 'onload' are NOT whitelisted
    ]);

    const attrLower = att.toLowerCase();
    if (attrLower.startsWith('on') && !SAFE_ON_ATTRS.has(attrLower)) {
      // Additional check: event handlers are specifically "on" + event name
      // Event names are things like "click", "load", "error", "mouseover" etc.
      // If it's a known safe attribute, allow it
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
    // TASK 13.3: During hydration, we MUST read the existing className and style.cssText
    // The SSR-rendered values should be preserved, not destroyed. The previous logic was
    // backwards - it skipped capture during hydration, causing static classes to be lost.
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
        // CRITICAL: Decode HTML entities AND strip control characters BEFORE validation
        // Attack vectors:
        //   1. Entity encoding: :href="'j&#97;vascript:alert(1)'"
        //      - Regex sees: j&#97;vascript: (passes)
        //      - Browser sees: javascript:alert(1) (executes!)
        //   2. Control characters: :href="'java\tscript:alert(1)'"
        //      - Regex sees: java\tscript: (passes if not stripped)
        //      - Browser sees: javascript:alert(1) (executes!)
        if (isUrlAttr && v != null && typeof v === 'string') {
          // CRITICAL FIX: Use centralized sanitization helper
          // This decodes ALL entities (including &Tab;, &NewLine;, etc.)
          // and strips ALL control characters (0x00-0x1F, 0x7F-0x9F)
          const sanitizedUrl = this._decodeAndSanitizeUrl(v);

          // Check the sanitized URL against our allowlist
          const isSafe = RELATIVE_URL_RE.test(sanitizedUrl) || SAFE_URL_RE.test(sanitizedUrl);
          if (!isSafe) {
            console.warn('Reflex: Blocked unsafe URL protocol in', att + ':', v, `(sanitized: ${sanitizedUrl})`);
            v = 'about:blank';
          }
        }

        // CRITICAL FIX: srcdoc validation - requires HTML sanitization, not URL validation
        // srcdoc attribute contains HTML content that can execute scripts
        // Apply DOMPurify sanitization similar to m-html
        //
        // TASK 12.7: Remove srcdoc sanitization opt-out
        // srcdoc MUST always pass through DOMPurify, regardless of the sanitize flag.
        // This is a guaranteed XSS hole if allowed to bypass.
        // Unlike m-html which may have legitimate use cases for opt-out, srcdoc
        // is always rendered in an isolated iframe context where XSS is particularly dangerous.
        if (isSrcdoc && v != null && typeof v === 'string') {
          const purify = this.cfg.domPurify;
          if (purify && typeof purify.sanitize === 'function') {
            v = purify.sanitize(v);
          } else {
            // TASK 12.7: Hard block - srcdoc REQUIRES DOMPurify, no opt-out allowed
            // This is a security-critical change - developers MUST configure DOMPurify
            throw new Error(
              'Reflex SECURITY ERROR: srcdoc attribute requires DOMPurify for safe HTML.\n' +
              'srcdoc accepts HTML content that can execute scripts.\n\n' +
              'Solution:\n' +
              '  1. Install DOMPurify: npm install dompurify\n' +
              '  2. Configure: app.configure({ domPurify: DOMPurify })\n' +
              '  3. Import: import DOMPurify from \'dompurify\'\n\n' +
              'SECURITY NOTE: Unlike m-html, srcdoc does NOT support { sanitize: false }.\n' +
              'The srcdoc attribute is always sanitized to prevent XSS attacks.'
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

                // CRITICAL SECURITY FIX: Apply comprehensive CSS sanitization
                // Object-style bindings must use the same sanitization as string-style bindings
                // This blocks:
                // - javascript:, data:, vbscript: protocols
                // - expression() (IE CSS expressions)
                // - -moz-binding (Firefox XBL binding)
                // - behavior: (IE behavior)
                // - @import directives
                // - CSS escape sequence bypasses
                // Previously only validated URLs for specific properties, allowing bypasses via:
                // - :style="{ width: 'expression(alert(1))' }"
                // - :style="{ '--custom': 'url(javascript:alert(1))' }"
                strVal = this._sanitizeStyleString(strVal);

                // If sanitization returned empty string, skip this property
                if (!strVal) {
                  continue;
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
          // CRITICAL SECURITY FIX: Block innerHTML and outerHTML binding to prevent SafeHTML bypass
          // The m-html directive enforces SafeHTML for XSS protection, but :innerHTML="str" bypasses this
          // Attackers or careless developers could inject XSS by binding to innerHTML directly
          // This creates an inconsistent security model where m-html is safe but :innerHTML is not
          const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
          if (dangerousHtmlProps.includes(att)) {
            throw new Error(
              `Reflex: SECURITY ERROR - Cannot bind to '${att}' property.\n` +
              `The '${att}' property accepts raw HTML and bypasses SafeHTML security.\n\n` +
              `Solution:\n` +
              `  1. Use the m-html directive instead: <div m-html="safeContent"></div>\n` +
              `  2. Wrap your HTML with SafeHTML: SafeHTML.sanitize(htmlString)\n` +
              `  3. Configure DOMPurify: SafeHTML.configureSanitizer(DOMPurify)\n\n` +
              `This prevents XSS attacks by enforcing consistent security checks.\n` +
              `For dynamic text content (no HTML), use m-text or :textContent instead.`
            );
          }

          // CRITICAL FIX: Read-Only Property Crash
          // Many DOM properties are read-only (e.g., input.list, video.duration, element.clientTop)
          // In strict mode (ES modules), assigning to read-only properties throws TypeError
          // Use try-catch to gracefully fall back to setAttribute for read-only properties
          try {
            // TASK 6 + 13.1: Object Identity for Checkbox/Radio/Option Values
            // When binding :value="obj" to a checkbox, radio, or option, the DOM stringifies objects to "[object Object]"
            // This makes it impossible to match objects in m-model array/select binding since all objects become identical strings
            // Solution: Store the original object reference in WeakMap for later retrieval by m-model
            if (att === 'value' && v !== null && typeof v === 'object' &&
                (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'OPTION')) {
              // TASK 6/13.1: Store in WeakMap instead of DOM property
              const state = this._nodeState.get(el) || {};
              state.valueRef = v;
              this._nodeState.set(el, state);
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
            // CRITICAL FIX: Unhandled SVG xlink:href Namespace
            // SVG namespaced attributes like xlink:href require setAttributeNS for strict XML/SVG contexts.
            // Modern browsers handle xlink:href without namespacing, but strict SVG parsers
            // (or older user agents) may fail to render SVG icons or references correctly.
            //
            // Namespace URIs:
            // - xlink: http://www.w3.org/1999/xlink (for xlink:href, xlink:show, etc.)
            // - xml: http://www.w3.org/XML/1998/namespace (for xml:lang, xml:space)
            if (att === 'xlink:href' || att.startsWith('xlink:')) {
              const XLINK_NS = 'http://www.w3.org/1999/xlink';
              const localName = att.split(':')[1]; // 'href' from 'xlink:href'
              if (next === null) {
                el.removeAttributeNS(XLINK_NS, localName);
              } else {
                el.setAttributeNS(XLINK_NS, att, next);
              }
            } else if (att.startsWith('xml:')) {
              // Handle xml: namespace attributes (xml:lang, xml:space, etc.)
              const XML_NS = 'http://www.w3.org/XML/1998/namespace';
              const localName = att.split(':')[1];
              if (next === null) {
                el.removeAttributeNS(XML_NS, localName);
              } else {
                el.setAttributeNS(XML_NS, att, next);
              }
            } else {
              next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
            }
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
   * BREAKING CHANGE: Expression MUST evaluate to a SafeHTML instance.
   * Raw strings will throw TypeError.
   *
   * @example
   * // In your state/computed:
   * computed: {
   *   htmlContent() {
   *     return SafeHTML.sanitize(this.userInput);
   *   }
   * }
   *
   * // In template:
   * <div m-html="htmlContent"></div>
   */
  _html(el, exp, o) {
    const fn = this._fn(exp);
    let prev: SafeHTML | null = null;
    const self = this;

    const e = this.createEffect(() => {
      try {
        const rawValue = fn(self.s, o);

        // BREAKING CHANGE: Value MUST be SafeHTML
        if (!SafeHTML.isSafeHTML(rawValue)) {
          throw new TypeError(
            `Reflex Security: m-html expression must evaluate to SafeHTML.\n` +
            `Expression: ${exp}\n` +
            `Received: ${typeof rawValue}\n\n` +
            `BREAKING CHANGE: Raw strings are no longer accepted.\n\n` +
            `Migration:\n` +
            `  1. Install DOMPurify: npm install dompurify @types/dompurify\n` +
            `  2. Configure at app startup: SafeHTML.configureSanitizer(DOMPurify);\n` +
            `  3. In your state/computed, wrap with SafeHTML:\n` +
            `     computed: {\n` +
            `       htmlContent() {\n` +
            `         return SafeHTML.sanitize(this.userInput);\n` +
            `       }\n` +
            `     }\n` +
            `  4. Then use: <div m-html="htmlContent"></div>`
          );
        }

        const safeHtml = rawValue as SafeHTML;
        const htmlString = safeHtml.toString();

        // TASK 12.9: "Loose" Hydration - optimized comparison to avoid expensive DOM parsing
        // During hydration, compare current innerHTML with new value
        // Only update if they differ to prevent destroying iframe state, focus, etc.
        if (self._hydrateMode) {
          const currentHTML = el.innerHTML;

          // Fast path: if strings match exactly, skip update
          if (currentHTML === htmlString) {
            prev = safeHtml;
            return;
          }

          // TASK 12.9: Text Comparison for text-only content
          // If the element only contains text (no child elements), compare directly
          // This avoids expensive DOM parsing for simple text content
          if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) {
            // Single text node - compare text content directly
            if (el.textContent === htmlString.replace(/<[^>]*>/g, '')) {
              prev = safeHtml;
              return;
            }
          }

          // TASK 13.7: Fast Path - Length Comparison First
          // Compare string lengths before doing expensive string comparison
          // If lengths differ, content is definitely different - skip the comparison
          // This is O(1) and catches most cases where content has changed
          //
          // NOTE: Adler-32 hash was removed because:
          // 1. Hash collisions (though rare) can cause silent data corruption
          // 2. Hash computation is O(n) anyway, same as string comparison
          // 3. Correctness > micro-optimization for security-critical code
          if (currentHTML.length !== htmlString.length) {
            // Lengths differ - content is definitely different, proceed to update
          } else if (currentHTML === htmlString) {
            // Lengths match AND content matches - skip the update
            prev = safeHtml;
            return;
          }

          // Lengths match but content differs - fall back to normalized comparison
          // Only now do we incur the cost of DOM parsing
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = htmlString;
          const normalizedNew = tempDiv.innerHTML;

          if (currentHTML === normalizedNew) {
            // Content matches after normalization - skip the destructive innerHTML write
            prev = safeHtml;
            return;
          }
        }

        // Only update if content changed
        if (prev === null || prev.toString() !== htmlString) {
          prev = safeHtml;

          // Clean up child resources before innerHTML replacement
          // innerHTML blindly replaces DOM content without cleanup, leaking:
          // - Reactive effects attached to child elements
          // - Event listeners registered via _reg
          // - Component instances and their resources
          let child = el.firstChild;
          while (child) {
            const next = child.nextSibling;
            if (child.nodeType === 1) {
              // Kill all Reflex resources attached to this element tree
              this._kill(child);
            }
            child = next;
          }

          // Use renderer's setInnerHTML which also enforces SafeHTML
          this._ren.setInnerHTML(el, safeHtml);
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
  _show(el, exp, o, trans) {
    const fn = this._fn(exp);
    const d = el.style.display === 'none' ? '' : el.style.display;
    let prev, transitioning = false;

    // TASK 12.4: Helper to ensure element is visible
    // Handles CSS class conflicts by checking computed style and forcing display if needed
    const forceShow = (element) => {
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
              forceShow(el);
              this._runTrans(el, trans, 'enter', () => { transitioning = false; });
            } else {
              this._runTrans(el, trans, 'leave', () => {
                // Hide element
                el.style.display = 'none';
                transitioning = false;
              });
            }
          } else {
            // TASK 12.4: Handle show/hide without transitions
            if (!show) {
              // Hide element
              el.style.display = 'none';
            } else {
              // Show element - handle CSS class conflict
              forceShow(el);
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
   *
   * CRITICAL FIX (Issue #2): m-model Dynamic Type Switching
   *
   * PROBLEM: The original implementation captured input type at binding time:
   *   const type = el.type; const isChk = type === 'checkbox'; ...
   * If the input type changes dynamically (e.g., <input :type="showPassword ? 'text' : 'password'">
   * or switching text -> checkbox), the m-model logic doesn't adapt. The binding becomes
   * desynchronized from the DOM type.
   *
   * SOLUTION: Move type detection inside the reactive effect and input handler so it's
   * evaluated on each update/input. Now switching from text to checkbox will:
   * - Re-evaluate the type in the effect
   * - Use the correct DOM property (checked vs value)
   * - Fire the correct events (change vs input)
   *
   * PERFORMANCE: Type detection inside effects adds a negligible String.toLowerCase() call
   * per reactive update. This is acceptable because m-model updates are user-driven (typing)
   * which are inherently rate-limited by human input speed (~20-40 chars/sec max).
   */
  _mod(el, exp, o, modifiers = []) {
    const fn = this._fn(exp);
    // CRITICAL FIX (Issue #2): Only capture modifiers and lazy flag at binding time
    // Type-related flags (isChk, isRadio, isNum, isMultiSelect) are now dynamic
    const hasNumberMod = modifiers.includes('number');
    const isLazy = modifiers.includes('lazy');

    // Initial file input warning (still static - just a warning)
    const initialType = (el.type || '').toLowerCase();
    if (initialType === 'file') {
      if (!this._fileInputsWarned.has(el)) {
        this._fileInputsWarned.add(el);
        console.warn(
          'Reflex: m-model is not supported on file inputs (security restriction).\n' +
          'Use @change="handler" and access el.files instead.\n' +
          'Note: If the input type changes dynamically, m-model will work when not type="file".'
        );
      }
    }

    const e = this.createEffect(() => {
      try {
        // CRITICAL FIX (Issue #2): Dynamic type detection inside effect
        // Re-evaluate type on every reactive update to handle :type bindings
        const currentType = (el.type || '').toLowerCase();

        // Handle file inputs (read-only .value)
        if (currentType === 'file') {
          fn(this.s, o); // Track dependency only
          return;
        }

        // CRITICAL FIX (Issue #2): Dynamic type flags
        const isChk = currentType === 'checkbox';
        const isRadio = currentType === 'radio';
        const isNum = currentType === 'number' || currentType === 'range' || hasNumberMod;
        const isMultiSelect = currentType === 'select-multiple';

        const v = fn(this.s, o);

        // TASK 8.3: Check contenteditable inside the effect
        // Elements with contenteditable="true" use innerText/innerHTML, not value
        // Check both property and attribute for compatibility with different DOM implementations
        const isContentEditable = el.contentEditable === 'true' ||
                                   el.getAttribute('contenteditable') === 'true';
        if (isContentEditable) {
          // contenteditable elements use innerText (or innerHTML if .html modifier is used)
          const useHTML = modifiers.includes('html');
          if (useHTML) {
            // TASK 8.3: Unified Security Type System
            // BREAKING CHANGE: m-model.html ONLY accepts SafeHTML instances
            // This eliminates ad-hoc sanitization and enforces a single security model
            if (!SafeHTML.isSafeHTML(v)) {
              throw new TypeError(
                'Reflex Security: m-model.html requires a SafeHTML value.\n\n' +
                'BREAKING CHANGE: Raw strings are no longer accepted.\n\n' +
                'Migration:\n' +
                '  1. Import SafeHTML: import { SafeHTML } from \'reflex\';\n' +
                '  2. Configure sanitizer (once): SafeHTML.configureSanitizer(DOMPurify);\n' +
                '  3. Sanitize user content: const safe = SafeHTML.sanitize(userInput);\n' +
                '  4. For static HTML: const trusted = SafeHTML.unsafe(staticHtml);\n\n' +
                'Example:\n' +
                '  // In your model:\n' +
                '  this.s.content = SafeHTML.sanitize(userInput);\n\n' +
                'Security: This ensures ALL HTML in Reflex goes through SafeHTML,\n' +
                'making it impossible to accidentally render unsanitized content.'
              );
            }
            const next = v.toString();
            if (el.innerHTML !== next) el.innerHTML = next;
          } else {
            const next = v == null ? '' : String(v);
            if (el.innerText !== next) el.innerText = next;
          }
        } else if (isChk) {
          // Handle checkbox array binding
          if (Array.isArray(v)) {
            // TASK 6: Object Identity for Checkbox Values
            // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
            // which makes all objects appear identical. Get the original object from WeakMap.
            const state = this._nodeState.get(el);
            const elValue = (state && state.valueRef !== undefined) ? state.valueRef : el.value;
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
          // TASK 13.1: Support object values in multi-select
          // DOM option.value is always a string, but model data might contain objects or numbers
          // Get the original object from nodeState if available
          const options = el.options;
          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const optState = this._nodeState.get(opt);
            const optValue = (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
            const isObjectValue = optValue !== null && typeof optValue === 'object';
            const rawOptValue = getRawValue(optValue);

            opt.selected = selectedValues.some(val => {
              // For objects, use identity comparison on raw (unwrapped) values
              if (isObjectValue || (val !== null && typeof val === 'object')) {
                const rawVal = getRawValue(val);
                return rawVal === rawOptValue;
              }
              // For primitives, use type coercion to match DOM string values
              return String(val) === String(optValue);
            });
          }
        } else if (el.tagName === 'SELECT') {
          // TASK 13.1: Handle single-select with object values
          // The model value v might be an object, and options might have object values stored in nodeState
          const options = el.options;
          let foundMatch = false;
          const rawV = getRawValue(v);
          const isObjectModel = v !== null && typeof v === 'object';

          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const optState = this._nodeState.get(opt);
            const optValue = (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
            const isObjectOption = optValue !== null && typeof optValue === 'object';
            const rawOptValue = getRawValue(optValue);

            let isMatch = false;
            if (isObjectModel || isObjectOption) {
              // Object comparison: use identity
              isMatch = rawV === rawOptValue;
            } else {
              // Primitive comparison: use string coercion
              isMatch = String(v) === String(optValue);
            }

            if (isMatch && !foundMatch) {
              el.selectedIndex = i;
              foundMatch = true;
            }
          }

          // If no match and value is null/undefined, reset to no selection or first option
          if (!foundMatch && v == null) {
            el.selectedIndex = options.length > 0 ? 0 : -1;
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

      // CRITICAL FIX (Issue #2): Dynamic type detection in input handler
      // Re-evaluate type on every input event to handle :type bindings
      const currentType = (el.type || '').toLowerCase();
      const isChk = currentType === 'checkbox';
      const isRadio = currentType === 'radio';
      const isNum = currentType === 'number' || currentType === 'range' || hasNumberMod;
      const isMultiSelect = currentType === 'select-multiple';

      let v;
      // TASK 8.3: Check contenteditable dynamically
      // Check both property and attribute for compatibility
      const isContentEditable = el.contentEditable === 'true' ||
                                 el.getAttribute('contenteditable') === 'true';
      if (isContentEditable) {
        // contenteditable elements use innerText (or innerHTML if .html modifier is used)
        const useHTML = modifiers.includes('html');
        if (useHTML) {
          // TASK 12.1: Fix m-model.html Crash Loop
          // CRITICAL: When reading innerHTML from user input, we must sanitize and wrap
          // in SafeHTML. This prevents the crash loop:
          //   Input event -> Writes raw string to state -> Reactive update
          //   -> SafeHTML.isSafeHTML(string) throws TypeError -> CRASH
          //
          // FIX: Input -> SafeHTML.fromUser(string) -> State Update -> Reactivity
          //      -> SafeHTML Check (Passes) -> Render
          v = SafeHTML.fromUser(el.innerHTML);
        } else {
          v = el.innerText;
        }
      } else if (isChk) {
        // Handle checkbox array binding
        const currentValue = fn(this.s, o);
        if (Array.isArray(currentValue)) {
          // CRITICAL FIX (Issue #4): Mutate the original array instead of creating a copy
          // Previously: const arr = [...currentValue]; ... v = arr;
          // This replaced the reactive array with a plain array, breaking:
          // - External references to the original state.selected array
          // - Equality checks (oldRef === newRef) in watchers
          // - Object identity for reactive tracking
          //
          // Now we mutate the original array in place, preserving reference identity.
          // The reactivity system will detect the mutation via the array method wrappers.
          const arr = currentValue;

          // TASK 6: Object Identity for Checkbox Values
          // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
          // Get the original object reference from WeakMap
          const state = this._nodeState.get(el);
          const elValue = (state && state.valueRef !== undefined) ? state.valueRef : el.value;
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
          // CRITICAL FIX (Issue #4): Don't reassign - the array was mutated in place
          // The reactive system already tracks these mutations via push/splice wrappers
          return; // Skip the assignment below since we mutated in place
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
        //
        // CRITICAL SECURITY FIX #8: m-model Type Confusion
        // VULNERABILITY: Type inference from DOM options allows attackers to change model type
        // by injecting DOM options (e.g., via a separate vulnerability or SSR injection)
        //
        // SOLUTION: Use explicit .number modifier OR infer from existing array elements
        // Priority order:
        // 1. .number modifier (explicit declaration by developer)
        // 2. First element type (if array has values)
        // 3. CRITICAL FIX (Issue #8): Infer from option values if array is empty
        // 4. Default to strings (safest)
        //
        // CRITICAL FIX (Issue #8): Smart type inference for empty arrays
        // Previously, empty arrays ALWAYS defaulted to strings, causing type confusion.
        // Example: user expects numeric IDs but gets ["1", "2"] instead of [1, 2].
        //
        // New behavior: If array is empty and ALL options have numeric values, assume numeric.
        // This matches user intent in the common case of ID-based selects.
        let shouldCoerceToNumber = false;

        if (modifiers.includes('number')) {
          // Explicit .number modifier - trust the developer's intent
          shouldCoerceToNumber = true;
        } else if (Array.isArray(currentValue) && currentValue.length > 0) {
          // Array has values - use first element's type (TRUSTED source)
          shouldCoerceToNumber = typeof currentValue[0] === 'number';
        } else if (Array.isArray(currentValue) && currentValue.length === 0) {
          // CRITICAL FIX (Issue #8): Empty array - infer from option values
          // Check if ALL options have numeric values (e.g., id-based selects)
          // This prevents the common "gotcha" where users expect [1, 2] but get ["1", "2"]
          const options = Array.from(el.options);
          if (options.length > 0) {
            const allNumeric = options.every(opt => {
              const val = opt.value.trim();
              // Check if value is a valid number that preserves format when converted
              // "01" -> 1 -> "1" !== "01" (not purely numeric, has leading zero)
              // "1" -> 1 -> "1" === "1" (purely numeric)
              return val !== '' && !isNaN(Number(val)) && String(Number(val)) === val;
            });
            if (allNumeric) {
              shouldCoerceToNumber = true;
            }
          }
        }

        // TASK 13.1: Get selected values, preserving object references from nodeState
        // Fallback for environments without selectedOptions (e.g., happy-dom)
        let selectedOptions: HTMLOptionElement[];
        if (el.selectedOptions) {
          selectedOptions = Array.from(el.selectedOptions);
        } else {
          selectedOptions = Array.from(el.options).filter(opt => opt.selected);
        }

        // TASK 13.1: Check if any option has an object value in nodeState
        // If so, we return object values; otherwise, we continue with string/number handling
        const hasObjectValues = selectedOptions.some(opt => {
          const optState = this._nodeState.get(opt);
          return optState && optState.valueRef !== undefined && typeof optState.valueRef === 'object';
        });

        if (hasObjectValues) {
          // Return object values from nodeState
          v = selectedOptions.map(opt => {
            const optState = this._nodeState.get(opt);
            return (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
          });
        } else {
          // Original behavior: string/number coercion
          const selectedValues = selectedOptions.map(opt => opt.value);

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
        }
      } else if (el.tagName === 'SELECT') {
        // TASK 13.1: Handle single-select reading with object values
        const selectedOpt = el.options[el.selectedIndex];
        if (selectedOpt) {
          const optState = this._nodeState.get(selectedOpt);
          v = (optState && optState.valueRef !== undefined) ? optState.valueRef : selectedOpt.value;
        } else {
          v = null;
        }
      } else if ((el.type || '').toLowerCase() === 'file') {
        // TASK 13.1: File input reading - return FileList or first file
        // File inputs can only be read (not set), so this is a one-way binding
        // Return el.files (FileList) so model can access the selected files
        v = el.files;
      } else v = el.value;

      // TASK 8.1: Parse path with dynamic segment support
      // parsePath() now returns PathSegment[] with type information
      // Dynamic segments (e.g., users[id]) must be evaluated in the current scope
      const pathSegments = parsePath(exp);
      const endSegment = pathSegments.pop();

      // Safety check
      if (!endSegment) {
        console.warn('Reflex: Invalid m-model expression:', exp);
        return;
      }

      // Security: prevent prototype pollution
      if (UNSAFE_PROPS[endSegment.key]) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', endSegment.key);
        return;
      }

      // BREAKING CHANGE: Handle FlatScope and ScopeContainer for first path lookup
      // FlatScope uses flat registry lookup, ScopeContainer uses Map-based storage
      const scopeIsFlatScope = o && isFlatScope(o);
      const scopeIsScopeContainer = o && ScopeContainer.isScopeContainer(o);

      // Check if first path segment exists in scope
      let hasInScope = false;
      if (scopeIsFlatScope && pathSegments.length > 0) {
        hasInScope = getFlatScopeValue(o, pathSegments[0].key).found;
      } else if (scopeIsScopeContainer && pathSegments.length > 0) {
        hasInScope = o.has(pathSegments[0].key);
      }

      let t = hasInScope ? o : this.s;
      let isFirstPath = true;

      // TASK 8.1: Traverse path with dynamic segment evaluation
      for (const segment of pathSegments) {
        // Evaluate dynamic segments in the current scope
        let key = segment.key;
        if (segment.type === 'dynamic') {
          // CRITICAL: Evaluate the dynamic key in the current scope
          // Example: users[id] where id=5 → key becomes '5'
          try {
            const keyFn = this._fn(segment.key);
            key = String(keyFn(this.s, o));
          } catch (err) {
            console.warn('Reflex: Failed to evaluate dynamic key:', segment.key, err);
            return;
          }
        }

        if (UNSAFE_PROPS[key]) {
          console.warn('Reflex: Blocked attempt to traverse unsafe property:', key);
          return;
        }

        // Handle FlatScope lookup for first path segment
        if (isFirstPath && isFlatScope(t)) {
          const result = getFlatScopeValue(t, key);
          t = result.value;
          isFirstPath = false;
          if (t == null) {
            console.warn('Reflex: Cannot traverse null/undefined in path:', key);
            return;
          }
          continue;
        }
        // Handle ScopeContainer lookup for first path segment
        if (isFirstPath && ScopeContainer.isScopeContainer(t)) {
          t = t.get(key);
          isFirstPath = false;
          if (t == null) {
            console.warn('Reflex: Cannot traverse null/undefined in path:', key);
            return;
          }
          continue;
        }
        isFirstPath = false;
        if (t[key] == null) t[key] = {};
        else if (typeof t[key] !== 'object') {
          console.warn('Reflex: Cannot set nested property on non-object value at path:', key);
          return;
        }
        t = t[key];
      }

      // TASK 8.1: Evaluate final segment if dynamic
      let finalKey = endSegment.key;
      if (endSegment.type === 'dynamic') {
        try {
          const keyFn = this._fn(endSegment.key);
          finalKey = String(keyFn(this.s, o));
        } catch (err) {
          console.warn('Reflex: Failed to evaluate dynamic key:', endSegment.key, err);
          return;
        }
      }

      // CRITICAL SECURITY FIX: Check finalKey AFTER evaluation for dynamic segments
      // The initial check at line 3128 only validates the raw expression string.
      // For dynamic keys (e.g., m-model="data[dynamicKey]"), we must also validate
      // the evaluated value to prevent prototype pollution via runtime-controlled keys.
      if (UNSAFE_PROPS[finalKey]) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', finalKey);
        return;
      }

      // CRITICAL SECURITY FIX: Prevent ALL Prototype Pollution
      // The original scope shadowing logic walked the prototype chain to find where
      // a property was defined. However, this is fundamentally unsafe:
      // 1. If the property is on Object.prototype, it pollutes ALL objects
      // 2. If the property is on a custom prototype, it pollutes ALL objects sharing that prototype
      // 3. Only updating OWN properties is safe, but then we don't need the chain walk
      //
      // SECURE APPROACH: Only update the target object (t), never any prototype.
      // This prevents prototype pollution while still supporting property assignment.
      // For ScopeContainer, shadowing is handled by the Map-based storage.
      // For regular objects, we simply set the property on the object itself.
      t[finalKey] = v;
    };

    // IME composition event handlers
    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => {
      isComposing = false;
      // Trigger update after composition completes
      up();
    };

    // CRITICAL FIX (Issue #2): Dynamic Event Listener Setup
    // When input type can change dynamically, we need to listen to both 'input' and 'change'
    // events to handle all type scenarios. This is a trade-off:
    // - For static types: slightly more listeners (negligible overhead)
    // - For dynamic types: correct behavior when switching between text/checkbox/radio
    //
    // The alternative (adding/removing listeners dynamically) is more complex and error-prone.
    // Since most inputs don't change type, and the extra listener is cheap, we always
    // listen to both events (unless .lazy is specified, which forces change-only).
    const initType = (el.type || '').toLowerCase();
    const initIsChk = initType === 'checkbox';
    const initIsRadio = initType === 'radio';

    // Determine initial event type for IME composition support
    let primaryEvt;
    if (isLazy) {
      primaryEvt = 'change'; // .lazy always uses 'change' only
    } else {
      primaryEvt = initIsChk || initIsRadio || el.tagName === 'SELECT' ? 'change' : 'input';
    }

    el.addEventListener(primaryEvt, up);
    // Also listen to 'change' for inputs (unless already using it)
    // This ensures we catch both events for dynamic type switching
    if (primaryEvt !== 'change' && !isLazy) {
      el.addEventListener('change', up);
    }
    // Also listen to 'input' for checkboxes/radios in case they become text inputs
    // (only if we didn't already add it)
    if (primaryEvt === 'change' && !isLazy) {
      el.addEventListener('input', up);
    }

    // Add IME composition listeners for text inputs
    // (checkbox/radio don't need IME support, but harmless if type changes)
    if (!initIsChk && !initIsRadio) {
      el.addEventListener('compositionstart', onCompositionStart);
      el.addEventListener('compositionend', onCompositionEnd);
    }

    // CRITICAL FIX (Issue #6): Dynamic Select Initial State Sync
    // When <option> elements are generated via m-for, they're added to the DOM AFTER
    // m-model has already run its initial sync. The browser doesn't auto-apply the
    // selection to newly added options, leaving the select box appearing empty.
    //
    // Solution: Use MutationObserver to watch for child changes on <select> elements.
    // When options are added, re-run the effect to sync the selection state.
    let selectObserver: MutationObserver | null = null;
    if (el.tagName === 'SELECT' && typeof MutationObserver !== 'undefined') {
      // Debounce the sync to batch multiple option additions
      let syncTimeout: any = null;
      const syncSelection = () => {
        if (syncTimeout) clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
          syncTimeout = null;
          // Re-run the effect to sync the selection state
          // The effect checks the current model value and applies it to all options
          e();
        }, 0);
      };

      selectObserver = new MutationObserver((mutations) => {
        // Check if any option elements were added
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === 1 && ((node as Element).tagName === 'OPTION' || (node as Element).tagName === 'OPTGROUP')) {
                syncSelection();
                return; // Only need to sync once per batch
              }
            }
          }
        }
      });

      // Observe child additions to the select element
      selectObserver.observe(el, { childList: true, subtree: true });
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
      // CRITICAL FIX (Issue #6): Clean up MutationObserver for select elements
      if (selectObserver) {
        selectObserver.disconnect();
        selectObserver = null;
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
   * Comprehensive URL decoding and sanitization
   * CRITICAL SECURITY FIX: Decode ALL HTML entities and strip control characters
   *
   * Browsers ignore control characters (tabs, newlines, etc.) in protocol schemes:
   * - "java\tscript:alert(1)" is executed as "javascript:alert(1)"
   * - "java\nscript:alert(1)" is executed as "javascript:alert(1)"
   *
   * This helper:
   * 1. Decodes ALL HTML entities (numeric, hex, and named including &Tab;, &NewLine;, etc.)
   * 2. Strips ALL control characters (0x00-0x1F, 0x7F-0x9F)
   * 3. Returns the sanitized URL ready for regex validation
   */
  _decodeAndSanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';

    // Step 1: Decode ALL HTML entities
    const decoded = url
      // Decode numeric hex entities: &#x61; &#x61 (semicolon optional)
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      // Decode numeric decimal entities: &#97; &#97 (semicolon optional)
      .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      // Decode common named entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, '\u00A0')
      // Decode URL-relevant named entities
      .replace(/&colon;/g, ':')
      .replace(/&sol;/g, '/')
      .replace(/&quest;/g, '?')
      .replace(/&equals;/g, '=')
      .replace(/&num;/g, '#')
      .replace(/&percnt;/g, '%')
      .replace(/&commat;/g, '@')
      // CRITICAL FIX: Decode control character entities that were previously missing
      .replace(/&Tab;/g, '\t')
      .replace(/&NewLine;/g, '\n')
      .replace(/&excl;/g, '!')
      .replace(/&dollar;/g, '$')
      .replace(/&lpar;/g, '(')
      .replace(/&rpar;/g, ')')
      .replace(/&ast;/g, '*')
      .replace(/&plus;/g, '+')
      .replace(/&comma;/g, ',')
      .replace(/&period;/g, '.')
      .replace(/&semi;/g, ';');

    // Step 2: Strip ALL control characters
    // Control characters: 0x00-0x1F (includes \0, \t, \n, \r, etc.) and 0x7F-0x9F
    // Browsers ignore these in protocol schemes, so we must remove them before validation
    // This prevents attacks like "java\tscript:alert(1)" bypassing the regex
    const sanitized = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    return sanitized;
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
    // CRITICAL FIX: Previous regex [^'")\s]+ failed to match URLs with whitespace inside quotes
    // Attack: url("java\tscript:alert(1)") would not match, bypassing validation
    // Fix: Use separate patterns for quoted vs unquoted URLs
    //   - Single-quoted: url('...')  - allows any chars except single quote
    //   - Double-quoted: url("...")  - allows any chars except double quote
    //   - Unquoted: url(...)         - allows only non-whitespace, non-quote chars
    const singleQuotedPattern = /url\s*\(\s*'([^']*)'\s*\)/gi;
    const doubleQuotedPattern = /url\s*\(\s*"([^"]*)"\s*\)/gi;
    const unquotedPattern = /url\s*\(\s*([^'"\s)]+)\s*\)/gi;

    let sanitized = cssText;

    // Process all three URL patterns
    const patterns = [
      { regex: singleQuotedPattern, name: 'single-quoted' },
      { regex: doubleQuotedPattern, name: 'double-quoted' },
      { regex: unquotedPattern, name: 'unquoted' }
    ];

    for (const { regex, name } of patterns) {
      const matches = Array.from(normalized.matchAll(regex));
      for (const match of matches) {
        const url = match[1];

        // CRITICAL FIX: Apply same sanitization as attribute URLs
        // Decode HTML entities and strip control characters before validation
        // This catches attacks like url("j&#97;va\tscript:alert(1)")
        const sanitizedUrl = this._decodeAndSanitizeUrl(url);

        // Validate the sanitized URL using the same logic as href/src attributes
        const isSafe = RELATIVE_URL_RE.test(sanitizedUrl) || SAFE_URL_RE.test(sanitizedUrl);
        if (!isSafe) {
          console.error(
            `Reflex Security: BLOCKED unsafe ${name} URL in style binding: ${url}\n` +
            `Sanitized form: ${sanitizedUrl}\n` +
            'Only http://, https://, mailto:, tel:, sms:, and relative URLs are allowed.\n' +
            'CSS injection attempt prevented.'
          );
          // Replace the entire url() with 'none'
          sanitized = sanitized.replace(match[0], 'none');
        }
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

          // CRITICAL SECURITY FIX (Issue #5): Sanitize CSS variable values
          // Previously, CSS variables bypassed all sanitization because they were just appended.
          // Attack: :style="{ '--bg': 'url(javascript:alert(1))' }"
          // If user CSS has: background: var(--bg);  → executes the malicious URL
          //
          // Solution: Apply the same sanitization to CSS variable values as to regular values.
          // This blocks javascript:, data:, and other dangerous URL protocols.
          let sanitizedVal = String(val);
          if (k.startsWith('--')) {
            // CSS variables can contain url() values that need sanitization
            sanitizedVal = this._sanitizeStyleString(sanitizedVal);
          }

          s += prop + ':' + sanitizedVal + ';';
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
