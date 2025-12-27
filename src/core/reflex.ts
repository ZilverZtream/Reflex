/**
 * Reflex Core - Main Class
 *
 * The Direct Reactive Engine
 * Zero Dependencies, Zero Build, Zero VDOM
 *
 * This module assembles the Reflex class from its constituent mixins:
 * - ReactivityMixin: Proxy-based reactivity system
 * - SchedulerMixin: Effect system and job scheduling
 * - ExprMixin: Expression compilation
 * - CompilerMixin: DOM walking and directive processing
 *
 * Supports an opt-in plugin system via app.use(Plugin) for tree-shakable
 * extensions like hydration, SSR, and custom features.
 */

// Symbols are used by mixins, not directly in this file
import { ReactivityMixin } from './reactivity.js';
import { SchedulerMixin } from './scheduler.js';
import { ExprMixin, ExprCache } from './expr.js';
import { CompilerMixin } from './compiler.js';

type ReactivityMixinType = typeof ReactivityMixin;
type SchedulerMixinType = typeof SchedulerMixin;
type ExprMixinType = typeof ExprMixin;
type CompilerMixinType = typeof CompilerMixin;


/**
 * Reflex - The Direct Reactive Engine
 *
 * A lightweight, zero-dependency reactive framework that compiles
 * templates directly to DOM operations without a virtual DOM.
 *
 * @example
 * const app = new Reflex({
 *   count: 0,
 *   items: ['a', 'b', 'c']
 * });
 *
 * // Access reactive state
 * app.s.count++;
 *
 * // Configure CSP-safe mode
 * app.configure({ cspSafe: true, parser: new SafeExprParser() });
 */
export class Reflex {
  declare s: any;
  declare _e: any;
  declare _es: any[];
  declare _q: any[];
  declare _qb: any[];
  declare _qf: boolean;
  declare _p: boolean;
  declare _b: number;
  declare _pt: Map<any, Set<any>>;
  declare _ec: ExprCache;
  declare _mf: WeakMap<object, any>;
  declare _cl: WeakMap<Node, Array<() => void>>;
  declare _scopeMap: WeakMap<Node, any>;
  declare _dh: Map<any, any>;
  declare _dr: Element | null;
  declare _cp: Map<string, any>;
  declare _cd: Map<string, any>;
  declare _refs: Record<string, any>;
  declare _parser: any;
  declare _plugins: Set<any>;
  declare _hydrateMode?: boolean;
  declare hydrate?: (el?: Element | null) => this;
  declare _hydrateWalk?: (node: Node, scope: any) => void;
  declare _hydrateNode?: (node: Element, scope: any) => void;
  declare _hydrateText?: (node: Node, scope: any) => void;
  declare _hydrateIf?: (node: Element, scope: any) => void;
  declare _hydrateFor?: (node: Element, scope: any) => void;
  declare _dtRegister?: () => void;
  declare _dtEmit?: (event: string, payload: any) => void;
  declare customMethod?: (...args: any[]) => any;
  declare cfg: {
    sanitize: boolean;
    cspSafe: boolean;
    cacheSize: number;
  };

  constructor(init = {}) {
    // === STATE ===
    this.s = null;            // Reactive state

    // === EFFECT SYSTEM ===
    this._e = null;           // Active Effect
    this._es = [];            // Effect Stack
    this._q = [];             // Job Queue (uses QUEUED flag for dedup)
    this._qb = [];            // Secondary Job Queue (double-buffer)
    this._qf = false;         // Which queue is active
    this._p = false;          // Flush Pending
    this._b = 0;              // Batch Depth
    this._pt = new Map();     // Pending Triggers (for batching)

    // === CACHES ===
    this._ec = new ExprCache(1000);  // Expression Cache (FIFO eviction)
    this._mf = new WeakMap();        // Meta Fallback (non-extensible objects)

    // === DOM ===
    this._cl = new WeakMap();        // Cleanup registry (lifecycle hooks)
    this._scopeMap = new WeakMap();  // Node -> Scope mapping (replaces node._sc)
    this._dh = new Map();            // Delegated event Handlers
    this._dr = null;                 // DOM Root

    // === EXTENSIONS ===
    this._cp = new Map();     // Component Definitions
    this._cd = new Map();     // Custom Directives
    this._refs = {};          // $refs registry
    this._parser = null;      // CSP parser (lazy-loaded)
    this._plugins = new Set(); // Installed plugins (per-instance)

    // === CONFIGURATION ===
    this.cfg = {
      sanitize: true,         // Sanitize HTML content
      cspSafe: false,         // CSP-safe mode (no new Function)
      cacheSize: 1000         // Expression cache size
    };

    // Initialize reactive state
    this.s = this._r(init);

    // Auto-mount on DOM ready
    if (typeof document !== 'undefined') {
      const r = document.readyState;
      if (r === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.mount(), { once: true });
      } else {
        queueMicrotask(() => this.mount());
      }
    }
  }

  /**
   * Configure the Reflex instance.
   *
   * @param {Object} opts - Configuration options
   * @param {boolean} opts.sanitize - Enable HTML sanitization (default: true)
   * @param {boolean} opts.cspSafe - Enable CSP-safe mode (default: false)
   * @param {number} opts.cacheSize - Expression cache size (default: 1000)
   * @param {Object} opts.parser - CSP-safe expression parser instance
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Enable CSP-safe mode
   * app.configure({
   *   cspSafe: true,
   *   parser: new SafeExprParser()
   * });
   */
  configure(opts) {
    if (opts.sanitize !== undefined) this.cfg.sanitize = opts.sanitize;
    if (opts.cspSafe !== undefined) this.cfg.cspSafe = opts.cspSafe;
    if (opts.cacheSize !== undefined) {
      this.cfg.cacheSize = opts.cacheSize;
      this._ec = new ExprCache(opts.cacheSize);
    }
    if (opts.parser !== undefined) this._parser = opts.parser;
    return this;
  }

  /**
   * Mount the application to a DOM element.
   *
   * @param {Element} el - Root element (default: document.body)
   * @returns {Reflex} This instance for chaining
   */
  mount(el = document.body) {
    this._dr = el;
    this._bnd(el, null);
    this._w(el, null);
    if (process.env.NODE_ENV !== 'production') {
      this._dtRegister();
    }
    return this;
  }

  /**
   * Register a component definition.
   *
   * @param {string} name - Component tag name
   * @param {Object} def - Component definition
   * @param {string} def.template - HTML template
   * @param {string[]} def.props - Prop names
   * @param {Function} def.setup - Setup function
   * @returns {Reflex} This instance for chaining
   */
  component(n, def) {
    const t = document.createElement('template');
    let template = def.template;

    if (this.cfg.sanitize) {
      if (typeof DOMPurify !== 'undefined') {
        template = DOMPurify.sanitize(template, {
          RETURN_DOM_FRAGMENT: false,
          WHOLE_DOCUMENT: false
        });
      } else {
        console.warn(
          'Reflex: DOMPurify not loaded. Component templates should be trusted ' +
          'or load DOMPurify for sanitization.'
        );
      }
    }

    t.innerHTML = template;
    this._cp.set(n.toLowerCase(), {
      _t: t.content.firstElementChild,
      p: def.props || [],
      s: def.setup
    });
    return this;
  }

  /**
   * Register a custom directive.
   *
   * @param {string} name - Directive name (without m- prefix)
   * @param {Function} callback - Directive handler (el, binding, reflex) => cleanup?
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * app.directive('focus', (el, { value }) => {
   *   if (value) el.focus();
   * });
   */
  directive(name, callback) {
    this._cd.set(name.toLowerCase(), callback);
    return this;
  }

  /**
   * Install a plugin to extend Reflex functionality.
   *
   * Plugins provide a tree-shakable way to extend Reflex. If a plugin
   * is not imported, its code won't be included in the final bundle.
   *
   * A plugin can be:
   * - A function: Called with (Reflex instance, options)
   * - An object with install method: install(Reflex instance, options)
   * - An object with mixin property: Mixin methods merged into prototype
   *
   * @param {Function|Object} plugin - Plugin to install
   * @param {Object} options - Options passed to the plugin
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Function plugin
   * app.use((reflex, opts) => {
   *   reflex.customMethod = () => { ... };
   * });
   *
   * @example
   * // Object plugin with install method
   * app.use({
   *   install(reflex, opts) {
   *     reflex.directive('custom', () => { ... });
   *   }
   * });
   *
   * @example
   * // Mixin plugin (methods added to prototype)
   * import { withHydration } from 'reflex/hydration';
   * app.use(withHydration);
   */
  use(plugin, options) {
    // Skip if plugin already installed on this instance
    if (this._plugins.has(plugin)) {
      return this;
    }

    if (typeof plugin === 'function') {
      // Function plugin: call with instance and options
      plugin(this, options);
      this._plugins.add(plugin);
    } else if (plugin && typeof plugin === 'object') {
      if (typeof plugin.install === 'function') {
        // Object with install method
        plugin.install(this, options);
        this._plugins.add(plugin);
      } else if (plugin.mixin && typeof plugin.mixin === 'object') {
        // Mixin plugin: merge methods into instance
        Object.assign(this, plugin.mixin);
        if (plugin.init && typeof plugin.init === 'function') {
          plugin.init(this, options);
        }
        this._plugins.add(plugin);
      }
    }

    return this;
  }

  /**
   * Component rendering
   */
  _comp(el: Element, tag: string, o: any) {
    const def = this._cp.get(tag);
    const inst = def._t.cloneNode(true);
    const props = this._r({});
    const propDefs = [];
    const hostHandlers = Object.create(null);

    const attrs = Array.from(el.attributes) as Attr[];
    for (const a of attrs) {
      const n = a.name, v = a.value;
      if (n.startsWith('@')) hostHandlers[n.slice(1)] = this._fn(v, true);
      else if (n.startsWith(':')) propDefs.push({ name: n.slice(1), exp: v });
      else props[n] = v;
    }

    for (const pd of propDefs) {
      props[pd.name] = this._fn(pd.exp)(this.s, o);
    }

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
      if (result && typeof result === 'object') {
        for (const k in result) {
          scopeRaw[k] = (result[k] !== null && typeof result[k] === 'object')
            ? this._r(result[k])
            : result[k];
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

  // === LIFECYCLE ===

  /**
   * Register a cleanup function for a node.
   * Uses WeakMap to avoid modifying DOM nodes directly.
   */
  _reg(node, fn) {
    let arr = this._cl.get(node);
    if (!arr) this._cl.set(node, arr = []);
    arr.push(fn);
  }

  /**
   * Kill a node and all its descendants' cleanup functions.
   */
  _kill(node) {
    const c = this._cl.get(node);
    if (c) {
      for (let i = 0; i < c.length; i++) {
        try { c[i](); } catch {} // eslint-disable-line no-empty
      }
      this._cl.delete(node);
    }
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      this._kill(ch);
    }
  }
}

export interface Reflex extends ReactivityMixinType, SchedulerMixinType, ExprMixinType, CompilerMixinType {}

// Apply mixins to Reflex prototype
Object.assign(Reflex.prototype, ReactivityMixin);
Object.assign(Reflex.prototype, SchedulerMixin);
Object.assign(Reflex.prototype, ExprMixin);
Object.assign(Reflex.prototype, CompilerMixin);

if (process.env.NODE_ENV !== 'production') {
  Reflex.prototype._dtRegister = function() {
    if (typeof window === 'undefined') return;
    const hook = window.__REFLEX_DEVTOOLS_HOOK__;
    if (!hook || typeof hook !== 'object') return;
    const payload = { app: this, root: this._dr, state: this.s, components: this._cp };
    if (typeof hook.registerApp === 'function') {
      hook.registerApp(payload);
    } else if (Array.isArray(hook.apps)) {
      hook.apps.push(payload);
    }
  };

  Reflex.prototype._dtEmit = function(event, payload) {
    if (typeof window === 'undefined') return;
    const hook = window.__REFLEX_DEVTOOLS_HOOK__;
    if (!hook || typeof hook.emit !== 'function') return;
    hook.emit(event, payload);
  };
}
