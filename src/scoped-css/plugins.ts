/**
 * Build Tool Plugins for Scoped CSS
 *
 * Zero-runtime CSS scoping plugins for popular build tools.
 * All CSS processing happens at build time - 0KB runtime overhead.
 */

import { transformComponent } from './component-transform.js';
import { minifyCSS } from './css-transform.js';

export interface ScopedCSSPluginOptions {
  include?: RegExp;
  exclude?: RegExp;
  cssOutput?: string | null;
  minify?: boolean;
  removeStyles?: boolean;
}

// ============================================================================
// ESBUILD PLUGIN
// ============================================================================

/**
 * esbuild plugin for zero-runtime scoped CSS.
 *
 * Features:
 * - Transforms <style scoped> blocks at build time
 * - Injects scope attributes into templates
 * - Collects and outputs all scoped CSS to a single file
 * - Supports .reflex, .vue, and .html files
 *
 * @param {Object} [options] - Plugin options
 * @param {RegExp} [options.include=/\.(reflex|vue|html)$/] - Files to process
 * @param {RegExp} [options.exclude=/node_modules/] - Files to skip
 * @param {string} [options.cssOutput] - Output path for combined CSS
 * @param {boolean} [options.minify=false] - Minify the CSS output
 * @param {boolean} [options.removeStyles=true] - Remove style tags from output
 * @returns {import('esbuild').Plugin}
 *
 * @example
 * import { scopedCSSPlugin } from 'reflex/scoped-css';
 *
 * esbuild.build({
 *   entryPoints: ['src/app.js'],
 *   bundle: true,
 *   plugins: [
 *     scopedCSSPlugin({
 *       cssOutput: 'dist/styles.css',
 *       minify: true
 *     })
 *   ]
 * });
 */
export function scopedCSSPlugin(options: ScopedCSSPluginOptions = {}) {
  const {
    include = /\.(reflex|vue|html)$/,
    exclude = /node_modules/,
    cssOutput = null,
    minify = false,
    removeStyles = true
  } = options;

  // Collect CSS from all processed files
  const cssCollection = new Map();

  return {
    name: 'reflex-scoped-css',

    setup(build) {
      // Process matching files
      build.onLoad({ filter: include }, async (args) => {
        // Skip excluded paths
        if (exclude && exclude.test(args.path)) {
          return null;
        }

        // Dynamic imports for Node.js modules
        const fs = await import('fs');
        const path = await import('path');

        // Read the source file
        const source = await fs.promises.readFile(args.path, 'utf8');

        // Get component name from filename
        const ext = path.extname(args.path);
        const componentName = path.basename(args.path, ext);

        // Transform the component
        const result = transformComponent(source, componentName, {
          removeStyles,
          minifyCSS: minify
        });

        // Collect the CSS
        if (result.css) {
          cssCollection.set(args.path, {
            css: result.css,
            scopeId: result.scopeId
          });
        }

        // Determine the appropriate loader
        let loader = 'js';
        if (ext === '.html') loader = 'text';
        else if (ext === '.vue') loader = 'js';

        return {
          contents: result.code,
          loader
        };
      });

      // Write collected CSS at end of build
      build.onEnd(async (buildResult) => {
        if (buildResult.errors.length > 0) {
          return;
        }

        if (cssOutput && cssCollection.size > 0) {
          const fs = await import('fs');
          const path = await import('path');

          // Combine all CSS
          let allCSS = '';
          for (const [filePath, { css, scopeId }] of cssCollection) {
            const relativePath = path.relative(process.cwd(), filePath);
            allCSS += `/* ${relativePath} [${scopeId}] */\n${css}\n\n`;
          }

          // Optionally minify the combined CSS
          if (minify) {
            allCSS = minifyCSS(allCSS);
          }

          // Ensure output directory exists
          const outDir = path.dirname(cssOutput);
          await fs.promises.mkdir(outDir, { recursive: true });

          // Write the CSS file
          await fs.promises.writeFile(cssOutput, allCSS.trim());

          console.log(`[scoped-css] Wrote ${cssCollection.size} component styles to ${cssOutput}`);
        }
      });
    }
  };
}

// ============================================================================
// VITE PLUGIN
// ============================================================================

/**
 * Vite plugin for zero-runtime scoped CSS.
 *
 * Features:
 * - HMR support for scoped styles
 * - Transforms components during dev and build
 * - Integrates with Vite's CSS handling
 *
 * @param {Object} [options] - Plugin options
 * @param {RegExp} [options.include=/\.(reflex|vue|html)$/] - Files to process
 * @param {RegExp} [options.exclude=/node_modules/] - Files to skip
 * @returns {import('vite').Plugin}
 *
 * @example
 * // vite.config.js
 * import { viteScopedCSS } from 'reflex/scoped-css';
 *
 * export default {
 *   plugins: [
 *     viteScopedCSS()
 *   ]
 * };
 */
export function viteScopedCSS(options: ScopedCSSPluginOptions = {}) {
  const {
    include = /\.(reflex|vue|html)$/,
    exclude = /node_modules/
  } = options;

  // Store CSS for virtual module resolution
  const cssModules = new Map();

  return {
    name: 'vite-reflex-scoped-css',
    enforce: 'pre',

    // Transform component files
    transform(code, id) {
      // Check if file should be processed
      if (!include.test(id) || (exclude && exclude.test(id))) {
        return null;
      }

      // Get component name from path
      const componentName = id.split('/').pop()?.replace(/\.[^.]+$/, '') || '';

      // Transform the component
      const result = transformComponent(code, componentName, {
        removeStyles: false // Keep inline for Vite's CSS handling
      });

      // Store CSS for virtual module if extracted
      if (result.css) {
        const cssModuleId = `${id}?scoped-css`;
        cssModules.set(cssModuleId, result.css);

        // Inject CSS import at the top of the module
        const cssImport = `import '${cssModuleId}';\n`;
        return {
          code: cssImport + result.code,
          map: null
        };
      }

      return {
        code: result.code,
        map: null
      };
    },

    // Resolve virtual CSS modules
    resolveId(id) {
      if (id.endsWith('?scoped-css')) {
        return id;
      }
      return null;
    },

    // Load virtual CSS modules
    load(id) {
      if (id.endsWith('?scoped-css')) {
        const css = cssModules.get(id);
        if (css) {
          return {
            code: css,
            map: null
          };
        }
      }
      return null;
    },

    // Handle HMR
    handleHotUpdate({ file, server }) {
      if (include.test(file)) {
        // Invalidate the module and its CSS
        const module = server.moduleGraph.getModuleById(file);
        if (module) {
          server.moduleGraph.invalidateModule(module);
        }

        const cssModule = server.moduleGraph.getModuleById(`${file}?scoped-css`);
        if (cssModule) {
          server.moduleGraph.invalidateModule(cssModule);
        }
      }
    }
  };
}

// ============================================================================
// ROLLUP PLUGIN
// ============================================================================

/**
 * Rollup plugin for zero-runtime scoped CSS.
 *
 * @param {Object} [options] - Plugin options
 * @param {RegExp} [options.include=/\.(reflex|vue|html)$/] - Files to process
 * @param {RegExp} [options.exclude=/node_modules/] - Files to skip
 * @param {string} [options.cssOutput] - Output path for combined CSS
 * @returns {import('rollup').Plugin}
 *
 * @example
 * // rollup.config.js
 * import { rollupScopedCSS } from 'reflex/scoped-css';
 *
 * export default {
 *   plugins: [
 *     rollupScopedCSS({
 *       cssOutput: 'dist/styles.css'
 *     })
 *   ]
 * };
 */
export function rollupScopedCSS(options: ScopedCSSPluginOptions = {}) {
  const {
    include = /\.(reflex|vue|html)$/,
    exclude = /node_modules/,
    cssOutput = null
  } = options;

  const cssCollection = new Map();

  return {
    name: 'rollup-reflex-scoped-css',

    async transform(code, id) {
      if (!include.test(id) || (exclude && exclude.test(id))) {
        return null;
      }

      const componentName = id.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const result = transformComponent(code, componentName, {
        removeStyles: true
      });

      if (result.css) {
        cssCollection.set(id, result.css);
      }

      return {
        code: result.code,
        map: null
      };
    },

    async generateBundle() {
      if (cssOutput && cssCollection.size > 0) {
        let allCSS = '';
        for (const [id, css] of cssCollection) {
          const fileName = id.split('/').pop();
          allCSS += `/* ${fileName} */\n${css}\n\n`;
        }

        this.emitFile({
          type: 'asset',
          fileName: cssOutput.replace(/^.*\//, ''),
          source: allCSS.trim()
        });
      }
    }
  };
}

// ============================================================================
// WEBPACK LOADER
// ============================================================================

/**
 * webpack loader for scoped CSS (exported as a string for documentation).
 * To use, create a separate loader file that imports this functionality.
 *
 * @example
 * // webpack.config.js
 * module.exports = {
 *   module: {
 *     rules: [
 *       {
 *         test: /\.(reflex|vue|html)$/,
 *         use: 'reflex-scoped-css-loader'
 *       }
 *     ]
 *   }
 * };
 */
export const webpackLoaderCode = `
const { transformComponent } = require('reflex/scoped-css');

module.exports = function(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const componentName = resourcePath.split('/').pop().replace(/\\.[^.]+$/, '');

  try {
    const result = transformComponent(source, componentName, {
      removeStyles: false
    });

    // Emit the CSS as a separate asset if needed
    if (result.css) {
      const cssFileName = componentName + '.scoped.css';
      this.emitFile(cssFileName, result.css);
    }

    callback(null, result.code);
  } catch (error) {
    callback(error);
  }
};
`;
