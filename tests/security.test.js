/**
 * Security Tests
 *
 * Tests security features including:
 * - Prototype pollution prevention
 * - XSS prevention (URL protocols, expressions)
 * - Expression sanitization
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Security', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Prototype Pollution Prevention', () => {
    it('should block __proto__ access in expressions', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj.__proto__"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });

    it('should block constructor access in expressions', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj.constructor"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });

    it('should block prototype access in expressions', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj.prototype"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });

    it('should block __proto__ in m-model paths', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<input m-model="obj.__proto__">';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const input = document.querySelector('input');
      input.value = 'test';
      input.dispatchEvent(new Event('input'));

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });

    it('should block bracket notation constructor access', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj[\'constructor\']"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });

    it('should block Function constructor calls', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="Function(\'return 1\')()"></span>';
      const app = new Reflex({});
      await app.nextTick();

      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      warnSpy.mockRestore();
    });
  });

  describe('URL Protocol Blocking', () => {
    it('should block javascript: protocol in href', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'javascript:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should block vbscript: protocol', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'vbscript:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      warnSpy.mockRestore();
    });

    it('should block data: protocol', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'data:text/html,<script>alert(1)</script>' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      warnSpy.mockRestore();
    });

    it('should allow safe protocols', async () => {
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'https://example.com' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('https://example.com');
    });

    it('should block protocols in src attribute', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<img :src="url">';
      const app = new Reflex({ url: 'javascript:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('img').getAttribute('src')).toBe('about:blank');
      warnSpy.mockRestore();
    });

    it('should block protocols with leading whitespace', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: '  javascript:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      warnSpy.mockRestore();
    });

    it('should be case insensitive for protocol detection', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'JAVASCRIPT:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      warnSpy.mockRestore();
    });
  });

  describe('HTML Sanitization', () => {
    it('should safely handle HTML when sanitize is disabled', async () => {
      document.body.innerHTML = '<div m-html="content"></div>';

      // When sanitize is disabled, HTML is inserted directly (dev convenience)
      // In production, always use sanitize: true with DOMPurify configured
      const app = new Reflex({ content: '<strong>Bold</strong>' });
      app.configure({ sanitize: false });
      await app.nextTick();

      expect(document.querySelector('div').innerHTML).toBe('<strong>Bold</strong>');
    });

    it('should respect sanitize: false config', async () => {
      document.body.innerHTML = '<div m-html="content"></div>';
      const app = new Reflex({ content: '<strong>Bold</strong>' });
      app.configure({ sanitize: false });
      await app.nextTick();

      expect(document.querySelector('div').innerHTML).toBe('<strong>Bold</strong>');
    });
  });

  describe('Expression Sandboxing', () => {
    it('should allow access to reserved window identifier', async () => {
      document.body.innerHTML = '<span m-text="typeof window"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // window is in reserved list, so it should be accessible from global scope
      expect(document.querySelector('span').textContent).toBe('object');
    });

    it('should allow access to safe globals like Math', async () => {
      document.body.innerHTML = '<span m-text="Math.max(1, 5)"></span>';
      const app = new Reflex({});
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('5');
    });

    it('should allow access to JSON', async () => {
      document.body.innerHTML = '<span m-text="JSON.stringify({a:1})"></span>';
      const app = new Reflex({});
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('{"a":1}');
    });
  });
});
