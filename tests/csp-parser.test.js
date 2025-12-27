/**
 * CSP-Safe Parser Tests
 *
 * Tests the SafeExprParser for expression evaluation
 * without using `new Function()` or `eval()`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';
import { SafeExprParser } from '../src/csp/SafeExprParser.ts';

describe('CSP-Safe Parser', () => {
  let parser;

  beforeEach(() => {
    document.body.innerHTML = '';
    parser = new SafeExprParser();
  });

  describe('Literals', () => {
    it('should parse numbers', () => {
      expect(parser.parse('42')).toEqual({ type: 'literal', value: 42 });
      expect(parser.parse('3.14')).toEqual({ type: 'literal', value: 3.14 });
      expect(parser.parse('-5')).toEqual({ type: 'literal', value: -5 });
    });

    it('should parse strings', () => {
      expect(parser.parse('"hello"')).toEqual({ type: 'literal', value: 'hello' });
      expect(parser.parse("'world'")).toEqual({ type: 'literal', value: 'world' });
    });

    it('should parse booleans', () => {
      expect(parser.parse('true')).toEqual({ type: 'literal', value: true });
      expect(parser.parse('false')).toEqual({ type: 'literal', value: false });
    });

    it('should parse null and undefined', () => {
      expect(parser.parse('null')).toEqual({ type: 'literal', value: null });
      expect(parser.parse('undefined')).toEqual({ type: 'literal', value: undefined });
    });
  });

  describe('Identifiers', () => {
    it('should parse identifiers', () => {
      expect(parser.parse('count')).toEqual({ type: 'identifier', name: 'count' });
      expect(parser.parse('_private')).toEqual({ type: 'identifier', name: '_private' });
      expect(parser.parse('$refs')).toEqual({ type: 'identifier', name: '$refs' });
    });
  });

  describe('Binary Operators', () => {
    it('should parse arithmetic operators', () => {
      const app = new Reflex({ a: 10, b: 3 });
      const fn = parser.compile('a + b', app);
      expect(fn(app.s, null)).toBe(13);
    });

    it('should parse comparison operators', () => {
      const app = new Reflex({ a: 5 });
      expect(parser.compile('a > 3', app)(app.s, null)).toBe(true);
      expect(parser.compile('a < 3', app)(app.s, null)).toBe(false);
      expect(parser.compile('a >= 5', app)(app.s, null)).toBe(true);
      expect(parser.compile('a <= 5', app)(app.s, null)).toBe(true);
    });

    it('should parse equality operators', () => {
      const app = new Reflex({ a: 5, b: '5' });
      expect(parser.compile('a == b', app)(app.s, null)).toBe(true);
      expect(parser.compile('a === b', app)(app.s, null)).toBe(false);
      expect(parser.compile('a != b', app)(app.s, null)).toBe(false);
      expect(parser.compile('a !== b', app)(app.s, null)).toBe(true);
    });

    it('should parse logical operators', () => {
      const app = new Reflex({ a: true, b: false });
      expect(parser.compile('a && b', app)(app.s, null)).toBe(false);
      expect(parser.compile('a || b', app)(app.s, null)).toBe(true);
    });

    it('should parse nullish coalescing', () => {
      const app = new Reflex({ a: null, b: 'default' });
      expect(parser.compile('a ?? b', app)(app.s, null)).toBe('default');
    });
  });

  describe('Unary Operators', () => {
    it('should parse negation', () => {
      const app = new Reflex({ a: true });
      expect(parser.compile('!a', app)(app.s, null)).toBe(false);
    });

    it('should parse negative numbers', () => {
      const app = new Reflex({ a: 5 });
      expect(parser.compile('-a', app)(app.s, null)).toBe(-5);
    });

    it('should parse typeof', () => {
      const app = new Reflex({ a: 'hello' });
      expect(parser.compile('typeof a', app)(app.s, null)).toBe('string');
    });
  });

  describe('Ternary Operator', () => {
    it('should parse ternary expressions', () => {
      const app = new Reflex({ condition: true });
      expect(parser.compile('condition ? "yes" : "no"', app)(app.s, null)).toBe('yes');
    });
  });

  describe('Property Access', () => {
    it('should parse dot notation', () => {
      const app = new Reflex({ user: { name: 'John' } });
      expect(parser.compile('user.name', app)(app.s, null)).toBe('John');
    });

    it('should parse bracket notation', () => {
      const app = new Reflex({ items: ['a', 'b', 'c'] });
      expect(parser.compile('items[1]', app)(app.s, null)).toBe('b');
    });

    it('should parse dynamic property access', () => {
      const app = new Reflex({ obj: { foo: 'bar' }, key: 'foo' });
      expect(parser.compile('obj[key]', app)(app.s, null)).toBe('bar');
    });
  });

  describe('Function Calls', () => {
    it('should parse function calls', () => {
      const app = new Reflex({
        greet(name) { return `Hello, ${name}`; }
      });
      expect(parser.compile('greet("World")', app)(app.s, null)).toBe('Hello, World');
    });

    it('should parse method calls', () => {
      const app = new Reflex({ arr: [1, 2, 3] });
      expect(parser.compile('arr.join("-")', app)(app.s, null)).toBe('1-2-3');
    });
  });

  describe('Arrays and Objects', () => {
    it('should parse array literals', () => {
      const app = new Reflex({});
      expect(parser.compile('[1, 2, 3]', app)(app.s, null)).toEqual([1, 2, 3]);
    });

    it('should parse object literals', () => {
      const app = new Reflex({});
      expect(parser.compile('{ a: 1, b: 2 }', app)(app.s, null)).toEqual({ a: 1, b: 2 });
    });

    it('should parse shorthand properties', () => {
      const app = new Reflex({ x: 10, y: 20 });
      expect(parser.compile('{ x, y }', app)(app.s, null)).toEqual({ x: 10, y: 20 });
    });
  });

  describe('CSP Mode Integration', () => {
    it('should work with Reflex in CSP mode', async () => {
      document.body.innerHTML = '<span m-text="count * 2"></span>';
      const app = new Reflex({ count: 5 });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('10');
    });

    it('should support all directives in CSP mode', async () => {
      document.body.innerHTML = `
        <div m-if="show">Visible</div>
        <ul><li m-for="item in items" m-text="item"></li></ul>
        <span>{{ message }}</span>
      `;
      const app = new Reflex({
        show: true,
        items: ['a', 'b'],
        message: 'Hello'
      });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });
      await app.nextTick();

      expect(document.body.textContent).toContain('Visible');
      expect(document.querySelectorAll('li').length).toBe(2);
      expect(document.body.textContent).toContain('Hello');
    });

    it('should block unsafe properties in CSP mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<span m-text="obj.__proto__"></span>';
      const app = new Reflex({ obj: {} });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });
      await app.nextTick();

      // console.warn is called with multiple args, join them to check content
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('unsafe property');
      warnSpy.mockRestore();
    });
  });

  describe('Magic Properties in CSP Mode', () => {
    it('should support $refs', async () => {
      document.body.innerHTML = '<input m-ref="myInput"><span m-text="$refs.myInput ? \'exists\' : \'none\'"></span>';
      const app = new Reflex({});
      app.configure({ cspSafe: true, parser: new SafeExprParser() });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('exists');
    });

    it('should support $event in handlers', async () => {
      let receivedEvent = null;
      document.body.innerHTML = '<button @click="handleClick($event)">Click</button>';
      const app = new Reflex({
        handleClick(e) { receivedEvent = e; }
      });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });
      await app.nextTick();

      document.querySelector('button').click();
      await app.nextTick();

      expect(receivedEvent).toBeInstanceOf(Event);
    });
  });
});
