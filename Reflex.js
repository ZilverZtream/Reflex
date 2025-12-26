/**
 * Reflex v1.1 - The Direct Reactive Engine
 * - Zero Dependencies, Zero Build, Zero VDOM
 * - Powered by the Meta-Pattern & Protoscopes
 * - Gauntlet Verified: Leak-free, NaN-safe, Strict Scoping
 * - CSP-Safe Mode Available
 */

const M = Symbol();
const I = Symbol.for("rx.i"); // Reflex Iterate
const S = Symbol.for("rx.s"); // Reflex Skip
const CLEAN = Symbol();

const A = 1, R = 2, Q = 4; // Active, Running, Queued (bitwise flags)

const RES = {
  __proto__: null,
  true: 1, false: 1, null: 1, undefined: 1, NaN: 1, Infinity: 1,
  if: 1, else: 1, for: 1, while: 1, do: 1, switch: 1, case: 1,
  break: 1, continue: 1, return: 1, try: 1, catch: 1, finally: 1,
  throw: 1, new: 1, delete: 1, typeof: 1, instanceof: 1, in: 1, of: 1,
  void: 1, await: 1, async: 1, yield: 1, function: 1, class: 1,
  extends: 1, super: 1, this: 1, var: 1, let: 1, const: 1,
  Math: 1, Date: 1, console: 1, window: 1, document: 1,
  Array: 1, Object: 1, Number: 1, String: 1, Boolean: 1, JSON: 1,
  Promise: 1, Symbol: 1, BigInt: 1, Map: 1, Set: 1, RegExp: 1, Error: 1,
  parseInt: 1, parseFloat: 1, isNaN: 1, isFinite: 1,
  $event: 1
};


const AM = { __proto__: null, push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1 };
const REORDER = { __proto__: null, splice: 1, sort: 1, reverse: 1, shift: 1, unshift: 1, fill: 1, copyWithin: 1 };
const CM = { __proto__: null, get: 1, has: 1, forEach: 1, keys: 1, values: 1, entries: 1, set: 1, add: 1, delete: 1, clear: 1 };
const ID_RE = /(?:^|[^.\w$])([a-zA-Z_$][\w$]*)/g;

// Dangerous property names that could lead to prototype pollution
const UNSAFE_PROPS = Object.assign(Object.create(null), { constructor: 1, prototype: 1, __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1, __lookupSetter__: 1 });
UNSAFE_PROPS["__proto__"] = 1; // Must use bracket notation to avoid syntax error

// Dangerous URL protocols
const UNSAFE_URL_RE = /^\s*(javascript|vbscript|data):/i;

// Dangerous patterns in expressions that could bypass reserved word checks
const UNSAFE_EXPR_RE = /\[(["'`])constructor\1\]|\[(["'`])__proto__\1\]|\.constructor\s*\(|Function\s*\(/i;

// Basic HTML entity escaping for when DOMPurify is unavailable
const escapeHTML = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// === STATIC PROXY HANDLERS ===
// Optimization: Define handlers ONCE outside the class to eliminate per-object allocation.
// Each reactive object reuses the same handler object, reducing memory by ~3 closures per object.
// The engine (Reflex instance) is stored on meta.engine, retrieved via target[M].

const ArrayHandler = {
  get(o, k, rec) {
    const meta = o[M];
    if (k === M) return meta;
    if (k === S) return o[S];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    const engine = meta.engine;

    // Cache array method wrappers to prevent closure factory bug
    if (AM[k]) {
      if (!meta._am) meta._am = Object.create(null);
      if (!meta._am[k]) meta._am[k] = engine._am(o, k, meta);
      return meta._am[k];
    }

    engine._tk(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[M];
    const engine = meta.engine;
    const raw = engine.toRaw(v);
    const old = o[k];
    if (Object.is(old, raw) && k !== "length") return true;

    let had, isIdx = false, n = -1;
    if (typeof k === "string") {
      n = Number(k);
      isIdx = n >= 0 && Number.isInteger(n) && String(n) === k;
    }
    if (k === "length") had = true;
    else if (isIdx) had = n < o.length;
    else had = k in o;

    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    engine._tr(meta, k);
    if (k === "length") {
      engine._tr(meta, I);
    } else if (isIdx) {
      engine._tr(meta, I);
      if (!had) engine._tr(meta, "length");
    }
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[M];
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      const engine = meta.engine;
      engine._tr(meta, k);
      engine._tr(meta, I);
      engine._tr(meta, "length");
    }
    return res;
  }
};

const ObjectHandler = {
  get(o, k, rec) {
    const meta = o[M];
    if (k === M) return meta;
    if (k === S) return o[S];

    // Fast path for symbols
    if (typeof k === 'symbol') return Reflect.get(o, k, rec);

    const engine = meta.engine;
    engine._tk(meta, k);
    const v = Reflect.get(o, k, rec);
    return engine._wrap(v);
  },

  set(o, k, v, rec) {
    const meta = o[M];
    const engine = meta.engine;
    const raw = engine.toRaw(v);
    const old = o[k];
    if (Object.is(old, raw)) return true;

    const had = k in o;
    const ok = Reflect.set(o, k, raw, rec);
    if (!ok) return false;

    engine._tr(meta, k);
    if (!had) engine._tr(meta, I);
    return true;
  },

  deleteProperty(o, k) {
    const meta = o[M];
    if (!(k in o)) return true;
    const res = Reflect.deleteProperty(o, k);
    if (res) {
      const engine = meta.engine;
      engine._tr(meta, k);
      engine._tr(meta, I);
    }
    return res;
  }
};

// Collection handlers need isMap flag, so we use a factory that returns static-ish handlers
// These are still created once per type (Map vs Set), not per instance
const MapHandler = {
  get(o, k, rec) {
    const meta = o[M];
    if (k === M) return meta;
    if (k === S) return o[S];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    const engine = meta.engine;

    if (k === "size") { engine._tk(meta, I); return o.size; }

    if ((k === Symbol.iterator || CM[k]) && typeof o[k] === "function") {
      return engine._cm(o, k, meta, true);
    }

    engine._tk(meta, k);
    return Reflect.get(o, k, rec);
  },

  set(o, k, v, rec) {
    return Reflect.set(o, k, v, rec);
  },

  deleteProperty(o, k) {
    return Reflect.deleteProperty(o, k);
  }
};

const SetHandler = {
  get(o, k, rec) {
    const meta = o[M];
    if (k === M) return meta;
    if (k === S) return o[S];

    // Fast path for symbols (except iterator)
    if (typeof k === 'symbol' && k !== Symbol.iterator) {
      return Reflect.get(o, k, rec);
    }

    const engine = meta.engine;

    if (k === "size") { engine._tk(meta, I); return o.size; }

    if ((k === Symbol.iterator || CM[k]) && typeof o[k] === "function") {
      return engine._cm(o, k, meta, false);
    }

    engine._tk(meta, k);
    return Reflect.get(o, k, rec);
  },

  set(o, k, v, rec) {
    return Reflect.set(o, k, v, rec);
  },

  deleteProperty(o, k) {
    return Reflect.deleteProperty(o, k);
  }
};

// === SIMPLE EXPRESSION CACHE WITH WIPE STRATEGY ===
// Optimization: Instead of complex LRU, use simple Map with hard limit wipe
// O(1) operations, zero overhead, prevents memory leaks
class SimpleCache {
  constructor(maxSize = 1000) {
    this.max = maxSize;
    this.cache = new Map();
  }

  get(key) {
    return this.cache.get(key);
  }

  set(key, value) {
    // Wipe strategy: if at capacity, clear everything and start fresh
    // This is O(1) and handles the crash risk with zero complexity
    if (this.cache.size >= this.max) {
      this.cache.clear();
    }
    this.cache.set(key, value);
    return value;
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }
}

// === CSP-SAFE MODE ===
// CSP parser is NOT bundled in core to reduce bundle size (~2KB savings).
// To use CSP mode, inject a parser via configure():
//   const app = new Reflex().configure({ parser: new SafeExprParser() });
// The parser must implement: compile(expression, reflex) => (state, context, $event) => result

class Reflex {
  constructor(init = {}) {
    this.s = null;      // State
    this._e = null;     // Active Effect
    this._es = [];      // Effect Stack
    this._q = [];       // Job Queue (uses Q flag for dedup instead of Set)
    this._p = false;    // Flush Pending
    this._b = 0;        // Batch Depth
    this._pt = new Map(); // Pending Triggers (Batching)
    this._ec = new SimpleCache(1000); // Expression Cache (wipe strategy to prevent memory leak)
    this._mf = new WeakMap(); // Meta Fallback (for non-extensible objects)
    this._dh = new Map(); // Delegated Handlers
    this._dr = null;    // DOM Root
    this._cp = new Map(); // Component Definitions
    this._parser = null;  // CSP parser (lazy-loaded only when needed)
    this.cfg = {
      sanitize: true,
      cspSafe: false,        // Enable CSP-safe mode (no new Function)
      cacheSize: 1000        // Expression cache size
    };

    this.s = this._r(init);

    const r = document.readyState;
    if (r === "loading") document.addEventListener("DOMContentLoaded", () => this.mount(), { once: true });
    else queueMicrotask(() => this.mount());
  }

  // Configure after construction
  configure(opts) {
    if (opts.sanitize !== undefined) this.cfg.sanitize = opts.sanitize;
    if (opts.cspSafe !== undefined) this.cfg.cspSafe = opts.cspSafe;
    if (opts.cacheSize !== undefined) {
      this.cfg.cacheSize = opts.cacheSize;
      this._ec = new SimpleCache(opts.cacheSize);
    }
    // Allow external parser injection (plugin architecture)
    if (opts.parser !== undefined) this._parser = opts.parser;
    return this;
  }

  // Get CSP parser - must be injected via configure() for CSP mode
  _getParser() {
    if (!this._parser) {
      throw new Error("Reflex: CSP mode requires a parser. Use configure({ parser: new SafeExprParser() }). " +
        "Import SafeExprParser from 'reflex/csp' or provide a custom parser with compile(exp, reflex) method.");
    }
    return this._parser;
  }

  mount(el = document.body) {
    this._dr = el;
    this._bnd(el, null);
    this._w(el, null);
    return this;
  }

  component(n, def) {
    const t = document.createElement("template");
    // FIX #1: Sanitize component templates to prevent XSS
    let template = def.template;
    if (this.cfg.sanitize) {
      if (typeof DOMPurify !== "undefined") {
        template = DOMPurify.sanitize(template, { RETURN_DOM_FRAGMENT: false, WHOLE_DOCUMENT: false });
      } else {
        console.warn("Reflex: DOMPurify not loaded. Component templates should be trusted or load DOMPurify for sanitization.");
      }
    }
    t.innerHTML = template;
    this._cp.set(n.toLowerCase(), { _t: t.content.firstElementChild, p: def.props || [], s: def.setup });
    return this;
  }

  computed(fn) {
    const self = this;
    let v, dirty = true;
    const subs = new Set();

    const runner = this._ef(() => {
      v = fn(self.s);
      dirty = false;
      return v;
    }, {
      lazy: true,
      sched: () => {
        if (!dirty) {
          dirty = true;
          // Auto-refresh if unconsumed to maintain state consistency
          if (!subs.size) {
            self._qj(runner);
            return;
          }
          for (const e of subs) {
            if (e.f & A && !(e.f & R)) e.s ? e.s(e) : self._qj(e);
          }
        }
      }
    });

    runner(); // Eager initial eval

    return {
      get value() {
        if (self._e && !subs.has(self._e)) {
          subs.add(self._e);
          self._e.d.push(subs);
        }
        if (dirty) runner();
        return v;
      }
    };
  }

  watch(src, cb, opts = {}) {
    const self = this;
    const getter = typeof src === "function" ? src : () => src.value;
    let old, cleanup;

    const job = () => {
      const n = runner();
      if (opts.deep || !Object.is(n, old)) {
        if (cleanup) cleanup();
        cb(n, old, fn => { cleanup = fn; });
        old = opts.deep ? self._clone(n) : n;
      }
    };

    const runner = this._ef(() => {
      const v = getter();
      if (opts.deep) self._trv(v);
      return v;
    }, { lazy: true, sched: () => self._qj(job) });

    if (opts.immediate) job();
    else { old = runner(); if (opts.deep) old = this._clone(old); }

    return () => runner.kill();
  }

  batch(fn) {
    this._b++;
    try { fn(); }
    finally {
      if (--this._b === 0) {
        // FIX: Wrap _fpt in try-catch to prevent state inconsistency
        try { this._fpt(); }
        catch (err) { console.error("Reflex: Error during batch flush:", err); }
      }
    }
  }

  nextTick(fn) {
    return new Promise(r => queueMicrotask(() => { this._fl(); fn?.(); r(); }));
  }

  toRaw(o) {
    if (o === null || typeof o !== "object") return o;
    const m = o[M] || this._mf.get(o);
    return m ? m.r : o;
  }

  // Clear expression cache (useful for long-running apps)
  clearCache() {
    this._ec.clear();
    return this;
  }

  // === REACTIVITY ENGINE ===
  // Optimization: Static handlers are defined ONCE outside the class (see top of file).
  // Each reactive object reuses the same handler, eliminating per-object closure allocation.
  // The engine reference is stored on meta.engine for handler access.

  _r(t) {
    if (t === null || typeof t !== "object") return t;
    if (t[S]) return t;
    if (t instanceof Node) return t;

    const existing = t[M] || this._mf.get(t);
    if (existing) return existing.p;

    // Store engine reference on meta for static handler access
    const meta = { p: null, r: t, d: new Map(), ai: false, _am: null, engine: this };
    const isArr = Array.isArray(t);
    const isMap = t instanceof Map;
    const isSet = t instanceof Set;

    // Use static handlers - ZERO allocation per reactive object
    let h;
    if (isArr) {
      h = ArrayHandler;
    } else if (isMap) {
      h = MapHandler;
    } else if (isSet) {
      h = SetHandler;
    } else {
      h = ObjectHandler;
    }

    meta.p = new Proxy(t, h);

    if (Object.isExtensible(t)) Object.defineProperty(t, M, { value: meta, configurable: true });
    else this._mf.set(t, meta);

    return meta.p;
  }

  _wrap(v) {
    return v !== null && typeof v === "object" && !v[S] && !(v instanceof Node) ? this._r(v) : v;
  }

  _tk(m, k) {
    if (!this._e) return;

    if (Array.isArray(m.r) && typeof k === "string") {
      const n = Number(k);
      if (n >= 0 && Number.isInteger(n) && String(n) === k) m.ai = true;
    }

    let s = m.d.get(k);
    if (!s) m.d.set(k, s = new Set());
    if (!s.has(this._e)) {
      s.add(this._e);
      this._e.d.push(s);
    }
  }

  _tr(m, k) {
    if (this._b > 0) {
      let ks = this._pt.get(m);
      if (!ks) this._pt.set(m, ks = new Set());
      ks.add(k);
      return;
    }
    const s = m.d.get(k);
    if (s) {
      for (const e of s) {
        if (e.f & A && !(e.f & R)) e.s ? e.s(e) : this._qj(e);
      }
    }
  }

  _fpt() {
    if (!this._pt.size) return;
    const pt = this._pt;
    this._pt = new Map();
    for (const [m, ks] of pt) {
      for (const k of ks) {
        // FIX: Wrap each trigger in try-catch to prevent partial state updates
        try { this._tr(m, k); }
        catch (err) { console.error("Reflex: Error triggering update for key:", k, err); }
      }
    }
  }

  // === CACHED ARRAY METHOD WRAPPER (Fixes Closure Factory Bug) ===
  _am(t, m, meta) {
    const self = this;
    return function(...args) {
      self._b++;
      let res;
      try {
        res = Array.prototype[m].apply(t, args);

        let ks = self._pt.get(meta);
        if (!ks) self._pt.set(meta, ks = new Set());
        ks.add(I);
        ks.add("length");

        if (meta.ai && REORDER[m]) {
          for (const [k, depSet] of meta.d) {
            if (!depSet.size) { meta.d.delete(k); continue; }
            if (typeof k === "string") {
              const n = Number(k);
              if (n >= 0 && Number.isInteger(n) && String(n) === k) ks.add(k);
            }
          }
        }
      } finally {
        if (--self._b === 0) {
          try { self._fpt(); }
          catch (err) { console.error("Reflex: Error flushing pending triggers:", err); }
        }
      }
      return res;
    };
  }

  _cm(t, m, meta, isMap) {
    if (meta[m]) return meta[m];
    const self = this;
    const proto = isMap ? Map.prototype : Set.prototype;
    const fn = proto[m];

    if (m === Symbol.iterator || m === "entries" || m === "values" || m === "keys") {
      return meta[m] = function() {
        self._tk(meta, I);
        const it = fn.call(t);
        return {
          [Symbol.iterator]() { return this; },
          next() {
            const n = it.next();
            if (n.done) return n;
            if (isMap) {
              if (m === "keys" || m === "values") return { done: false, value: self._wrap(n.value) };
              const [k, v] = n.value;
              return { done: false, value: [self._wrap(k), self._wrap(v)] };
            }
            return { done: false, value: self._wrap(n.value) };
          },
          return(v) { return it.return ? it.return(v) : { done: true, value: v }; }
        };
      };
    }

    if (m === "get") return meta[m] = k => { const rk = self.toRaw(k); self._tk(meta, rk); return self._wrap(fn.call(t, rk)); };
    if (m === "has") return meta[m] = k => { const rk = self.toRaw(k); self._tk(meta, rk); return fn.call(t, rk); };
    if (m === "forEach") return meta[m] = function(cb, ctx) { self._tk(meta, I); fn.call(t, (v, k) => cb.call(ctx, self._wrap(v), self._wrap(k), meta.p)); };

    if (m === "set") return meta[m] = function(k, v) {
      const rk = self.toRaw(k), rv = self.toRaw(v), had = t.has(rk), old = had ? t.get(rk) : undefined;
      fn.call(t, rk, rv);
      if (!had || !Object.is(old, rv)) {
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rk); ks.add(I);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); }
            catch (err) { console.error("Reflex: Error flushing pending triggers:", err); }
          }
        }
      }
      return meta.p;
    };

    if (m === "add") return meta[m] = function(v) {
      const rv = self.toRaw(v);
      if (!t.has(rv)) {
        fn.call(t, rv);
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rv); ks.add(I);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); }
            catch (err) { console.error("Reflex: Error flushing pending triggers:", err); }
          }
        }
      }
      return meta.p;
    };

    if (m === "delete") return meta[m] = k => {
      const rk = self.toRaw(k), had = t.has(rk), res = fn.call(t, rk);
      if (had) {
        self._b++;
        try {
          let ks = self._pt.get(meta);
          if (!ks) self._pt.set(meta, ks = new Set());
          ks.add(rk); ks.add(I);
        } finally {
          if (--self._b === 0) {
            try { self._fpt(); }
            catch (err) { console.error("Reflex: Error flushing pending triggers:", err); }
          }
        }
      }
      return res;
    };

    if (m === "clear") return meta[m] = () => {
      if (!t.size) return;
      self._b++;
      try {
        let ks = self._pt.get(meta);
        if (!ks) self._pt.set(meta, ks = new Set());
        t.forEach((_, k) => ks.add(k)); ks.add(I);
        fn.call(t);
      } finally {
        if (--self._b === 0) {
          try { self._fpt(); }
          catch (err) { console.error("Reflex: Error flushing pending triggers:", err); }
        }
      }
    };

    return meta[m] = function() { self._tk(meta, I); return fn.call(t); };
  }

  // === SCHEDULER ===
  _ef(fn, o = {}) {
    const self = this;
    const e = () => {
      if (!(e.f & A)) return;
      self._cln_eff(e);
      self._es.push(self._e);
      self._e = e;
      e.f |= R;
      try { return fn(); }
      finally { e.f &= ~R; self._e = self._es.pop(); }
    };
    e.f = A; e.d = []; e.s = o.sched || null;
    e.kill = () => { self._cln_eff(e); e.f = 0; };
    if (!o.lazy) e();
    return e;
  }

  _cln_eff(e) {
    for (let i = 0; i < e.d.length; i++) e.d[i].delete(e);
    e.d.length = 0;
  }

  // Optimization: Use Q flag instead of Set.has() for deduplication
  // Checking a property is faster than Set.has() in hot paths
  _qj(j) {
    if (j.f & Q) return; // Already queued
    j.f |= Q;            // Mark as queued
    this._q.push(j);
    if (!this._p) { this._p = true; queueMicrotask(() => this._fl()); }
  }

  _fl() {
    this._p = false;
    const q = this._q;
    this._q = [];
    for (let i = 0; i < q.length; i++) {
      const j = q[i];
      j.f &= ~Q; // Clear queued flag before running
      try { j(); }
      catch (err) { console.error("Reflex: Error during flush:", err); }
    }
  }

  // === LIFECYCLE ===
  _reg(node, fn) { (node[CLEAN] || (node[CLEAN] = [])).push(fn); }

  _kill(node) {
    const c = node[CLEAN];
    if (c) {
      for (let i = 0; i < c.length; i++) try { c[i](); } catch {}
      node[CLEAN] = null;
    }
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) this._kill(ch);
  }

  // === COMPILER & WALKER ===
  // Note: Recursive walking is intentionally used over TreeWalker because:
  // 1. It allows efficient subtree skipping for m-ignore, m-for, m-if
  // 2. TreeWalker forces visiting every node even if we want to skip
  // 3. Benchmarks show recursion is faster when skipping is needed
  _w(n, o) {
    let c = n.firstChild;
    while (c) {
      const next = c.nextSibling;
      const nt = c.nodeType;
      // Element node (1)
      if (nt === 1) {
        // Single getAttribute call is faster than multiple hasAttribute checks
        const mIgnore = c.getAttribute("m-ignore");
        if (mIgnore === null) {
          const tag = c.tagName;
          if (tag === "TEMPLATE") {
            // Skip templates
          } else {
            const mIf = c.getAttribute("m-if");
            if (mIf !== null) {
              this._dir_if(c, o);
            } else {
              const mFor = c.getAttribute("m-for");
              if (mFor !== null) {
                this._dir_for(c, o);
              } else {
                const t = tag.toLowerCase();
                if (this._cp.has(t)) {
                  this._comp(c, t, o);
                } else {
                  this._bnd(c, o);
                  this._w(c, o);
                }
              }
            }
          }
        }
      }
      // Text node (3) with interpolation
      else if (nt === 3) {
        const nv = c.nodeValue;
        if (nv && nv.indexOf("{{") !== -1) {
          this._txt(c, o);
        }
      }
      c = next;
    }
  }

  _bnd(n, o) {
    const atts = n.attributes;
    if (!atts) return;
    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;
      if (nm.startsWith(":")) this._at(n, nm.slice(1), v, o);
      else if (nm.startsWith("@")) this._ev(n, nm.slice(1), v, o);
      else if (nm.startsWith("m-")) {
        if (nm === "m-model") this._mod(n, v, o);
        else if (nm === "m-text") this._at(n, "textContent", v, o);
        else if (nm === "m-html") this._html(n, v, o);
        else if (nm === "m-show") this._show(n, v, o);
      }
    }
  }

  _dir_if(el, o) {
    const fn = this._fn(el.getAttribute("m-if"));
    const cm = document.createComment("if");
    el.replaceWith(cm);
    let cur;

    const e = this._ef(() => {
      const ok = !!fn(this.s, o);
      if (ok && !cur) {
        cur = el.cloneNode(true); cur.removeAttribute("m-if");
        cm.after(cur); this._bnd(cur, o); this._w(cur, o);
      } else if (!ok && cur) {
        this._kill(cur); cur.remove(); cur = null;
      }
    });
    this._reg(cm, e.kill);
  }

  _dir_for(el, o) {
    const ex = el.getAttribute("m-for");
    const kAttr = el.getAttribute("m-key");
    const match = ex.match(/^\s*(.*?)\s+in\s+(.*$)/);
    if (!match) return;

    const [_, l, r] = match;
    const parts = l.replace(/[()]/g, "").split(",").map(s => s.trim());
    const alias = parts[0], idxAlias = parts[1];
    const listFn = this._fn(r);
    const keyIsProp = !!kAttr && /^[a-zA-Z_$][\w$]*$/.test(kAttr);
    const keyFn = (!kAttr || keyIsProp) ? null : this._fn(kAttr);

    const cm = document.createComment("for");
    el.replaceWith(cm);
    const tpl = el.cloneNode(true);
    tpl.removeAttribute("m-for"); tpl.removeAttribute("m-key");

    let rows = new Map();

    const eff = this._ef(() => {
      const list = listFn(this.s, o) || [];
      const listMeta = list[M] || this._mf.get(list);
      if (listMeta) this._tk(listMeta, I);

      const raw = Array.isArray(list) ? this.toRaw(list) : Array.from(list);
      const next = new Map();
      let after = cm;

      for (let i = 0; i < raw.length; i++) {
        let item = raw[i];
        if (item !== null && typeof item === "object" && !item[S]) item = this._r(item);
        const sc = Object.create(o || {});
        sc[alias] = item;
        if (idxAlias) sc[idxAlias] = i;

        const key = kAttr ? (keyIsProp ? (item && item[kAttr]) : keyFn(this.s, sc)) : i;
        let node = rows.get(key);

        if (!node) {
          node = tpl.cloneNode(true);
          node._sc = this._r(sc);
          this._bnd(node, node._sc); this._w(node, node._sc);
        } else {
          const p = node._sc;
          p[alias] = item;
          if (idxAlias) p[idxAlias] = i;
          rows.delete(key);
        }
        if (after.nextSibling !== node) after.after(node);
        next.set(key, node); after = node;
      }
      rows.forEach(n => { this._kill(n); n.remove(); });
      rows = next;
    });
    this._reg(cm, () => { rows.forEach(n => this._kill(n)); eff.kill(); });
  }

  _txt(n, o) {
    const raw = n.nodeValue;
    if (raw.startsWith("{{") && raw.endsWith("}}") && raw.indexOf("{{", 2) < 0) {
      const fn = this._fn(raw.slice(2, -2));
      let prev;
      const e = this._ef(() => {
        const v = fn(this.s, o);
        const next = v == null ? "" : String(v);
        if (next !== prev) { prev = next; n.nodeValue = next; }
      });
      this._reg(n, e.kill);
      return;
    }
    const pts = raw.split(/(\{\{.*?\}\})/g).map(x => x.startsWith("{{") ? this._fn(x.slice(2, -2)) : x);
    let prev;
    const e = this._ef(() => {
      let out = "";
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        out += typeof p === "function" ? (p(this.s, o) ?? "") : p;
      }
      if (out !== prev) { prev = out; n.nodeValue = out; }
    });
    this._reg(n, e.kill);
  }

  _at(el, att, exp, o) {
    const fn = this._fn(exp);
    let prev;
    // FIX #5: Attributes that can execute JavaScript via protocol handlers
    const isUrlAttr = att === "href" || att === "src" || att === "action" || att === "formaction" || att === "xlink:href";
    const e = this._ef(() => {
      let v = fn(this.s, o);
      // FIX #5: Validate URL protocols to prevent javascript:, vbscript:, data: XSS
      if (isUrlAttr && v != null && typeof v === "string" && UNSAFE_URL_RE.test(v)) {
        console.warn("Reflex: Blocked unsafe URL protocol in", att + ":", v);
        v = "about:blank";
      }
      if (att === "class") {
        const next = this._cls(v);
        if (next !== prev) { prev = next; el.className = next; }
      } else if (att === "style") {
        const next = this._sty(v);
        if (next !== prev) { prev = next; el.style.cssText = next; }
      } else if (att in el) {
        el[att] = v ?? "";
      } else {
        const next = v === null || v === false ? null : String(v);
        if (next !== prev) { prev = next; next === null ? el.removeAttribute(att) : el.setAttribute(att, next); }
      }
    });
    this._reg(el, e.kill);
  }

  _html(el, exp, o) {
    const fn = this._fn(exp);
    let prev;
    const e = this._ef(() => {
      const v = fn(this.s, o);
      let html = v == null ? "" : String(v);
      // FIX #2: Always sanitize when cfg.sanitize is true; escape HTML if DOMPurify unavailable
      if (this.cfg.sanitize) {
        if (typeof DOMPurify !== "undefined") {
          html = DOMPurify.sanitize(html);
        } else {
          // Fallback: escape HTML entities to prevent XSS when DOMPurify is not available
          html = escapeHTML(html);
          console.warn("Reflex: DOMPurify not loaded. HTML content escaped for safety. Load DOMPurify for proper sanitization.");
        }
      }
      if (html !== prev) { prev = html; el.innerHTML = html; }
    });
    this._reg(el, e.kill);
  }

  _show(el, exp, o) {
    const fn = this._fn(exp);
    const d = el.style.display === "none" ? "" : el.style.display;
    let prev;
    const e = this._ef(() => {
      const next = fn(this.s, o) ? d : "none";
      if (next !== prev) { prev = next; el.style.display = next; }
    });
    this._reg(el, e.kill);
  }

  _mod(el, exp, o) {
    const fn = this._fn(exp);
    const type = (el.type || "").toLowerCase(), isChk = type === "checkbox", isNum = type === "number" || type === "range";
    const e = this._ef(() => {
      const v = fn(this.s, o);
      if (isChk) el.checked = !!v;
      else { const next = v == null ? "" : String(v); if (el.value !== next) el.value = next; }
    });
    this._reg(el, e.kill);

    const up = () => {
      let v;
      if (isChk) v = el.checked;
      else if (isNum) v = el.value === "" ? null : parseFloat(el.value);
      else v = el.value;
      const paths = exp.split("."), end = paths.pop();
      // FIX #3: Prevent prototype pollution by blocking dangerous property names
      if (UNSAFE_PROPS[end]) {
        console.warn("Reflex: Blocked attempt to set unsafe property:", end);
        return;
      }
      let t = o && paths[0] in o ? o : this.s;
      for (const p of paths) {
        // FIX #3: Block prototype pollution via path segments
        if (UNSAFE_PROPS[p]) {
          console.warn("Reflex: Blocked attempt to traverse unsafe property:", p);
          return;
        }
        // FIX #6: Check if intermediate value is an object before traversing
        if (t[p] == null) t[p] = {};
        else if (typeof t[p] !== "object") {
          console.warn("Reflex: Cannot set nested property on non-object value at path:", p);
          return;
        }
        t = t[p];
      }
      t[end] = v;
    };
    const evt = isChk || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(evt, up);
    if (evt !== "change") el.addEventListener("change", up);
    this._reg(el, () => { el.removeEventListener(evt, up); el.removeEventListener("change", up); });
  }

  _ev(el, evt, exp, o) {
    const [nm, ...mod] = evt.split(".");
    if (!this._dh.has(nm)) {
      this._dh.set(nm, new WeakMap());
      this._dr.addEventListener(nm, e => this._hdl(e, nm));
    }
    this._dh.get(nm).set(el, { f: this._fn(exp, true), o, m: mod });
  }

  _hdl(e, nm) {
    let t = e.target;
    while (t && t !== this._dr) {
      const h = this._dh.get(nm)?.get(t);
      if (h) {
        const { f, o, m } = h;
        if (m.includes("self") && e.target !== t) { t = t.parentNode; continue; }
        if (m.includes("prevent")) e.preventDefault();
        if (m.includes("stop")) e.stopPropagation();
        f(this.s, o, e);
        if (m.includes("once")) this._dh.get(nm).delete(t);
        if (e.cancelBubble) return;
      }
      t = t.parentNode;
    }
  }

  _fn(exp, isH) {
    const k = (isH ? "H:" : "") + exp;
    const cached = this._ec.get(k);
    if (cached) return cached;

    // FIX #4: Block dangerous expression patterns that could bypass reserved word checks
    if (UNSAFE_EXPR_RE.test(exp)) {
      console.warn("Reflex: Blocked potentially unsafe expression:", exp);
      return this._ec.set(k, () => undefined);
    }

    // === FAST PATH OPTIMIZATIONS ===
    // Skip new Function/regex for common simple expressions (80%+ of real-world cases)

    // Fast path 1: Simple negation (!isActive, !user.verified)
    if (!isH && exp.charCodeAt(0) === 33 && /^![a-z_$][\w$.]*$/i.test(exp)) {
      const inner = exp.slice(1);
      const p = inner.split(".");
      for (const seg of p) {
        if (UNSAFE_PROPS[seg]) {
          console.warn("Reflex: Blocked access to unsafe property:", seg);
          return this._ec.set(k, () => undefined);
        }
      }
      const self = this;
      return this._ec.set(k, (s, o) => {
        if (o) { const meta = o[M] || self._mf.get(o); if (meta) self._tk(meta, p[0]); }
        let v = (o && p[0] in o) ? o : s;
        for (const pk of p) { if (v == null) return true; v = v[pk]; }
        return !v;
      });
    }

    // Fast path 2: Simple property path (count, user.name, user.profile.avatar)
    if (!isH && /^[a-z_$][\w$.]*$/i.test(exp)) {
      const p = exp.split(".");
      for (const seg of p) {
        if (UNSAFE_PROPS[seg]) {
          console.warn("Reflex: Blocked access to unsafe property:", seg);
          return this._ec.set(k, () => undefined);
        }
      }
      const self = this;
      // Optimization: specialize for single-segment paths (most common)
      if (p.length === 1) {
        const key = p[0];
        return this._ec.set(k, (s, o) => {
          if (o) { const meta = o[M] || self._mf.get(o); if (meta) self._tk(meta, key); }
          return (o && key in o) ? o[key] : s[key];
        });
      }
      return this._ec.set(k, (s, o) => {
        if (o) { const meta = o[M] || self._mf.get(o); if (meta) self._tk(meta, p[0]); }
        let v = (o && p[0] in o) ? o : s;
        for (const pk of p) { if (v == null) return; v = v[pk]; }
        return v;
      });
    }

    // Fast path 3: Simple array access with numeric literal (items[0], users[1].name)
    const arrMatch = !isH && /^([a-z_$][\w$]*)\[(\d+)\](\.[\w$.]+)?$/i.exec(exp);
    if (arrMatch) {
      const arrName = arrMatch[1], idx = parseInt(arrMatch[2], 10), rest = arrMatch[3];
      if (UNSAFE_PROPS[arrName]) {
        console.warn("Reflex: Blocked access to unsafe property:", arrName);
        return this._ec.set(k, () => undefined);
      }
      const restParts = rest ? rest.slice(1).split(".") : null;
      if (restParts) {
        for (const seg of restParts) {
          if (UNSAFE_PROPS[seg]) {
            console.warn("Reflex: Blocked access to unsafe property:", seg);
            return this._ec.set(k, () => undefined);
          }
        }
      }
      const self = this;
      return this._ec.set(k, (s, o) => {
        if (o) { const meta = o[M] || self._mf.get(o); if (meta) self._tk(meta, arrName); }
        let arr = (o && arrName in o) ? o[arrName] : s[arrName];
        if (arr == null) return;
        let v = arr[idx];
        if (restParts) {
          for (const pk of restParts) { if (v == null) return; v = v[pk]; }
        }
        return v;
      });
    }

    // CSP-safe mode: use external parser (must be injected via configure)
    if (this.cfg.cspSafe) {
      try {
        // Parser must implement compile(exp, reflex) => (state, context, $event) => result
        const fn = this._getParser().compile(exp, this);
        return this._ec.set(k, fn);
      } catch (err) {
        console.warn("Reflex: CSP-safe compile error:", exp, err);
        return this._ec.set(k, () => undefined);
      }
    }

    // Standard mode: use new Function (faster but requires unsafe-eval CSP)
    const vars = new Set();
    let m; ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(exp))) !RES[m[1]] && vars.add(m[1]);

    const arg = Array.from(vars).map(v =>
      `var ${v}=(c&&(${JSON.stringify(v)} in c))?c.${v}:s.${v};`
    ).join("");
    const body = isH ? `${arg}${exp};` : `${arg}return(${exp});`;

    try { return this._ec.set(k, new Function("s", "c", "$event", body)); }
    catch (err) { console.warn("Reflex compile error:", exp, err); return this._ec.set(k, () => undefined); }
  }

  _trv(v, s = new Set()) {
    if (v === null || typeof v !== "object" || s.has(v)) return;
    s.add(v);
    const meta = v[M] || this._mf.get(v);
    if (meta) this._tk(meta, I);
    if (Array.isArray(v)) for (const i of v) this._trv(i, s);
    else if (v instanceof Map || v instanceof Set) v.forEach(x => this._trv(x, s));
    else for (const k in v) this._trv(v[k], s);
  }

  _clone(v, seen = new Map()) {
    v = this.toRaw(v);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return seen.get(v);
    if (v instanceof Date) return new Date(v);
    if (v instanceof RegExp) return new RegExp(v.source, v.flags);
    if (v instanceof Map) {
      const o = new Map(); seen.set(v, o);
      v.forEach((val, key) => o.set(key, this._clone(val, seen)));
      return o;
    }
    if (v instanceof Set) {
      const o = new Set(); seen.set(v, o);
      v.forEach(val => o.add(this._clone(val, seen)));
      return o;
    }
    if (Array.isArray(v)) {
      const o = []; seen.set(v, o);
      for (let i = 0; i < v.length; i++) o[i] = this._clone(v[i], seen);
      return o;
    }
    const o = {}; seen.set(v, o);
    for (const k in v) o[k] = this._clone(v[k], seen);
    return o;
  }

  _cls(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(x => this._cls(x)).filter(Boolean).join(" ");
    if (typeof v === "object") return Object.keys(v).filter(k => v[k]).join(" ");
    return String(v);
  }

  _sty(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      let s = "";
      for (const k in v) { const val = v[k]; if (val != null && val !== false) s += k + ":" + val + ";"; }
      return s;
    }
    return String(v);
  }

  _comp(el, tag, o) {
    const def = this._cp.get(tag);
    const inst = def._t.cloneNode(true);
    const props = this._r({});
    const propDefs = [];
    const hostHandlers = Object.create(null);

    const attrs = Array.from(el.attributes);
    for (const a of attrs) {
      const n = a.name, v = a.value;
      if (n.startsWith("@")) hostHandlers[n.slice(1)] = this._fn(v, true);
      else if (n.startsWith(":")) propDefs.push({ name: n.slice(1), exp: v });
      else props[n] = v;
    }

    for (const pd of propDefs) props[pd.name] = this._fn(pd.exp)(this.s, o);

    const emit = (event, detail) => {
      inst.dispatchEvent(new CustomEvent(event, { detail, bubbles: true }));
      const h = hostHandlers[event];
      if (h) h(this.s, o, detail);
    };

    const scopeRaw = Object.create(props);
    scopeRaw.$props = props;
    scopeRaw.$emit = emit;

    if (def.s) {
      const result = def.s(props, { emit, props, slots: {} });
      if (result && typeof result === "object") {
        for (const k in result) {
          scopeRaw[k] = (result[k] !== null && typeof result[k] === "object") ? this._r(result[k]) : result[k];
        }
      }
    }

    const scope = this._r(scopeRaw);
    el.replaceWith(inst);

    for (const pd of propDefs) {
      const fn = this._fn(pd.exp);
      const e = this._ef(() => { props[pd.name] = fn(this.s, o); });
      this._reg(inst, e.kill);
    }

    this._bnd(inst, scope);
    this._w(inst, scope);
  }
}

typeof module !== "undefined" ? module.exports = Reflex : window.Reflex = Reflex;
