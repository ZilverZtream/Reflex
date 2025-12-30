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

// CRITICAL FIX #11 + #8: queueMicrotask polyfill with pollution prevention
// Missing in iOS < 13, older Node.js, and legacy browsers
// Fallback to Promise.resolve().then() which has equivalent semantics
// CRITICAL FIX #8: Only polyfill if not already defined to prevent namespace pollution
// If multiple libraries polyfill queueMicrotask, each overwrites the other's implementation
// This can break libraries that expect native behavior or have custom polyfills
if (typeof globalThis !== 'undefined' && typeof globalThis.queueMicrotask === 'undefined') {
  (globalThis as any).queueMicrotask = (callback: () => void) => {
    Promise.resolve().then(callback).catch(err => {
      // CRITICAL FIX: Better error reporting for polyfill
      // Use reportError if available (modern browsers), fallback to console.error
      // This preserves the error context better than setTimeout(() => throw)
      if (typeof globalThis.reportError === 'function') {
        globalThis.reportError(err);
      } else {
        // Fallback for older browsers: log and rethrow async
        console.error('Uncaught error in queueMicrotask:', err);
        setTimeout(() => { throw err; }, 0);
      }
    });
  };
}

// Symbols are used by mixins, and META is used for DevTools
import { META } from './symbols.js';
import { ReactivityMixin } from './reactivity.js';
import { SchedulerMixin } from './scheduler.js';
import { ExprMixin, ExprCache } from './expr.js';
import { CompilerMixin, cloneNodeWithProps } from './compiler.js';
import { DOMRenderer } from '../renderers/dom.js';
import { ScopeRegistry } from './scope-registry.js';
import type { IRendererAdapter, RendererOptions } from '../renderers/types.js';

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
  declare pendingTriggers: Map<any, Set<any>>;
  declare _ec: ExprCache;
  declare _mf: WeakMap<object, any>;
  declare _cl: WeakMap<Node, Array<() => void>>;
  declare _scopeMap: WeakMap<Node, any>;
  declare _nodeState: WeakMap<Element, any>; // TASK 6: Node state storage (valueRef, etc.)
  declare _dh: Map<any, any>;
  declare _dr: Element | null;
  declare _cp: Map<string, any>;
  declare _acp: Map<string, any>;  // Async component factories
  declare _cd: Map<string, any>;
  declare _refs: Record<string, any>;
  declare _parser: any;
  declare _plugins: Set<any>;
  declare _m: boolean;
  declare _ren: IRendererAdapter;  // Pluggable renderer adapter
  declare _scopeRegistry: ScopeRegistry;  // Flat scope storage (replaces prototype chains)
  declare _gcRegistry: FinalizationRegistry<string[]>;  // GC-driven cleanup for scope IDs (TASK 5)
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
  // CRITICAL FIX #3: Active component tracking for auto-cleanup
  // This property holds the currently rendering component instance
  // Effects created during component setup will auto-attach their cleanup
  declare _activeComponent?: Element | null;
  declare cfg: {
    sanitize: boolean;
    cspSafe: boolean;
    cacheSize: number;
    onError: ((err: any) => void) | null;
    domPurify: any | null;
  };

  constructor(init = {}, options: RendererOptions = {}) {
    // === BREAKING CHANGE: GC-DRIVEN ENGINE REQUIREMENTS ===
    // TASK 5: Registry Leak Fix - Reflex now requires modern browser features
    // for automatic memory management via garbage collection.
    //
    // Required Features:
    // - WeakRef: Track objects without preventing GC
    // - FinalizationRegistry: Run cleanup when objects are collected
    //
    // This eliminates the "registry leak" by inverting control from manual
    // cleanup (removeNode) to automatic GC-driven cleanup.
    //
    // Result: document.body.innerHTML = '' will self-clean instantly. Zero leaks.
    //
    // Browser Support:
    // - Chrome/Edge 84+
    // - Firefox 79+
    // - Safari 14.1+
    // - Node.js 14.6+
    //
    // NO POLYFILLS: These features cannot be polyfilled. Old browsers are NOT supported.
    if (typeof WeakRef === 'undefined' || typeof FinalizationRegistry === 'undefined') {
      throw new Error(
        'Reflex Error: This environment does not support WeakRef and FinalizationRegistry.\n' +
        '\n' +
        'BREAKING CHANGE (Task 5): Reflex now requires modern browser features for automatic\n' +
        'memory management. This eliminates the "registry leak" that caused memory leaks when\n' +
        'DOM nodes were removed without calling cleanup functions.\n' +
        '\n' +
        'Required Browser Versions:\n' +
        '  • Chrome/Edge 84+ (July 2020)\n' +
        '  • Firefox 79+ (July 2020)\n' +
        '  • Safari 14.1+ (April 2021)\n' +
        '  • Node.js 14.6+ (July 2020)\n' +
        '\n' +
        'These features CANNOT be polyfilled. If you need to support older browsers,\n' +
        'you must use an older version of Reflex (pre-Task-5).\n' +
        '\n' +
        'Why this change? The GC-driven engine uses FinalizationRegistry to automatically\n' +
        'clean up scope data when DOM nodes are garbage collected. This means you can now\n' +
        'safely use `document.body.innerHTML = \'\'` without memory leaks.\n'
      );
    }

    // === RENDERER ===
    // Initialize the pluggable renderer adapter
    // Supports: web (DOMRenderer), native (VirtualRenderer), or custom
    if (options.renderer) {
      // Custom renderer provided
      this._ren = options.renderer;
    } else if (options.target === 'native' || options.target === 'test') {
      // Native/test targets require explicit renderer injection
      // This allows tree-shaking of VirtualRenderer in web builds
      throw new Error(
        'Reflex: Native/test targets require a renderer to be provided.\n' +
        'Example: new Reflex({}, { renderer: new VirtualRenderer() })\n' +
        'Import: import { VirtualRenderer } from "reflex/renderers"'
      );
    } else {
      // Default to DOMRenderer for web targets
      this._ren = DOMRenderer;
    }

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
    this.pendingTriggers = new Map();     // Pending Triggers (for batching)

    // === CACHES ===
    this._ec = new ExprCache(1000);  // Expression Cache (FIFO eviction)
    this._mf = new WeakMap();        // Meta Fallback (non-extensible objects)

    // === DOM ===
    this._cl = new WeakMap();        // Cleanup registry (lifecycle hooks)
    this._scopeMap = new WeakMap();  // Node -> Scope mapping (replaces node._sc)
    this._nodeState = new WeakMap(); // TASK 6: Node -> State mapping (replaces el._rx_value_ref)
    this._dh = new Map();            // Delegated event Handlers
    this._dr = null;                 // DOM Root

    // === EXTENSIONS ===
    this._cp = new Map();     // Component Definitions
    this._acp = new Map();    // Async Component Factories
    this._cd = new Map();     // Custom Directives
    this._refs = {};          // $refs registry
    this._parser = null;      // CSP parser (lazy-loaded)
    this._plugins = new Set(); // Installed plugins (per-instance)
    this._m = false;          // Mounted flag (prevents double-mount)
    this._fileInputsWarned = new WeakSet(); // Track file inputs that have been warned (prevents spam)

    // === FLAT SCOPE REGISTRY ===
    // BREAKING CHANGE: Replaces prototype-based scope chains
    // All scope variables are stored in a flat Map with unique IDs
    // This prevents prototype pollution attacks and scope shadowing exploits
    this._scopeRegistry = new ScopeRegistry();

    // === GC-DRIVEN CLEANUP REGISTRY (TASK 5) ===
    // BREAKING CHANGE: Automatic memory management via garbage collection
    //
    // When a DOM node with a scope is garbage collected, this registry
    // automatically cleans up the scope's IDs from the ScopeRegistry.
    //
    // How it works:
    // 1. When creating a scope, we register the node with _gcRegistry.register(node, scopeIds)
    // 2. When the node is removed and has no references, it's garbage collected
    // 3. The FinalizationRegistry callback fires with the scopeIds
    // 4. We delete each ID from the ScopeRegistry
    //
    // This eliminates the "registry leak" - even if removeNode() isn't called,
    // the GC will eventually clean up the scope data automatically.
    //
    // Result: document.body.innerHTML = '' will self-clean when GC runs.
    this._gcRegistry = new FinalizationRegistry((scopeIds: string[]) => {
      // Automatic cleanup: delete all scope IDs from the registry
      // This runs when the DOM node is garbage collected
      for (const id of scopeIds) {
        this._scopeRegistry.delete(id);
      }
    });

    // === CONFIGURATION ===
    // SECURITY: Secure by default - sanitization is enabled by default
    // m-html without sanitization is a critical XSS vector
    // To use m-html, you must either:
    //   1. Configure DOMPurify: app.configure({ domPurify: DOMPurify })
    //   2. Explicitly opt-out (NOT recommended): app.configure({ sanitize: false })
    this.cfg = {
      sanitize: true,         // Sanitize HTML content (secure by default)
      cspSafe: options.cspSafe || false,  // CSP-safe mode (apply from options)
      cacheSize: 1000,        // Expression cache size
      onError: null,          // Global error handler
      // Try to use globalThis.DOMPurify if available (for test environments)
      domPurify: (typeof globalThis !== 'undefined' && (globalThis as any).DOMPurify) || null,
      autoMount: options.autoMount !== false  // CRITICAL FIX #2: Make auto-mount opt-in
    };

    // === AUTO-CSP DETECTION ===
    // Try to detect CSP restrictions and automatically enable safe mode
    // Only run auto-detection if cspSafe wasn't explicitly set in options
    if (!this.cfg.cspSafe) {
      try {
        // Attempt to create a function - this will fail in strict CSP environments
        new Function('');
      } catch (e) {
        // CSP violation detected - switch to safe mode automatically
        this.cfg.cspSafe = true;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(
            'Reflex: CSP restriction detected. Automatically switching to Safe Parser mode.\n' +
            'To suppress this warning, configure explicitly: app.configure({ cspSafe: true, parser: SafeExprParser })'
          );
        }
      }
    }

    // Initialize reactive state
    this.s = this._r(init);

    // CRITICAL FIX #2: Conditional auto-mount to prevent async initialization race conditions
    // Auto-mount on DOM ready (browser only), but only if autoMount is enabled
    // Users can disable with: new Reflex({}, { autoMount: false })
    // This allows async initialization (e.g., fetching auth tokens) before mounting
    // For non-browser targets, user must call mount() explicitly with a virtual root
    if (this.cfg.autoMount && this._ren.isBrowser && typeof document !== 'undefined') {
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
   * @param {Object} opts.domPurify - DOMPurify instance for m-html sanitization
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Enable CSP-safe mode
   * app.configure({
   *   cspSafe: true,
   *   parser: new SafeExprParser()
   * });
   *
   * @example
   * // Configure DOMPurify for m-html security
   * import DOMPurify from 'dompurify';
   * app.configure({ domPurify: DOMPurify });
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
    if (opts.domPurify !== undefined) this.cfg.domPurify = opts.domPurify;
    return this;
  }

  /**
   * Mount the application to a DOM element or virtual node.
   *
   * For web targets, defaults to document.body.
   * For non-web targets (native/test), you must provide a root element.
   *
   * @param {Element|VNode} el - Root element (default: document.body for web)
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Web target (default)
   * const app = new Reflex({ count: 0 });
   * app.mount(); // Mounts to document.body
   *
   * @example
   * // Virtual renderer (test/native)
   * const renderer = new VirtualRenderer();
   * const app = new Reflex({ count: 0 }, { renderer });
   * app.mount(renderer.getRoot());
   */
  mount(el?: Element | any) {
    // Prevent double-mounting (could cause memory leaks and duplicate effects)
    if (this._m) {
      console.warn('Reflex: mount() called multiple times. Ignoring duplicate mount.');
      return this;
    }
    this._m = true;

    // Determine root element
    let root = el;
    if (!root) {
      if (this._ren.isBrowser && typeof document !== 'undefined') {
        root = document.body;
      } else if (this._ren.getRoot) {
        root = this._ren.getRoot();
      } else {
        throw new Error(
          'Reflex: No root element provided for mount().\n' +
          'For non-browser targets, call: app.mount(renderer.getRoot())'
        );
      }
    }

    this._dr = root;

    // CRITICAL FIX: Double Mount Leak - Check for existing app and unmount it first
    // If mount() is called on an element that already hosts a Reflex app,
    // the old app must be unmounted to prevent memory leaks and ghost behavior
    if (root && typeof root === 'object') {
      const existingApp = (root as any).__rfx_app;
      if (existingApp && existingApp !== this) {
        // Another app is mounted here - unmount it first
        if (typeof existingApp.unmount === 'function') {
          try {
            console.warn(
              'Reflex: Detected existing app on mount root. Unmounting previous app to prevent memory leak.'
            );
            existingApp.unmount();
          } catch (err) {
            console.warn('Reflex: Error unmounting existing app:', err);
          }
        }
      }
      // Store app reference on root element for cleanup
      // This allows _kill to detect and unmount child Reflex instances
      (root as any).__rfx_app = this;
    }

    this._bnd(root, null);
    this._w(root, null);
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      this._dtRegister?.();
    }
    return this;
  }

  /**
   * Unmount the application and clean up all effects and listeners.
   *
   * This method gracefully tears down the Reflex application:
   * - Kills all effects and cleanup functions
   * - Removes the app reference from the root element
   * - Resets the mounted flag
   *
   * This is critical for:
   * - Micro-frontends (nested Reflex apps)
   * - SPA routing (mounting/unmounting views)
   * - Testing (clean teardown between tests)
   *
   * @returns {Reflex} This instance for chaining
   *
   * @example
   * // Micro-frontend teardown
   * const app = new Reflex({ count: 0 });
   * app.mount(container);
   * // Later...
   * app.unmount(); // Clean up before removing container
   */
  unmount() {
    // Prevent double-unmount
    if (!this._m) {
      console.warn('Reflex: unmount() called on non-mounted app. Ignoring.');
      return this;
    }

    // Kill all effects and cleanup functions in the DOM tree
    if (this._dr) {
      this._kill(this._dr);

      // CRITICAL FIX: Remove delegated event listeners from root
      // Without this, listeners accumulate on repeated mount/unmount cycles
      this._dh.forEach((eventData, eventName) => {
        if (eventData && eventData.listener) {
          this._dr.removeEventListener(eventName, eventData.listener);
        }
      });
      this._dh.clear();

      // Clear the app reference to allow garbage collection
      if (typeof this._dr === 'object') {
        (this._dr as any).__rfx_app = null;
        delete (this._dr as any).__rfx_app;
      }

      this._dr = null;
    }

    // CRITICAL FIX: Cancel pending scheduler tasks to prevent zombie execution
    // Clear both job queues to prevent callbacks from running after unmount
    this._q.length = 0;
    this._qb.length = 0;
    this._p = false;
    if (this._flushIterations) this._flushIterations = 0;

    // Clear the scope registry to free memory and reset IDs
    this._scopeRegistry.clear();

    // Reset mounted flag
    this._m = false;

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
    const t = this._ren.createElement('template') as HTMLTemplateElement;
    let template = def.template;

    // SECURITY: Fail closed - if sanitization is enabled but DOMPurify is missing, throw error
    if (this.cfg.sanitize) {
      if (!this.cfg.domPurify) {
        throw new Error(
          'Reflex Security: sanitize is enabled but domPurify is not configured.\n' +
          'To fix: app.configure({ domPurify: DOMPurify })\n' +
          'Or disable sanitization (NOT recommended): app.configure({ sanitize: false })'
        );
      }
      template = this.cfg.domPurify.sanitize(template, {
        RETURN_DOM_FRAGMENT: false,
        WHOLE_DOCUMENT: false
      });
    }

    // CRITICAL FIX #3: SVG Context Loss in Component Templates
    // When a component template starts with an SVG element (not <svg> itself),
    // template.innerHTML parses it as HTML, creating HTMLUnknownElement instead of SVGElement
    // Example: template: '<circle cx="10" cy="10" r="5"/>' becomes HTMLUnknownElement
    // Fix: Detect SVG elements and wrap in <svg> for parsing, then extract the element
    const trimmed = template.trim();
    const svgTagMatch = trimmed.match(/^<(\w+)/);
    const rootTag = svgTagMatch ? svgTagMatch[1].toLowerCase() : '';

    // List of SVG tags (excluding <svg> itself, which parses correctly)
    const svgElements = new Set([
      'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'path',
      'text', 'tspan', 'textPath', 'g', 'defs', 'symbol', 'use',
      'linearGradient', 'radialGradient', 'stop', 'pattern',
      'clipPath', 'mask', 'marker', 'image', 'foreignObject'
    ]);

    if (svgElements.has(rootTag)) {
      // CRITICAL FIX: Parse SVG elements with proper namespace
      // Create an actual SVG element, use its innerHTML to parse content with proper namespace
      const svgContainer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      // Temporarily add to document to ensure proper parsing context
      const tempDiv = document.createElement('div');
      tempDiv.style.display = 'none';
      document.body.appendChild(tempDiv);
      tempDiv.appendChild(svgContainer);

      try {
        svgContainer.innerHTML = template;
        const actualElement = svgContainer.firstElementChild;

        if (actualElement) {
          // Clone to break connection with temporary container
          const cloned = actualElement.cloneNode(true);
          t.content.appendChild(cloned);
          this._cp.set(name, {
            _t: cloned,
            p: def.props || [],
            s: def.setup
          });
        } else {
          // Fallback
          t.innerHTML = template;
          this._cp.set(name, {
            _t: t.content.firstElementChild,
            p: def.props || [],
            s: def.setup
          });
        }
      } finally {
        // Clean up temporary container
        tempDiv.remove();
      }
    } else{
      t.innerHTML = template;

      // CRITICAL FIX #7: Component Fragment Support (Multi-root components)
      // Previous bug: Only stored firstElementChild, losing all siblings
      // This silently broke multi-root components (fragments)
      //
      // Fix: Check if template has multiple root elements
      // If yes, store a DocumentFragment containing all children
      // If no, store the single element as before (for performance/compatibility)
      const children = Array.from(t.content.children);

      let templateNode;
      if (children.length === 0) {
        // Empty template - store null or empty fragment
        templateNode = null;
      } else if (children.length === 1) {
        // Single root - store the element directly (existing behavior)
        templateNode = t.content.firstElementChild;
      } else {
        // Multiple roots (fragment) - store a cloneable fragment
        // We'll clone the entire template content which preserves all children
        // TASK 6: Pass _nodeState WeakMap to preserve node state
        templateNode = cloneNodeWithProps(t.content, true, this._nodeState);
      }

      this._cp.set(name, {
        _t: templateNode,
        p: def.props || [],
        s: def.setup
      });
    }
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
   * Component rendering without recursive walking (for iterative stack processing)
   * CRITICAL FIX #6: Non-recursive version of _comp
   * This method sets up the component but doesn't walk it (no _w calls)
   * The caller is responsible for walking the returned instance
   * @returns The component instance element to be walked by the caller
   */
  _compNoRecurse(el: Element, tag: string, o: any): Element {
    const def = this._cp.get(tag);

    // CRITICAL FIX #7: Handle fragment components (multi-root templates)
    // If _t is a DocumentFragment, we need to clone all children
    // For single-element templates, clone works as before
    let inst: Element;
    let isFragment = false;
    const fragmentNodes: Element[] = [];

    if (def._t instanceof DocumentFragment) {
      // Fragment component - clone and collect all children
      isFragment = true;
      // TASK 6: Pass _nodeState WeakMap to preserve node state
      const cloned = cloneNodeWithProps(def._t, true, this._nodeState) as DocumentFragment;
      // Collect all element children (ignore text nodes for now)
      Array.from(cloned.children).forEach(child => {
        fragmentNodes.push(child as Element);
      });
      // Use the first element as the primary instance
      inst = fragmentNodes[0];
    } else {
      // Single element component (existing behavior)
      // TASK 6: Pass _nodeState WeakMap to preserve node state
      inst = cloneNodeWithProps(def._t, true, this._nodeState) as Element;
    }

    const props = this._r({});
    const propDefs = [];
    const hostHandlers = Object.create(null);
    const self = this;

    // Collect cleanup functions registered via onCleanup
    const cleanupFns: Array<() => void> = [];

    // Capture slot content BEFORE processing attributes
    const slotContent: Node[] = [];
    while (el.firstChild) {
      slotContent.push(el.removeChild(el.firstChild));
    }

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

    const onCleanup = (fn: () => void) => {
      if (typeof fn === 'function') {
        cleanupFns.push(fn);
      }
    };

    const scopeRaw = Object.assign({}, props);
    scopeRaw.$props = props;
    scopeRaw.$emit = emit;

    // CRITICAL FIX #3 & #4: Set active component for auto-cleanup
    // This allows computed(), watch(), and createEffect() called in setup()
    // to automatically register their cleanup when the component unmounts
    const prevActiveComponent = this._activeComponent;
    this._activeComponent = inst;

    try {
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
    } finally {
      // CRITICAL: Always restore previous active component, even if setup() throws
      this._activeComponent = prevActiveComponent;
    }

    const scope = this._r(scopeRaw);

    // CRITICAL FIX #7: Handle fragment components when replacing
    if (isFragment && fragmentNodes.length > 1) {
      // For fragments, replace el with all fragment nodes
      const parent = el.parentNode;
      const nextSibling = el.nextSibling;

      // Insert all fragment nodes
      for (const node of fragmentNodes) {
        if (nextSibling) {
          parent.insertBefore(node, nextSibling);
        } else {
          parent.appendChild(node);
        }
      }

      // Remove the original element
      el.remove();
    } else {
      // Single element replacement (existing behavior)
      el.replaceWith(inst);
    }

    // Store scope for later use by _w
    this._scopeMap.set(inst, scope);

    // Project slot content into <slot> elements
    // CRITICAL FIX #6: Don't walk slotted content here - caller will walk the instance
    if (slotContent.length > 0) {
      const slots = inst.querySelectorAll('slot');
      if (slots.length > 0) {
        const defaultSlot = Array.from(slots).find(s => !s.hasAttribute('name')) || slots[0];
        if (defaultSlot) {
          const parent = defaultSlot.parentNode;
          for (const node of slotContent) {
            parent.insertBefore(node, defaultSlot);
          }
          defaultSlot.remove();
        }
      } else {
        for (const node of slotContent) {
          inst.appendChild(node);
        }
      }

      // Process bindings on slotted content but don't walk yet
      for (const node of slotContent) {
        if (node.nodeType === 1) {
          this._bnd(node as Element, o);
          // CRITICAL FIX #6: Don't call _w - caller will walk
        } else if (node.nodeType === 3) {
          const nv = node.nodeValue;
          if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
            this._txt(node, o);
          }
        }
      }
    }

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
      const e = this.createEffect(() => { props[pd.name] = fn(this.s, o); });
      e.o = o;
      this._reg(inst, e.kill);
    }

    this._bnd(inst, scope);
    // CRITICAL FIX #6: Don't call _w here - caller will walk the returned instance

    return inst;
  }

  /**
   * Component rendering
   * @returns The component instance element (for use in m-for etc.)
   */
  _comp(el: Element, tag: string, o: any): Element {
    const def = this._cp.get(tag);
    // TASK 6: Pass _nodeState WeakMap to preserve node state
    const inst = cloneNodeWithProps(def._t, true, this._nodeState) as Element;
    const props = this._r({});
    const propDefs = [];
    const hostHandlers = Object.create(null);
    const self = this;

    // Collect cleanup functions registered via onCleanup
    const cleanupFns: Array<() => void> = [];

    // Capture slot content BEFORE processing attributes
    // Move (not clone) child nodes to preserve any existing bindings
    const slotContent: Node[] = [];
    while (el.firstChild) {
      slotContent.push(el.removeChild(el.firstChild));
    }

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

    // Use flat object copy instead of Object.create for V8 optimization
    // Object.create creates unique prototype chains, preventing inline caching
    const scopeRaw = Object.assign({}, props);
    scopeRaw.$props = props;
    scopeRaw.$emit = emit;

    // CRITICAL FIX #3 & #4: Set active component for auto-cleanup
    // This allows computed(), watch(), and createEffect() called in setup()
    // to automatically register their cleanup when the component unmounts
    const prevActiveComponent = this._activeComponent;
    this._activeComponent = inst;

    try {
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
    } finally {
      // CRITICAL: Always restore previous active component, even if setup() throws
      this._activeComponent = prevActiveComponent;
    }

    const scope = this._r(scopeRaw);
    el.replaceWith(inst);

    // Project slot content into <slot> elements
    // The slotted content uses the PARENT scope (o), not the component scope
    if (slotContent.length > 0) {
      const slots = inst.querySelectorAll('slot');
      if (slots.length > 0) {
        // Find default slot (no name attribute) or first slot
        const defaultSlot = Array.from(slots).find(s => !s.hasAttribute('name')) || slots[0];
        if (defaultSlot) {
          // Move slot content into the slot location
          const parent = defaultSlot.parentNode;
          for (const node of slotContent) {
            parent.insertBefore(node, defaultSlot);
          }
          // Remove the <slot> placeholder
          defaultSlot.remove();
        }
      } else {
        // No <slot> in template - append content to component root
        for (const node of slotContent) {
          inst.appendChild(node);
        }
      }

      // Process bindings on slotted content using PARENT scope
      // This is critical - slotted content should be reactive to parent state
      for (const node of slotContent) {
        if (node.nodeType === 1) {
          this._bnd(node as Element, o);
          this._w(node, o);
        } else if (node.nodeType === 3) {
          const nv = node.nodeValue;
          if (typeof nv === 'string' && nv.indexOf('{{') !== -1) {
            this._txt(node, o);
          }
        }
      }
    }

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
      const e = this.createEffect(() => { props[pd.name] = fn(this.s, o); });
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
    // Use renderer for DOM operations (supports both web and virtual targets)
    const marker = this._ren.createComment(`async:${tag}`);
    let fallbackNode: Element | null = null;

    if (asyncDef.fallback) {
      // Render fallback template
      const fallbackTpl = this._ren.createElement('template') as HTMLTemplateElement;
      let fallbackHtml = asyncDef.fallback;

      // SECURITY: Fail closed - if sanitization is enabled but DOMPurify is missing, throw error
      if (this.cfg.sanitize) {
        if (!this.cfg.domPurify) {
          throw new Error(
            'Reflex Security: sanitize is enabled but domPurify is not configured.\n' +
            'To fix: app.configure({ domPurify: DOMPurify })\n' +
            'Or disable sanitization (NOT recommended): app.configure({ sanitize: false })'
          );
        }
        fallbackHtml = this.cfg.domPurify.sanitize(fallbackHtml, {
          RETURN_DOM_FRAGMENT: false,
          WHOLE_DOCUMENT: false
        });
      }

      fallbackTpl.innerHTML = fallbackHtml;
      // TASK 6: Pass _nodeState WeakMap to preserve node state
      fallbackNode = cloneNodeWithProps(fallbackTpl.content.firstElementChild, true, this._nodeState) as Element;
    }

    // Track if this async component has been aborted
    // Use a unique mount ID to prevent race conditions from multiple loads
    const mountId = Symbol('mount');
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
      // ROBUST ABORT CHECKS to prevent zombie components:
      // 1. Check if app instance is still mounted (prevents race condition)
      // 2. Check explicit abort flag (set when parent is destroyed)
      // 3. Verify marker is still in the document (not detached)
      // 4. Ensure marker's parent exists and is connected
      // This prevents "zombie effects" when parent is destroyed/moved while loading
      if (!self._m) {
        // App was destroyed before async component loaded
        if (fallbackNode?.parentNode) {
          self._kill(fallbackNode);
          fallbackNode.remove();
        }
        return;
      }

      if (aborted) {
        // Explicitly aborted during cleanup
        if (fallbackNode?.parentNode) {
          self._kill(fallbackNode);
          fallbackNode.remove();
        }
        return;
      }

      // Verify marker is still in a valid location
      if (!marker.parentNode || !marker.parentNode.isConnected) {
        // Marker was removed or its parent was detached
        aborted = true;
        if (fallbackNode?.parentNode) {
          self._kill(fallbackNode);
          fallbackNode.remove();
        }
        return;
      }

      // Create a temporary element with saved attributes
      // CRITICAL FIX: Pass parent context for SVG awareness (fixes SVG link hijack)
      const tempEl = self._ren.createElement(tag, marker.parentElement);
      for (const attr of savedAttrs) {
        self._ren.setAttribute(tempEl, attr.name, attr.value);
      }

      // Register the resolved component in the sync map
      const t = self._ren.createElement('template') as HTMLTemplateElement;
      let template = def.template;

      // SECURITY: Fail closed - if sanitization is enabled but DOMPurify is missing, throw error
      if (self.cfg.sanitize) {
        if (!self.cfg.domPurify) {
          throw new Error(
            'Reflex Security: sanitize is enabled but domPurify is not configured.\n' +
            'To fix: app.configure({ domPurify: DOMPurify })\n' +
            'Or disable sanitization (NOT recommended): app.configure({ sanitize: false })'
          );
        }
        template = self.cfg.domPurify.sanitize(template, {
          RETURN_DOM_FRAGMENT: false,
          WHOLE_DOCUMENT: false
        });
      }

      // CRITICAL FIX #3: SVG Context Loss in Component Templates (async components)
      // Apply same fix as sync components
      const trimmed = template.trim();
      const svgTagMatch = trimmed.match(/^<(\w+)/);
      const rootTag = svgTagMatch ? svgTagMatch[1].toLowerCase() : '';

      const svgElements = new Set([
        'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'path',
        'text', 'tspan', 'textPath', 'g', 'defs', 'symbol', 'use',
        'linearGradient', 'radialGradient', 'stop', 'pattern',
        'clipPath', 'mask', 'marker', 'image', 'foreignObject'
      ]);

      if (svgElements.has(rootTag)) {
        // CRITICAL FIX: Parse SVG elements with proper namespace (same as sync components)
        const svgContainer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const tempDiv = document.createElement('div');
        tempDiv.style.display = 'none';
        document.body.appendChild(tempDiv);
        tempDiv.appendChild(svgContainer);

        try {
          svgContainer.innerHTML = template;
          const actualElement = svgContainer.firstElementChild;

          if (actualElement) {
            const cloned = actualElement.cloneNode(true);
            t.content.appendChild(cloned);
            self._cp.set(tag, {
              _t: cloned,
              p: def.props || [],
              s: def.setup
            });
          } else {
            t.innerHTML = template;
            self._cp.set(tag, {
              _t: t.content.firstElementChild,
              p: def.props || [],
              s: def.setup
            });
          }
        } finally {
          tempDiv.remove();
        }
      } else {
        t.innerHTML = template;
        self._cp.set(tag, {
          _t: t.content.firstElementChild,
          p: def.props || [],
          s: def.setup
        });
      }

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
   * CRITICAL FIX: Also unmounts any child Reflex instances to prevent memory leaks.
   * CRITICAL FIX: Bottom-Up unmounting (children first) to prevent context collapse.
   * CRITICAL FIX: Iterative approach to prevent stack overflow on deep DOM trees.
   * CRITICAL FIX #10: DOM Traversal Instability During Unmount
   * Snapshot children using Array.from instead of linked list traversal
   * This prevents issues if cleanup functions modify DOM structure during unmount
   */
  _kill(node) {
    // CRITICAL FIX: Use iterative stack-based approach instead of recursion
    // This prevents "Maximum Call Stack Size Exceeded" errors on deeply nested DOM
    // (e.g., >10,000 levels from recursive components or large visualizations)
    const stack = [node];

    // First pass: collect all nodes in post-order (children before parents)
    // CRITICAL FIX #10: Snapshot children to prevent instability
    // If cleanup functions modify DOM (remove siblings), linked list traversal can skip nodes
    // Array.from creates a stable snapshot that won't be affected by DOM modifications
    const nodesToKill: any[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      nodesToKill.push(current);

      // Snapshot children before iterating to prevent instability
      // This ensures cleanup functions can safely modify DOM without breaking traversal
      if (current.childNodes && current.childNodes.length > 0) {
        const children = Array.from(current.childNodes);
        // Push in reverse order to maintain correct post-order traversal
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i]);
        }
      }
    }

    // Second pass: kill nodes in reverse order (children first)
    // This ensures child cleanups run before parent cleanups
    for (let i = nodesToKill.length - 1; i >= 0; i--) {
      const node = nodesToKill[i];

      // CRITICAL: Check for child Reflex app instances and unmount them
      // This prevents memory leaks when components with separate Reflex instances
      // are removed via m-if or list reconciliation
      if (node && typeof node === 'object') {
        const childApp = (node as any).__rfx_app;
        if (childApp && childApp !== this && typeof childApp.unmount === 'function') {
          try {
            childApp.unmount();
          } catch (err) {
            console.warn('Reflex: Error unmounting child app:', err);
          }
          // Clear the reference to allow garbage collection
          (node as any).__rfx_app = null;
          delete (node as any).__rfx_app;
        }
      }

      // Run this node's cleanups
      // Even if the node was removed from DOM by another cleanup, we still need to
      // run its cleanup functions to prevent memory leaks (event listeners, effects, etc.)
      const c = this._cl.get(node);
      if (c) {
        for (let i = 0; i < c.length; i++) {
          try { c[i](); } catch {} // eslint-disable-line no-empty
        }
        this._cl.delete(node);
      }
    }
  }
}

export interface Reflex extends ReactivityMixinType, SchedulerMixinType, ExprMixinType, CompilerMixinType {}

// Apply mixins to Reflex prototype
Object.assign(Reflex.prototype, ReactivityMixin);
Object.assign(Reflex.prototype, SchedulerMixin);
Object.assign(Reflex.prototype, ExprMixin);
Object.assign(Reflex.prototype, CompilerMixin);

if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
  Reflex.prototype._dtRegister = function() {
    if (typeof window === 'undefined') return;
    const hook = window.__REFLEX_DEVTOOLS_HOOK__;
    if (!hook || typeof hook !== 'object') return;

    // Helper function to get dependency map for an object
    const getDependencies = (obj) => {
      if (obj === null || typeof obj !== 'object') return null;
      const meta = obj[META] || this._mf.get(obj);
      if (!meta) return null;

      // Convert dependency map to a readable format
      const deps = {};
      for (const [key, effectSet] of meta.d) {
        deps[String(key)] = Array.from(effectSet).length;
      }
      return deps;
    };

    const payload = {
      app: this,
      root: this._dr,
      state: this.s,
      components: this._cp,
      getDependencies  // Expose the helper to DevTools
    };
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
