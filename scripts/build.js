#!/usr/bin/env node
/**
 * Reflex Build Script
 *
 * Builds the library in multiple formats:
 * - ESM (ES Modules)
 * - CJS (CommonJS)
 * - IIFE (Browser global)
 *
 * Also generates TypeScript declarations.
 */

import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { minify } from 'terser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const srcDir = path.join(rootDir, 'src');

// Ensure dist directories exist
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(path.join(distDir, 'csp'))) {
  fs.mkdirSync(path.join(distDir, 'csp'), { recursive: true });
}
if (!fs.existsSync(path.join(distDir, 'hydration'))) {
  fs.mkdirSync(path.join(distDir, 'hydration'), { recursive: true });
}
if (!fs.existsSync(path.join(distDir, 'scoped-css'))) {
  fs.mkdirSync(path.join(distDir, 'scoped-css'), { recursive: true });
}
if (!fs.existsSync(path.join(distDir, 'observer'))) {
  fs.mkdirSync(path.join(distDir, 'observer'), { recursive: true });
}

const isWatch = process.argv.includes('--watch');

// Common esbuild options
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: ['es2020'],
  logLevel: 'info',
};

// Build configurations
const builds = [
  // Main library - ESM
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(distDir, 'reflex.esm.js'),
    format: 'esm',
  },
  // Main library - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(distDir, 'reflex.cjs'),
    format: 'cjs',
  },
  // Main library - IIFE (browser)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(distDir, 'reflex.iife.js'),
    format: 'iife',
    globalName: 'Reflex',
    footer: {
      js: '// Export Reflex to window for browser usage\nif(typeof window!=="undefined"){window.Reflex=Reflex.Reflex;}'
    }
  },
  // Main library - Minified IIFE
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(distDir, 'reflex.min.js'),
    format: 'iife',
    globalName: 'Reflex',
    minify: true,
    sourcemap: false,
    // Mangle properties to reduce bundle size
    // This mangles internal method names to short names in the minified build
    // We mangle properties that:
    // 1. Start with underscore (private internal methods)
    // 2. Match our renamed long method names (trackDependency, triggerEffects, etc.)
    mangleProps: /^(_[a-z_]+|trackDependency|triggerEffects|pendingTriggers|wrapArrayMethod|wrapCollectionMethod|queueJob|createEffect|flushQueue)$/,
    footer: {
      js: 'if(typeof window!=="undefined"){window.Reflex=Reflex.Reflex;}'
    }
  },
  // CSP module - ESM
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.ts')],
    outfile: path.join(distDir, 'csp', 'index.esm.js'),
    format: 'esm',
  },
  // CSP module - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.ts')],
    outfile: path.join(distDir, 'csp', 'index.cjs'),
    format: 'cjs',
  },
  // CSP module - IIFE
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.ts')],
    outfile: path.join(distDir, 'csp', 'index.iife.js'),
    format: 'iife',
    globalName: 'ReflexCSP',
    footer: {
      js: 'if(typeof window!=="undefined"){window.SafeExprParser=ReflexCSP.SafeExprParser;}'
    }
  },
  // Hydration module - ESM
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'hydration', 'index.ts')],
    outfile: path.join(distDir, 'hydration', 'index.esm.js'),
    format: 'esm',
    // Mark core modules as external to avoid duplication
    external: ['../core/*'],
  },
  // Hydration module - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'hydration', 'index.ts')],
    outfile: path.join(distDir, 'hydration', 'index.cjs'),
    format: 'cjs',
    external: ['../core/*'],
  },
  // Hydration module - IIFE (standalone, includes dependencies)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'hydration', 'index.ts')],
    outfile: path.join(distDir, 'hydration', 'index.iife.js'),
    format: 'iife',
    globalName: 'ReflexHydration',
    footer: {
      js: 'if(typeof window!=="undefined"){window.withHydration=ReflexHydration.withHydration;}'
    }
  },
  // Scoped CSS module - ESM (for build tools, Node.js)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'scoped-css', 'index.ts')],
    outfile: path.join(distDir, 'scoped-css', 'index.esm.js'),
    format: 'esm',
    platform: 'node',
  },
  // Scoped CSS module - CJS (for CommonJS build tools)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'scoped-css', 'index.ts')],
    outfile: path.join(distDir, 'scoped-css', 'index.cjs'),
    format: 'cjs',
    platform: 'node',
  },
  // Runtime Helpers - ESM (for AOT compiled mode)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'runtime-helpers.ts')],
    outfile: path.join(distDir, 'runtime-helpers.esm.js'),
    format: 'esm',
  },
  // Runtime Helpers - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'runtime-helpers.ts')],
    outfile: path.join(distDir, 'runtime-helpers.cjs'),
    format: 'cjs',
  },
];

// Generate TypeScript declarations
function generateDeclarations() {
  const mainDts = `/**
 * Reflex - The Direct Reactive Engine
 */

export declare const META: unique symbol;
export declare const ITERATE: symbol;
export declare const SKIP: symbol;
export declare const ACTIVE: number;
export declare const RUNNING: number;
export declare const QUEUED: number;
export declare const RESERVED: Record<string, number>;
export declare const UNSAFE_PROPS: Record<string, number>;
export declare const UNSAFE_URL_RE: RegExp;
export declare const UNSAFE_EXPR_RE: RegExp;

export declare class ExprCache {
  constructor(maxSize?: number);
  get(key: string): any;
  set(key: string, value: any): any;
  has(key: string): boolean;
  clear(): void;
}

export declare function computeLIS(arr: number[]): number[];

export declare function runTransition(
  el: Element,
  name: string,
  type: 'enter' | 'leave',
  done?: (() => void) | null
): void;

export interface ReflexConfig {
  sanitize?: boolean;
  cspSafe?: boolean;
  cacheSize?: number;
  parser?: { compile(exp: string, reflex: Reflex): Function };
}

export interface ComputedRef<T> {
  readonly value: T;
}

export interface WatchOptions {
  deep?: boolean;
  immediate?: boolean;
}

export interface DirectiveBinding {
  value: any;
  expression: string;
  modifiers: string[];
}

export interface ComponentDefinition {
  template: string;
  props?: string[];
  setup?: (props: any, context: { emit: Function; props: any; slots: any }) => any;
}

/**
 * Plugin interface for extending Reflex.
 * A plugin can be a function, an object with install method,
 * or an object with mixin property.
 */
export type ReflexPlugin =
  | ((reflex: Reflex, options?: any) => void)
  | { install: (reflex: Reflex, options?: any) => void }
  | { mixin: Record<string, any>; init?: (reflex: Reflex, options?: any) => void };

export declare class Reflex {
  /** Reactive state */
  s: any;

  /** Configuration */
  cfg: ReflexConfig;

  constructor(init?: Record<string, any>);

  /**
   * Configure the Reflex instance
   */
  configure(opts: ReflexConfig): this;

  /**
   * Mount to a DOM element
   */
  mount(el?: Element): this;

  /**
   * Register a component
   */
  component(name: string, def: ComponentDefinition): this;

  /**
   * Register a custom directive
   */
  directive(name: string, callback: (el: Element, binding: DirectiveBinding, reflex: Reflex) => void | (() => void)): this;

  /**
   * Install a plugin to extend Reflex functionality.
   * Plugins provide a tree-shakable way to extend Reflex.
   */
  use<T extends ReflexPlugin>(plugin: T, options?: any): this;

  /**
   * Create a computed property
   */
  computed<T>(fn: (state: any) => T): ComputedRef<T>;

  /**
   * Watch a reactive source
   */
  watch<T>(
    source: (() => T) | ComputedRef<T>,
    callback: (newVal: T, oldVal: T, onCleanup: (fn: () => void) => void) => void,
    options?: WatchOptions
  ): () => void;

  /**
   * Batch multiple state changes
   */
  batch(fn: () => void): void;

  /**
   * Execute callback after next DOM update
   */
  nextTick(fn?: () => void): Promise<void>;

  /**
   * Extract raw object from proxy
   */
  toRaw<T>(proxy: T): T;

  /**
   * Clear the expression cache
   */
  clearCache(): this;
}

export default Reflex;
`;

  const cspDts = `/**
 * Reflex CSP-Safe Expression Parser
 */

export declare class SafeExprParser {
  constructor();

  /**
   * Compile an expression to an evaluator function
   */
  compile(exp: string, reflex: any): (state: any, context: any, $event?: Event, $el?: Element) => any;

  /**
   * Parse an expression into an AST
   */
  parse(expr: string): any;
}
`;

  const hydrationDts = `/**
 * Reflex Hydration Module
 *
 * Provides SSR hydration support for Reflex applications.
 * Tree-shakable: if not imported, hydration code won't be bundled.
 */

import { Reflex } from '../reflex';

export interface HydrationPlugin {
  mixin: {
    /**
     * Hydrate a server-rendered DOM tree.
     *
     * Unlike mount(), hydrate() assumes the DOM already exists and
     * attaches reactive bindings to existing elements without
     * modifying the DOM structure.
     *
     * @param el - Root element to hydrate
     * @returns Reflex instance for chaining
     */
    hydrate(el?: Element): Reflex;

    /**
     * Internal: Walk DOM tree in hydration mode
     */
    _hydrateWalk(n: Node, o: any): void;

    /**
     * Internal: Hydrate bindings on a single element
     */
    _hydrateNode(n: Element, o: any): void;

    /**
     * Internal: Hydrate text interpolation
     */
    _hydrateText(n: Text, o: any): void;

    /**
     * Internal: Hydrate m-if directive
     */
    _hydrateIf(el: Element, o: any): void;

    /**
     * Internal: Hydrate m-for directive
     */
    _hydrateFor(el: Element, o: any): void;

    /**
     * Internal: Hydrate a component
     */
    _hydrateComponent(el: Element, tag: string, o: any): void;
  };
  init(reflex: Reflex): void;
}

/**
 * Hydration plugin for Reflex.
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
export declare const withHydration: HydrationPlugin;

export default withHydration;
`;

  const scopedCssDts = `/**
 * Reflex Scoped CSS Module
 *
 * Zero-runtime scoped CSS for Reflex components.
 * All processing happens at build time - 0KB runtime overhead.
 *
 * Use this module with esbuild, Vite, or Rollup to automatically
 * scope component styles at build time.
 */

/**
 * Generate a unique scope ID from source content.
 * @param source - Source content to hash
 * @param name - Optional component name for additional uniqueness
 * @returns Scope ID in format 'v-xxxxxx'
 */
export declare function generateScopeId(source: string, name?: string): string;

/**
 * Scope a CSS selector by adding a data attribute.
 * @param selector - CSS selector
 * @param scopeId - Scope ID (e.g., 'v-abc123')
 * @returns Scoped selector
 */
export declare function scopeSelector(selector: string, scopeId: string): string;

/**
 * Transform CSS with scoped selectors.
 * @param css - Original CSS
 * @param scopeId - Scope ID
 * @param options - Transform options
 * @returns Transformed CSS
 */
export declare function transformCSS(
  css: string,
  scopeId: string,
  options?: { preserveComments?: boolean }
): string;

/**
 * Transform an HTML template to add scope attributes.
 * @param template - HTML template string
 * @param scopeId - Scope ID
 * @param options - Transform options
 * @returns Transformed template
 */
export declare function transformTemplate(
  template: string,
  scopeId: string,
  options?: { scopeSlots?: boolean; skip?: Set<string> }
): string;

/**
 * Inject scope attribute into an element's attribute string.
 * @param attrs - Existing attributes string
 * @param scopeAttr - Scope attribute name
 * @returns Modified attributes string
 */
export declare function injectScopeAttribute(attrs: string, scopeAttr: string): string;

/**
 * Extracted style information.
 */
export interface ExtractedStyle {
  content: string;
  scoped: boolean;
  lang: string | null;
  start: number;
  end: number;
  original: string;
}

/**
 * Extract <style> blocks from component source.
 * @param source - Component source code
 * @returns Array of extracted styles
 */
export declare function extractStyles(source: string): ExtractedStyle[];

/**
 * Extracted template information.
 */
export interface ExtractedTemplate {
  content: string;
  start: number;
  end: number;
  type: 'tag' | 'property';
  quote?: string;
}

/**
 * Extract template from component source.
 * @param source - Component source
 * @returns Extracted template or null
 */
export declare function extractTemplate(source: string): ExtractedTemplate | null;

/**
 * Component transformation result.
 */
export interface TransformResult {
  code: string;
  css: string;
  scopeId: string | null;
  styles: ExtractedStyle[];
}

/**
 * Transform a complete component with scoped styles.
 * @param source - Component source code
 * @param componentName - Component name for hash uniqueness
 * @param options - Transform options
 * @returns Transform result
 */
export declare function transformComponent(
  source: string,
  componentName?: string,
  options?: { removeStyles?: boolean; minifyCSS?: boolean }
): TransformResult;

/**
 * esbuild plugin options.
 */
export interface ScopedCSSPluginOptions {
  include?: RegExp;
  exclude?: RegExp;
  cssOutput?: string;
  minify?: boolean;
  removeStyles?: boolean;
}

/**
 * esbuild plugin for zero-runtime scoped CSS.
 * @param options - Plugin options
 * @returns esbuild plugin
 */
export declare function scopedCSSPlugin(options?: ScopedCSSPluginOptions): {
  name: string;
  setup(build: any): void;
};

/**
 * Vite plugin options.
 */
export interface ViteScopedCSSOptions {
  include?: RegExp;
  exclude?: RegExp;
}

/**
 * Vite plugin for zero-runtime scoped CSS.
 * @param options - Plugin options
 * @returns Vite plugin
 */
export declare function viteScopedCSS(options?: ViteScopedCSSOptions): {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): { code: string; map: null } | null;
  resolveId(id: string): string | null;
  load(id: string): { code: string; map: null } | null;
  handleHotUpdate(ctx: { file: string; server: any }): void;
};

/**
 * Rollup plugin options.
 */
export interface RollupScopedCSSOptions {
  include?: RegExp;
  exclude?: RegExp;
  cssOutput?: string;
}

/**
 * Rollup plugin for zero-runtime scoped CSS.
 * @param options - Plugin options
 * @returns Rollup plugin
 */
export declare function rollupScopedCSS(options?: RollupScopedCSSOptions): {
  name: string;
  transform(code: string, id: string): { code: string; map: null } | null;
  generateBundle(): void;
};
`;

  const runtimeHelpersDts = `/**
 * Reflex Runtime Helpers for AOT Compiled Mode
 *
 * Tree-shakeable runtime helpers used by compiled templates.
 * Only included in bundle if used by compiled code.
 */

import type { IRendererAdapter } from './renderers/types';

/**
 * Create a keyed list with efficient reconciliation
 */
export declare function createKeyedList<T>(
  ctx: any,
  anchor: Comment | Node,
  getItems: () => T[],
  getKey: (item: T, index: number) => any,
  renderItem: (item: T, index: number) => Node
): void;

/**
 * Run a CSS transition on an element
 */
export declare function runTransition(
  el: Element,
  name: string,
  phase: 'enter' | 'leave',
  onComplete?: () => void
): void;

/**
 * Convert a value to a display string
 */
export declare function toDisplayString(val: any): string;

/**
 * Create reactive effects for compiled templates
 */
export declare function createReactiveEffect(ctx: any, fn: () => void): void;
`;

  fs.writeFileSync(path.join(distDir, 'reflex.d.ts'), mainDts);
  fs.writeFileSync(path.join(distDir, 'csp', 'index.d.ts'), cspDts);
  fs.writeFileSync(path.join(distDir, 'hydration', 'index.d.ts'), hydrationDts);
  fs.writeFileSync(path.join(distDir, 'scoped-css', 'index.d.ts'), scopedCssDts);
  fs.writeFileSync(path.join(distDir, 'runtime-helpers.d.ts'), runtimeHelpersDts);
  console.log('Generated TypeScript declarations');
}

async function build() {
  console.log('Building Reflex...\n');

  try {
    if (isWatch) {
      // Watch mode
      const contexts = await Promise.all(
        builds.map(config => esbuild.context(config))
      );
      await Promise.all(contexts.map(ctx => ctx.watch()));
      console.log('\nWatching for changes...');
    } else {
      // Single build
      await Promise.all(builds.map(config => esbuild.build(config)));

      // Post-process minified build with Terser for aggressive property mangling
      const minifiedPath = path.join(distDir, 'reflex.min.js');
      const code = fs.readFileSync(minifiedPath, 'utf8');

      const terserResult = await minify(code, {
        compress: {
          passes: 2,
          unsafe: true,
          unsafe_methods: true,
          unsafe_proto: true,
        },
        mangle: {
          properties: {
            // Mangle properties matching these patterns
            regex: /^(trackDependency|triggerEffects|pendingTriggers|wrapArrayMethod|wrapCollectionMethod|queueJob|createEffect|flushQueue|_[a-z_]+)$/,
            reserved: ['s', 'cfg', 'mount', 'configure', 'component', 'directive', 'use', 'computed', 'watch', 'batch', 'nextTick', 'toRaw', 'clearCache', 'Reflex']
          }
        },
        format: {
          comments: false
        }
      });

      fs.writeFileSync(minifiedPath, terserResult.code);

      generateDeclarations();

      // Print bundle sizes
      console.log('\nBundle sizes:');
      const files = [
        'reflex.esm.js',
        'reflex.cjs',
        'reflex.iife.js',
        'reflex.min.js',
        'csp/index.esm.js',
        'csp/index.cjs',
        'hydration/index.esm.js',
        'hydration/index.cjs',
        'hydration/index.iife.js',
        'scoped-css/index.esm.js',
        'scoped-css/index.cjs',
        'runtime-helpers.esm.js',
        'runtime-helpers.cjs',
      ];

      for (const file of files) {
        const filePath = path.join(distDir, file);
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          const sizeKb = (stats.size / 1024).toFixed(2);
          console.log(`  ${file}: ${sizeKb} KB`);
        }
      }

      console.log('\nBuild complete!');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
