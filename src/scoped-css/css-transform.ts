/**
 * CSS Transformation Module
 *
 * Provides CSS parsing and selector scoping at build time.
 * Handles complex CSS including:
 * - Nested selectors and combinators
 * - Pseudo-classes and pseudo-elements
 * - At-rules (@media, @keyframes, @supports)
 * - :deep() and :global() modifiers
 */

import { createHash } from 'crypto';

// ============================================================================
// HASH GENERATION
// ============================================================================

/**
 * Generate a deterministic scope ID from source content.
 *
 * @param {string} source - Source content to hash
 * @param {string} [name] - Optional name for additional uniqueness
 * @returns {string} Scope ID in format 'v-xxxxxx'
 */
export function generateScopeId(source, name = '') {
  const hash = createHash('md5')
    .update(source + name)
    .digest('hex')
    .slice(0, 6);
  return `v-${hash}`;
}

// ============================================================================
// CSS TOKENIZER
// ============================================================================

/**
 * Token types for the CSS lexer.
 * @enum {string}
 */
export const TokenType = Object.freeze({
  SELECTOR: 'selector',
  OPEN_BRACE: '{',
  CLOSE_BRACE: '}',
  DECLARATION: 'declaration',
  AT_RULE: 'at-rule',
  COMMENT: 'comment',
});

/**
 * Tokenize CSS source into a token stream.
 *
 * @param {string} css - CSS source code
 * @returns {Array<{type: TokenType, value: string, line: number}>}
 */
export function tokenizeCSS(css) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const len = css.length;

  const pushToken = (type, value) => {
    tokens.push({ type, value, line });
  };

  while (i < len) {
    const ch = css[i];

    // Track line numbers
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Skip other whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comments: /* ... */
    if (ch === '/' && css[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(css[i] === '*' && css[i + 1] === '/')) {
        if (css[i] === '\n') line++;
        i++;
      }
      i += 2; // Skip */
      pushToken(TokenType.COMMENT, css.slice(start, i));
      continue;
    }

    // Opening brace
    if (ch === '{') {
      pushToken(TokenType.OPEN_BRACE, '{');
      i++;
      continue;
    }

    // Closing brace
    if (ch === '}') {
      pushToken(TokenType.CLOSE_BRACE, '}');
      i++;
      continue;
    }

    // At-rules: @media, @keyframes, @supports, etc.
    if (ch === '@') {
      const start = i;
      i++;
      // Read at-rule name
      while (i < len && /[a-zA-Z-]/.test(css[i])) i++;
      // Read at-rule prelude (until { or ;)
      while (i < len && css[i] !== '{' && css[i] !== ';') {
        if (css[i] === '\n') line++;
        i++;
      }
      const value = css.slice(start, i).trim();
      pushToken(TokenType.AT_RULE, value);
      if (css[i] === ';') i++; // Skip terminating semicolon
      continue;
    }

    // Selector or declaration - read until we hit { or ; at depth 0
    const start = i;
    let braceDepth = 0;
    let inString = false;
    let stringChar = '';

    while (i < len) {
      const c = css[i];

      // Track string literals
      if ((c === '"' || c === "'") && css[i - 1] !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = c;
        } else if (c === stringChar) {
          inString = false;
        }
        i++;
        continue;
      }

      if (inString) {
        if (c === '\n') line++;
        i++;
        continue;
      }

      // Track line numbers
      if (c === '\n') line++;

      // End of selector (before opening brace) or declaration (at semicolon)
      if (braceDepth === 0 && (c === '{' || c === ';' || c === '}')) {
        break;
      }

      // Track brace depth for nested blocks (like calc())
      if (c === '(') braceDepth++;
      else if (c === ')') braceDepth--;

      i++;
    }

    const value = css.slice(start, i).trim();
    if (value) {
      // Determine token type based on what follows
      if (css[i] === '{') {
        pushToken(TokenType.SELECTOR, value);
      } else {
        pushToken(TokenType.DECLARATION, value);
        if (css[i] === ';') i++;
      }
    }
  }

  return tokens;
}

// ============================================================================
// SELECTOR SCOPING
// ============================================================================

/**
 * CSS combinator pattern.
 * Matches: space, >, +, ~
 */
const COMBINATOR_RE = /(\s*[>+~]\s*|\s+)/;

/**
 * Elements that should not receive scope attributes.
 */
const SKIP_ELEMENTS = new Set(['html', 'body', 'head', ':root']);

/**
 * Scope a CSS selector by adding data attribute.
 *
 * Features:
 * - Simple selectors: .btn -> .btn[data-v-xxx]
 * - Compound: .btn.active -> .btn.active[data-v-xxx]
 * - Descendant: .parent .child -> .parent[data-v-xxx] .child[data-v-xxx]
 * - Child: .parent > .child -> .parent[data-v-xxx] > .child[data-v-xxx]
 * - Pseudo-elements: .btn::before -> .btn[data-v-xxx]::before
 * - :deep(.child) -> scopes parent only
 * - :global(.class) -> no scoping
 * - :slotted(.class) -> for slot content scoping
 *
 * @param {string} selector - CSS selector
 * @param {string} scopeId - Scope ID (e.g., 'v-abc123')
 * @returns {string} Scoped selector
 */
export function scopeSelector(selector, scopeId) {
  const dataAttr = `[data-${scopeId}]`;

  // Handle :global() - no scoping
  if (selector.includes(':global(')) {
    return selector.replace(/:global\(([^)]+)\)/g, '$1');
  }

  // Handle :deep() - scope ancestor only, not deep children
  if (selector.includes(':deep(')) {
    return selector.replace(
      /([^,]*?)\s*:deep\(\s*([^)]+)\s*\)/g,
      (_, before, inside) => {
        const scopedBefore = before.trim()
          ? scopeSingleSelector(before.trim(), dataAttr)
          : dataAttr;
        return `${scopedBefore} ${inside.trim()}`;
      }
    );
  }

  // Handle :slotted() - for styling slot content
  if (selector.includes(':slotted(')) {
    return selector.replace(
      /:slotted\(\s*([^)]+)\s*\)/g,
      (_, inside) => `${inside.trim()}${dataAttr}`
    );
  }

  // Handle comma-separated selector list
  if (selector.includes(',')) {
    return selector
      .split(',')
      .map(s => scopeSelector(s.trim(), scopeId))
      .join(', ');
  }

  // Split by combinators and scope each part
  const parts = selector.split(COMBINATOR_RE);
  const result = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Preserve combinators and whitespace as-is
    if (!part.trim() || /^[>+~]$/.test(part.trim())) {
      result.push(part);
      continue;
    }

    // Skip certain root selectors
    const lower = part.trim().toLowerCase();
    if (SKIP_ELEMENTS.has(lower)) {
      result.push(part);
      continue;
    }

    result.push(scopeSingleSelector(part.trim(), dataAttr));
  }

  return result.join('');
}

/**
 * Scope a single selector (no combinators).
 *
 * @param {string} selector - Single selector
 * @param {string} dataAttr - Data attribute (e.g., '[data-v-xxx]')
 * @returns {string} Scoped selector
 */
function scopeSingleSelector(selector, dataAttr) {
  if (!selector) return selector;

  // Universal selector
  if (selector === '*') {
    return `*${dataAttr}`;
  }

  // Find insertion point (before pseudo-elements)
  let insertPos = selector.length;

  // Pseudo-elements come last: ::before, ::after, ::placeholder, etc.
  const pseudoElementMatch = selector.match(/::[a-zA-Z-]+(\([^)]*\))?/);
  if (pseudoElementMatch) {
    insertPos = pseudoElementMatch.index;
  }

  return selector.slice(0, insertPos) + dataAttr + selector.slice(insertPos);
}

// ============================================================================
// CSS TRANSFORMATION
// ============================================================================

/**
 * Transform CSS with scoped selectors.
 *
 * @param {string} css - Original CSS
 * @param {string} scopeId - Scope ID
 * @param {Object} [options] - Options
 * @param {boolean} [options.preserveComments=true] - Keep CSS comments
 * @returns {string} Transformed CSS
 */
export interface ScopedCSSTransformOptions {
  preserveComments?: boolean;
}

export function transformCSS(css: string, scopeId: string, options: ScopedCSSTransformOptions = {}) {
  const { preserveComments = true } = options;

  const tokens = tokenizeCSS(css);
  const output = [];
  const atRuleStack = [];
  let indent = '';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token.type) {
      case TokenType.COMMENT:
        if (preserveComments) {
          output.push(token.value);
        }
        break;

      case TokenType.AT_RULE: {
        output.push(`${indent}${token.value}`);
        // Check if this at-rule has a block
        const next = tokens[i + 1];
        if (next?.type === TokenType.OPEN_BRACE) {
          atRuleStack.push(token.value);
        }
        break;
      }

      case TokenType.OPEN_BRACE:
        output.push(' {\n');
        indent = '  '.repeat(atRuleStack.length + 1);
        break;

      case TokenType.CLOSE_BRACE:
        if (atRuleStack.length > 0) {
          atRuleStack.pop();
        }
        indent = '  '.repeat(atRuleStack.length);
        output.push(`${indent}}\n`);
        break;

      case TokenType.SELECTOR: {
        // Don't scope inside @keyframes
        const inKeyframes = atRuleStack.some(r =>
          r.includes('@keyframes') || r.includes('@-webkit-keyframes')
        );

        if (inKeyframes) {
          output.push(`${indent}${token.value}`);
        } else {
          const scoped = scopeSelector(token.value, scopeId);
          output.push(`${indent}${scoped}`);
        }
        break;
      }

      case TokenType.DECLARATION:
        output.push(`${indent}${token.value};\n`);
        break;
    }
  }

  return output.join('').trim();
}

/**
 * Minify CSS by removing whitespace and comments.
 *
 * @param {string} css - CSS source
 * @returns {string} Minified CSS
 */
export function minifyCSS(css) {
  return css
    // Remove comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove whitespace around special characters
    .replace(/\s*([{};:,>+~])\s*/g, '$1')
    // Collapse multiple whitespace
    .replace(/\s+/g, ' ')
    // Remove whitespace at start/end
    .trim();
}
