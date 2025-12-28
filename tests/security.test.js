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

      // Regex check blocks constructor access early with a warning
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.flat().join(' ')).toContain('unsafe');
      expect(document.querySelector('span').textContent).toBe('');
      warnSpy.mockRestore();
    });

    it('should block Function constructor calls', async () => {
      // Function constructor is blocked by the reserved words list and membrane
      document.body.innerHTML = '<span m-text="Function(\'return 1\')()"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // Should not execute the function
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
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

  describe('Iron Membrane Sandbox', () => {
    it('should block obfuscated constructor access via string concatenation', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="user[&quot;con&quot; + &quot;structor&quot;](&quot;alert(1)&quot;)()"></span>';
      const app = new Reflex({ user: { name: 'Alice' } });

      // The expression should fail due to membrane blocking constructor access
      await app.nextTick();

      // The element should be empty or show undefined (no code execution)
      const text = document.querySelector('span').textContent;
      expect(text).not.toContain('alert');
      expect(text === '' || text === 'undefined').toBe(true);

      errorSpy.mockRestore();
    });

    it('should block constructor access via bracket notation', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj[&quot;constructor&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // The membrane should block access, resulting in empty or undefined
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);

      errorSpy.mockRestore();
    });

    it('should block __proto__ access via bracket notation', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj[&quot;__proto__&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // The membrane should block access, resulting in empty or undefined
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);

      errorSpy.mockRestore();
    });

    it('should block prototype access via bracket notation', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj[&quot;prototype&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // The membrane should block access, resulting in empty or undefined
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);

      errorSpy.mockRestore();
    });

    it('should allow safe array methods through membrane', async () => {
      document.body.innerHTML = '<span m-text="items.map(x => x * 2).join(\',\')"></span>';
      const app = new Reflex({ items: [1, 2, 3] });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('2,4,6');
    });

    it('should allow safe string methods through membrane', async () => {
      document.body.innerHTML = '<span m-text="name.toUpperCase()"></span>';
      const app = new Reflex({ name: 'alice' });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('ALICE');
    });

    it('should allow safe object access through membrane', async () => {
      document.body.innerHTML = '<span m-text="user.profile.age"></span>';
      const app = new Reflex({ user: { profile: { age: 25 } } });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('25');
    });

    it('should allow user data with property name "global"', async () => {
      // User data with property name 'global' should be allowed
      // Only the actual global object should be blocked
      document.body.innerHTML = '<span m-text="obj.global"></span>';
      const app = new Reflex({ obj: { global: 'test' } });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text).toBe('test');
    });

    it('should allow user data with property name "Function"', async () => {
      // User data with property name 'Function' should be allowed
      // Only the actual Function constructor should be blocked
      document.body.innerHTML = '<span m-text="obj.Function"></span>';
      const app = new Reflex({ obj: { Function: 'test' } });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text).toBe('test');
    });

    it('should recursively wrap nested objects in membrane', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="user.data[&quot;constructor&quot;]"></span>';
      const app = new Reflex({ user: { data: { name: 'test' } } });
      await app.nextTick();

      // Even nested objects should be protected by membrane
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);

      errorSpy.mockRestore();
    });
  });
});
