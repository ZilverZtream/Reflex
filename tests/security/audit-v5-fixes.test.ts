/**
 * Security Audit v5.1 Test Suite
 *
 * This test suite validates fixes for critical vulnerabilities identified in
 * the Level 5 Code Audit of the Reflex Security Architecture.
 *
 * Issues Tested:
 * 1. CRITICAL: Event Handler Injection (`on*`) Bypasses Sink Validation
 * 2. CRITICAL: SafeHTML Brand Symbol Exposure Allows Forgery
 * 3. SEVERE: Raw `style` Object Exposure Bypasses Sink Gate
 * 4. SEVERE: Architectural Failure - Blacklist Security Model
 * 5. HIGH: Meta Refresh XSS Vector (`http-equiv`)
 * 6. HIGH: Raw `dataset` Object Exposure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateSink, isEventHandlerSink, SINK_TYPES, getBlockReason } from '../../src/core/sinks.js';
import { SafeHTML } from '../../src/core/safe-html.js';

describe('Security Audit v5.1 Fixes', () => {
  let consoleWarnSpy: any;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Issue #1: Event Handler Injection Prevention', () => {
    it('should block onclick attribute', () => {
      expect(validateSink('onclick', 'alert(1)')).toBe(false);
    });

    it('should block onmouseover attribute', () => {
      expect(validateSink('onmouseover', 'alert(1)')).toBe(false);
    });

    it('should block onerror attribute', () => {
      expect(validateSink('onerror', 'alert(1)')).toBe(false);
    });

    it('should block onload attribute', () => {
      expect(validateSink('onload', 'alert(1)')).toBe(false);
    });

    it('should block onfocus attribute', () => {
      expect(validateSink('onfocus', 'alert(1)')).toBe(false);
    });

    it('should block onsubmit attribute', () => {
      expect(validateSink('onsubmit', 'alert(1)')).toBe(false);
    });

    it('should block case-insensitive event handlers (ONCLICK)', () => {
      // Pattern is case-insensitive
      expect(isEventHandlerSink('ONCLICK')).toBe(true);
      expect(isEventHandlerSink('OnClick')).toBe(true);
    });

    it('should block all on* patterns (future-proof)', () => {
      // Even unknown/future event handlers should be blocked
      expect(isEventHandlerSink('onfutureevent')).toBe(true);
      expect(isEventHandlerSink('oncustom')).toBe(true);
    });

    it('should NOT block non-event handler attributes', () => {
      // 'on' alone or 'on' not followed by letters should be allowed
      expect(isEventHandlerSink('on')).toBe(false);
      expect(validateSink('id', 'test')).toBe(true);
      expect(validateSink('class', 'test')).toBe(true);
      expect(validateSink('title', 'test')).toBe(true);
    });

    it('should provide correct block reason for event handlers', () => {
      const reason = getBlockReason('onclick', 'alert(1)');
      expect(reason).toContain('event handler');
      expect(reason).toContain('onclick');
    });
  });

  describe('Issue #2: SafeHTML Brand Symbol Forgery Prevention', () => {
    it('should NOT expose brand symbol via Object.getOwnPropertySymbols on class', () => {
      // The brand symbol should NOT be on the class constructor
      const symbols = Object.getOwnPropertySymbols(SafeHTML);

      // There should be no symbols on the SafeHTML class that could be used for forgery
      const forgeableSymbols = symbols.filter(sym => {
        // Check if the symbol could be used to forge SafeHTML instances
        const desc = Object.getOwnPropertyDescriptor(SafeHTML, sym);
        return desc && desc.value !== undefined;
      });

      expect(forgeableSymbols.length).toBe(0);
    });

    it('should reject forged SafeHTML-like objects', () => {
      // Try to forge using symbols found on SafeHTML (should fail)
      const symbols = Object.getOwnPropertySymbols(SafeHTML);

      // Even if there are symbols, they shouldn't allow forgery
      for (const sym of symbols) {
        const forged = { [sym]: true, toString: () => '<script>alert(1)</script>' };
        expect(SafeHTML.isSafeHTML(forged)).toBe(false);
      }
    });

    it('should reject objects that mimic SafeHTML structure', () => {
      // Try various forgery attempts
      const fakeObjects = [
        { toString: () => '<script>alert(1)</script>' },
        { _html: '<script>alert(1)</script>', toString: () => '<script>alert(1)</script>' },
        Object.create(SafeHTML.prototype, { _html: { value: '<script>alert(1)</script>' } }),
      ];

      for (const fake of fakeObjects) {
        expect(SafeHTML.isSafeHTML(fake)).toBe(false);
      }
    });

    it('should accept legitimate SafeHTML instances', () => {
      // Configure sanitizer for testing
      SafeHTML.configureSanitizer({
        sanitize: (html: string) => html.replace(/<script>/gi, '').replace(/<\/script>/gi, '')
      });

      const safe = SafeHTML.sanitize('<div>Hello</div>');
      expect(SafeHTML.isSafeHTML(safe)).toBe(true);
    });

    it('should accept SafeHTML created via trustGivenString_DANGEROUS', () => {
      const trusted = SafeHTML.trustGivenString_DANGEROUS('<svg></svg>');
      expect(SafeHTML.isSafeHTML(trusted)).toBe(true);
    });
  });

  describe('Issue #3: Style Object CSS Injection Prevention', () => {
    it('should have validateSink block javascript: in style values', () => {
      // This tests the sinks.ts layer
      expect(validateSink('style', 'background: url("javascript:alert(1)")')).toBe(false);
    });

    it('should block expression() in style values', () => {
      expect(validateSink('style', 'width: expression(alert(1))')).toBe(false);
    });

    it('should block expression with whitespace variations', () => {
      expect(validateSink('style', 'width: expression  (alert(1))')).toBe(false);
    });

    it('should allow safe CSS values', () => {
      expect(validateSink('style', 'color: red')).toBe(true);
      expect(validateSink('style', 'background: url("https://example.com/img.png")')).toBe(true);
      expect(validateSink('style', 'width: 100px')).toBe(true);
    });
  });

  describe('Issue #4: Architecture Fix - Pattern-Based Blocking', () => {
    it('should use pattern matching for event handlers, not enumeration', () => {
      // The fix should block ANY on* pattern, not just known ones
      const unknownEvents = [
        'ontouchstart',
        'ontouchend',
        'onpointerdown',
        'onanimationend',
        'ontransitionend',
        'ondragstart',
        'onwheel',
        'onauxclick',
        'oncontextmenu',
        'onsecuritypolicyviolation', // CSP violation event
        'onrejectionhandled',
        'onunhandledrejection',
      ];

      for (const event of unknownEvents) {
        expect(isEventHandlerSink(event)).toBe(true);
        expect(validateSink(event, 'alert(1)')).toBe(false);
      }
    });

    it('should block javascript: protocol in ALL attribute values (defense in depth)', () => {
      // Even non-sink attributes should block javascript: as defense in depth
      expect(validateSink('custom-attr', 'javascript:alert(1)')).toBe(false);
      expect(validateSink('data-url', 'javascript:void(0)')).toBe(false);
    });
  });

  describe('Issue #5: Meta Refresh XSS Prevention', () => {
    it('should have http-equiv in SINK_TYPES', () => {
      expect(SINK_TYPES['http-equiv']).toBeDefined();
      expect(SINK_TYPES['httpEquiv']).toBeDefined();
    });

    it('should block meta refresh with javascript: URL', () => {
      // The content attribute with refresh pattern
      expect(validateSink('http-equiv', 'javascript:alert(1)')).toBe(false);
    });

    it('should block meta refresh XSS pattern in values', () => {
      // This pattern: url=javascript: should be blocked
      expect(validateSink('target', 'url=javascript:alert(1)')).toBe(false);
    });

    it('should have target in SINK_TYPES', () => {
      expect(SINK_TYPES['target']).toBeDefined();
      expect(SINK_TYPES['formtarget']).toBeDefined();
      expect(SINK_TYPES['formTarget']).toBeDefined();
    });

    it('should allow safe http-equiv values', () => {
      expect(validateSink('http-equiv', 'Content-Type')).toBe(true);
      expect(validateSink('http-equiv', 'X-UA-Compatible')).toBe(true);
    });
  });

  describe('Issue #6: Dataset Protection', () => {
    // Note: Full dataset membrane tests would require JSDOM for DOM testing
    // These tests verify the sinks layer protections

    it('should block javascript: in any attribute via defense in depth', () => {
      // Even data-* attributes should be protected
      expect(validateSink('data-url', 'javascript:alert(1)')).toBe(false);
    });
  });

  describe('Regression Tests: Existing Functionality', () => {
    it('should still block href with javascript:', () => {
      expect(validateSink('href', 'javascript:alert(1)')).toBe(false);
    });

    it('should still block src with javascript:', () => {
      expect(validateSink('src', 'javascript:alert(1)')).toBe(false);
    });

    it('should still block innerHTML without SafeHTML', () => {
      expect(validateSink('innerHTML', '<div>test</div>')).toBe(false);
    });

    it('should still allow innerHTML with SafeHTML', () => {
      SafeHTML.configureSanitizer({ sanitize: (html: string) => html });
      const safe = SafeHTML.sanitize('<div>test</div>');
      expect(validateSink('innerHTML', safe)).toBe(true);
    });

    it('should still allow safe URLs', () => {
      expect(validateSink('href', 'https://example.com')).toBe(true);
      expect(validateSink('src', '/images/logo.png')).toBe(true);
    });

    it('should handle control character evasion', () => {
      // java\0script: should still be blocked
      expect(validateSink('href', 'java\0script:alert(1)')).toBe(false);
      // java\nscript: should still be blocked
      expect(validateSink('href', 'java\nscript:alert(1)')).toBe(false);
    });

    it('should handle object coercion attacks', () => {
      const malicious = { toString: () => 'javascript:alert(1)' };
      expect(validateSink('href', malicious)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null values safely', () => {
      expect(validateSink('onclick', null)).toBe(false); // Event handlers always blocked
      expect(validateSink('href', null)).toBe(true);
      expect(validateSink('style', null)).toBe(true);
    });

    it('should handle undefined values safely', () => {
      expect(validateSink('onclick', undefined)).toBe(false); // Event handlers always blocked
      expect(validateSink('href', undefined)).toBe(true);
    });

    it('should handle empty strings', () => {
      expect(validateSink('href', '')).toBe(true);
      expect(validateSink('style', '')).toBe(true);
    });

    it('should handle numeric values', () => {
      expect(validateSink('width', 100)).toBe(true);
      expect(validateSink('style', 123)).toBe(true);
    });
  });
});
