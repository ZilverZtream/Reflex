/**
 * @reflex/compiler - Runtime Helpers
 * Helpers used by compiled templates for complex scenarios
 * These are tree-shakeable and only included if used
 */

import type { IRendererAdapter } from './types.js';

/**
 * Create a keyed list with LIS reconciliation
 * This wraps the complex reconciliation logic from DirectivesMixin
 * but accepts direct callbacks instead of parsing DOM
 */
export function createKeyedList<T>(
  ctx: any,
  anchor: Comment,
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

    // Full reconciliation with LIS algorithm
    const result = reconcileKeyedList(prevKeys, newKeys);

    // Apply operations
    const newNodes: Node[] = [];

    for (const op of result.operations) {
      if (op.type === 'keep') {
        // Reuse existing node
        newNodes.push(prevNodes[op.oldIndex!]);
      } else if (op.type === 'insert') {
        // Create new node
        const node = renderItem(items[op.newIndex], op.newIndex);
        newNodes.push(node);
      } else if (op.type === 'move') {
        // Reuse and move
        newNodes.push(prevNodes[op.oldIndex!]);
      } else if (op.type === 'remove') {
        // Will be removed
      }
    }

    // Remove old nodes
    for (let i = 0; i < prevNodes.length; i++) {
      if (!newNodes.includes(prevNodes[i])) {
        // CRITICAL FIX: Clean up effects before removing from DOM to prevent memory leaks
        // The ctx._kill method destroys all reactive scopes, effects, and listeners
        // associated with the node's subtree
        if (typeof ctx._kill === 'function') {
          ctx._kill(prevNodes[i]);
        }
        _ren.removeChild(prevNodes[i]);
      }
    }

    // Insert/move nodes in correct order
    for (let i = 0; i < newNodes.length; i++) {
      const node = newNodes[i];
      const nextNode = newNodes[i + 1];

      if (nextNode) {
        // Insert before next
        if (_ren.contains(document.body, nextNode)) {
          _ren.insertBefore(nextNode, node);
        } else {
          _ren.insertBefore(anchor, node);
        }
      } else {
        // Insert before anchor
        _ren.insertBefore(anchor, node);
      }
    }

    prevItems = items.slice();
    prevNodes = newNodes;
    prevKeys = newKeys;
  });
}

/**
 * Compute the Longest Increasing Subsequence (LIS) of an array.
 * Ported from core runtime for optimal keyed list reconciliation.
 *
 * @param {number[]} arr - Array of old indices (-1 for new nodes)
 * @returns {number[]} Indices in arr that form the LIS
 */
function computeLIS(arr: number[]): number[] {
  const n = arr.length;
  if (n === 0) return [];

  // result[i] = index in arr of smallest tail of LIS of length i+1
  const result: number[] = [];
  // predecessors[i] = previous index in LIS ending at i
  const predecessors = new Array(n);

  for (let i = 0; i < n; i++) {
    const val = arr[i];
    // Skip -1 entries (new nodes have no old position)
    if (val < 0) continue;

    // Binary search for insertion position
    let lo = 0, hi = result.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[result[mid]] < val) lo = mid + 1;
      else hi = mid;
    }

    // Update predecessor chain
    if (lo > 0) predecessors[i] = result[lo - 1];
    result[lo] = i;
  }

  // Reconstruct the LIS by following predecessors
  let len = result.length;
  const lis = new Array(len);
  let idx = result[len - 1];
  while (len-- > 0) {
    lis[len] = idx;
    idx = predecessors[idx];
  }

  return lis;
}

/**
 * Reconcile keyed lists using LIS (Longest Increasing Subsequence) algorithm
 * FIXED: Now uses real LIS algorithm instead of naive oldIndex === i check
 * This minimizes DOM moves from O(N) to O(N - LIS_length)
 */
function reconcileKeyedList(
  oldKeys: any[],
  newKeys: any[]
): { operations: ReconcileOp[] } {
  const operations: ReconcileOp[] = [];

  // Build key to index map for old list
  const oldKeyToIndex = new Map<any, number>();
  for (let i = 0; i < oldKeys.length; i++) {
    oldKeyToIndex.set(oldKeys[i], i);
  }

  // Track which old indices are used
  const used = new Set<number>();

  // Build array of old indices for LIS computation
  const oldIndices: number[] = new Array(newKeys.length);

  // First pass: map new keys to old indices
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i];
    const oldIndex = oldKeyToIndex.get(key);

    if (oldIndex !== undefined) {
      oldIndices[i] = oldIndex;
      used.add(oldIndex);
    } else {
      oldIndices[i] = -1; // New item
    }
  }

  // Compute LIS - nodes in LIS don't need to move
  const lis = computeLIS(oldIndices);
  const lisSet = new Set(lis);

  // Second pass: generate operations based on LIS
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i];
    const oldIndex = oldIndices[i];

    if (oldIndex === -1) {
      // New key - insert
      operations.push({
        type: 'insert',
        newIndex: i,
        key,
      });
    } else if (lisSet.has(i)) {
      // In LIS - keep (no move needed)
      operations.push({
        type: 'keep',
        oldIndex,
        newIndex: i,
        key,
      });
    } else {
      // Not in LIS - move
      operations.push({
        type: 'move',
        oldIndex,
        newIndex: i,
        key,
      });
    }
  }

  // Third pass: identify removes
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
 * Compatible with Vue-style transition classes
 */
export function runTransition(
  el: Element,
  name: string,
  phase: 'enter' | 'leave',
  onComplete?: () => void
): void {
  const _ren = (window as any).__reflex_renderer;

  if (!_ren) {
    // No renderer available - just call callback
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
    el.classList.add(enterFromClass);
    el.classList.add(enterActiveClass);

    _ren.requestAnimationFrame(() => {
      el.classList.remove(enterFromClass);
      el.classList.add(enterToClass);

      // Wait for transition to end
      const handleTransitionEnd = () => {
        el.classList.remove(enterActiveClass);
        el.classList.remove(enterToClass);
        el.removeEventListener('transitionend', handleTransitionEnd);
        onComplete?.();
      };

      el.addEventListener('transitionend', handleTransitionEnd);

      // Fallback: remove classes after 500ms if no transition
      setTimeout(() => {
        if (el.classList.contains(enterActiveClass)) {
          handleTransitionEnd();
        }
      }, 500);
    });
  } else {
    // Leave transition
    el.classList.add(leaveFromClass);
    el.classList.add(leaveActiveClass);

    _ren.requestAnimationFrame(() => {
      el.classList.remove(leaveFromClass);
      el.classList.add(leaveToClass);

      // Wait for transition to end
      const handleTransitionEnd = () => {
        el.classList.remove(leaveActiveClass);
        el.classList.remove(leaveToClass);
        el.removeEventListener('transitionend', handleTransitionEnd);
        onComplete?.();
      };

      el.addEventListener('transitionend', handleTransitionEnd);

      // Fallback: remove classes after 500ms if no transition
      setTimeout(() => {
        if (el.classList.contains(leaveActiveClass)) {
          handleTransitionEnd();
        }
      }, 500);
    });
  }
}

/**
 * Convert value to display string
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
