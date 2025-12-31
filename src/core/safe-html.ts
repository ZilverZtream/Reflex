/**
 * SafeHTML - Wrapper for sanitized HTML content
 *
 * CRITICAL FIX (Issue #5): SafeHTML Coupling in Core
 *
 * This module was extracted from src/renderers/dom.ts to decouple the core
 * compiler from the browser-specific DOM renderer.
 *
 * PROBLEM: The core compiler (compiler.ts) imported SafeHTML directly from
 * the DOM renderer (renderers/dom.js). This introduced a hard dependency on
 * the browser-specific dom.js module within the generic compiler. If dom.js
 * contained any top-level browser globals (like document or Node), it would
 * break the library in strict non-browser environments (e.g., React Native
 * or certain Serverless Edge workers) even if VirtualRenderer was used.
 *
 * SOLUTION: Extract SafeHTML to its own module that has no browser dependencies.
 * The compiler imports from this module, and the DOM renderer re-exports for
 * backwards compatibility.
 *
 * BREAKING CHANGE: setInnerHTML() and m-html ONLY accept SafeHTML instances.
 * Raw strings will throw TypeError.
 *
 * SafeHTML ensures that all HTML content has been explicitly sanitized
 * before being inserted into the DOM, preventing XSS vulnerabilities.
 *
 * @example
 * // Setup (once at app initialization)
 * import DOMPurify from 'dompurify';
 * SafeHTML.configureSanitizer(DOMPurify);
 *
 * // Usage
 * const safe = SafeHTML.sanitize(userInput);
 * renderer.setInnerHTML(element, safe);
 *
 * // For static trusted strings (use with extreme caution)
 * const trusted = SafeHTML.unsafe(staticHtmlFromBuild);
 */

export class SafeHTML {
  /** The sanitized HTML content */
  private readonly _html: string;

  /** Brand symbol for type checking - uses global symbol registry for cross-bundle compatibility */
  private static readonly _brand = Symbol.for('reflex.SafeHTML');

  /** Configured sanitizer (DOMPurify or compatible) */
  private static _sanitizer: { sanitize: (html: string) => string } | null = null;

  /** Private constructor - only create via static methods */
  private constructor(html: string) {
    this._html = html;
    // Add global brand symbol for cross-bundle type checking
    (this as any)[SafeHTML._brand] = true;
  }

  /**
   * Configure the HTML sanitizer (required before using SafeHTML.sanitize)
   *
   * @param sanitizer - DOMPurify or compatible sanitizer with .sanitize() method
   *
   * @example
   * import DOMPurify from 'dompurify';
   * SafeHTML.configureSanitizer(DOMPurify);
   */
  static configureSanitizer(sanitizer: { sanitize: (html: string) => string }): void {
    if (!sanitizer || typeof sanitizer.sanitize !== 'function') {
      throw new TypeError(
        'Reflex Security: SafeHTML.configureSanitizer() requires a sanitizer with .sanitize() method.\n\n' +
        'Expected: DOMPurify or compatible library.\n\n' +
        'Example:\n' +
        '  import DOMPurify from \'dompurify\';\n' +
        '  SafeHTML.configureSanitizer(DOMPurify);'
      );
    }
    SafeHTML._sanitizer = sanitizer;
  }

  /**
   * Check if a sanitizer has been configured
   */
  static hasSanitizer(): boolean {
    return SafeHTML._sanitizer !== null;
  }

  /**
   * Sanitize HTML content and wrap in SafeHTML
   *
   * @param html - Raw HTML string to sanitize
   * @returns SafeHTML instance containing sanitized content
   *
   * @throws TypeError if sanitizer not configured
   *
   * @example
   * const safe = SafeHTML.sanitize(userInput);
   */
  static sanitize(html: string): SafeHTML {
    if (!SafeHTML._sanitizer) {
      throw new TypeError(
        'Reflex Security: SafeHTML.sanitize() requires a sanitizer to be configured.\n\n' +
        'BREAKING CHANGE: Raw strings are no longer accepted.\n\n' +
        'Migration:\n' +
        '  1. Install: npm install dompurify @types/dompurify\n' +
        '  2. Configure: SafeHTML.configureSanitizer(DOMPurify);\n' +
        '  3. Use: SafeHTML.sanitize(html)'
      );
    }

    const sanitized = SafeHTML._sanitizer.sanitize(String(html ?? ''));
    return new SafeHTML(sanitized);
  }

  /**
   * Create SafeHTML from a trusted static string WITHOUT sanitization.
   *
   * ⚠️ DANGER: Only use for build-time static HTML that you control.
   * NEVER use with user-provided content.
   *
   * @param html - Trusted static HTML string
   * @returns SafeHTML instance (unsanitized)
   *
   * @example
   * // ONLY for static build-time HTML
   * const icon = SafeHTML.unsafe('<svg>...</svg>');
   */
  static unsafe(html: string): SafeHTML {
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.warn(
        'Reflex Security Warning: SafeHTML.unsafe() bypasses sanitization.\n' +
        'Only use for static, trusted HTML that you control.\n' +
        'NEVER use with user-provided content.'
      );
    }
    return new SafeHTML(String(html ?? ''));
  }

  /**
   * Create an empty SafeHTML instance
   */
  static empty(): SafeHTML {
    return new SafeHTML('');
  }

  /**
   * Create SafeHTML from user-provided HTML input (e.g., contenteditable elements).
   *
   * This method is specifically for m-model.html two-way binding.
   * When a user types in a contenteditable element, we need to:
   * 1. Read the raw innerHTML (string)
   * 2. Sanitize it through DOMPurify
   * 3. Return a SafeHTML instance that passes isSafeHTML() check
   *
   * This breaks the crash loop:
   * Input -> SafeHTML.fromUser(string) -> State Update -> Reactivity -> SafeHTML Check (Passes) -> Render
   *
   * @param html - Raw HTML string from user input (e.g., el.innerHTML)
   * @returns SafeHTML instance containing sanitized content
   *
   * @throws TypeError if sanitizer not configured
   */
  static fromUser(html: string): SafeHTML {
    if (!SafeHTML._sanitizer) {
      throw new TypeError(
        'Reflex Security: SafeHTML.fromUser() requires a sanitizer to be configured.\n\n' +
        'REQUIRED for m-model.html binding to work safely.\n\n' +
        'Setup:\n' +
        '  1. Install: npm install dompurify @types/dompurify\n' +
        '  2. Configure: SafeHTML.configureSanitizer(DOMPurify);\n\n' +
        'This ensures user input in contenteditable elements is sanitized.'
      );
    }

    const sanitized = SafeHTML._sanitizer.sanitize(String(html ?? ''));
    return new SafeHTML(sanitized);
  }

  /**
   * Check if a value is a SafeHTML instance
   *
   * @param value - Value to check
   * @returns true if value is SafeHTML
   */
  static isSafeHTML(value: unknown): value is SafeHTML {
    return value !== null &&
           typeof value === 'object' &&
           (value as any)[SafeHTML._brand] === true;
  }

  /**
   * Get the sanitized HTML string
   */
  toString(): string {
    return this._html;
  }

  /**
   * Get the sanitized HTML string (for JSON serialization)
   */
  toJSON(): string {
    return this._html;
  }
}
