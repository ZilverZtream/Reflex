/**
 * Template Transformation Module
 *
 * Injects scope attributes into HTML templates at build time.
 * Adds data-v-{hash} attributes to all elements for CSS scoping.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Void elements that are self-closing and have no content.
 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Elements that should not receive scope attributes.
 */
const SKIP_ELEMENTS = new Set([
  'html', 'head', 'body', 'script', 'style', 'template', 'slot'
]);

/**
 * SVG namespace elements that need special handling.
 */
const SVG_ELEMENTS = new Set([
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'ellipse', 'g', 'defs', 'symbol', 'use', 'text', 'tspan', 'image',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient',
  'radialGradient', 'stop', 'filter', 'feBlend', 'feColorMatrix',
  'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feFlood', 'feFuncR',
  'feFuncG', 'feFuncB', 'feFuncA', 'feGaussianBlur', 'feImage',
  'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'feSpecularLighting', 'feTile', 'feTurbulence', 'foreignObject'
]);

// ============================================================================
// HTML TOKENIZER
// ============================================================================

/**
 * Token types for HTML parsing.
 */
const HtmlTokenType = {
  TEXT: 'text',
  OPEN_TAG: 'open_tag',
  CLOSE_TAG: 'close_tag',
  SELF_CLOSE_TAG: 'self_close_tag',
  COMMENT: 'comment',
  DOCTYPE: 'doctype',
};

/**
 * Parse HTML into a token stream for transformation.
 *
 * @param {string} html - HTML source
 * @returns {Array<{type: string, raw: string, tagName?: string, attrs?: string}>}
 */
function tokenizeHTML(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    // Look for tag start
    const tagStart = html.indexOf('<', i);

    // Text before next tag
    if (tagStart === -1) {
      if (i < len) {
        tokens.push({ type: HtmlTokenType.TEXT, raw: html.slice(i) });
      }
      break;
    }

    if (tagStart > i) {
      tokens.push({ type: HtmlTokenType.TEXT, raw: html.slice(i, tagStart) });
    }

    i = tagStart;

    // Comment: <!-- ... -->
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1) {
        tokens.push({ type: HtmlTokenType.COMMENT, raw: html.slice(i) });
        break;
      }
      tokens.push({ type: HtmlTokenType.COMMENT, raw: html.slice(i, end + 3) });
      i = end + 3;
      continue;
    }

    // DOCTYPE: <!DOCTYPE ...>
    if (html.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        tokens.push({ type: HtmlTokenType.DOCTYPE, raw: html.slice(i) });
        break;
      }
      tokens.push({ type: HtmlTokenType.DOCTYPE, raw: html.slice(i, end + 1) });
      i = end + 1;
      continue;
    }

    // CDATA: <![CDATA[ ... ]]>
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9);
      if (end === -1) {
        tokens.push({ type: HtmlTokenType.TEXT, raw: html.slice(i) });
        break;
      }
      tokens.push({ type: HtmlTokenType.TEXT, raw: html.slice(i, end + 3) });
      i = end + 3;
      continue;
    }

    // Closing tag: </tagname>
    if (html[i + 1] === '/') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        tokens.push({ type: HtmlTokenType.TEXT, raw: html.slice(i) });
        break;
      }
      const content = html.slice(i + 2, end);
      const tagName = content.trim().toLowerCase();
      tokens.push({
        type: HtmlTokenType.CLOSE_TAG,
        raw: html.slice(i, end + 1),
        tagName
      });
      i = end + 1;
      continue;
    }

    // Opening tag: <tagname ...> or <tagname ... />
    const tagMatch = html.slice(i).match(/^<([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)(\/?)\s*>/);
    if (tagMatch) {
      const [full, tagName, attrs, selfClose] = tagMatch;
      const hasSlash = selfClose === '/';
      const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase());

      tokens.push({
        type: (hasSlash || isVoid) ? HtmlTokenType.SELF_CLOSE_TAG : HtmlTokenType.OPEN_TAG,
        raw: full,
        tagName: tagName.toLowerCase(),
        attrs: attrs,
        hasSlash: hasSlash  // Preserve original format
      });
      i += full.length;
      continue;
    }

    // Unrecognized - treat as text
    tokens.push({ type: HtmlTokenType.TEXT, raw: html[i] });
    i++;
  }

  return tokens;
}

// ============================================================================
// TEMPLATE TRANSFORMATION
// ============================================================================

/**
 * Inject scope attribute into an element's attribute string.
 *
 * @param {string} attrs - Existing attributes string
 * @param {string} scopeAttr - Scope attribute name (e.g., 'data-v-abc123')
 * @returns {string} Modified attributes string
 */
export function injectScopeAttribute(attrs, scopeAttr) {
  // Check if already has this attribute
  if (attrs.includes(scopeAttr)) {
    return attrs;
  }

  // Normalize: trim trailing whitespace and add single space before new attr
  const trimmed = attrs.trimEnd();

  // Add the scope attribute
  if (trimmed) {
    return `${trimmed} ${scopeAttr}`;
  }
  return ` ${scopeAttr}`;
}

/**
 * Transform an HTML template to add scope attributes to all elements.
 *
 * @param {string} template - HTML template string
 * @param {string} scopeId - Scope ID (e.g., 'v-abc123')
 * @param {Object} [options] - Transform options
 * @param {boolean} [options.scopeSlots=false] - Add scope to slot elements
 * @param {Set<string>} [options.skip] - Additional elements to skip
 * @returns {string} Transformed template
 */
export interface TemplateTransformOptions {
  scopeSlots?: boolean;
  skip?: Set<string>;
}

export function transformTemplate(template: string, scopeId: string, options: TemplateTransformOptions = {}) {
  const {
    scopeSlots = false,
    skip = new Set()
  } = options;

  const scopeAttr = `data-${scopeId}`;
  const tokens = tokenizeHTML(template);
  const output = [];

  // Track nesting to skip children of certain elements
  const skipStack = [];

  for (const token of tokens) {
    // Check if we're inside a skipped element
    if (skipStack.length > 0) {
      output.push(token.raw);

      if (token.type === HtmlTokenType.OPEN_TAG) {
        skipStack.push(token.tagName);
      } else if (token.type === HtmlTokenType.CLOSE_TAG) {
        if (skipStack[skipStack.length - 1] === token.tagName) {
          skipStack.pop();
        }
      }
      continue;
    }

    switch (token.type) {
      case HtmlTokenType.OPEN_TAG:
      case HtmlTokenType.SELF_CLOSE_TAG: {
        const tagName = token.tagName;

        // Check if this element should be skipped
        const shouldSkip =
          SKIP_ELEMENTS.has(tagName) ||
          skip.has(tagName) ||
          (!scopeSlots && tagName === 'slot');

        if (shouldSkip) {
          output.push(token.raw);
          if (token.type === HtmlTokenType.OPEN_TAG) {
            skipStack.push(tagName);
          }
          continue;
        }

        // Inject scope attribute
        const attrs = injectScopeAttribute(token.attrs || '', scopeAttr);
        const isSelfClose = token.type === HtmlTokenType.SELF_CLOSE_TAG;

        if (isSelfClose && token.hasSlash) {
          // Explicit self-closing syntax: <img ... />
          output.push(`<${tagName}${attrs} />`);
        } else {
          // Regular tag or void element without slash: <div> or <input>
          output.push(`<${tagName}${attrs}>`);
        }
        break;
      }

      case HtmlTokenType.CLOSE_TAG:
      case HtmlTokenType.TEXT:
      case HtmlTokenType.COMMENT:
      case HtmlTokenType.DOCTYPE:
      default:
        output.push(token.raw);
        break;
    }
  }

  return output.join('');
}

/**
 * Transform template string in a JavaScript source.
 * Handles template literals and string literals containing HTML.
 *
 * @param {string} jsSource - JavaScript source code
 * @param {string} scopeId - Scope ID
 * @returns {string} Transformed JavaScript source
 */
export function transformTemplateInJS(jsSource, scopeId) {
  // Match template: '...' or template: "..." or template: `...`
  const templatePropRegex = /(template\s*:\s*)(['"`])([^]*?)\2/g;

  return jsSource.replace(templatePropRegex, (match, prefix, quote, content) => {
    const transformed = transformTemplate(content, scopeId);
    // Escape special characters for the quote type
    let escaped = transformed;
    if (quote === '`') {
      escaped = transformed.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    } else if (quote === "'") {
      escaped = transformed.replace(/'/g, "\\'").replace(/\n/g, '\\n');
    } else {
      escaped = transformed.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }
    return `${prefix}${quote}${escaped}${quote}`;
  });
}
