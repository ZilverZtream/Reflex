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
   * @deprecated Use `trustGivenString_DANGEROUS` instead. This method will be removed in v6.
   *
   * Create SafeHTML from a trusted static string WITHOUT ANY sanitization or validation.
   *
   * ⚠️ CRITICAL SECURITY WARNING: This method provides ZERO protection against XSS.
   * It exists only for backwards compatibility. Use `trustGivenString_DANGEROUS` instead.
   */
  static unsafe(html: string): SafeHTML {
    return SafeHTML.trustGivenString_DANGEROUS(html);
  }

  /**
   * Create SafeHTML from a trusted static string WITHOUT ANY sanitization or validation.
   *
   * ╔══════════════════════════════════════════════════════════════════════════════╗
   * ║  ⛔ CRITICAL SECURITY WARNING - READ BEFORE USING                            ║
   * ╠══════════════════════════════════════════════════════════════════════════════╣
   * ║                                                                              ║
   * ║  This method performs ZERO validation on the input string.                   ║
   * ║  NO patterns are blocked. NO sanitization is applied.                        ║
   * ║  The string is trusted EXACTLY as provided.                                  ║
   * ║                                                                              ║
   * ║  PREVIOUS VERSIONS had regex-based blocking that was SECURITY THEATER:       ║
   * ║  - Patterns like `javascript:` could be bypassed with `&#106;avascript:`    ║
   * ║  - Event handlers could be bypassed with HTML encoding                       ║
   * ║  - This gave developers a FALSE sense of security                           ║
   * ║                                                                              ║
   * ║  The regex checks were REMOVED because:                                      ║
   * ║  1. They were fundamentally bypassable (see DOMRenderer.setInnerHTML)       ║
   * ║  2. They created a misleading security guarantee                            ║
   * ║  3. A proper parser-based approach would have unacceptable overhead         ║
   * ║                                                                              ║
   * ║  SAFE use cases (content you fully control at build time):                  ║
   * ║    ✓ Static SVG icons bundled in your application                           ║
   * ║    ✓ HTML templates that are part of your source code                       ║
   * ║    ✓ Markdown rendered server-side by a trusted library                     ║
   * ║                                                                              ║
   * ║  DANGEROUS use cases (WILL cause XSS vulnerabilities):                      ║
   * ║    ✗ User-submitted content (comments, posts, profiles)                     ║
   * ║    ✗ Data from APIs, databases, or external sources                         ║
   * ║    ✗ URL query parameters or form inputs                                    ║
   * ║    ✗ ANYTHING that users can influence in ANY way                           ║
   * ║                                                                              ║
   * ║  For user content, ALWAYS use: SafeHTML.sanitize(userContent)               ║
   * ║                                                                              ║
   * ╚══════════════════════════════════════════════════════════════════════════════╝
   *
   * @param html - Trusted static HTML string (NO validation is performed)
   * @returns SafeHTML instance containing the UNVALIDATED string
   *
   * @example
   * // ONLY for static build-time HTML that you wrote yourself
   * const icon = SafeHTML.trustGivenString_DANGEROUS('<svg>...</svg>');
   *
   * // NEVER do this - XSS vulnerability:
   * // const userContent = SafeHTML.trustGivenString_DANGEROUS(userInput);
   */
  static trustGivenString_DANGEROUS(html: string): SafeHTML {
    // CRITICAL FIX (Audit Issue #3): Security Theater Removal
    //
    // PREVIOUS IMPLEMENTATION had regex-based pattern blocking that was:
    // 1. Fundamentally bypassable (e.g., `&#106;avascript:` bypasses `/javascript:/i`)
    // 2. Denounced in DOMRenderer.setInnerHTML as "bypassable"
    // 3. Giving developers a FALSE sense of security
    //
    // The regex checks have been REMOVED because:
    // - They cannot provide real security (too many bypass techniques)
    // - A proper parser-based approach would add unacceptable overhead
    // - It's better to be honest about the danger than provide false assurance
    //
    // The method name was changed to `trustGivenString_DANGEROUS` to make
    // the risk explicit. The `unsafe()` method is kept for backwards
    // compatibility but is deprecated.

    // Track usage for security monitoring
    SafeHTML._unsafeCallCount = (SafeHTML._unsafeCallCount || 0) + 1;

    const str = String(html ?? '');

    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      // Include stack trace to identify source in security audits
      const stack = new Error().stack;
      const callLocation = stack?.split('\n')[2]?.trim() || 'unknown location';

      console.warn(
        '┌────────────────────────────────────────────────────────────────┐\n' +
        '│ ⛔ SECURITY: trustGivenString_DANGEROUS() called               │\n' +
        '├────────────────────────────────────────────────────────────────┤\n' +
        '│                                                               │\n' +
        '│ ⚠️  NO VALIDATION IS PERFORMED ON THIS STRING                  │\n' +
        '│                                                               │\n' +
        '│ This method trusts the input EXACTLY as provided.             │\n' +
        '│ If this contains user-controlled data, you have an XSS bug.   │\n' +
        '│                                                               │\n' +
        `│ Call #${SafeHTML._unsafeCallCount} from:                                            │\n` +
        `│   ${callLocation.slice(0, 60)}${callLocation.length > 60 ? '...' : ''}   │\n` +
        '│                                                               │\n' +
        '│ For user content, use: SafeHTML.sanitize(userContent)        │\n' +
        '└────────────────────────────────────────────────────────────────┘'
      );
    }

    return new SafeHTML(str);
  }

  /** Track unsafe() call count for monitoring (Issue #9) */
  private static _unsafeCallCount: number = 0;

  /**
   * Get the count of unsafe() calls (for security auditing)
   * CRITICAL FIX (Issue #9): Allow security monitoring
   */
  static getUnsafeCallCount(): number {
    return SafeHTML._unsafeCallCount || 0;
  }

  /**
   * Reset the unsafe call counter (useful for tests)
   */
  static resetUnsafeCallCount(): void {
    SafeHTML._unsafeCallCount = 0;
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
