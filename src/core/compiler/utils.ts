/**
 * Reflex Core - Compiler Utilities
 *
 * Shared utility functions and constants for the compiler.
 */

import { META } from '../symbols.js';

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
export const objectKeyMap = new WeakMap<object, number>();
export let objectKeyUid = 0;

/**
 * CRITICAL FIX: Track if WeakRef warning has been shown
 * Only warn once to avoid spamming the console
 */
export let weakRefWarningShown = false;
export function setWeakRefWarningShown(value: boolean) {
  weakRefWarningShown = value;
}

/**
 * Transition timing constants
 * These are used to calculate transition/animation timeouts
 */
export const MILLISECONDS_PER_SECOND = 1000;
export const TRANSITION_BUFFER_MS = 50; // Extra buffer to ensure transition completes

/**
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
export const OBJECT_KEY_PREFIX = '\u200B__rfx_obj__';

/**
 * Get the raw (unwrapped) value from a reactive proxy.
 * If the value is not a proxy, returns the value as-is.
 * This is needed for object identity comparison since the same object
 * might be accessed via different proxy wrappers.
 */
export const getRawValue = (v: any): any => {
  if (v !== null && typeof v === 'object') {
    const meta = v[META];
    if (meta && meta.r) {
      return meta.r; // Return the raw target
    }
  }
  return v;
};

/**
 * Convert a key to a stable, unique string representation.
 * For objects, uses the WeakMap-based ID generator.
 * For primitives, uses String() directly.
 */
export function getStableKey(key: any): string | number | symbol {
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
export interface PathSegment {
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
export function parsePath(exp: string): PathSegment[] {
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
 * Clone a node while preserving ALL node state from WeakMap.
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
 * CRITICAL FIX (Issue #10): Copy ALL State Properties
 * Previous implementation only copied valueRef, causing state desync when
 * new properties were added (e.g., dirty flags, validation state).
 * Now we shallow-copy the entire state object to prevent silent data loss.
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

  // CRITICAL FIX (Issue #10): Helper to shallow-copy ALL state properties
  // This ensures new state properties added in the future are automatically copied
  const copyState = (source: any, target: any, stateMap: WeakMap<Element, any>) => {
    const state = stateMap.get(source);
    if (state) {
      // Shallow copy ALL properties from state object
      // Uses Object.assign to handle any future state properties automatically
      const clonedState = Object.assign({}, state);
      stateMap.set(target, clonedState);
    }
  };

  // TASK 6: Copy node state from WeakMap if provided
  if (nodeState && node.nodeType === 1) { // Element node
    copyState(node, cloned, nodeState);
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

          // CRITICAL FIX (Issue #10): Copy ALL state properties
          if (nodeState && srcChild.nodeType === 1) {
            copyState(srcChild, tgtChild, nodeState);
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
export function hasStrictParent(marker: Comment): boolean {
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
export function sortRefsByDOM(refArray: Element[]): void {
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
