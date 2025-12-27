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
    entryPoints: [path.join(srcDir, 'index.js')],
    outfile: path.join(distDir, 'reflex.esm.js'),
    format: 'esm',
  },
  // Main library - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.js')],
    outfile: path.join(distDir, 'reflex.cjs'),
    format: 'cjs',
  },
  // Main library - IIFE (browser)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'index.js')],
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
    entryPoints: [path.join(srcDir, 'index.js')],
    outfile: path.join(distDir, 'reflex.min.js'),
    format: 'iife',
    globalName: 'Reflex',
    minify: true,
    sourcemap: false,
    footer: {
      js: 'if(typeof window!=="undefined"){window.Reflex=Reflex.Reflex;}'
    }
  },
  // CSP module - ESM
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.js')],
    outfile: path.join(distDir, 'csp', 'index.esm.js'),
    format: 'esm',
  },
  // CSP module - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.js')],
    outfile: path.join(distDir, 'csp', 'index.cjs'),
    format: 'cjs',
  },
  // CSP module - IIFE
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'csp', 'index.js')],
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
    entryPoints: [path.join(srcDir, 'hydration', 'index.js')],
    outfile: path.join(distDir, 'hydration', 'index.esm.js'),
    format: 'esm',
    // Mark core modules as external to avoid duplication
    external: ['../core/*'],
  },
  // Hydration module - CJS
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'hydration', 'index.js')],
    outfile: path.join(distDir, 'hydration', 'index.cjs'),
    format: 'cjs',
    external: ['../core/*'],
  },
  // Hydration module - IIFE (standalone, includes dependencies)
  {
    ...commonOptions,
    entryPoints: [path.join(srcDir, 'hydration', 'index.js')],
    outfile: path.join(distDir, 'hydration', 'index.iife.js'),
    format: 'iife',
    globalName: 'ReflexHydration',
    footer: {
      js: 'if(typeof window!=="undefined"){window.withHydration=ReflexHydration.withHydration;}'
    }
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

  fs.writeFileSync(path.join(distDir, 'reflex.d.ts'), mainDts);
  fs.writeFileSync(path.join(distDir, 'csp', 'index.d.ts'), cspDts);
  fs.writeFileSync(path.join(distDir, 'hydration', 'index.d.ts'), hydrationDts);
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
