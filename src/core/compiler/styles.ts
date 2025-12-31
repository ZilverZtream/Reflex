/**
 * Reflex Core - Style Utilities
 *
 * CSS sanitization and style binding helpers.
 */

import { SAFE_URL_RE, RELATIVE_URL_RE } from '../symbols.js';

/**
 * StylesMixin for Reflex class.
 * Provides style binding and sanitization methods.
 */
export const StylesMixin = {
  /**
   * Convert class binding value to string
   *
   * CRITICAL: Array check MUST come before object check!
   * In JavaScript, Array.isArray([]) === true AND typeof [] === 'object'
   * If we check typeof first, arrays would be treated as objects:
   * - ['btn', 'active'] would become 'for (const k in arr)' → k='0', k='1'
   * - Result: class="0 1" instead of class="btn active"
   */
  _cls(this: any, v: any): string {
    if (!v) return '';
    if (typeof v === 'string') return v;
    // CRITICAL: Check Array BEFORE object to prevent array indices becoming class names
    if (Array.isArray(v)) return v.map((x: any) => this._cls(x)).filter(Boolean).join(' ');
    // Object map: { btn: true, active: false } → 'btn'
    if (typeof v === 'object') return Object.keys(v).filter(k => v[k]).join(' ');
    return String(v);
  },

  /**
   * Comprehensive URL decoding and sanitization
   * CRITICAL SECURITY FIX: Decode ALL HTML entities and strip control characters
   *
   * Browsers ignore control characters (tabs, newlines, etc.) in protocol schemes:
   * - "java\tscript:alert(1)" is executed as "javascript:alert(1)"
   * - "java\nscript:alert(1)" is executed as "javascript:alert(1)"
   *
   * This helper:
   * 1. Decodes ALL HTML entities (numeric, hex, and named including &Tab;, &NewLine;, etc.)
   * 2. Strips ALL control characters (0x00-0x1F, 0x7F-0x9F)
   * 3. Returns the sanitized URL ready for regex validation
   */
  _decodeAndSanitizeUrl(this: any, url: string): string {
    if (!url || typeof url !== 'string') return '';

    // Step 1: Decode ALL HTML entities
    const decoded = url
      // Decode numeric hex entities: &#x61; &#x61 (semicolon optional)
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      // Decode numeric decimal entities: &#97; &#97 (semicolon optional)
      .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      // Decode common named entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, '\u00A0')
      // Decode URL-relevant named entities
      .replace(/&colon;/g, ':')
      .replace(/&sol;/g, '/')
      .replace(/&quest;/g, '?')
      .replace(/&equals;/g, '=')
      .replace(/&num;/g, '#')
      .replace(/&percnt;/g, '%')
      .replace(/&commat;/g, '@')
      // CRITICAL FIX: Decode control character entities that were previously missing
      .replace(/&Tab;/g, '\t')
      .replace(/&NewLine;/g, '\n')
      .replace(/&excl;/g, '!')
      .replace(/&dollar;/g, '$')
      .replace(/&lpar;/g, '(')
      .replace(/&rpar;/g, ')')
      .replace(/&ast;/g, '*')
      .replace(/&plus;/g, '+')
      .replace(/&comma;/g, ',')
      .replace(/&period;/g, '.')
      .replace(/&semi;/g, ';');

    // Step 2: Strip ALL control characters
    // Control characters: 0x00-0x1F (includes \0, \t, \n, \r, etc.) and 0x7F-0x9F
    // Browsers ignore these in protocol schemes, so we must remove them before validation
    // This prevents attacks like "java\tscript:alert(1)" bypassing the regex
    const sanitized = decoded.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    return sanitized;
  },

  /**
   * Sanitize CSS string to prevent javascript: URL injection
   * CRITICAL SECURITY FIX #4: CSS Injection via String Interpolation
   *
   * VULNERABILITY: Regex parsing of CSS is fragile and can be bypassed:
   * - Escaped sequences: background-image: u\rl(javascript:alert(1))
   * - Comment injection: url("javascript:alert(1) /*")
   * - Expression() for IE: style="width: expression(alert(1))"
   *
   * SOLUTION: Enhanced validation with CSS escape sequence handling
   */
  _sanitizeStyleString(this: any, cssText: string): string {
    if (!cssText) return '';

    // CRITICAL: Detect and block CSS escape sequences in URLs
    // CSS allows backslash escapes like u\rl, java\script, etc.
    // We need to normalize these before validation
    const normalizeCSS = (css: string): string => {
      // Remove CSS escape sequences: \XX (hex) and \X (single char)
      // This prevents u\rl(javascript:...) bypass
      return css.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (match, char) => {
        // If it's a hex escape, convert it
        if (/^[0-9a-f]{1,6}$/i.test(char.trim())) {
          return String.fromCharCode(parseInt(char.trim(), 16));
        }
        // Single character escape
        return char;
      });
    };

    const normalized = normalizeCSS(cssText);

    // Block dangerous CSS features entirely
    const dangerousPatterns = [
      /javascript:/i,           // javascript: protocol
      /data:/i,                 // data: URLs (can contain scripts)
      /vbscript:/i,             // VBScript (IE legacy)
      /expression\s*\(/i,       // CSS expression() (IE)
      /-moz-binding/i,          // XBL binding (Firefox)
      /behavior\s*:/i,          // IE behavior
      /@import/i,               // CSS @import (can load external malicious CSS)
      /\/\*.*\*\//              // CSS comments (can be used to hide attacks)
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(normalized) || pattern.test(cssText)) {
        console.error(
          `Reflex Security: BLOCKED dangerous CSS pattern in style binding.\n` +
          `Pattern: ${pattern}\n` +
          'CSS injection attempt prevented. Use object-style bindings for dynamic styles.'
        );
        return ''; // Return empty string to block the entire style
      }
    }

    // Validate url() functions
    // CRITICAL FIX: Previous regex [^'")\s]+ failed to match URLs with whitespace inside quotes
    // Attack: url("java\tscript:alert(1)") would not match, bypassing validation
    // Fix: Use separate patterns for quoted vs unquoted URLs
    //   - Single-quoted: url('...')  - allows any chars except single quote
    //   - Double-quoted: url("...")  - allows any chars except double quote
    //   - Unquoted: url(...)         - allows only non-whitespace, non-quote chars
    const singleQuotedPattern = /url\s*\(\s*'([^']*)'\s*\)/gi;
    const doubleQuotedPattern = /url\s*\(\s*"([^"]*)"\s*\)/gi;
    const unquotedPattern = /url\s*\(\s*([^'"\s)]+)\s*\)/gi;

    let sanitized = cssText;

    // Process all three URL patterns
    const patterns = [
      { regex: singleQuotedPattern, name: 'single-quoted' },
      { regex: doubleQuotedPattern, name: 'double-quoted' },
      { regex: unquotedPattern, name: 'unquoted' }
    ];

    for (const { regex, name } of patterns) {
      const matches = Array.from(normalized.matchAll(regex));
      for (const match of matches) {
        const url = match[1];

        // CRITICAL FIX: Apply same sanitization as attribute URLs
        // Decode HTML entities and strip control characters before validation
        // This catches attacks like url("j&#97;va\tscript:alert(1)")
        const sanitizedUrl = this._decodeAndSanitizeUrl(url);

        // Validate the sanitized URL using the same logic as href/src attributes
        const isSafe = RELATIVE_URL_RE.test(sanitizedUrl) || SAFE_URL_RE.test(sanitizedUrl);
        if (!isSafe) {
          console.error(
            `Reflex Security: BLOCKED unsafe ${name} URL in style binding: ${url}\n` +
            `Sanitized form: ${sanitizedUrl}\n` +
            'Only http://, https://, mailto:, tel:, sms:, and relative URLs are allowed.\n' +
            'CSS injection attempt prevented.'
          );
          // Replace the entire url() with 'none'
          sanitized = sanitized.replace(match[0], 'none');
        }
      }
    }

    return sanitized;
  },

  /**
   * Convert style binding value to string
   * CRITICAL FIX: Support Arrays (consistent with _cls)
   * CRITICAL SECURITY FIX: Validate URLs in string-based style bindings
   */
  _sty(this: any, v: any): string {
    if (!v) return '';
    if (typeof v === 'string') {
      // CRITICAL SECURITY FIX: String path must also be sanitized
      // Previously only object bindings were validated, allowing bypass via:
      // :style="'background-image: url(javascript:alert(1))'"
      return this._sanitizeStyleString(v);
    }
    // CRITICAL: Check Array BEFORE object (same as _cls)
    // Arrays are objects, so typeof [] === 'object', but we need special handling
    if (Array.isArray(v)) {
      // Recursively process array elements and merge styles
      return v.map((x: any) => this._sty(x)).filter(Boolean).join('');
    }
    if (typeof v === 'object') {
      let s = '';
      for (const k in v) {
        const val = v[k];
        if (val != null && val !== false) {
          // Handle CSS variables (--custom-props) - preserve as-is
          // For regular properties, convert camelCase to kebab-case
          const prop = k.startsWith('--')
            ? k
            : k.replace(/([A-Z])/g, '-$1').toLowerCase();

          // CRITICAL SECURITY FIX (Issue #5): Sanitize CSS variable values
          // Previously, CSS variables bypassed all sanitization because they were just appended.
          // Attack: :style="{ '--bg': 'url(javascript:alert(1))' }"
          // If user CSS has: background: var(--bg);  → executes the malicious URL
          //
          // Solution: Apply the same sanitization to CSS variable values as to regular values.
          // This blocks javascript:, data:, and other dangerous URL protocols.
          let sanitizedVal = String(val);
          if (k.startsWith('--')) {
            // CSS variables can contain url() values that need sanitization
            sanitizedVal = this._sanitizeStyleString(sanitizedVal);
          }

          s += prop + ':' + sanitizedVal + ';';
        }
      }
      return s;
    }
    return String(v);
  }
};
