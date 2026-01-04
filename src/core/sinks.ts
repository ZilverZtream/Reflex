/**
 * REFLEX SECURITY KERNEL
 *
 * Centralized "Sink-Based Security" - the final firewall for all rendering targets.
 * This module defines strict validation rules for DOM/Native sinks and acts as
 * the single source of truth for security across:
 *
 * - Web (Runtime) - DOMRenderer
 * - Native (App) - VirtualRenderer
 * - Compiled (AOT) - Generated code via DOMRenderer
 *
 * SECURITY MODEL:
 * 1. URL Injection Sinks (Type 1): Block javascript: protocol
 * 2. Code Injection Sinks (Type 2): Strictly blocked (use SafeHTML)
 * 3. CSS Sinks (Type 3): Block expression() and javascript: in url()
 */

// Control character regex for normalization (prevents evasion via \0, etc.)
const CTRL = /[\u0000-\u001F\u007F-\u009F]/g;

// Disallowed protocols for URL sinks
const DISALLOWED_PROTOCOLS = /^javascript:/i;

// Optional: Data URI protocol detection
// const DATA_PROTOCOL = /^data:/i;

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
  'style': 3
};

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
 * // innerHTML - always blocked (use SafeHTML instead)
 * validateSink('innerHTML', '<div>Hello</div>') // false
 *
 * // CSS with expression() - blocked
 * validateSink('style', 'width: expression(alert(1))') // false
 */
export function validateSink(prop: string, value: any): boolean {
  const type = SINK_TYPES[prop];

  // Not a sink (e.g., 'id', 'class', 'title') - allow
  if (!type) return true;

  // Non-string values are generally safe (booleans, numbers, null, undefined)
  if (typeof value !== 'string') return true;

  // TYPE 1: URL Sinks - Block javascript: protocol
  if (type === 1) {
    // SECURITY: Normalize to prevent control-character evasion
    // Attackers use "java\0script:" or "java\nscript:" to bypass naive checks
    const normalized = value.replace(CTRL, '').trim();

    if (DISALLOWED_PROTOCOLS.test(normalized)) {
      return false;
    }

    // Optional: Block data: URI unless it's an image
    // Uncomment to enable stricter data URI policy:
    // if (DATA_PROTOCOL.test(normalized) && !/^data:image\//i.test(normalized)) {
    //   return false;
    // }

    return true;
  }

  // TYPE 2: HTML/Code Sinks - STRICT BLOCK
  // Never allow string assignment to innerHTML/outerHTML/srcdoc.
  // User must use renderer.setInnerHTML() with SafeHTML instances,
  // which bypasses this gate via a specific renderer method.
  if (type === 2) {
    return false;
  }

  // TYPE 3: CSS Sinks - Block dangerous patterns
  if (type === 3) {
    // SECURITY: Normalize to prevent control-character evasion
    const normalized = value.replace(CTRL, '').trim();

    // Block expression() (IE legacy) and javascript: inside url()
    if (DANGEROUS_CSS.test(normalized)) {
      return false;
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
  const type = SINK_TYPES[prop];

  if (type === 1) {
    return `Blocked javascript: protocol in URL sink '${prop}'`;
  }
  if (type === 2) {
    return `Blocked direct assignment to code injection sink '${prop}'. Use SafeHTML.sanitize() with m-html directive instead.`;
  }
  if (type === 3) {
    return `Blocked dangerous CSS pattern in style sink '${prop}'`;
  }

  return `Unknown security violation for sink '${prop}'`;
}
