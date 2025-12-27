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
 */

import { META, ITERATE, SKIP, UNSAFE_PROPS, UNSAFE_URL_RE } from './symbols.js';
import { computeLIS } from './reconcile.js';

// Basic HTML entity escaping for when DOMPurify is unavailable
const escapeHTML = s => s.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/**
 * CSS Transition helper for enter/leave animations.
 * Follows Vue/Alpine naming convention:
 * - {name}-enter-from, {name}-enter-active, {name}-enter-to
 * - {name}-leave-from, {name}-leave-active, {name}-leave-to
 */
export function runTransition(el, name, type, done) {
  const from = `${name}-${type}-from`;
  const active = `${name}-${type}-active`;
  const to = `${name}-${type}-to`;

  // Add initial classes
  el.classList.add(from, active);

  // Force reflow to ensure initial state is applied
  el.offsetHeight; // eslint-disable-line no-unused-expressions

  // Next frame: start transition
  requestAnimationFrame(() => {
    el.classList.remove(from);
    el.classList.add(to);

    // Listen for transition end
    const onEnd = (e) => {
      if (e.target !== el) return;
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      el.classList.remove(active, to);
      if (done) done();
    };

    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);

    // Fallback timeout (in case transitionend doesn't fire)
    const style = getComputedStyle(el);
    const duration = parseFloat(style.transitionDuration) || parseFloat(style.animationDuration) || 0;
    const delay = parseFloat(style.transitionDelay) || parseFloat(style.animationDelay) || 0;
    const timeout = (duration + delay) * 1000 + 50; // Add 50ms buffer

    if (timeout > 50) {
      setTimeout(() => {
        el.removeEventListener('transitionend', onEnd);
        el.removeEventListener('animationend', onEnd);
        el.classList.remove(active, to);
        if (done) done();
      }, timeout);
    } else {
      // No transition defined, complete immediately
      el.classList.remove(active, to);
      if (done) done();
    }
  });
}

/**
 * Compiler mixin for Reflex class.
 */
export const CompilerMixin = {
  /**
   * Walk the DOM tree and process nodes.
   * Uses recursive walking (not TreeWalker) because:
   * 1. Allows efficient subtree skipping for m-ignore, m-for, m-if
   * 2. TreeWalker forces visiting every node even when skipping
   * 3. Benchmarks show recursion is faster when skipping is needed
   */
  _w(n, o) {
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
              this._dir_if(c, o);
            } else {
              const mFor = c.getAttribute('m-for');
              if (mFor !== null) {
                this._dir_for(c, o);
              } else {
                const t = tag.toLowerCase();
                if (this._cp.has(t)) {
                  this._comp(c, t, o);
                } else if (this._acp.has(t)) {
                  // Async component: lazy-load the handler
                  this._asyncComp(c, t, o);
                } else {
                  this._bnd(c, o);
                  this._w(c, o);
                }
              }
            }
          }
        }
      } else if (nt === 3) {
        // Text node with interpolation
        const nv = c.nodeValue;
        if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
          this._txt(c, o);
        }
      }
      c = next;
    }
  },

  /**
   * Process bindings on an element.
   */
  _bnd(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans'); // For m-show transitions

    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        this._ev(n, nm.slice(1), v, o);
      } else if (nm.startsWith('m-')) {
        if (nm === 'm-model') this._mod(n, v, o);
        else if (nm === 'm-text') this._at(n, 'textContent', v, o);
        else if (nm === 'm-html') this._html(n, v, o);
        else if (nm === 'm-show') this._show(n, v, o, trans);
        else if (nm === 'm-effect') this._effect(n, v, o);
        else if (nm === 'm-ref') {
          // Register element in $refs
          this._refs[v] = n;
          this._reg(n, () => { delete this._refs[v]; });
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
    const cm = document.createComment('if');
    el.replaceWith(cm);
    let cur, leaving = false;

    // Check if the element is a component
    const tag = el.tagName.toLowerCase();
    const isSyncComp = this._cp.has(tag);
    const isAsyncComp = this._acp.has(tag);

    const e = this._ef(() => {
      const ok = !!fn(this.s, o);
      if (ok && !cur && !leaving) {
        const cloned = el.cloneNode(true);
        cloned.removeAttribute('m-if');
        cloned.removeAttribute('m-trans');
        cm.after(cloned);

        if (isSyncComp) {
          // For sync components, track the returned instance
          cur = this._comp(cloned, tag, o);
        } else if (isAsyncComp) {
          // For async components, track the marker that _asyncComp creates
          // _asyncComp replaces cloned with marker (+ optional fallback)
          this._asyncComp(cloned, tag, o);
          // The marker is now at cloned's position (cm.nextSibling)
          cur = cm.nextSibling;
        } else {
          cur = cloned;
          this._bnd(cur, o);
          this._w(cur, o);
        }
        // Run enter transition
        if (trans && cur) runTransition(cur, trans, 'enter', null);
      } else if (!ok && cur && !leaving) {
        // For async components, we need to find all nodes between marker and end
        // For now, remove all siblings after the marker until we hit another comment/marker
        if (isAsyncComp) {
          // Remove all content from async component (marker, fallback, or loaded component)
          let node = cm.nextSibling;
          while (node) {
            const next = node.nextSibling;
            // Stop if we hit another structural directive marker
            if (node.nodeType === 8 && ((node as Comment).nodeValue?.startsWith('if') ||
                (node as Comment).nodeValue?.startsWith('for'))) {
              break;
            }
            this._kill(node);
            (node as ChildNode).remove();
            // For async, remove only one element/marker set
            if (node.nodeType === 1 || (node as Comment).nodeValue?.startsWith('async:')) {
              break;
            }
            node = next;
          }
          cur = null;
        } else if (trans) {
          // Run leave transition before removing
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
    e.o = o;
    this._reg(cm, e.kill);
  },

  /**
   * m-for directive: keyed list rendering with LIS-optimized reconciliation.
   *
   * Uses Longest Increasing Subsequence to minimize DOM moves.
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
    const listFn = this._fn(r);
    const keyIsProp = !!kAttr && /^[a-zA-Z_$][\w$]*$/.test(kAttr);
    const keyFn = (!kAttr || keyIsProp) ? null : this._fn(kAttr);

    const cm = document.createComment('for');
    el.replaceWith(cm);
    const tpl = el.cloneNode(true);
    tpl.removeAttribute('m-for');
    tpl.removeAttribute('m-key');

    // Check if the template is a component
    const tag = el.tagName.toLowerCase();
    const isSyncComp = this._cp.has(tag);
    const isAsyncComp = this._acp.has(tag);

    let rows = new Map();     // key -> { node, oldIdx }
    let oldKeys = [];         // Track key order for LIS

    const eff = this._ef(() => {
      const list = listFn(this.s, o) || [];
      const listMeta = list[META] || this._mf.get(list);
      if (listMeta) this._tk(listMeta, ITERATE);

      const raw = Array.isArray(list) ? this.toRaw(list) : Array.from(list);
      const newLen = raw.length;

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
        let item = raw[i];
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
          // Reuse existing node, update scope
          const p = this._scopeMap.get(existing.node);
          if (p) {
            p[alias] = item;
            if (idxAlias) p[idxAlias] = i;
          }
          newNodes[i] = existing.node;
          oldIndices[i] = keyToOldIdx.get(key) ?? -1;
          rows.delete(key);
        } else {
          // Create new node
          const node = tpl.cloneNode(true);
          const scope = this._r(sc);

          if (isSyncComp) {
            // For sync components, we need to insert the node first,
            // call _comp which replaces it, then track the instance
            const tempMarker = document.createComment('comp');
            cm.after(tempMarker);
            tempMarker.after(node);
            const inst = this._comp(node, tag, scope);
            this._scopeMap.set(inst, scope);
            tempMarker.remove();
            newNodes[i] = inst;
          } else if (isAsyncComp) {
            // For async components, insert and let _asyncComp handle it
            const tempMarker = document.createComment('async');
            cm.after(tempMarker);
            tempMarker.after(node);
            this._asyncComp(node, tag, scope);
            // For async, we track the marker's next sibling (fallback or loaded component)
            const tracked = tempMarker.nextSibling || node;
            this._scopeMap.set(tracked, scope);
            tempMarker.remove();
            newNodes[i] = tracked;
          } else {
            this._scopeMap.set(node, scope);
            this._bnd(node, scope);
            this._w(node, scope);
            newNodes[i] = node;
          }
          oldIndices[i] = -1;
        }
      }

      // Remove stale nodes
      rows.forEach(({ node }) => {
        this._kill(node);
        node.remove();
      });

      // Compute LIS for optimal moves - nodes in LIS don't need to move
      const lis = computeLIS(oldIndices);
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

    eff.o = o;
    this._reg(cm, () => {
      rows.forEach(({ node }) => this._kill(node));
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
      const e = this._ef(() => {
        const v = fn(this.s, o);
        const next = v == null ? '' : String(v);
        if (next !== prev) { prev = next; n.nodeValue = next; }
      });
      e.o = o;
      this._reg(n, e.kill);
      return;
    }
    const pts = raw.split(/(\{\{.*?\}\})/g).map(x =>
      x.startsWith('{{') ? this._fn(x.slice(2, -2)) : x
    );
    let prev;
    const e = this._ef(() => {
      let out = '';
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        out += typeof p === 'function' ? (p(this.s, o) ?? '') : p;
      }
      if (out !== prev) { prev = out; n.nodeValue = out; }
    });
    e.o = o;
    this._reg(n, e.kill);
  },

  /**
   * Attribute binding: :attr="expr"
   */
  _at(el, att, exp, o) {
    const fn = this._fn(exp);
    let prev;
    const isUrlAttr = att === 'href' || att === 'src' || att === 'action' ||
                      att === 'formaction' || att === 'xlink:href';

    const e = this._ef(() => {
      let v = fn(this.s, o);

      // Security: validate URL protocols
      if (isUrlAttr && v != null && typeof v === 'string' && UNSAFE_URL_RE.test(v)) {
        console.warn('Reflex: Blocked unsafe URL protocol in', att + ':', v);
        v = 'about:blank';
      }

      if (att === 'class') {
        const next = this._cls(v);
        if (next !== prev) { prev = next; el.className = next; }
      } else if (att === 'style') {
        const next = this._sty(v);
        if (next !== prev) { prev = next; el.style.cssText = next; }
      } else if (att in el) {
        el[att] = v ?? '';
      } else {
        const next = v === null || v === false ? null : String(v);
        if (next !== prev) {
          prev = next;
          next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
        }
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * HTML binding: m-html="expr"
   */
  _html(el, exp, o) {
    const fn = this._fn(exp);
    let prev;
    const e = this._ef(() => {
      const v = fn(this.s, o);
      let html = v == null ? '' : String(v);

      if (this.cfg.sanitize) {
        if (typeof DOMPurify !== 'undefined') {
          html = DOMPurify.sanitize(html);
        } else {
          html = escapeHTML(html);
          console.warn('Reflex: DOMPurify not loaded. HTML content escaped for safety.');
        }
      }

      if (html !== prev) { prev = html; el.innerHTML = html; }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Show/hide: m-show="expr"
   */
  _show(el, exp, o, trans) {
    const fn = this._fn(exp);
    const d = el.style.display === 'none' ? '' : el.style.display;
    let prev, transitioning = false;

    const e = this._ef(() => {
      const show = !!fn(this.s, o);
      const next = show ? d : 'none';

      if (next !== prev && !transitioning) {
        if (trans && prev !== undefined) {
          transitioning = true;
          if (show) {
            el.style.display = d;
            runTransition(el, trans, 'enter', () => { transitioning = false; });
          } else {
            runTransition(el, trans, 'leave', () => {
              el.style.display = 'none';
              transitioning = false;
            });
          }
        } else {
          el.style.display = next;
        }
        prev = next;
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Two-way binding: m-model="expr"
   */
  _mod(el, exp, o) {
    const fn = this._fn(exp);
    const type = (el.type || '').toLowerCase();
    const isChk = type === 'checkbox';
    const isNum = type === 'number' || type === 'range';

    const e = this._ef(() => {
      const v = fn(this.s, o);
      if (isChk) el.checked = !!v;
      else {
        const next = v == null ? '' : String(v);
        if (el.value !== next) el.value = next;
      }
    });
    e.o = o;
    this._reg(el, e.kill);

    const up = () => {
      let v;
      if (isChk) v = el.checked;
      else if (isNum) v = el.value === '' ? null : parseFloat(el.value);
      else v = el.value;

      const paths = exp.split('.'), end = paths.pop();

      // Security: prevent prototype pollution
      if (UNSAFE_PROPS[end]) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', end);
        return;
      }

      let t = o && paths[0] in o ? o : this.s;
      for (const p of paths) {
        if (UNSAFE_PROPS[p]) {
          console.warn('Reflex: Blocked attempt to traverse unsafe property:', p);
          return;
        }
        if (t[p] == null) t[p] = {};
        else if (typeof t[p] !== 'object') {
          console.warn('Reflex: Cannot set nested property on non-object value at path:', p);
          return;
        }
        t = t[p];
      }
      t[end] = v;
    };

    const evt = isChk || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, up);
    if (evt !== 'change') el.addEventListener('change', up);
    this._reg(el, () => {
      el.removeEventListener(evt, up);
      el.removeEventListener('change', up);
    });
  },

  /**
   * Event binding: @event.mod1.mod2="expr"
   */
  _ev(el, evt, exp, o) {
    const [nm, ...mod] = evt.split('.');
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

    // Debounce modifier: @input.debounce.300ms="search"
    const debounceDelay = getDelay('debounce.');
    if (debounceDelay || mod.includes('debounce')) {
      const delay = debounceDelay || 300;
      const origFn = fn;
      let timer = null;
      fn = (s, c, e) => {
        clearTimeout(timer);
        timer = setTimeout(() => origFn(s, c, e), delay);
      };
    }

    // Throttle modifier: @scroll.throttle.100ms="onScroll"
    const throttleDelay = getDelay('throttle.');
    if (throttleDelay || mod.includes('throttle')) {
      const delay = throttleDelay || 300;
      const origFn = fn;
      let last = 0;
      fn = (s, c, e) => {
        const now = Date.now();
        if (now - last >= delay) {
          last = now;
          origFn(s, c, e);
        }
      };
    }

    // Window/Document modifiers: @keydown.window="handleKey"
    if (mod.includes('window') || mod.includes('document')) {
      const target = mod.includes('window') ? window : document;
      const self = this;
      const handler = (e) => {
        if (mod.includes('prevent')) e.preventDefault();
        if (mod.includes('stop')) e.stopPropagation();
        fn(self.s, o, e, el);
      };
      const opts: AddEventListenerOptions | undefined = mod.includes('once') ? { once: true } : undefined;
      target.addEventListener(nm, handler, opts);
      this._reg(el, () => target.removeEventListener(nm, handler, opts));
      return;
    }

    // Outside modifier: @click.outside="closeModal"
    if (mod.includes('outside')) {
      const self = this;
      const handler = (e) => {
        if (!el.contains(e.target) && e.target !== el) {
          if (mod.includes('prevent')) e.preventDefault();
          if (mod.includes('stop')) e.stopPropagation();
          fn(self.s, o, e, el);
        }
      };
      document.addEventListener(nm, handler);
      this._reg(el, () => document.removeEventListener(nm, handler));
      return;
    }

    // Default: use event delegation
    if (!this._dh.has(nm)) {
      this._dh.set(nm, new WeakMap());
      this._dr.addEventListener(nm, e => this._hdl(e, nm));
    }
    this._dh.get(nm).set(el, { f: fn, o, m: mod });
  },

  /**
   * Delegated event handler
   */
  _hdl(e, nm) {
    let t = e.target;
    while (t && t !== this._dr) {
      const h = this._dh.get(nm)?.get(t);
      if (h) {
        const { f, o, m } = h;
        if (m.includes('self') && e.target !== t) { t = t.parentNode; continue; }
        if (m.includes('prevent')) e.preventDefault();
        if (m.includes('stop')) e.stopPropagation();
        f(this.s, o, e, t);
        if (m.includes('once')) this._dh.get(nm).delete(t);
        if (e.cancelBubble) return;
      }
      t = t.parentNode;
    }
  },

  /**
   * m-effect directive: run side effects when dependencies change
   */
  _effect(el, exp, o) {
    const fn = this._fn(exp, true);
    const e = this._ef(() => {
      try { fn(this.s, o, null, el); } catch (err) { this._handleError(err, o); }
    });
    e.o = o;
    this._reg(el, e.kill);
  },

  /**
   * Apply custom directive
   */
  _applyDir(el, name, value, mods, o) {
    const dir = this._cd.get(name);
    if (!dir) return false;

    const fn = this._fn(value);
    const self = this;

    const e = this._ef(() => {
      const binding = {
        value: fn(self.s, o),
        expression: value,
        modifiers: mods
      };
      const cleanup = dir(el, binding, self);
      if (typeof cleanup === 'function') {
        self._reg(el, cleanup);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
    return true;
  },

  /**
   * Convert class binding value to string
   */
  _cls(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(x => this._cls(x)).filter(Boolean).join(' ');
    if (typeof v === 'object') return Object.keys(v).filter(k => v[k]).join(' ');
    return String(v);
  },

  /**
   * Convert style binding value to string
   */
  _sty(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      let s = '';
      for (const k in v) {
        const val = v[k];
        if (val != null && val !== false) {
          // Convert camelCase to kebab-case (e.g., fontSize -> font-size)
          const prop = k.replace(/([A-Z])/g, '-$1').toLowerCase();
          s += prop + ':' + val + ';';
        }
      }
      return s;
    }
    return String(v);
  }
};
