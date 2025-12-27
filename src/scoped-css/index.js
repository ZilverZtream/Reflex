/**
 * Reflex Scoped CSS Module
 *
 * Zero-runtime scoped CSS for Reflex components.
 * All processing happens at build time - 0KB runtime overhead.
 *
 * This module is designed for:
 * - Build tool integration (esbuild, Vite, Rollup)
 * - Pre-compilation of component styles
 * - CLI usage for manual processing
 *
 * @example
 * // In your build config
 * import { scopedCSSPlugin } from 'reflex/scoped-css';
 *
 * esbuild.build({
 *   plugins: [scopedCSSPlugin()],
 *   ...
 * });
 */

export { transformCSS, scopeSelector, generateScopeId } from './css-transform.js';
export { transformTemplate, injectScopeAttribute } from './template-transform.js';
export { transformComponent, extractStyles, extractTemplate } from './component-transform.js';
export { scopedCSSPlugin, viteScopedCSS } from './plugins.js';
