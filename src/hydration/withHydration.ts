/**
 * Reflex Hydration Mixin
 *
 * Provides SSR hydration support for Reflex applications.
 * This module walks existing server-rendered DOM nodes and attaches
 * reactive bindings and event listeners without creating new elements.
 *
 * Tree-shakable: If not imported, this code won't be in the final bundle.
 *
 * @example
 * import { Reflex } from 'reflex';
 * import { withHydration } from 'reflex/hydration';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withHydration);
 * app.hydrate(document.getElementById('app'));
 */

import { META, ITERATE, SKIP } from '../core/symbols.js';
import { runTransition } from '../core/compiler.js';

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
   */
  _hydrateWalk(n, o) {
    let c = n.firstChild;
    while (c) {
      const next = c.nextSibling;
      const nt = c.nodeType;

      // Element node (1)
      if (nt === 1) {
        const mIgnore = c.getAttribute('m-ignore');
        if (mIgnore === null) {
          const tag = c.tagName;
          if (tag === 'TEMPLATE') {
            // Skip templates
          } else {
            const mIf = c.getAttribute('m-if');
            if (mIf !== null) {
              this._hydrateIf(c, o);
            } else {
              const mFor = c.getAttribute('m-for');
              if (mFor !== null) {
                this._hydrateFor(c, o);
              } else {
                const t = tag.toLowerCase();
                if (this._cp.has(t)) {
                  // Components in hydration mode
                  this._hydrateComponent(c, t, o);
                } else {
                  this._hydrateNode(c, o);
                  this._hydrateWalk(c, o);
                }
              }
            }
          }
        }
      } else if (nt === 3) {
        // Text node with interpolation
        const nv = c.nodeValue;
        if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
          this._hydrateText(c, o);
        }
      }
      c = next;
    }
  },

  /**
   * Hydrate bindings on a single element.
   * Attaches event listeners and reactive bindings to existing DOM.
   */
  _hydrateNode(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans');

    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        // Attribute binding - attach reactivity
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        // Event binding - attach listener
        this._ev(n, nm.slice(1), v, o);
      } else if (nm.startsWith('m-')) {
        if (nm === 'm-model') this._mod(n, v, o);
        else if (nm === 'm-text') this._at(n, 'textContent', v, o);
        else if (nm === 'm-html') this._html(n, v, o);
        else if (nm === 'm-show') this._show(n, v, o, trans);
        else if (nm === 'm-effect') this._effect(n, v, o);
        else if (nm === 'm-ref') {
          this._refs[v] = n;
          this._reg(n, () => { delete this._refs[v]; });
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
   * Hydrate text interpolation.
   * The text node already has the rendered content, we just attach reactivity.
   */
  _hydrateText(n, o) {
    // Use the existing _txt method - it will update the text reactively
    this._txt(n, o);
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
    const existingNodes = [];
    let sibling = el;

    // First node is the template element itself
    for (let i = 0; i < raw.length; i++) {
      if (sibling && sibling.nodeType === 1 && sibling.tagName === el.tagName) {
        existingNodes.push(sibling);
        sibling = sibling.nextElementSibling;
      } else {
        break;
      }
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

        const key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, sc)) : i;
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
