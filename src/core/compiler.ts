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
import { computeLIS, resolveDuplicateKey, reconcileKeyedList } from './reconcile.js';

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
   * Uses iterative walking with explicit stack to prevent stack overflow.
   * This approach handles deeply nested DOM structures (10,000+ levels) safely.
   *
   * The stack stores {node, scope} pairs to process.
   * Each node's children are pushed in reverse order to maintain left-to-right processing.
   */
  _w(n, o) {
    // Explicit stack prevents recursive call stack overflow
    const stack = [{ node: n, scope: o }];

    while (stack.length > 0) {
      const { node, scope } = stack.pop();
      let c = node.firstChild;

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
                this._dir_if(c, scope);
              } else {
                const mFor = c.getAttribute('m-for');
                if (mFor !== null) {
                  this._dir_for(c, scope);
                } else {
                  const t = tag.toLowerCase();
                  if (this._cp.has(t)) {
                    this._comp(c, t, scope);
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
            this._w(cur, o);
          }
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

      // Track seen keys to detect and handle duplicates
      const seenKeys = new Set();

      // Configure reconciliation with Reflex-specific logic
      const config = {
        getKey: (item, index, scope) => {
          let key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, scope)) : index;
          // Handle duplicate keys to prevent ghost nodes
          return resolveDuplicateKey(seenKeys, key, index);
        },

        createScope: (item, index) => {
          let processedItem = item;
          if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
            processedItem = this._r(processedItem);
          }
          // Use flat object copy instead of Object.create to allow V8 inline caching
          // Object.create creates unique prototype chains, preventing optimization
          const sc = o ? Object.assign({}, o) : {};
          sc[alias] = processedItem;
          if (idxAlias) sc[idxAlias] = index;
          return this._r(sc);
        },

        createNode: (item, index) => {
          const scope = config.createScope(item, index);
          const node = tpl.cloneNode(true);

          if (isSyncComp) {
            // For sync components, we need to insert the node first,
            // call _comp which replaces it, then track the instance
            const tempMarker = document.createComment('comp');
            cm.after(tempMarker);
            tempMarker.after(node);
            const inst = this._comp(node, tag, scope);
            this._scopeMap.set(inst, scope);
            tempMarker.remove();
            return inst;
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
            return tracked;
          } else {
            this._scopeMap.set(node, scope);
            this._bnd(node, scope);
            this._w(node, scope);
            return node;
          }
        },

        updateNode: (node, item, index) => {
          const scope = this._scopeMap.get(node);
          if (scope) {
            let processedItem = item;
            if (processedItem !== null && typeof processedItem === 'object' && !processedItem[SKIP]) {
              processedItem = this._r(processedItem);
            }
            scope[alias] = processedItem;
            if (idxAlias) scope[idxAlias] = index;
          }
        },

        removeNode: (node) => {
          this._kill(node);
          node.remove();
        }
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
    });

    eff.o = o;
    this._reg(cm, () => {
      // Kill effects and REMOVE nodes from DOM
      // This is critical for m-if + m-for combinations where
      // removing the m-for comment marker must also remove list items
      rows.forEach(({ node }) => {
        this._kill(node);
        if (node.parentNode) {
          node.remove();
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
   *
   * CRITICAL SECURITY NOTE:
   * m-html is DANGEROUS and can lead to XSS attacks if used with untrusted content.
   *
   * Requirements:
   * 1. DOMPurify must be configured: app.configure({ domPurify: DOMPurify })
   * 2. Never use m-html with user-provided content
   * 3. Consider using m-text instead for user content
   *
   * Without DOMPurify, m-html will THROW AN ERROR to prevent silent XSS vulnerabilities.
   */
  _html(el, exp, o) {
    const fn = this._fn(exp);
    let prev;
    const self = this;
    const e = this._ef(() => {
      const v = fn(self.s, o);
      let html = v == null ? '' : String(v);

      if (self.cfg.sanitize) {
        // Use configured DOMPurify instance (not global variable)
        const purify = self.cfg.domPurify;
        if (purify && typeof purify.sanitize === 'function') {
          html = purify.sanitize(html);
        } else {
          // CRITICAL: Fail hard instead of silent fallback
          throw new Error(
            'Reflex: SECURITY ERROR - m-html requires DOMPurify.\n' +
            'Configure it with: app.configure({ domPurify: DOMPurify })\n' +
            'Install: npm install dompurify\n' +
            'Or disable sanitization (UNSAFE): app.configure({ sanitize: false })'
          );
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
    const isMultiSelect = type === 'select-multiple';

    const e = this._ef(() => {
      const v = fn(this.s, o);
      if (isChk) el.checked = !!v;
      else if (isMultiSelect) {
        // For multi-select, v should be an array of selected values
        const selectedValues = Array.isArray(v) ? v : [];
        // Update the selected options
        const options = el.options;
        for (let i = 0; i < options.length; i++) {
          options[i].selected = selectedValues.includes(options[i].value);
        }
      } else {
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
      else if (isMultiSelect) {
        // For multi-select, return array of selected values
        // Fallback for environments without selectedOptions (e.g., happy-dom)
        if (el.selectedOptions) {
          v = Array.from(el.selectedOptions).map(opt => opt.value);
        } else {
          v = Array.from(el.options)
            .filter(opt => opt.selected)
            .map(opt => opt.value);
        }
      } else v = el.value;

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

    const e = this._ef(() => {
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
