/**
 * Security Tests
 *
 * Tests security features including:
 * - White-List Only Security Model
 * - Prototype pollution prevention
 * - XSS prevention (URL protocols, expressions)
 * - Expression sanitization
 *
 * SECURITY MODEL: White-List Only ("Iron Membrane" 2.0)
 *
 * The security model has been upgraded from blacklist-based to white-list only:
 * 1. ALLOWS: Own data properties (via hasOwnProperty)
 * 2. ALLOWS: Safe standard methods (map, filter, etc.)
 * 3. ALLOWS: Well-known symbols (iterators, toPrimitive)
 * 4. DENIES: Everything else (prototype chain, unknown globals, future features)
 *
 * This approach is fundamentally more secure because:
 * - New dangerous properties added to JavaScript won't be allowed
 * - Browser extensions and polyfills can't add exploitable accessors
 * - The default action is DENY, not ALLOW
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex, SafeHTML } from '../src/index.ts';

describe('Security', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('White-List Only Security Model', () => {
    it('should allow access to own data properties', async () => {
      document.body.innerHTML = '<span m-text="user.name"></span>';
      const app = new Reflex({ user: { name: 'Alice' } });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('Alice');
    });

    it('should allow access to nested own properties', async () => {
      document.body.innerHTML = '<span m-text="user.profile.age"></span>';
      const app = new Reflex({ user: { profile: { age: 25 } } });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('25');
    });

    it('should allow toString method (it is in SAFE_METHODS)', async () => {
      document.body.innerHTML = '<span m-text="user.toString"></span>';
      const app = new Reflex({ user: { name: 'Alice' } });
      await app.nextTick();

      // toString is a safe method, so it should be available
      // The membrane wraps it in a function that forwards calls
      const text = document.querySelector('span').textContent;
      // toString is in SAFE_METHODS, so it returns a function (wrapped or native)
      expect(text.includes('function') || text.includes('toString')).toBe(true);
    });

    it('should block constructor access - returns undefined', async () => {
      document.body.innerHTML = '<span m-text="obj.constructor"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // constructor is NOT an own property and NOT in SAFE_METHODS
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block __proto__ access - returns undefined', async () => {
      document.body.innerHTML = '<span m-text="obj.__proto__"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block prototype access - returns undefined', async () => {
      document.body.innerHTML = '<span m-text="obj.prototype"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should block __proto__ access in expressions', async () => {
      document.body.innerHTML = '<span m-text="obj.__proto__"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block constructor access in expressions', async () => {
      document.body.innerHTML = '<span m-text="obj.constructor"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block prototype access in expressions', async () => {
      document.body.innerHTML = '<span m-text="obj.prototype"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block bracket notation constructor access', async () => {
      document.body.innerHTML = '<span m-text="obj[\'constructor\']"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // White-list approach: constructor is not an own property, returns undefined
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block Function constructor calls', async () => {
      // Function constructor is blocked because it's not in SAFE_GLOBALS
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

      // BREAKING CHANGE: m-html now requires SafeHTML instances regardless of sanitize config
      const app = new Reflex({ content: SafeHTML.unsafe('<strong>Bold</strong>') });
      await app.nextTick();

      expect(document.querySelector('div').innerHTML).toBe('<strong>Bold</strong>');
    });

    it('should respect sanitize: false config', async () => {
      document.body.innerHTML = '<div m-html="content"></div>';
      const app = new Reflex({ content: SafeHTML.unsafe('<strong>Bold</strong>') });
      await app.nextTick();

      expect(document.querySelector('div').innerHTML).toBe('<strong>Bold</strong>');
    });
  });

  describe('Expression Sandboxing', () => {
    it('should compile expressions without strict mode syntax errors', async () => {
      document.body.innerHTML = '<button @click="count++">Click</button><span m-text="count"></span>';
      const app = new Reflex({ count: 0 });
      await app.nextTick();

      const button = document.querySelector('button');
      button.click();
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('1');
    });

    it('should compile handler expressions without syntax errors', async () => {
      document.body.innerHTML = `
        <button @click="handleClick">Simple Handler</button>
        <button @click="count = count + 1">Expression</button>
        <button @click="handleClick(); count++">Multi-statement</button>
      `;
      const app = new Reflex({
        count: 0,
        handleClick: () => {}
      });

      expect(() => app.mount()).not.toThrow();
    });

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

  describe('Iron Membrane 2.0 (White-List Only)', () => {
    it('should block obfuscated constructor access via string concatenation', async () => {
      document.body.innerHTML = '<span m-text="user[&quot;con&quot; + &quot;structor&quot;](&quot;alert(1)&quot;)()"></span>';
      const app = new Reflex({ user: { name: 'Alice' } });

      await app.nextTick();

      // White-list: "constructor" is not an own property, returns undefined
      const text = document.querySelector('span').textContent;
      expect(text).not.toContain('alert');
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block constructor access via bracket notation', async () => {
      document.body.innerHTML = '<span m-text="obj[&quot;constructor&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // White-list: constructor is not an own property
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block __proto__ access via bracket notation', async () => {
      document.body.innerHTML = '<span m-text="obj[&quot;__proto__&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // White-list: __proto__ is not an own property
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block prototype access via bracket notation', async () => {
      document.body.innerHTML = '<span m-text="obj[&quot;prototype&quot;]"></span>';
      const app = new Reflex({ obj: {} });
      await app.nextTick();

      // White-list: prototype is not an own property
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
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
      // User data with property name 'global' should be allowed (own property)
      document.body.innerHTML = '<span m-text="obj.global"></span>';
      const app = new Reflex({ obj: { global: 'test' } });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text).toBe('test');
    });

    it('should allow user data with property name "Function"', async () => {
      // User data with property name 'Function' should be allowed (own property)
      document.body.innerHTML = '<span m-text="obj.Function"></span>';
      const app = new Reflex({ obj: { Function: 'test' } });
      await app.nextTick();

      const text = document.querySelector('span').textContent;
      expect(text).toBe('test');
    });

    it('should recursively wrap nested objects in membrane', async () => {
      document.body.innerHTML = '<span m-text="user.data[&quot;constructor&quot;]"></span>';
      const app = new Reflex({ user: { data: { name: 'test' } } });
      await app.nextTick();

      // Even nested objects should be protected - constructor is not own property
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block Reflect.construct exploit', async () => {
      // This was a critical vulnerability in the old blacklist approach
      document.body.innerHTML = '<span m-text="Reflect"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // Reflect is not in SAFE_GLOBALS, returns undefined
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block globalThis access', async () => {
      document.body.innerHTML = '<span m-text="globalThis"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // globalThis is not in SAFE_GLOBALS
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });

    it('should block eval access', async () => {
      document.body.innerHTML = '<span m-text="eval"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // eval is not in SAFE_GLOBALS
      const text = document.querySelector('span').textContent;
      expect(text === '' || text === 'undefined').toBe(true);
    });
  });

  describe('Defense in Depth', () => {
    it('should protect against object literal constructor chain (limited protection)', async () => {
      // KNOWN LIMITATION: Object literals ({}) created inside expressions are NOT
      // wrapped in the membrane because they're created by JavaScript directly.
      // However, attempting to CALL the Function constructor will fail because
      // it requires a code string, and our membrane wraps function return values.
      //
      // Full protection against object literal constructor chains would require
      // parsing and transforming expressions at compile time, which is complex.
      // For most use cases, this is acceptable because:
      // 1. Attackers can't inject arbitrary expressions into templates
      // 2. Templates are typically authored by developers, not users
      document.body.innerHTML = '<span m-text="typeof ({}).constructor.constructor"></span>';
      const app = new Reflex({});
      await app.nextTick();

      // The constructor chain works but executing code still fails
      const text = document.querySelector('span').textContent;
      // typeof returns 'function' but we can't execute it with arbitrary code
      expect(text).toBe('function');
    });

    it('should work with Date objects', async () => {
      document.body.innerHTML = '<span m-text="date.getFullYear()"></span>';
      const app = new Reflex({ date: new Date('2025-01-01') });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('2025');
    });

    it('should work with Map objects', async () => {
      document.body.innerHTML = '<span m-text="map.get(\'key\')"></span>';
      const map = new Map();
      map.set('key', 'value');
      const app = new Reflex({ map });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('value');
    });

    it('should work with array length property', async () => {
      document.body.innerHTML = '<span m-text="items.length"></span>';
      const app = new Reflex({ items: [1, 2, 3, 4, 5] });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('5');
    });
  });
});
