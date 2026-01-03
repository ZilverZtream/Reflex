/**
 * Runtime Helpers for AOT Compiled Mode
 *
 * These helpers are used by compiled templates to handle complex scenarios
 * like keyed lists and transitions without including the full WalkerMixin
 * and ExprMixin in the bundle.
 *
 * Tree-shakeable: Only included if used by compiled code.
 */

import type { IRendererAdapter } from './renderers/types.js';

/**
 * Create a keyed list with efficient reconciliation
 *
 * This is used by compiled m-for directives to handle list rendering
 * with proper key-based reconciliation (LIS algorithm).
 *
 * @param ctx - Reflex instance
 * @param anchor - Anchor comment node for insertion
 * @param getItems - Function that returns the list items
 * @param getKey - Function to extract key from item
 * @param renderItem - Function to render each item
 *
 * @example
 * ```js
 * createKeyedList(
 *   ctx,
 *   anchor,
 *   () => ctx.s.items,
 *   (item) => item.id,
 *   (item, index) => {
 *     const el = _ren.createElement('li');
 *     _ren.setTextContent(el, item.name);
 *     return el;
 *   }
 * );
 * ```
 */
export function createKeyedList<T>(
  ctx: any,
  anchor: Comment | Node,
  getItems: () => T[],
  getKey: (item: T, index: number) => any,
  renderItem: (item: T, index: number) => Node
): void {
  const _ren = ctx._ren as IRendererAdapter;

  let prevItems: T[] = [];
  let prevNodes: Node[] = [];
  let prevKeys: any[] = [];

  ctx.createEffect(() => {
    const items = getItems();

    if (!items || !Array.isArray(items)) {
      // Clear all
      for (const node of prevNodes) {
        _ren.removeChild(node);
      }
      prevItems = [];
      prevNodes = [];
      prevKeys = [];
      return;
    }

    const newKeys = items.map((item, i) => getKey(item, i));

    // Fast path: empty to non-empty
    if (prevNodes.length === 0) {
      const newNodes: Node[] = [];
      for (let i = 0; i < items.length; i++) {
        const node = renderItem(items[i], i);
        newNodes.push(node);
        _ren.insertBefore(anchor, node);
      }
      prevItems = items.slice();
      prevNodes = newNodes;
      prevKeys = newKeys;
      return;
    }

    // Fast path: non-empty to empty
    if (items.length === 0) {
      for (const node of prevNodes) {
        _ren.removeChild(node);
      }
      prevItems = [];
      prevNodes = [];
      prevKeys = [];
      return;
    }

    // Full reconciliation with key-based diffing
    const result = reconcileKeyedList(prevKeys, newKeys);

    // Build new nodes array
    const newNodes: Node[] = new Array(items.length);
    const toRemove: Node[] = [];

    for (let i = 0; i < items.length; i++) {
      const key = newKeys[i];
      const oldIndex = prevKeys.indexOf(key);

      if (oldIndex !== -1) {
        // Reuse existing node
        newNodes[i] = prevNodes[oldIndex];
      } else {
        // Create new node
        newNodes[i] = renderItem(items[i], i);
      }
    }

    // Find nodes to remove
    for (let i = 0; i < prevNodes.length; i++) {
      if (!newKeys.includes(prevKeys[i])) {
        toRemove.push(prevNodes[i]);
      }
    }

    // Remove old nodes
    for (const node of toRemove) {
      _ren.removeChild(node);
    }

    // Insert/move nodes in correct order
    let lastInsertedNode: Node | null = null;

    for (let i = newNodes.length - 1; i >= 0; i--) {
      const node = newNodes[i];

      if (lastInsertedNode) {
        _ren.insertBefore(lastInsertedNode, node);
      } else {
        _ren.insertBefore(anchor, node);
      }

      lastInsertedNode = node;
    }

    prevItems = items.slice();
    prevNodes = newNodes;
    prevKeys = newKeys;
  });
}

/**
 * Reconcile keyed lists
 * Returns operations needed to transform old list into new list
 */
function reconcileKeyedList(
  oldKeys: any[],
  newKeys: any[]
): { operations: ReconcileOp[] } {
  const operations: ReconcileOp[] = [];

  // Build key to index maps
  const oldKeyToIndex = new Map<any, number>();
  for (let i = 0; i < oldKeys.length; i++) {
    oldKeyToIndex.set(oldKeys[i], i);
  }

  const newKeyToIndex = new Map<any, number>();
  for (let i = 0; i < newKeys.length; i++) {
    newKeyToIndex.set(newKeys[i], i);
  }

  // Track which old indices are used
  const used = new Set<number>();

  // Identify operations
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i];
    const oldIndex = oldKeyToIndex.get(key);

    if (oldIndex !== undefined) {
      operations.push({
        type: oldIndex === i ? 'keep' : 'move',
        oldIndex,
        newIndex: i,
        key,
      });
      used.add(oldIndex);
    } else {
      operations.push({
        type: 'insert',
        newIndex: i,
        key,
      });
    }
  }

  // Mark removes
  for (let i = 0; i < oldKeys.length; i++) {
    if (!used.has(i)) {
      operations.push({
        type: 'remove',
        oldIndex: i,
        key: oldKeys[i],
      });
    }
  }

  return { operations };
}

interface ReconcileOp {
  type: 'keep' | 'insert' | 'move' | 'remove';
  oldIndex?: number;
  newIndex?: number;
  key: any;
}

/**
 * Run a CSS transition on an element
 *
 * Used by compiled m-if and m-show directives with m-trans.
 * Follows Vue-style transition class naming.
 *
 * @param el - Element to transition
 * @param name - Transition name (class prefix)
 * @param phase - 'enter' or 'leave'
 * @param onComplete - Callback when transition completes
 *
 * @example
 * ```js
 * runTransition(element, 'fade', 'enter');
 * runTransition(element, 'slide', 'leave', () => {
 *   // Remove element after transition
 *   element.remove();
 * });
 * ```
 */
export function runTransition(
  el: Element,
  name: string,
  phase: 'enter' | 'leave',
  onComplete?: () => void
): void {
  if (!el || typeof window === 'undefined') {
    onComplete?.();
    return;
  }

  const enterFromClass = `${name}-enter-from`;
  const enterActiveClass = `${name}-enter-active`;
  const enterToClass = `${name}-enter-to`;
  const leaveFromClass = `${name}-leave-from`;
  const leaveActiveClass = `${name}-leave-active`;
  const leaveToClass = `${name}-leave-to`;

  if (phase === 'enter') {
    // Enter transition
    el.classList.add(enterFromClass, enterActiveClass);

    requestAnimationFrame(() => {
      el.classList.remove(enterFromClass);
      el.classList.add(enterToClass);

      const handleEnd = () => {
        el.classList.remove(enterActiveClass, enterToClass);
        el.removeEventListener('transitionend', handleEnd);
        el.removeEventListener('animationend', handleEnd);
        onComplete?.();
      };

      el.addEventListener('transitionend', handleEnd, { once: true });
      el.addEventListener('animationend', handleEnd, { once: true });

      // Fallback timeout
      setTimeout(handleEnd, 500);
    });
  } else {
    // Leave transition
    el.classList.add(leaveFromClass, leaveActiveClass);

    requestAnimationFrame(() => {
      el.classList.remove(leaveFromClass);
      el.classList.add(leaveToClass);

      const handleEnd = () => {
        el.classList.remove(leaveActiveClass, leaveToClass);
        el.removeEventListener('transitionend', handleEnd);
        el.removeEventListener('animationend', handleEnd);
        onComplete?.();
      };

      el.addEventListener('transitionend', handleEnd, { once: true });
      el.addEventListener('animationend', handleEnd, { once: true });

      // Fallback timeout
      setTimeout(handleEnd, 500);
    });
  }
}

/**
 * Convert a value to a display string
 *
 * Used by compiled interpolations to convert values to strings.
 *
 * @param val - Value to convert
 * @returns String representation
 */
export function toDisplayString(val: any): string {
  if (val == null) {
    return '';
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val);
}

/**
 * Helper to create reactive effects for compiled templates
 * This is a lightweight wrapper that compiled code can use
 */
export function createReactiveEffect(ctx: any, fn: () => void): void {
  ctx.createEffect(fn);
}
