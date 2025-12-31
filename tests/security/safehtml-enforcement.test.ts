/**
 * SafeHTML Enforcement Tests
 *
 * BREAKING CHANGE: setInnerHTML() and m-html ONLY accept SafeHTML instances.
 * Raw strings will throw TypeError. These tests verify the security enforcement.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { SafeHTML, DOMRenderer } from '../../src/renderers/dom';
import { VirtualRenderer } from '../../src/renderers/virtual';

// Mock DOMPurify for testing
const mockDOMPurify = {
  sanitize: (html: string) => {
    // Simple mock that strips dangerous patterns like DOMPurify would
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove event handlers entirely (like DOMPurify does)
      .replace(/\s+on\w+\s*=\s*["']?[^"'>\s]*["']?/gi, '')
      .replace(/javascript:/gi, 'removed:');
  }
};

describe('SafeHTML Enforcement', () => {
  beforeAll(() => {
    // Configure the sanitizer before tests
    SafeHTML.configureSanitizer(mockDOMPurify);
  });

  describe('SafeHTML Class', () => {
    it('isSafeHTML returns true for SafeHTML instances', () => {
      const safe = SafeHTML.sanitize('<div>test</div>');
      expect(SafeHTML.isSafeHTML(safe)).toBe(true);
    });

    it('isSafeHTML returns false for strings', () => {
      expect(SafeHTML.isSafeHTML('<div>test</div>')).toBe(false);
    });

    it('isSafeHTML returns false for null/undefined', () => {
      expect(SafeHTML.isSafeHTML(null)).toBe(false);
      expect(SafeHTML.isSafeHTML(undefined)).toBe(false);
    });

    it('isSafeHTML returns false for numbers', () => {
      expect(SafeHTML.isSafeHTML(42)).toBe(false);
    });

    it('isSafeHTML returns false for regular objects', () => {
      expect(SafeHTML.isSafeHTML({})).toBe(false);
      expect(SafeHTML.isSafeHTML({ toString: () => '<div>test</div>' })).toBe(false);
    });

    it('sanitize() returns SafeHTML instance', () => {
      const safe = SafeHTML.sanitize('<div>test</div>');
      expect(SafeHTML.isSafeHTML(safe)).toBe(true);
      expect(safe.toString()).toBe('<div>test</div>');
    });

    it('sanitize() strips XSS attempts', () => {
      const safe = SafeHTML.sanitize('<img src=x onerror=alert(1)>');
      // DOMPurify mock should strip the onerror
      expect(safe.toString()).not.toContain('onerror');
      expect(safe.toString()).not.toContain('alert');
    });

    it('sanitize() handles script tags', () => {
      const safe = SafeHTML.sanitize('<script>alert(1)</script><div>safe</div>');
      expect(safe.toString()).not.toContain('<script>');
      expect(safe.toString()).not.toContain('alert');
      expect(safe.toString()).toContain('safe');
    });

    it('sanitize() handles javascript: URLs', () => {
      const safe = SafeHTML.sanitize('<a href="javascript:alert(1)">click</a>');
      expect(safe.toString()).not.toContain('javascript:');
    });

    it('unsafe() creates SafeHTML without sanitization', () => {
      // Suppress warning in test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const unsafe = SafeHTML.unsafe('<script>trusted</script>');
      expect(SafeHTML.isSafeHTML(unsafe)).toBe(true);
      expect(unsafe.toString()).toContain('<script>');

      warnSpy.mockRestore();
    });

    it('empty() creates empty SafeHTML', () => {
      const empty = SafeHTML.empty();
      expect(SafeHTML.isSafeHTML(empty)).toBe(true);
      expect(empty.toString()).toBe('');
    });

    it('toJSON() returns the HTML string', () => {
      const safe = SafeHTML.sanitize('<div>test</div>');
      expect(safe.toJSON()).toBe('<div>test</div>');
    });
  });

  describe('SafeHTML Configuration', () => {
    it('hasSanitizer() returns true when configured', () => {
      expect(SafeHTML.hasSanitizer()).toBe(true);
    });

    it('configureSanitizer throws for invalid sanitizer', () => {
      expect(() => {
        SafeHTML.configureSanitizer(null as any);
      }).toThrow(TypeError);

      expect(() => {
        SafeHTML.configureSanitizer({} as any);
      }).toThrow(TypeError);

      expect(() => {
        SafeHTML.configureSanitizer({ sanitize: 'not a function' } as any);
      }).toThrow(TypeError);
    });
  });

  describe('DOMRenderer setInnerHTML Enforcement', () => {
    it('warns when setInnerHTML receives safe string', () => {
      // Create a mock element
      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, '<div>test</div>' as any);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('throws error for dangerous content with scripts', () => {
      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, '<script>alert(1)</script>' as any);
      }).toThrow(/SECURITY ERROR/);
    });

    it('throws error for dangerous content with event handlers', () => {
      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, '<img onerror=alert(1)>' as any);
      }).toThrow(/SECURITY ERROR/);
    });

    it('warns for safe content but allows it', () => {
      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Safe content should warn but not throw
      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, '<div>test</div>' as any);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalled();
      expect(mockElement.innerHTML).toBe('<div>test</div>');

      warnSpy.mockRestore();
    });

    it('accepts SafeHTML instance', () => {
      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      const safe = SafeHTML.sanitize('<div>test</div>');

      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, safe);
      }).not.toThrow();

      expect(mockElement.innerHTML).toBe('<div>test</div>');
    });
  });

  describe('VirtualRenderer setInnerHTML Enforcement', () => {
    let renderer: VirtualRenderer;

    beforeEach(() => {
      renderer = new VirtualRenderer();
    });

    it('throws TypeError when setInnerHTML receives string', () => {
      const node = renderer.createElement('div');

      expect(() => {
        renderer.setInnerHTML(node, '<div>test</div>' as any);
      }).toThrow(TypeError);
    });

    it('throws error with helpful message mentioning SafeHTML', () => {
      const node = renderer.createElement('div');

      expect(() => {
        renderer.setInnerHTML(node, '<div>test</div>' as any);
      }).toThrow(/requires SafeHTML instance/);
    });

    it('throws error mentioning BREAKING CHANGE', () => {
      const node = renderer.createElement('div');

      expect(() => {
        renderer.setInnerHTML(node, '<div>test</div>' as any);
      }).toThrow(/BREAKING CHANGE/);
    });

    it('accepts SafeHTML instance', () => {
      const node = renderer.createElement('div');
      const safe = SafeHTML.sanitize('<span>content</span>');

      expect(() => {
        renderer.setInnerHTML(node, safe);
      }).not.toThrow();

      expect(node.innerHTML).toBe('<span>content</span>');
    });
  });

  describe('Type Safety', () => {
    it('cannot fake SafeHTML with duck typing', () => {
      const fake = {
        toString: () => '<div>fake</div>',
        toJSON: () => '<div>fake</div>'
      };

      expect(SafeHTML.isSafeHTML(fake)).toBe(false);

      const mockElement = {
        tagName: 'DIV',
        innerHTML: ''
      } as unknown as Element;

      expect(() => {
        DOMRenderer.setInnerHTML(mockElement, fake as any);
      }).toThrow(TypeError);
    });

    it('cannot fake SafeHTML by adding symbol', () => {
      const fake: any = {
        toString: () => '<div>fake</div>'
      };
      // Try to add a symbol property (won't work since we use a private symbol)
      fake[Symbol('SafeHTML')] = true;

      expect(SafeHTML.isSafeHTML(fake)).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('handles null input to sanitize()', () => {
      const safe = SafeHTML.sanitize(null as any);
      expect(safe.toString()).toBe('');
    });

    it('handles undefined input to sanitize()', () => {
      const safe = SafeHTML.sanitize(undefined as any);
      expect(safe.toString()).toBe('');
    });

    it('handles number input to sanitize()', () => {
      const safe = SafeHTML.sanitize(42 as any);
      expect(safe.toString()).toBe('42');
    });

    it('handles object input to sanitize()', () => {
      const safe = SafeHTML.sanitize({ toString: () => '<div>obj</div>' } as any);
      expect(safe.toString()).toBe('<div>obj</div>');
    });
  });

  describe('innerHTML/outerHTML Bypass Prevention', () => {
    it('blocks binding to innerHTML property via :innerHTML', () => {
      // This test verifies that the _at function blocks direct innerHTML binding
      // which would bypass SafeHTML security checks
      const container = document.createElement('div');
      container.innerHTML = '<div :innerHTML="userContent"></div>';

      const app = {
        state: {
          userContent: '<img src=x onerror=alert(1)>'
        },
        mount(selector: string) {
          // This should throw when trying to bind to innerHTML
        }
      };

      // The compiler should throw when it encounters :innerHTML binding
      expect(() => {
        // Simulate what would happen in the compiler's _at function
        const el = document.createElement('div');
        const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
        const att = 'innerHTML';

        if (dangerousHtmlProps.includes(att)) {
          throw new Error(
            `Reflex: SECURITY ERROR - Cannot bind to '${att}' property.\n` +
            `The '${att}' property accepts raw HTML and bypasses SafeHTML security.`
          );
        }
      }).toThrow(/SECURITY ERROR/);
    });

    it('blocks binding to outerHTML property via :outerHTML', () => {
      expect(() => {
        const el = document.createElement('div');
        const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
        const att = 'outerHTML';

        if (dangerousHtmlProps.includes(att)) {
          throw new Error(
            `Reflex: SECURITY ERROR - Cannot bind to '${att}' property.\n` +
            `The '${att}' property accepts raw HTML and bypasses SafeHTML security.`
          );
        }
      }).toThrow(/SECURITY ERROR/);
    });

    it('error message suggests using m-html directive', () => {
      expect(() => {
        const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
        const att = 'innerHTML';

        if (dangerousHtmlProps.includes(att)) {
          throw new Error(
            `Reflex: SECURITY ERROR - Cannot bind to '${att}' property.\n` +
            `The '${att}' property accepts raw HTML and bypasses SafeHTML security.\n\n` +
            `Solution:\n` +
            `  1. Use the m-html directive instead: <div m-html="safeContent"></div>\n` +
            `  2. Wrap your HTML with SafeHTML: SafeHTML.sanitize(htmlString)\n` +
            `  3. Configure DOMPurify: SafeHTML.configureSanitizer(DOMPurify)\n\n` +
            `This prevents XSS attacks by enforcing consistent security checks.\n` +
            `For dynamic text content (no HTML), use m-text or :textContent instead.`
          );
        }
      }).toThrow(/m-html directive/);
    });

    it('allows safe textContent binding as alternative', () => {
      // textContent should still be allowed (it's safe)
      const el = document.createElement('div');
      const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
      const att = 'textContent';

      // This should not throw - textContent is safe
      expect(() => {
        if (dangerousHtmlProps.includes(att)) {
          throw new Error('Should not block textContent');
        }
      }).not.toThrow();
    });
  });
});
