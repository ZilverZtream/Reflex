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
  declare _acp: Map<string, any>;  // Async component factories
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
    onError: ((err: any) => void) | null;
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
    this._acp = new Map();    // Async Component Factories
    this._cd = new Map();     // Custom Directives
    this._refs = {};          // $refs registry
    this._parser = null;      // CSP parser (lazy-loaded)
    this._plugins = new Set(); // Installed plugins (per-instance)

    // === CONFIGURATION ===
    this.cfg = {
      sanitize: true,         // Sanitize HTML content
      cspSafe: false,         // CSP-safe mode (no new Function)
      cacheSize: 1000,        // Expression cache size
      onError: null           // Global error handler
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
   * @param {Function} opts.onError - Global error handler
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
    if (opts.onError !== undefined) this.cfg.onError = opts.onError;
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
   * Supports both synchronous and asynchronous component definitions:
   * - Sync: app.component('name', { template: '...', setup: ... })
   * - Async: app.component('name', () => import('./Component.js'))
   *
   * Async components support a fallback placeholder that displays while loading.
   *
   * @param {string} name - Component tag name
   * @param {Object|Function} def - Component definition or async factory
   * @param {string} def.template - HTML template (sync only)
   * @param {string[]} def.props - Prop names
   * @param {Function} def.setup - Setup function
   * @param {string} def.fallback - Fallback template for async components
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Synchronous component
   * app.component('my-button', {
   *   template: '<button>{{ label }}</button>',
   *   props: ['label']
   * });
   *
   * @example
   * // Async component with dynamic import
   * app.component('heavy-chart', () => import('./HeavyChart.js'));
   *
   * @example
   * // Async component with fallback
   * app.component('lazy-modal', () => import('./Modal.js'), {
   *   fallback: '<div class="loading">Loading...</div>'
   * });
   */
  component(n, def, opts?) {
    const name = n.toLowerCase();

    // Async component: factory function that returns a Promise
    if (typeof def === 'function') {
      this._acp.set(name, {
        factory: def,
        fallback: opts?.fallback || null,
        resolved: null,  // Cache resolved definition
        pending: null    // Shared pending Promise
      });
      return this;
    }

    // Sync component: standard definition object
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
    this._cp.set(name, {
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
   * @returns The component instance element (for use in m-for etc.)
   */
  _comp(el: Element, tag: string, o: any): Element {
    const def = this._cp.get(tag);
    const inst = def._t.cloneNode(true) as Element;
    const props = this._r({});
    const propDefs = [];
    const hostHandlers = Object.create(null);
    const self = this;

    // Collect cleanup functions registered via onCleanup
    const cleanupFns: Array<() => void> = [];

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

    /**
     * Register a cleanup callback that will be called when the component is unmounted.
     * This is essential for cleaning up:
     * - setInterval / setTimeout
     * - window.addEventListener / document.addEventListener
     * - WebSocket connections
     * - Third-party library subscriptions
     *
     * @param fn - Cleanup function to call on unmount
     *
     * @example
     * setup(props, { onCleanup }) {
     *   const timer = setInterval(() => console.log('tick'), 1000);
     *   onCleanup(() => clearInterval(timer));
     *
     *   const handleResize = () => { ... };
     *   window.addEventListener('resize', handleResize);
     *   onCleanup(() => window.removeEventListener('resize', handleResize));
     * }
     */
    const onCleanup = (fn: () => void) => {
      if (typeof fn === 'function') {
        cleanupFns.push(fn);
      }
    };

    const scopeRaw = Object.create(props);
    scopeRaw.$props = props;
    scopeRaw.$emit = emit;

    if (def.s) {
      const result = def.s(props, { emit, props, slots: {}, onCleanup });
      if (result && typeof result === 'object') {
        for (const k in result) {
          scopeRaw[k] = (result[k] !== null && typeof result[k] === 'object')
            ? this._r(result[k])
            : result[k];
        }
      }
    }
    if (typeof scopeRaw.catchError !== 'function' && typeof def.catchError === 'function') {
      scopeRaw.catchError = def.catchError;
    }

    const scope = this._r(scopeRaw);
    el.replaceWith(inst);

    // Register all cleanup functions on the component instance
    if (cleanupFns.length > 0) {
      this._reg(inst, () => {
        for (const fn of cleanupFns) {
          try {
            fn();
          } catch (err) {
            console.warn('Reflex: Error in component cleanup:', err);
          }
        }
      });
    }

    for (const pd of propDefs) {
      const fn = this._fn(pd.exp);
      const e = this._ef(() => { props[pd.name] = fn(this.s, o); });
      e.o = o;
      this._reg(inst, e.kill);
    }

    this._bnd(inst, scope);
    this._w(inst, scope);

    return inst;
  }

  /**
   * Async component rendering with Suspense support.
   *
   * This method is only called when an async component is actually used,
   * keeping the runtime minimal for apps that don't use code-splitting.
   *
   * The flow:
   * 1. Show fallback placeholder (if defined) or a comment marker
   * 2. Load the component via its factory function
   * 3. Cache the resolved definition for future instances
   * 4. Swap the placeholder with the real component
   *
   * @param el - The element placeholder in the DOM
   * @param tag - Component tag name (lowercase)
   * @param o - Parent scope
   */
  _asyncComp(el: Element, tag: string, o: any) {
    const asyncDef = this._acp.get(tag);
    const self = this;

    // Capture attributes before replacing element
    const savedAttrs: { name: string; value: string }[] = [];
    const attrs = Array.from(el.attributes) as Attr[];
    for (const a of attrs) {
      savedAttrs.push({ name: a.name, value: a.value });
    }

    // Create a marker comment and optional fallback
    const marker = document.createComment(`async:${tag}`);
    let fallbackNode: Element | null = null;

    if (asyncDef.fallback) {
      // Render fallback template
      const fallbackTpl = document.createElement('template');
      let fallbackHtml = asyncDef.fallback;

      if (this.cfg.sanitize && typeof DOMPurify !== 'undefined') {
        fallbackHtml = DOMPurify.sanitize(fallbackHtml, {
          RETURN_DOM_FRAGMENT: false,
          WHOLE_DOCUMENT: false
        });
      }

      fallbackTpl.innerHTML = fallbackHtml;
      fallbackNode = fallbackTpl.content.firstElementChild?.cloneNode(true) as Element;
    }

    // Track if this async component has been aborted
    let aborted = false;

    // Replace element with marker (and fallback if present)
    if (fallbackNode) {
      el.replaceWith(marker, fallbackNode);
      // Bind the fallback so it can use reactive expressions
      this._bnd(fallbackNode, o);
      this._w(fallbackNode, o);
    } else {
      el.replaceWith(marker);
    }

    // Register cleanup for the marker - if parent is destroyed, abort loading
    this._reg(marker, () => {
      aborted = true;
      if (fallbackNode && fallbackNode.isConnected) {
        self._kill(fallbackNode);
        fallbackNode.remove();
      }
    });

    // Function to mount the real component once loaded
    const mountComponent = (def) => {
      // Security: Check if marker is still connected to the DOM or aborted
      // This prevents "zombie effects" when parent is destroyed while loading
      if (aborted || !marker.isConnected) {
        // Parent was destroyed while we were loading - don't mount
        // Clean up fallback if it exists
        if (fallbackNode && fallbackNode.isConnected) {
          self._kill(fallbackNode);
          fallbackNode.remove();
        }
        return;
      }

      // Create a temporary element with saved attributes
      const tempEl = document.createElement(tag);
      for (const attr of savedAttrs) {
        tempEl.setAttribute(attr.name, attr.value);
      }

      // Register the resolved component in the sync map
      const t = document.createElement('template');
      let template = def.template;

      if (self.cfg.sanitize && typeof DOMPurify !== 'undefined') {
        template = DOMPurify.sanitize(template, {
          RETURN_DOM_FRAGMENT: false,
          WHOLE_DOCUMENT: false
        });
      }

      t.innerHTML = template;
      self._cp.set(tag, {
        _t: t.content.firstElementChild,
        p: def.props || [],
        s: def.setup
      });

      // Remove fallback if present
      if (fallbackNode && fallbackNode.parentNode) {
        self._kill(fallbackNode);
        fallbackNode.remove();
      }

      // Insert temporary element after marker
      marker.after(tempEl);

      // Now render the real component (this will replace tempEl)
      self._comp(tempEl, tag, o);

      // Clean up marker
      marker.remove();
    };

    // Check if already resolved (cached)
    if (asyncDef.resolved) {
      // Already loaded, mount immediately
      mountComponent(asyncDef.resolved);
      return;
    }

    // Check if already loading (shared promise)
    if (asyncDef.pending) {
      asyncDef.pending.then(mountComponent).catch(err => {
        this._handleError(err, o);
      });
      return;
    }

    // Start loading the component
    asyncDef.pending = asyncDef.factory()
      .then(module => {
        // Support both default export and named export
        const def = module.default || module;
        asyncDef.resolved = def;
        asyncDef.pending = null;
        return def;
      });

    asyncDef.pending
      .then(mountComponent)
      .catch(err => {
        asyncDef.pending = null;
        // Remove fallback on error
        if (fallbackNode && fallbackNode.parentNode) {
          self._kill(fallbackNode);
          fallbackNode.remove();
        }
        this._handleError(err, o);
      });
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
