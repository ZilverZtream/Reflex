/**
 * Reflex Hydration Mixin
 *
 * Provides SSR hydration support for Reflex applications.
 * This module walks existing server-rendered DOM nodes and attaches
 * reactive bindings and event listeners without creating new elements.
 *
 * Tree-shakable: If not imported, this code won't be in the final bundle.
 *
 * ARCHITECTURAL LIMITATION - "Ghost Template" Issue:
 * If m-if was FALSE on the server (DOM node missing) but TRUE on the client
 * (node should be rendered), Reflex CANNOT render it during hydration because
 * the template wasn't in the server HTML. The content will be missing until
 * the state toggles false -> true again, triggering a client-side render.
 *
 * Workaround: For critical conditional content, ensure server and client initial
 * states match, or use m-show instead of m-if (m-show hides with CSS, keeping DOM).
 *
 * @example
 * import { Reflex } from 'reflex';
 * import { withHydration } from 'reflex/hydration';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withHydration);
 * app.hydrate(document.getElementById('app'));
 */

import { META, ITERATE, SKIP, UNSAFE_PROPS } from '../core/symbols.js';
import { runTransition } from '../core/compiler.js';
import { resolveDuplicateKey } from '../core/reconcile.js';

/**
 * Hydration mixin methods.
 * These methods are designed to work with server-rendered HTML,
 * attaching reactivity to existing DOM nodes instead of creating new ones.
 */
const HydrationMixin = {
  /**
   * Hydrate a server-rendered DOM tree.
   *
   * Unlike mount(), hydrate() assumes the DOM already exists and
   * attaches reactive bindings to existing elements without
   * modifying the DOM structure.
   *
   * @param {Element} el - Root element to hydrate
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Server renders: <div id="app"><span>0</span></div>
   * const app = new Reflex({ count: 0 });
   * app.use(withHydration);
   * app.hydrate(document.getElementById('app'));
   */
  hydrate(el) {
    if (!el) {
      if (typeof document !== 'undefined') {
        el = document.body;
      } else {
        return this;
      }
    }

    this._dr = el;
    this._hydrateMode = true;

    // Process bindings on root element
    this._hydrateNode(el, null);

    // Walk and hydrate children
    this._hydrateWalk(el, null);

    this._hydrateMode = false;
    return this;
  },

  /**
   * Walk DOM tree in hydration mode.
   * Similar to _w() but for hydrating existing nodes.
   *
   * ITERATIVE IMPLEMENTATION:
   * Uses explicit stack to avoid "Maximum call stack size exceeded" errors
   * on large pages with deeply nested DOM (3000+ elements).
   * This matches the robustness of the core compiler's _trv method.
   *
   * CRITICAL FIX: Whitespace filtering to prevent hydration mismatches.
   * Browsers and minifiers treat whitespace differently between server and client.
   * We skip whitespace-only text nodes to align the trees.
   *
   * CRITICAL FIX: Text Interpolation Hydration
   * The server renders evaluated values ("Hello World") not templates ("{{ value }}").
   * We detect reactive text nodes via comment markers: <!--txt:{{ expr }}-->
   * This allows the server to render the final value while preserving template info.
   */
  _hydrateWalk(n, o) {
    // Stack of {node, scope} pairs to process
    const stack = [{ node: n, scope: o }];

    while (stack.length > 0) {
      const { node: parent, scope: parentScope } = stack.pop();

      let c = parent.firstChild;
      while (c) {
        const next = c.nextSibling;
        const nt = c.nodeType;

        // CRITICAL FIX: Do NOT skip whitespace-only text nodes
        // While it may seem safe to skip them, whitespace is often semantically significant:
        // - Space between inline elements: <span>A</span> <span>B</span>
        // - Whitespace in <pre> tags
        // - CSS white-space: pre-wrap
        // Skipping them causes visual layout corruption (elements mashing together)
        // Instead, hydration must preserve ALL text nodes exactly as the server rendered them

        // Comment node (8) - check for text interpolation markers
        if (nt === 8) {
          const cv = c.nodeValue;
          // CRITICAL FIX: Server marks reactive text with <!--txt:{{ expr }}-->
          // This allows SSR to render the evaluated value while preserving template info
          if (cv && cv.startsWith('txt:')) {
            const template = cv.slice(4); // Remove 'txt:' prefix
            // Find the next text node (skip whitespace-only text nodes)
            let textNode = c.nextSibling;
            while (textNode && textNode.nodeType === 3 && !textNode.nodeValue.trim()) {
              textNode = textNode.nextSibling;
            }

            if (textNode && textNode.nodeType === 3) {
              // Apply the template to the text node
              this._hydrateTextWithTemplate(textNode, template, parentScope);
              // Remove the marker comment
              c.remove();
            }
          }
        }
        // Element node (1)
        else if (nt === 1) {
          const mIgnore = c.getAttribute('m-ignore');
          if (mIgnore === null) {
            const tag = c.tagName;
            if (tag === 'TEMPLATE') {
              // Skip templates
            } else {
              const mIf = c.getAttribute('m-if');
              if (mIf !== null) {
                this._hydrateIf(c, parentScope);
              } else {
                const mFor = c.getAttribute('m-for');
                if (mFor !== null) {
                  this._hydrateFor(c, parentScope);
                } else {
                  const t = tag.toLowerCase();
                  if (this._cp.has(t)) {
                    // Components in hydration mode
                    this._hydrateComponent(c, t, parentScope);
                  } else {
                    this._hydrateNode(c, parentScope);
                    // Push child onto stack for iterative processing instead of recursion
                    stack.push({ node: c, scope: parentScope });
                  }
                }
              }
            }
          }
        } else if (nt === 3) {
          // Text node with interpolation (legacy path for backward compatibility)
          // This handles cases where the server still renders literal {{ }} syntax
          const nv = c.nodeValue;
          if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
            this._hydrateText(c, parentScope);
          }
        }
        c = next;
      }
    }
  },

  /**
   * Hydrate bindings on a single element.
   * Attaches event listeners and reactive bindings to existing DOM.
   *
   * CRITICAL FIX: Hydration Input Wipe
   * On slow 3G networks, users might start typing into inputs before Reflex loads.
   * We must preserve user input by reading DOM value into state instead of overwriting.
   */
  _hydrateNode(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans');

    // CRITICAL FIX: Check if element is an input/textarea/select with user-modified value
    // If so, preserve the DOM value by updating state instead of overwriting DOM
    const isFormControl = n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT';
    let hasValueBinding = false;
    let valueExpression = null;

    // First pass: check for m-model or :value bindings
    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;
      if (nm === 'm-model' || nm.startsWith('m-model.')) {
        hasValueBinding = true;
        valueExpression = v;
        break;
      } else if (nm === ':value') {
        hasValueBinding = true;
        valueExpression = v;
        break;
      }
    }

    // Preserve user input by reading DOM into state
    if (isFormControl && hasValueBinding && valueExpression) {
      try {
        const fn = this._fn(valueExpression);
        const stateValue = fn(this.s, o);

        // CRITICAL FIX: Checkbox/Radio State Corruption
        // For checkboxes and radios, we need to compare checked state, not value
        // Checkboxes have domValue="on" (string) but stateValue=true (boolean)
        // Comparing String(true) !== "on" incorrectly overwrites state with "on"
        const type = (n.type || '').toLowerCase();
        const isCheckbox = type === 'checkbox';
        const isRadio = type === 'radio';

        let shouldPreserve = false;
        let finalValue;

        if (isCheckbox || isRadio) {
          // For boolean inputs, compare checked state instead of value
          const domChecked = n.checked;
          const stateChecked = isCheckbox ? !!stateValue : (String(stateValue) === String(n.value));

          if (domChecked !== stateChecked) {
            shouldPreserve = true;
            // Preserve the checked state
            if (isCheckbox) {
              finalValue = domChecked;
            } else {
              // Radio: preserve the value if checked
              finalValue = domChecked ? n.value : stateValue;
            }
          }
        } else {
          // For text/number inputs, compare values
          const domValue = n.value;
          if (domValue !== '' && String(stateValue) !== domValue) {
            shouldPreserve = true;
            // Preserve type: convert to number for number inputs
            if (type === 'number' || type === 'range') {
              finalValue = domValue === '' ? null : parseFloat(domValue);
            } else {
              finalValue = domValue;
            }
          }
        }

        if (shouldPreserve) {
          // CRITICAL FIX: Properly handle bracket notation in expressions
          // Expression: items[0].value should set state.items[0].value, NOT state['items[0]']['value']
          // We need to manually traverse the path, correctly parsing brackets

          // Parse path segments correctly, handling both dots and brackets
          // Examples: "items[0].name" -> ["items", 0, "name"]
          //           "user.address[0]" -> ["user", "address", 0]
          const pathSegments = [];
          let currentPath = valueExpression;

          while (currentPath.length > 0) {
            // Match: identifier, bracket notation, or dot notation
            const dotMatch = currentPath.match(/^([^.[]+)/);
            const bracketMatch = currentPath.match(/^\[(\d+|'[^']*'|"[^"]*")\]/);

            if (bracketMatch) {
              // Bracket notation: extract the index/key
              let key = bracketMatch[1];
              // Remove quotes if present
              if ((key[0] === "'" && key[key.length - 1] === "'") ||
                  (key[0] === '"' && key[key.length - 1] === '"')) {
                key = key.slice(1, -1);
              } else {
                // Convert to number if it's a numeric index
                key = parseInt(key, 10);
              }
              pathSegments.push(key);
              currentPath = currentPath.slice(bracketMatch[0].length);
            } else if (dotMatch) {
              // Property name
              pathSegments.push(dotMatch[1]);
              currentPath = currentPath.slice(dotMatch[0].length);
            } else {
              // Skip unexpected characters (like dots)
              currentPath = currentPath.slice(1);
            }

            // Skip leading dot
            if (currentPath[0] === '.') {
              currentPath = currentPath.slice(1);
            }
          }

          // Navigate to the parent object and set the final property
          if (pathSegments.length > 0) {
            const finalKey = pathSegments.pop();

            // CRITICAL SECURITY FIX: Prototype Pollution Prevention
            // Block unsafe properties to prevent attacks like m-model="constructor.prototype.isAdmin"
            if (UNSAFE_PROPS[finalKey]) {
              console.warn('Reflex Hydration: Blocked attempt to set unsafe property:', finalKey);
              return;
            }

            let target = o && pathSegments[0] in o ? o : this.s;

            for (const segment of pathSegments) {
              // CRITICAL SECURITY FIX: Check each segment for prototype pollution
              if (UNSAFE_PROPS[segment]) {
                console.warn('Reflex Hydration: Blocked attempt to traverse unsafe property:', segment);
                return;
              }

              if (target[segment] == null) {
                // Create intermediate objects/arrays as needed
                const nextSegment = pathSegments[pathSegments.indexOf(segment) + 1];
                target[segment] = typeof nextSegment === 'number' ? [] : {};
              }
              target = target[segment];
            }

            target[finalKey] = finalValue;
          }
        }
      } catch (err) {
        // Ignore errors during state update, fall through to normal hydration
      }
    }

    // Second pass: attach reactive bindings
    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        // Attribute binding - attach reactivity
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        // Event binding - attach listener
        // Extract modifiers for consistency with compiler
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
          // CRITICAL FIX: Hydration m-ref Array Mismatch
          // Check if this ref should be an array (matching compiler behavior)
          const isArrayRef = v in this.s && Array.isArray(this.s[v]);

          if (isArrayRef) {
            // Array mode: push element to array (consistent with compiler)
            if (!Array.isArray(this._refs[v])) {
              this._refs[v] = [];
            }
            this._refs[v].push(n);
            this.s[v].push(n);

            this._reg(n, () => {
              // CRITICAL FIX: Preserve DOM order for ref arrays (use splice, not swap-and-pop)
              const refsArray = this._refs[v];
              if (Array.isArray(refsArray)) {
                const idx = refsArray.indexOf(n);
                if (idx !== -1) {
                  refsArray.splice(idx, 1);
                }
              }
              const stateArray = this.s[v];
              if (Array.isArray(stateArray)) {
                const idx = stateArray.indexOf(n);
                if (idx !== -1) {
                  stateArray.splice(idx, 1);
                }
              }
            });
          } else {
            // Single mode: replace ref (original behavior)
            this._refs[v] = n;
            this._reg(n, () => { delete this._refs[v]; });
          }
        } else {
          // Custom directives
          const parts = nm.slice(2).split('.');
          const dirName = parts[0];
          const mods = parts.slice(1);
          this._applyDir(n, dirName, v, mods, o);
        }
      }
    }
  },

  /**
   * Hydrate text interpolation (legacy path).
   * The text node already has the rendered content, we just attach reactivity.
   * This handles cases where the server still renders literal {{ }} syntax.
   */
  _hydrateText(n, o) {
    // Use the existing _txt method - it will update the text reactively
    this._txt(n, o);
  },

  /**
   * Hydrate text interpolation with explicit template.
   * CRITICAL FIX: Handles server-rendered values with preserved template info.
   *
   * During SSR, the server renders the evaluated value (e.g., "Hello World")
   * and adds a comment marker with the template (e.g., <!--txt:{{ user.name }}-->).
   * This method applies the template to the text node to make it reactive.
   *
   * @param {Text} n - The text node containing the server-rendered value
   * @param {string} template - The template expression (e.g., "{{ value }}" or "Hello {{ name }}")
   * @param {Object} o - The scope object
   */
  _hydrateTextWithTemplate(n, template, o) {
    // Temporarily set the text node to contain the template
    // so that _txt can parse and apply it correctly
    const originalValue = n.nodeValue;
    n.nodeValue = template;

    try {
      // Use the existing _txt method to set up reactivity
      this._txt(n, o);
    } catch (err) {
      // If _txt fails, restore the original value
      n.nodeValue = originalValue;
      this._handleError(err, o);
    }
  },

  /**
   * Hydrate m-if directive.
   * The element already exists if the condition was true during SSR.
   */
  _hydrateIf(el, o) {
    const fn = this._fn(el.getAttribute('m-if'));
    const trans = el.getAttribute('m-trans');

    // In hydration mode, we need to track the current state
    // and set up reactivity without modifying the DOM initially
    const initialValue = !!fn(this.s, o);

    if (initialValue) {
      // Element is already in DOM - just attach bindings
      el.removeAttribute('m-if');
      el.removeAttribute('m-trans');
      this._hydrateNode(el, o);
      this._hydrateWalk(el, o);

      // Create a comment marker for future conditional updates
      const cm = document.createComment('if');
      el.before(cm);

      let cur = el;
      let leaving = false;
      const tpl = el.cloneNode(true);

      const e = this.createEffect(() => {
        const ok = !!fn(this.s, o);
        if (ok && !cur && !leaving) {
          cur = tpl.cloneNode(true);
          cm.after(cur);
          this._bnd(cur, o);
          this._w(cur, o);
          if (trans) runTransition(cur, trans, 'enter', null);
        } else if (!ok && cur && !leaving) {
          if (trans) {
            leaving = true;
            const node = cur;
            runTransition(node, trans, 'leave', () => {
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
      });
      this._reg(cm, e.kill);
    } else {
      // Element should not be in DOM (SSR rendered it conditionally hidden)
      // Create the standard m-if setup
      this._dir_if(el, o);
    }
  },

  /**
   * Hydrate m-for directive.
   * The list items already exist in the DOM from SSR.
   */
  _hydrateFor(el, o) {
    const ex = el.getAttribute('m-for');
    const kAttr = el.getAttribute('m-key');
    const match = ex.match(/^\s*(.*?)\s+in\s+(.*$)/);
    if (!match) return;

    const [, l, r] = match;
    const parts = l.replace(/[()]/g, '').split(',').map(s => s.trim());
    const alias = parts[0], idxAlias = parts[1];
    const listFn = this._fn(r);
    const keyIsProp = !!kAttr && /^[a-zA-Z_$][\w$]*$/.test(kAttr);
    const keyFn = (!kAttr || keyIsProp) ? null : this._fn(kAttr);

    // Get the current list value
    const list = listFn(this.s, o) || [];
    const raw = Array.isArray(list) ? this.toRaw(list) : Array.from(list);

    // Collect existing DOM nodes (siblings that match the template structure)
    // CRITICAL FIX: Robust sibling collection that skips non-matching elements
    // The previous logic broke early if it encountered a non-matching element,
    // causing hydration to fail when server renders lists with separators or mixed content
    const existingNodes = [];
    let sibling = el;
    let collected = 0;
    const maxSearch = raw.length * 3; // Prevent infinite loops, search up to 3x the expected count

    // Collect exactly raw.length matching siblings, skipping non-matching elements
    while (sibling && collected < raw.length && existingNodes.length < maxSearch) {
      if (sibling.nodeType === 1) { // Element node
        if (sibling.tagName === el.tagName) {
          existingNodes.push(sibling);
          collected++;
        }
        // Skip non-matching elements instead of breaking
      }
      sibling = sibling.nextElementSibling;
    }

    // If we have matching nodes, hydrate them
    if (existingNodes.length > 0 && existingNodes.length === raw.length) {
      // Create comment marker before first node
      const cm = document.createComment('for');
      existingNodes[0].before(cm);

      const tpl = el.cloneNode(true);
      tpl.removeAttribute('m-for');
      tpl.removeAttribute('m-key');

      let rows = new Map();
      let oldKeys = [];

      // CRITICAL FIX: Hydration Ghost Nodes - Use duplicate key resolution
      // The compiler uses resolveDuplicateKey to handle duplicate keys, but
      // hydration was missing this logic, causing ghost nodes when duplicate
      // keys are encountered during hydration.
      const seenKeys = new Map();

      // Hydrate existing nodes
      for (let i = 0; i < existingNodes.length; i++) {
        const node = existingNodes[i];
        let item = raw[i];
        if (item !== null && typeof item === 'object' && !item[SKIP]) {
          item = this._r(item);
        }

        const sc = Object.create(o || {});
        sc[alias] = item;
        if (idxAlias) sc[idxAlias] = i;

        let key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, sc)) : i;
        // CRITICAL: Resolve duplicate keys to prevent ghost nodes
        key = resolveDuplicateKey(seenKeys, key, i);

        const scope = this._r(sc);

        // Remove m-for and m-key attributes from hydrated nodes
        node.removeAttribute('m-for');
        node.removeAttribute('m-key');

        this._scopeMap.set(node, scope);
        this._hydrateNode(node, scope);
        this._hydrateWalk(node, scope);

        rows.set(key, { node, oldIdx: i });
        oldKeys.push(key);
      }

      // Set up reactive effect for future updates
      const eff = this.createEffect(() => {
        const newList = listFn(this.s, o) || [];
        const listMeta = newList[META] || this._mf.get(newList);
        if (listMeta) this.trackDependency(listMeta, ITERATE);

        const newRaw = Array.isArray(newList) ? this.toRaw(newList) : Array.from(newList);
        const newLen = newRaw.length;

        // Build key-to-oldIndex map for LIS calculation
        const keyToOldIdx = new Map();
        for (let i = 0; i < oldKeys.length; i++) {
          keyToOldIdx.set(oldKeys[i], i);
        }

        // Prepare new nodes and collect old indices for LIS
        const newNodes = new Array(newLen);
        const newKeys = new Array(newLen);
        const oldIndices = new Array(newLen);

        for (let i = 0; i < newLen; i++) {
          let item = newRaw[i];
          if (item !== null && typeof item === 'object' && !item[SKIP]) {
            item = this._r(item);
          }
          const sc = Object.create(o || {});
          sc[alias] = item;
          if (idxAlias) sc[idxAlias] = i;

          const key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, sc)) : i;
          newKeys[i] = key;

          const existing = rows.get(key);
          if (existing) {
            const p = this._scopeMap.get(existing.node);
            if (p) {
              p[alias] = item;
              if (idxAlias) p[idxAlias] = i;
            }
            newNodes[i] = existing.node;
            oldIndices[i] = keyToOldIdx.get(key) ?? -1;
            rows.delete(key);
          } else {
            const node = tpl.cloneNode(true);
            const scope = this._r(sc);
            this._scopeMap.set(node, scope);
            this._bnd(node, scope);
            this._w(node, scope);
            newNodes[i] = node;
            oldIndices[i] = -1;
          }
        }

        // Remove stale nodes
        rows.forEach(({ node }) => {
          this._kill(node);
          node.remove();
        });

        // Compute LIS for optimal moves
        const lis = this._computeLIS ? this._computeLIS(oldIndices) : computeLISLocal(oldIndices);
        const lisSet = new Set(lis);

        // Insert nodes - only move nodes NOT in LIS
        let nextSibling = null;
        for (let i = newLen - 1; i >= 0; i--) {
          const node = newNodes[i];
          if (!lisSet.has(i)) {
            if (nextSibling) {
              cm.parentNode.insertBefore(node, nextSibling);
            } else {
              let lastNode = cm;
              for (let j = 0; j < i; j++) {
                if (newNodes[j].parentNode) lastNode = newNodes[j];
              }
              lastNode.after(node);
            }
          }
          nextSibling = node;
        }

        // Rebuild rows map
        rows = new Map();
        for (let i = 0; i < newLen; i++) {
          rows.set(newKeys[i], { node: newNodes[i], oldIdx: i });
        }
        oldKeys = newKeys;
      });

      this._reg(cm, () => {
        rows.forEach(({ node }) => this._kill(node));
        eff.kill();
      });
    } else {
      // No matching nodes or mismatch - fall back to normal m-for
      // FIX: Remove all existing server-rendered nodes to prevent "Zombie Siblings"
      // Without this cleanup, mismatched server nodes remain in DOM alongside
      // newly rendered client nodes, causing duplicate/ghost content.
      existingNodes.forEach(node => {
        if (node !== el) {
          node.remove();
        }
      });
      this._dir_for(el, o);
    }
  },

  /**
   * Hydrate a component.
   */
  _hydrateComponent(el, tag, o) {
    // For components, we need to use the normal component initialization
    // but hydrate the resulting DOM instead of mounting fresh
    this._comp(el, tag, o);
  }
};

/**
 * Local LIS computation for hydration module independence.
 * This duplicates the logic from reconcile.js to keep hydration tree-shakable.
 */
function computeLISLocal(arr) {
  const n = arr.length;
  if (n === 0) return [];

  const tails = [];
  const prevIdx = new Array(n);
  const result = [];

  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v < 0) continue; // Skip new items

    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }

    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;

    prevIdx[i] = lo > 0 ? tails[lo - 1] : -1;
  }

  if (tails.length === 0) return [];

  let idx = tails[tails.length - 1];
  for (let i = tails.length - 1; i >= 0; i--) {
    result[i] = idx;
    idx = prevIdx[idx];
  }

  return result;
}

/**
 * withHydration plugin.
 *
 * Adds hydration capabilities to Reflex instances.
 * Tree-shakable: if not imported, hydration code won't be bundled.
 *
 * @example
 * import { Reflex } from 'reflex';
 * import { withHydration } from 'reflex/hydration';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withHydration);
 * app.hydrate(document.getElementById('app'));
 */
export const withHydration = {
  mixin: HydrationMixin,
  init(reflex) {
    // Initialize hydration-specific state
    reflex._hydrateMode = false;
  }
};

export default withHydration;
