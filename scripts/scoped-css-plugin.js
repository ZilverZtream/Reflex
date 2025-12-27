#!/usr/bin/env node
/**
 * Zero-Runtime Scoped CSS Build Plugin
 *
 * Transforms component styles at build time for true style encapsulation
 * with 0KB runtime overhead.
 *
 * Features:
 * - Generates unique hash for each component
 * - Rewrites CSS selectors at build time (.btn -> .btn[data-v-abc123])
 * - Transforms templates to inject scope attributes
 * - Compatible with esbuild and Vite
 *
 * Usage:
 *   import { scopedCSSPlugin, transformComponent } from './scoped-css-plugin.js';
 *
 *   // With esbuild
 *   esbuild.build({
 *     plugins: [scopedCSSPlugin()],
 *     ...
 *   });
 *
 *   // Direct usage
 *   const { css, template, scopeId } = transformComponent(source, 'my-component');
 */

import crypto from 'crypto';

// ============================================================================
// HASH GENERATION
// ============================================================================

/**
 * Generate a unique scope ID for a component.
 * Uses the component source content for deterministic hashing.
 *
 * @param {string} source - Component source code or identifier
 * @param {string} [name] - Optional component name for debugging
 * @returns {string} Scope ID in format 'v-xxxxxx'
 */
export function generateScopeId(source, name = '') {
  const hash = crypto
    .createHash('md5')
    .update(source + name)
    .digest('hex')
    .slice(0, 6);
  return `v-${hash}`;
}

/**
 * Generate a short hash for a string.
 * Used for creating unique identifiers.
 *
 * @param {string} str - Input string
 * @returns {string} 6-character hex hash
 */
export function shortHash(str) {
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 6);
}

// ============================================================================
// CSS PARSING AND TRANSFORMATION
// ============================================================================

/**
 * Token types for CSS lexer
 */
const TokenType = {
  SELECTOR: 'selector',
  OPEN_BRACE: '{',
  CLOSE_BRACE: '}',
  PROPERTY: 'property',
  VALUE: 'value',
  AT_RULE: 'at-rule',
  COMMENT: 'comment',
  STRING: 'string',
};

/**
 * Tokenize CSS into a stream of tokens.
 *
 * @param {string} css - CSS source code
 * @returns {Array<{type: string, value: string}>} Token stream
 */
function tokenizeCSS(css) {
  const tokens = [];
  let i = 0;
  const len = css.length;

  while (i < len) {
    const ch = css[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) {
        tokens.push({ type: TokenType.COMMENT, value: css.slice(i) });
        break;
      }
      tokens.push({ type: TokenType.COMMENT, value: css.slice(i, end + 2) });
      i = end + 2;
      continue;
    }

    // Braces
    if (ch === '{') {
      tokens.push({ type: TokenType.OPEN_BRACE, value: '{' });
      i++;
      continue;
    }
    if (ch === '}') {
      tokens.push({ type: TokenType.CLOSE_BRACE, value: '}' });
      i++;
      continue;
    }

    // At-rules (@media, @keyframes, etc.)
    if (ch === '@') {
      let j = i + 1;
      // Read the at-rule name and params
      while (j < len && css[j] !== '{' && css[j] !== ';') {
        j++;
      }
      tokens.push({ type: TokenType.AT_RULE, value: css.slice(i, j).trim() });
      i = j;
      continue;
    }

    // Selector or declaration
    let j = i;
    let inString = false;
    let stringChar = '';
    let braceDepth = 0;

    while (j < len) {
      const c = css[j];

      // Handle strings
      if ((c === '"' || c === "'") && css[j - 1] !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = c;
        } else if (c === stringChar) {
          inString = false;
        }
        j++;
        continue;
      }

      if (inString) {
        j++;
        continue;
      }

      // Track nested braces
      if (c === '{') {
        braceDepth++;
      } else if (c === '}') {
        if (braceDepth === 0) break;
        braceDepth--;
      }

      // End of selector/declaration block
      if ((c === '{' || c === ';') && braceDepth === 0) {
        break;
      }

      j++;
    }

    const value = css.slice(i, j).trim();
    if (value) {
      // Determine if this is a selector or property declaration
      const nextChar = css[j];
      if (nextChar === '{') {
        tokens.push({ type: TokenType.SELECTOR, value });
      } else if (value.includes(':')) {
        tokens.push({ type: TokenType.PROPERTY, value });
        if (css[j] === ';') j++; // Skip semicolon
      } else {
        tokens.push({ type: TokenType.SELECTOR, value });
      }
    }
    i = j;
  }

  return tokens;
}

/**
 * Scope individual CSS selectors by adding data attribute.
 *
 * Handles:
 * - Simple selectors: .btn -> .btn[data-v-xxx]
 * - Compound selectors: .btn.active -> .btn.active[data-v-xxx]
 * - Combinator selectors: .parent .child -> .parent[data-v-xxx] .child[data-v-xxx]
 * - Pseudo-elements: .btn::before -> .btn[data-v-xxx]::before
 * - Pseudo-classes: .btn:hover -> .btn[data-v-xxx]:hover
 * - Deep selectors: .parent :deep(.child) -> .parent[data-v-xxx] .child
 * - Global selectors: :global(.class) -> .class (unscoped)
 *
 * @param {string} selector - CSS selector string
 * @param {string} scopeId - Scope ID (e.g., 'v-abc123')
 * @returns {string} Scoped selector
 */
export function scopeSelector(selector, scopeId) {
  const dataAttr = `[data-${scopeId}]`;

  // Handle :global() - these selectors should NOT be scoped
  if (selector.includes(':global(')) {
    return selector.replace(/:global\(([^)]+)\)/g, '$1');
  }

  // Handle :deep() - scope only the part before :deep
  if (selector.includes(':deep(')) {
    const deepRegex = /(.+?)\s*:deep\(([^)]+)\)/g;
    return selector.replace(deepRegex, (_, before, inside) => {
      const scopedBefore = scopeSimpleSelector(before.trim(), dataAttr);
      return `${scopedBefore} ${inside}`;
    });
  }

  // Split by combinators (space, >, +, ~) while preserving them
  const parts = selector.split(/(\s*[>+~]\s*|\s+)/);
  const scopedParts = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Skip empty parts and combinators
    if (!part.trim() || /^[>+~]$/.test(part.trim())) {
      scopedParts.push(part);
      continue;
    }

    // Skip if it's just whitespace between combinators
    if (/^\s+$/.test(part) && i > 0 && i < parts.length - 1) {
      scopedParts.push(part);
      continue;
    }

    scopedParts.push(scopeSimpleSelector(part.trim(), dataAttr));
  }

  return scopedParts.join('');
}

/**
 * Scope a simple selector (without combinators).
 *
 * @param {string} selector - Simple selector
 * @param {string} dataAttr - Data attribute to add (e.g., '[data-v-xxx]')
 * @returns {string} Scoped selector
 */
function scopeSimpleSelector(selector, dataAttr) {
  if (!selector) return selector;

  // Handle * (universal selector)
  if (selector === '*') {
    return `*${dataAttr}`;
  }

  // Find where to insert the data attribute
  // It should go before pseudo-elements (::) but after pseudo-classes (:)
  // and after attribute selectors
  let insertPos = selector.length;

  // Find the position of pseudo-element (::before, ::after, etc.)
  const pseudoElementMatch = selector.match(/::[a-zA-Z-]+/);
  if (pseudoElementMatch) {
    insertPos = pseudoElementMatch.index;
  }

  // Insert the scope attribute
  return selector.slice(0, insertPos) + dataAttr + selector.slice(insertPos);
}

/**
 * Parse and transform CSS with scoped selectors.
 *
 * @param {string} css - Original CSS
 * @param {string} scopeId - Scope ID
 * @param {Object} [options] - Transform options
 * @param {boolean} [options.deep=false] - Scope all descendants
 * @returns {string} Transformed CSS
 */
export function transformCSS(css, scopeId, options = {}) {
  const tokens = tokenizeCSS(css);
  const output = [];
  let inAtRule = false;
  let atRuleStack = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token.type) {
      case TokenType.COMMENT:
        output.push(token.value);
        break;

      case TokenType.AT_RULE:
        output.push(token.value);
        // Track at-rules that contain blocks
        if (tokens[i + 1]?.type === TokenType.OPEN_BRACE) {
          atRuleStack.push(token.value);
          inAtRule = true;
        }
        break;

      case TokenType.OPEN_BRACE:
        output.push(' {');
        break;

      case TokenType.CLOSE_BRACE:
        output.push('}');
        if (atRuleStack.length > 0) {
          atRuleStack.pop();
          if (atRuleStack.length === 0) {
            inAtRule = false;
          }
        }
        break;

      case TokenType.SELECTOR:
        // Don't scope selectors inside @keyframes
        const inKeyframes = atRuleStack.some(rule => rule.includes('@keyframes'));
        if (inKeyframes) {
          output.push(token.value);
        } else {
          // Scope each selector in a comma-separated list
          const selectors = token.value.split(',').map(s => s.trim());
          const scopedSelectors = selectors.map(sel => scopeSelector(sel, scopeId));
          output.push(scopedSelectors.join(', '));
        }
        break;

      case TokenType.PROPERTY:
        output.push(token.value + ';');
        break;
    }
  }

  return output.join('\n').replace(/\n+/g, '\n').trim();
}

// ============================================================================
// TEMPLATE TRANSFORMATION
// ============================================================================

/**
 * Regular expression to match HTML tags.
 */
const TAG_REGEX = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)\/?>/g;

/**
 * Check if a tag is a void element (self-closing).
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Transform HTML template to add scope attributes.
 *
 * @param {string} template - HTML template string
 * @param {string} scopeId - Scope ID
 * @returns {string} Transformed template
 */
export function transformTemplate(template, scopeId) {
  const dataAttr = `data-${scopeId}`;

  return template.replace(TAG_REGEX, (match, tagName, attrs) => {
    // Skip script, style, and template tags
    if (['script', 'style', 'template'].includes(tagName.toLowerCase())) {
      return match;
    }

    // Skip if already has the scope attribute
    if (attrs && attrs.includes(dataAttr)) {
      return match;
    }

    // Add the scope attribute
    const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase());
    const isSelfClosing = match.endsWith('/>');

    if (isSelfClosing) {
      return `<${tagName}${attrs || ''} ${dataAttr} />`;
    } else if (isVoid) {
      return `<${tagName}${attrs || ''} ${dataAttr}>`;
    } else {
      return `<${tagName}${attrs || ''} ${dataAttr}>`;
    }
  });
}

// ============================================================================
// COMPONENT TRANSFORMATION
// ============================================================================

/**
 * Extract <style scoped> blocks from HTML/component source.
 *
 * @param {string} source - Component source
 * @returns {Array<{content: string, scoped: boolean, start: number, end: number}>}
 */
export function extractStyles(source) {
  const styles = [];
  const styleRegex = /<style(\s+[^>]*)?>([^]*?)<\/style>/gi;
  let match;

  while ((match = styleRegex.exec(source)) !== null) {
    const attrs = match[1] || '';
    const content = match[2];
    const scoped = /\bscoped\b/.test(attrs);

    styles.push({
      content,
      scoped,
      start: match.index,
      end: match.index + match[0].length,
      original: match[0]
    });
  }

  return styles;
}

/**
 * Extract template from component source.
 * Supports both <template> tags and template property in object definitions.
 *
 * @param {string} source - Component source
 * @returns {{content: string, start: number, end: number} | null}
 */
export function extractTemplate(source) {
  // Check for <template> tag
  const templateMatch = source.match(/<template(\s+[^>]*)?>([^]*?)<\/template>/i);
  if (templateMatch) {
    return {
      content: templateMatch[2],
      start: templateMatch.index,
      end: templateMatch.index + templateMatch[0].length,
      type: 'tag'
    };
  }

  // Check for template: '...' or template: "..." or template: `...`
  const templatePropMatch = source.match(/template\s*:\s*(['"`])([^]*?)\1/);
  if (templatePropMatch) {
    return {
      content: templatePropMatch[2],
      start: templatePropMatch.index,
      end: templatePropMatch.index + templatePropMatch[0].length,
      type: 'property',
      quote: templatePropMatch[1]
    };
  }

  return null;
}

/**
 * Transform a component with scoped styles.
 *
 * @param {string} source - Component source code
 * @param {string} [componentName] - Component name for hash generation
 * @param {Object} [options] - Transform options
 * @returns {{
 *   code: string,
 *   css: string,
 *   scopeId: string,
 *   map: null
 * }}
 */
export function transformComponent(source, componentName = '', options = {}) {
  // Generate scope ID
  const scopeId = generateScopeId(source, componentName);

  // Extract styles
  const styles = extractStyles(source);
  const scopedStyles = styles.filter(s => s.scoped);

  // If no scoped styles, return source unchanged
  if (scopedStyles.length === 0) {
    return {
      code: source,
      css: '',
      scopeId: null,
      map: null
    };
  }

  // Extract and transform template
  const template = extractTemplate(source);
  let transformedSource = source;
  let collectedCSS = '';

  // Transform each scoped style block
  for (const style of scopedStyles) {
    const transformedCSS = transformCSS(style.content, scopeId);
    collectedCSS += transformedCSS + '\n';
  }

  // Remove style tags from source and add scope attribute to template
  // Process in reverse order to maintain correct positions
  const allStyles = [...styles].reverse();
  for (const style of allStyles) {
    if (style.scoped) {
      // Remove scoped style blocks (CSS will be output separately)
      transformedSource =
        transformedSource.slice(0, style.start) +
        transformedSource.slice(style.end);
    }
  }

  // Transform template to add scope attributes
  if (template) {
    const transformedTemplate = transformTemplate(template.content, scopeId);

    if (template.type === 'tag') {
      const templateTag = transformedSource.match(/<template(\s+[^>]*)?>/i);
      if (templateTag) {
        const templateStart = transformedSource.indexOf(template.content);
        if (templateStart !== -1) {
          transformedSource =
            transformedSource.slice(0, templateStart) +
            transformedTemplate +
            transformedSource.slice(templateStart + template.content.length);
        }
      }
    } else if (template.type === 'property') {
      // For template property in JS objects
      const quote = template.quote;
      const escapedTemplate = transformedTemplate.replace(/\\/g, '\\\\');
      const newTemplateValue = `template: ${quote}${escapedTemplate}${quote}`;

      // Find and replace the template property
      const templatePropRegex = /template\s*:\s*(['"`])([^]*?)\1/;
      transformedSource = transformedSource.replace(templatePropRegex, newTemplateValue);
    }
  }

  return {
    code: transformedSource,
    css: collectedCSS.trim(),
    scopeId,
    map: null
  };
}

// ============================================================================
// ESBUILD PLUGIN
// ============================================================================

/**
 * esbuild plugin for scoped CSS processing.
 *
 * @param {Object} [options] - Plugin options
 * @param {RegExp} [options.include] - Files to include
 * @param {RegExp} [options.exclude] - Files to exclude
 * @param {string} [options.cssOutput] - Output path for collected CSS
 * @returns {import('esbuild').Plugin}
 */
export function scopedCSSPlugin(options = {}) {
  const {
    include = /\.(reflex|vue|html)$/,
    exclude = /node_modules/,
    cssOutput = null
  } = options;

  const collectedCSS = new Map();

  return {
    name: 'scoped-css',
    setup(build) {
      // Transform component files
      build.onLoad({ filter: include }, async (args) => {
        if (exclude.test(args.path)) {
          return null;
        }

        const fs = await import('fs');
        const path = await import('path');

        const source = await fs.promises.readFile(args.path, 'utf8');
        const componentName = path.basename(args.path, path.extname(args.path));

        const result = transformComponent(source, componentName);

        if (result.css) {
          collectedCSS.set(args.path, result.css);
        }

        return {
          contents: result.code,
          loader: args.path.endsWith('.html') ? 'text' : 'js'
        };
      });

      // Write collected CSS at end of build
      build.onEnd(async () => {
        if (cssOutput && collectedCSS.size > 0) {
          const fs = await import('fs');
          const path = await import('path');

          const allCSS = Array.from(collectedCSS.values()).join('\n\n');

          await fs.promises.mkdir(path.dirname(cssOutput), { recursive: true });
          await fs.promises.writeFile(cssOutput, allCSS);

          console.log(`Scoped CSS written to: ${cssOutput}`);
        }
      });
    }
  };
}

// ============================================================================
// VITE PLUGIN
// ============================================================================

/**
 * Vite plugin for scoped CSS processing.
 *
 * @param {Object} [options] - Plugin options
 * @param {RegExp} [options.include] - Files to include
 * @param {RegExp} [options.exclude] - Files to exclude
 * @returns {import('vite').Plugin}
 */
export function viteScopedCSS(options = {}) {
  const {
    include = /\.(reflex|vue|html)$/,
    exclude = /node_modules/
  } = options;

  const cssMap = new Map();

  return {
    name: 'vite-scoped-css',
    enforce: 'pre',

    transform(code, id) {
      if (!include.test(id) || exclude.test(id)) {
        return null;
      }

      const componentName = id.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const result = transformComponent(code, componentName);

      if (result.css) {
        cssMap.set(id, result.css);
      }

      return {
        code: result.code,
        map: null
      };
    },

    // Handle CSS imports
    resolveId(id) {
      if (id.endsWith('?scoped-css')) {
        return id;
      }
      return null;
    },

    load(id) {
      if (id.endsWith('?scoped-css')) {
        const originalId = id.replace('?scoped-css', '');
        const css = cssMap.get(originalId);
        return css || '';
      }
      return null;
    }
  };
}

// ============================================================================
// CLI USAGE
// ============================================================================

/**
 * Process a single file and output scoped CSS.
 * Used for testing and debugging.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Scoped CSS Build Plugin

Usage:
  node scoped-css-plugin.js <input-file> [output-css]

Examples:
  node scoped-css-plugin.js component.html
  node scoped-css-plugin.js component.html dist/component.css

Options:
  --help    Show this help message
`);
    process.exit(0);
  }

  const inputFile = args[0];
  const outputFile = args[1];

  const fs = await import('fs');
  const path = await import('path');

  const source = await fs.promises.readFile(inputFile, 'utf8');
  const componentName = path.basename(inputFile, path.extname(inputFile));

  const result = transformComponent(source, componentName);

  console.log('Scope ID:', result.scopeId);
  console.log('\n=== Transformed Code ===\n');
  console.log(result.code);
  console.log('\n=== Scoped CSS ===\n');
  console.log(result.css);

  if (outputFile) {
    await fs.promises.writeFile(outputFile, result.css);
    console.log(`\nCSS written to: ${outputFile}`);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export default {
  generateScopeId,
  shortHash,
  scopeSelector,
  transformCSS,
  transformTemplate,
  transformComponent,
  extractStyles,
  extractTemplate,
  scopedCSSPlugin,
  viteScopedCSS
};
