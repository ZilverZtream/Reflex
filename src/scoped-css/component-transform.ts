/**
 * Component Transformation Module
 *
 * Transforms complete components with scoped styles.
 * Handles extraction of <style scoped> blocks and template transformation.
 */

import { generateScopeId, transformCSS } from './css-transform.js';
import { transformTemplate, transformTemplateInJS } from './template-transform.js';

// ============================================================================
// STYLE EXTRACTION
// ============================================================================

/**
 * Extract <style> blocks from HTML/component source.
 *
 * @param {string} source - Component source code
 * @returns {Array<{
 *   content: string,
 *   scoped: boolean,
 *   lang: string|null,
 *   start: number,
 *   end: number,
 *   original: string
 * }>}
 */
export function extractStyles(source) {
  const styles = [];
  const styleRegex = /<style(\s+[^>]*)?>([^]*?)<\/style>/gi;
  let match;

  while ((match = styleRegex.exec(source)) !== null) {
    const attrsStr = match[1] || '';
    const content = match[2];

    // Parse attributes
    const scoped = /\bscoped\b/i.test(attrsStr);
    const langMatch = attrsStr.match(/\blang\s*=\s*["']?([^"'\s>]+)/i);
    const lang = langMatch ? langMatch[1] : null;

    styles.push({
      content,
      scoped,
      lang,
      start: match.index,
      end: match.index + match[0].length,
      original: match[0]
    });
  }

  return styles;
}

// ============================================================================
// TEMPLATE EXTRACTION
// ============================================================================

/**
 * Extract template from component source.
 *
 * Supports:
 * - <template>...</template> tags (SFC-style)
 * - template: '...' property in JS objects
 * - template: `...` template literals
 *
 * @param {string} source - Component source
 * @returns {{
 *   content: string,
 *   start: number,
 *   end: number,
 *   type: 'tag'|'property',
 *   quote?: string
 * } | null}
 */
export function extractTemplate(source) {
  // Check for <template> tag first (SFC-style)
  const templateTagMatch = source.match(/<template(\s+[^>]*)?>([^]*?)<\/template>/i);
  if (templateTagMatch) {
    const contentStart = source.indexOf(templateTagMatch[2], templateTagMatch.index);
    return {
      content: templateTagMatch[2],
      start: templateTagMatch.index,
      end: templateTagMatch.index + templateTagMatch[0].length,
      contentStart,
      contentEnd: contentStart + templateTagMatch[2].length,
      type: 'tag'
    };
  }

  // Check for template property in JS
  // Handle multiline template literals
  const templateLiteralMatch = source.match(/template\s*:\s*`([^`]*(?:\\`[^`]*)*)`/);
  if (templateLiteralMatch) {
    const content = templateLiteralMatch[1].replace(/\\`/g, '`').replace(/\\\$/g, '$');
    return {
      content,
      start: templateLiteralMatch.index,
      end: templateLiteralMatch.index + templateLiteralMatch[0].length,
      type: 'property',
      quote: '`'
    };
  }

  // Handle single-quoted template
  const singleQuoteMatch = source.match(/template\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/);
  if (singleQuoteMatch) {
    const content = singleQuoteMatch[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
    return {
      content,
      start: singleQuoteMatch.index,
      end: singleQuoteMatch.index + singleQuoteMatch[0].length,
      type: 'property',
      quote: "'"
    };
  }

  // Handle double-quoted template
  const doubleQuoteMatch = source.match(/template\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (doubleQuoteMatch) {
    const content = doubleQuoteMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    return {
      content,
      start: doubleQuoteMatch.index,
      end: doubleQuoteMatch.index + doubleQuoteMatch[0].length,
      type: 'property',
      quote: '"'
    };
  }

  return null;
}

// ============================================================================
// COMPONENT TRANSFORMATION
// ============================================================================

/**
 * Transform a complete component with scoped styles.
 *
 * This function:
 * 1. Generates a unique scope ID for the component
 * 2. Extracts and transforms all <style scoped> blocks
 * 3. Transforms the template to add scope attributes
 * 4. Returns the transformed code and extracted CSS
 *
 * @param {string} source - Component source code
 * @param {string} [componentName=''] - Component name for hash uniqueness
 * @param {Object} [options] - Transform options
 * @param {boolean} [options.removeStyles=false] - Remove style tags from output
 * @param {boolean} [options.minifyCSS=false] - Minify extracted CSS
 * @returns {{
 *   code: string,
 *   css: string,
 *   scopeId: string|null,
 *   styles: Array<{content: string, scoped: boolean}>
 * }}
 */
export interface ComponentTransformOptions {
  removeStyles?: boolean;
  minifyCSS?: boolean;
}

export function transformComponent(
  source: string,
  componentName = '',
  options: ComponentTransformOptions = {}
) {
  const {
    removeStyles = false,
    minifyCSS = false
  } = options;

  // Extract styles
  const styles = extractStyles(source);
  const scopedStyles = styles.filter(s => s.scoped);

  // If no scoped styles, return source unchanged
  if (scopedStyles.length === 0) {
    return {
      code: source,
      css: '',
      scopeId: null,
      styles
    };
  }

  // Generate scope ID based on scoped style content
  const scopeContent = scopedStyles.map(s => s.content).join('');
  const scopeId = generateScopeId(scopeContent, componentName);

  // Transform CSS for all scoped styles
  let collectedCSS = '';
  for (const style of scopedStyles) {
    let css = transformCSS(style.content, scopeId);
    if (minifyCSS) {
      css = css.replace(/\s+/g, ' ').replace(/\s*([{};:,])\s*/g, '$1').trim();
    }
    collectedCSS += css + '\n';
  }

  // Process source - work from end to start to preserve positions
  let transformedSource = source;
  const allStyles = [...styles].sort((a, b) => b.start - a.start);

  for (const style of allStyles) {
    if (style.scoped && removeStyles) {
      // Remove the entire style block
      transformedSource =
        transformedSource.slice(0, style.start) +
        transformedSource.slice(style.end);
    } else if (style.scoped) {
      // Replace with transformed CSS in place
      const transformed = transformCSS(style.content, scopeId);
      const replacement = `<style>${transformed}</style>`;
      transformedSource =
        transformedSource.slice(0, style.start) +
        replacement +
        transformedSource.slice(style.end);
    }
  }

  // Transform template
  const template = extractTemplate(transformedSource);
  if (template) {
    if (template.type === 'tag') {
      // SFC-style template tag
      const transformedContent = transformTemplate(template.content, scopeId);
      const before = transformedSource.slice(0, template.contentStart);
      const after = transformedSource.slice(template.contentEnd);
      transformedSource = before + transformedContent + after;
    } else {
      // JavaScript template property
      transformedSource = transformTemplateInJS(transformedSource, scopeId);
    }
  }

  return {
    code: transformedSource,
    css: collectedCSS.trim(),
    scopeId,
    styles
  };
}

/**
 * Process multiple component files and collect their scoped CSS.
 *
 * @param {Array<{source: string, name: string, path: string}>} components
 * @returns {{
 *   results: Array<{code: string, css: string, scopeId: string, path: string}>,
 *   combinedCSS: string
 * }}
 */
export function processComponents(components) {
  const results = [];
  let combinedCSS = '';

  for (const { source, name, path } of components) {
    const result = transformComponent(source, name, { removeStyles: true });
    results.push({
      code: result.code,
      css: result.css,
      scopeId: result.scopeId,
      path
    });
    if (result.css) {
      combinedCSS += `/* ${path} */\n${result.css}\n\n`;
    }
  }

  return {
    results,
    combinedCSS: combinedCSS.trim()
  };
}

/**
 * Create a CSS injection helper for runtime usage.
 * This is useful when you need to inject scoped CSS at runtime
 * (though build-time injection is preferred for 0KB overhead).
 *
 * Note: Using this adds minimal runtime code. For true zero-runtime,
 * inject CSS via build tools instead.
 *
 * @param {string} css - CSS content
 * @param {string} [id] - Optional ID for the style element
 * @returns {string} JavaScript code to inject CSS
 */
export function createCSSInjector(css, id) {
  const escapedCSS = css.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const idAttr = id ? ` id="${id}"` : '';

  return `(function(){
  if(typeof document==='undefined')return;
  var s=document.createElement('style');
  s.textContent=\`${escapedCSS}\`;
  ${id ? `s.id='${id}';` : ''}
  document.head.appendChild(s);
})();`;
}
