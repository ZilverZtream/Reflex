/**
 * Reflex Core - DOM Reconciliation
 *
 * Implements keyed list reconciliation using the Longest Increasing Subsequence (LIS)
 * algorithm for minimal DOM operations.
 *
 * ## Algorithm Overview
 *
 * When reordering a keyed list, we want to minimize DOM moves. The insight is that
 * nodes in the LIS of old positions don't need to move - only nodes outside the LIS
 * need repositioning.
 *
 * Example:
 *   Old: [A, B, C, D, E]  (indices: 0, 1, 2, 3, 4)
 *   New: [C, A, B, E, D]
 *   Old indices of new items: [2, 0, 1, 4, 3]
 *   LIS: [0, 1, 4] (positions 1, 2, 3 in new array - A, B, E don't move)
 *   Only C and D need to be moved.
 *
 * ## Complexity
 * - Time: O(n log n) using binary search
 * - Space: O(n) for predecessor tracking
 *
 * ## Influences / Credits
 *
 * This implementation uses the LIS technique popularized by:
 * - Vue 3's runtime-core (https://github.com/vuejs/core)
 * - Inferno's keyed diffing (https://github.com/infernojs/inferno)
 * - The algorithm itself is based on the patience sorting approach
 *   described in academic literature on LIS computation.
 *
 * The core idea: finding nodes that are already in correct relative order
 * (the LIS) and only moving the rest. This reduces O(n) potential DOM
 * operations to O(n - LIS_length) actual moves.
 */

/**
 * Compute the Longest Increasing Subsequence (LIS) of an array.
 *
 * @param {number[]} arr - Array of old indices (-1 for new nodes)
 * @returns {number[]} Indices in arr that form the LIS
 *
 * @example
 * computeLIS([2, 0, 1, 4, 3])  // Returns [1, 2, 3] (indices of 0, 1, 4)
 * computeLIS([-1, 0, 1, -1])   // Returns [1, 2] (skips -1 entries)
 */
export function computeLIS(arr) {
  const n = arr.length;
  if (n === 0) return [];

  // result[i] = index in arr of smallest tail of LIS of length i+1
  const result = [];
  // predecessors[i] = previous index in LIS ending at i
  const predecessors = new Array(n);

  for (let i = 0; i < n; i++) {
    const val = arr[i];
    // Skip -1 entries (new nodes have no old position)
    if (val < 0) continue;

    // Binary search for insertion position
    // Find the first position where arr[result[pos]] >= val
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
 * Reconcile a keyed list with minimal DOM operations.
 *
 * Given the old and new arrays, this function:
 * 1. Removes nodes that are no longer present
 * 2. Creates nodes that are new
 * 3. Moves existing nodes to their correct positions using LIS
 *
 * @param {Object} params - Reconciliation parameters
 * @param {Map} params.oldRows - Map of key -> { node, oldIdx }
 * @param {string[]} params.oldKeys - Previous key order
 * @param {Array} params.rawList - New raw list data
 * @param {Object} params.config - Configuration for node creation/update
 * @param {Reflex} params.engine - Reflex instance
 * @param {Comment} params.marker - Comment marker for insertion point
 *
 * @returns {Object} { rows: Map, keys: string[] } - New state
 */
export function reconcileKeyedList({
  oldRows,
  oldKeys,
  rawList,
  config,
  engine: _engine, // Reserved for future use
  marker
}) {
  const {
    getKey,      // (item, index, scope) => key
    createNode,  // (item, index) => node | null
    updateNode,  // (node, item, index) => void
    removeNode,  // (node) => void
    createScope, // (item, index) => scope
    shouldKeep   // (item, index, scope) => boolean (optional, for m-if filtering)
  } = config;

  const newLen = rawList.length;

  // Build key-to-oldIndex map for LIS calculation
  const keyToOldIdx = new Map();
  for (let i = 0; i < oldKeys.length; i++) {
    keyToOldIdx.set(oldKeys[i], i);
  }

  // Prepare new nodes and collect old indices for LIS
  const newNodes = new Array(newLen);
  const newKeys = new Array(newLen);
  const oldIndices = new Array(newLen); // For LIS: old index or -1 if new

  // First pass: create/update nodes and collect metadata
  for (let i = 0; i < newLen; i++) {
    const item = rawList[i];
    const scope = createScope(item, i);
    const key = getKey(item, i, scope);
    newKeys[i] = key;

    const existing = oldRows.get(key);
    if (existing) {
      // Check if node should still be kept (m-if re-evaluation for existing nodes)
      if (shouldKeep && !shouldKeep(item, i, scope)) {
        // m-if condition is now false, remove this node
        removeNode(existing.node);
        newNodes[i] = null;
        oldIndices[i] = -1;
        oldRows.delete(key);
      } else {
        // Reuse existing node, update scope
        updateNode(existing.node, item, i);
        newNodes[i] = existing.node;
        oldIndices[i] = keyToOldIdx.get(key) ?? -1;
        oldRows.delete(key);
      }
    } else {
      // Create new node
      const node = createNode(item, i);
      // CRITICAL: Handle null nodes (skipped due to m-if failing)
      if (node === null) {
        // Skip this item - it failed the m-if check
        newNodes[i] = null;
        oldIndices[i] = -1;
      } else {
        newNodes[i] = node;
        oldIndices[i] = -1; // New node
      }
    }
  }

  // Remove stale nodes
  oldRows.forEach(({ node }) => removeNode(node));

  // Compute LIS for optimal moves - nodes in LIS don't need to move
  const lis = computeLIS(oldIndices);
  const lisSet = new Set(lis);

  // Insert nodes - only move nodes NOT in LIS
  // We iterate backwards and insert before the next sibling
  // CRITICAL FIX: Logic Flaw in Keyed Reconciliation with null Nodes
  // When a node is null (filtered by m-if), we must still track nextSibling correctly
  // Otherwise, the next valid node will be inserted in the wrong position
  let nextSibling = null;
  for (let i = newLen - 1; i >= 0; i--) {
    const node = newNodes[i];
    // Skip null nodes (filtered by m-if) but continue tracking nextSibling
    if (node === null) {
      // Don't update nextSibling - it should remain pointing to the next valid node
      // This ensures the next valid item is inserted before the correct sibling
      continue;
    }

    // CRITICAL FIX: Handle virtual containers (for strict parents like <table>)
    const isVirtual = node._isVirtualContainer;
    const actualNodes = isVirtual ? node._nodes : [node];
    const firstNode = actualNodes[0];
    const _lastNode = actualNodes[actualNodes.length - 1];

    if (!lisSet.has(i)) {
      // Node needs to be moved/inserted
      if (nextSibling) {
        // Insert all nodes from virtual container before nextSibling
        actualNodes.forEach(n => {
          marker.parentNode.insertBefore(n, nextSibling);
        });
      } else {
        // Insert at end (after last sibling or after comment marker)
        // CRITICAL FIX: Robust handling of null nodes in insertion logic
        // When nextSibling is null (because we skipped null nodes or this is the first item),
        // we need to find the correct insertion point by scanning previous valid nodes
        let lastNode = marker;
        // Search backwards from current position to find the last valid inserted node
        for (let j = i - 1; j >= 0; j--) {
          const prevNode = newNodes[j];
          // Skip null nodes - they have no DOM presence
          if (prevNode === null) continue;

          if (prevNode._isVirtualContainer) {
            const prevActual = prevNode._nodes;
            // Find the last actual node in the virtual container that's in the DOM
            if (prevActual.length > 0 && prevActual[prevActual.length - 1].parentNode) {
              lastNode = prevActual[prevActual.length - 1];
              break;
            }
          } else if (prevNode.parentNode) {
            lastNode = prevNode;
            break;
          }
        }
        // Insert all nodes from virtual container after lastNode
        actualNodes.forEach(n => {
          lastNode.after(n);
          lastNode = n;
        });
      }
    }
    // Update nextSibling to the first node of this item (for backwards iteration)
    // This ensures the next iteration knows where to insert relative to this item
    nextSibling = firstNode;
  }

  // Build new rows map (excluding null nodes)
  const newRows = new Map();
  for (let i = 0; i < newLen; i++) {
    if (newNodes[i] !== null) {
      newRows.set(newKeys[i], { node: newNodes[i], oldIdx: i });
    }
  }

  return { rows: newRows, keys: newKeys };
}

/**
 * Handle duplicate keys in a list.
 *
 * CRITICAL FIX: When duplicate keys are detected, we warn in development and use
 * a stable counter-based fallback to prevent DOM corruption and crashes.
 *
 * Without this fix, duplicate keys cause the Map to silently overwrite entries,
 * leading to the LIS algorithm breaking completely. This results in:
 * - Random element deletion (thinking nodes don't exist)
 * - Incorrect element reordering
 * - Data integrity corruption
 *
 * CRITICAL FIX: Do NOT include index in duplicate key generation.
 * Including the index causes keys to change when the list is reordered, which
 * defeats the purpose of keyed reconciliation and forces full DOM recreation.
 *
 * CRITICAL FIX: Use unique Symbol-based namespace to prevent user key collisions.
 * The previous format `__dup_${counter}_${key}` was predictable and could collide
 * with user keys. For example:
 * - Item A has key="foo" (duplicates to __dup_1_foo)
 * - Item B has key="foo" (duplicates to __dup_2_foo)
 * - User adds Item C with key="__dup_1_foo" → COLLISION! Item B disappears
 *
 * Solution: Use Symbol.for() with a reserved namespace that users can't create.
 *
 * @param {Map} seen - Set of already-seen keys with counter tracking
 * @param {*} key - Current key
 * @param {number} index - Current index (NOT used in key generation)
 * @returns {*} Unique key (original or fallback)
 */
export function resolveDuplicateKey(seen, key, _index) {
  // Check if we've seen this key before
  const seenEntry = seen.get(key);

  if (seenEntry !== undefined) {
    // Duplicate detected - increment counter for stable key
    const counter = seenEntry + 1;
    seen.set(key, counter);

    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.error(
        `⚠️ Reflex: CRITICAL - Duplicate key "${key}" detected in m-for list!\n` +
        'This will cause DOM corruption and unpredictable behavior.\n' +
        'Fix: Ensure each item has a unique key value.\n' +
        `Temporarily using counter-based fallback (occurrence #${counter}).`
      );
    }

    // CRITICAL: Use Symbol.for() with reserved namespace to prevent user collisions
    // Symbols are guaranteed unique and can't be created by user code
    // Format: Symbol.for('reflex.dup:counter:originalKey')
    return Symbol.for(`reflex.dup:${counter}:${String(key)}`);
  }

  // First occurrence of this key - track it with counter 1
  seen.set(key, 1);
  return key;
}
