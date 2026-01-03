/**
 * @reflex/compiler - Vite Plugin
 * Integrates Reflex AOT compilation into Vite build process
 */

import type { Plugin } from 'vite';
import { compileSFC } from './index.js';
import type { CompilerOptions } from './types.js';
import path from 'path';

export interface ReflexPluginOptions extends CompilerOptions {
  /**
   * File extensions to process (default: ['.rfx'])
   */
  include?: string[];

  /**
   * File patterns to exclude
   */
  exclude?: string[];

  /**
   * Enable compiled mode (default: true in production)
   */
  compile?: boolean;
}

/**
 * Vite plugin for Reflex AOT compilation
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import reflex from '@reflex/compiler/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     reflex({
 *       hoistStatic: true,
 *       compile: true,
 *     }),
 *   ],
 * });
 * ```
 */
export default function reflexPlugin(options: ReflexPluginOptions = {}): Plugin {
  const {
    include = ['.rfx'],
    exclude = [],
    compile = true,
    ...compilerOptions
  } = options;

  let isDev = false;

  return {
    name: 'vite-plugin-reflex',

    configResolved(config) {
      isDev = config.command === 'serve';
    },

    resolveId(id) {
      // Handle runtime helpers import
      if (id === '@reflex/core/runtime-helpers') {
        return '\0runtime-helpers';
      }
      return null;
    },

    load(id) {
      // Provide runtime helpers as virtual module
      if (id === '\0runtime-helpers') {
        return `
          export { createKeyedList, runTransition, toDisplayString } from '@reflex/compiler';
        `;
      }
      return null;
    },

    transform(code, id) {
      // Check if file should be processed
      const isIncluded = include.some(ext => id.endsWith(ext));
      const isExcluded = exclude.some(pattern =>
        typeof pattern === 'string' ? id.includes(pattern) : pattern.test(id)
      );

      if (!isIncluded || isExcluded) {
        return null;
      }

      // Determine if we should compile
      const shouldCompile = compile !== false && !isDev;

      if (!shouldCompile) {
        // Runtime mode - just export the template as string
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null,
        };
      }

      // Compile mode
      try {
        const filename = path.basename(id);
        const result = compileSFC(code, filename, {
          ...compilerOptions,
          dev: isDev,
          basePath: path.dirname(id),
          resolveComponent: (name) => {
            // Try to resolve component relative to current file
            const kebabName = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
            const possiblePaths = [
              `./${kebabName}.rfx`,
              `./${name}.rfx`,
              `../components/${kebabName}.rfx`,
              `../components/${name}.rfx`,
            ];

            // Return first path (Vite will handle resolution)
            return possiblePaths[0];
          },
        });

        if (result.warnings.length > 0) {
          for (const warning of result.warnings) {
            console.warn(`[reflex] ${filename}: ${warning.message}`);
          }
        }

        return {
          code: result.code,
          map: result.map || null,
        };
      } catch (error) {
        this.error({
          message: `Failed to compile ${id}: ${error instanceof Error ? error.message : String(error)}`,
          id,
        });
        return null;
      }
    },

    handleHotUpdate({ file, server }) {
      // Handle HMR for .rfx files
      if (include.some(ext => file.endsWith(ext))) {
        // Invalidate module and trigger full reload
        const module = server.moduleGraph.getModuleById(file);
        if (module) {
          server.moduleGraph.invalidateModule(module);
        }

        // Send HMR update
        server.ws.send({
          type: 'full-reload',
        });

        return [];
      }
    },
  };
}

// Named export for better tree-shaking
export { reflexPlugin };

/**
 * Helper function to create optimized production config
 */
export function createProductionConfig(
  userOptions: ReflexPluginOptions = {}
): Plugin {
  return reflexPlugin({
    hoistStatic: true,
    whitespace: 'condense',
    compile: true,
    sourceMap: false,
    ...userOptions,
  });
}

/**
 * Helper function to create development config
 */
export function createDevConfig(
  userOptions: ReflexPluginOptions = {}
): Plugin {
  return reflexPlugin({
    hoistStatic: false,
    whitespace: 'preserve',
    compile: false, // Use runtime mode for faster HMR
    dev: true,
    sourceMap: true,
    ...userOptions,
  });
}
