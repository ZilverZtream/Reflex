/**
 * Membrane Critical Issues Test Suite
 *
 * Tests for the 6 critical and severe issues identified in the Level 5 Audit
 * of the "Iron Membrane 2.0" and refactored Standard Mode compiler.
 *
 * Issues covered:
 * 1. Standard Mode Global Escape (RCE Vulnerability) - CRITICAL
 * 2. $el.innerHTML Sanitization Bypass (XSS) - CRITICAL
 * 3. Broken Map/Set Sizing (Functional Defect) - SEVERE
 * 4. Method Identity Instability (Performance/Logic) - SEVERE
 * 5. Promises are Unusable (Functional Defect) - HIGH
 * 6. Standard Mode vs CSP Mode Inconsistency - MEDIUM
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Reflex } from '../src/core/reflex.js';
import { SafeExprParser } from '../src/csp/SafeExprParser.js';

describe('Membrane Critical Issues - Level 5 Audit Fixes', () => {
  let app: any;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('Issue #1: Standard Mode Global Escape (RCE Vulnerability)', () => {
    it('should block access to window global', () => {
      app = new Reflex({ test: 'safe' });
      container.innerHTML = `<div m-text="window"></div>`;
      app.mount(container);

      // window should be undefined, not the actual window object
      expect(container.querySelector('div')?.textContent).toBe('');
    });

    it('should block window.location access', () => {
      app = new Reflex({ test: 'safe' });

      // This expression should safely return undefined instead of accessing window
      const fn = app._fn('window.location.href');
      const result = fn(app.state, {});

      expect(result).toBeUndefined();
    });

    it('should block process.env access (Node.js)', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('process');
      const result = fn(app.state, {});

      expect(result).toBeUndefined();
    });

    it('should block fetch access', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('fetch');
      const result = fn(app.state, {});

      expect(result).toBeUndefined();
    });

    it('should block document access', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('document');
      const result = fn(app.state, {});

      expect(result).toBeUndefined();
    });

    it('should allow safe globals like Math', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('Math.PI');
      const result = fn(app.state, {});

      expect(result).toBe(Math.PI);
    });

    it('should allow safe globals like Date', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('Date.now()');
      const result = fn(app.state, {});

      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should allow safe globals like Array', () => {
      app = new Reflex({ items: [1, 2, 3] });

      const fn = app._fn('Array.isArray(items)');
      const result = fn(app.state, {});

      expect(result).toBe(true);
    });

    it('should allow console for logging', () => {
      app = new Reflex({ test: 'safe' });

      const fn = app._fn('console');
      const result = fn(app.state, {});

      expect(result).toBe(console);
    });

    it('should block Function constructor access', () => {
      app = new Reflex({ test: 'safe' });

      // Try to access Function to create RCE
      const fn = app._fn('Function');
      const result = fn(app.state, {});

      // Function should be blocked (undefined), not the actual Function constructor
      expect(result).toBeUndefined();
    });
  });

  describe('Issue #2: $el.innerHTML Sanitization Bypass (XSS)', () => {
    it('should block setting innerHTML on $el in expressions', () => {
      app = new Reflex({ xss: '<img src=x onerror=alert(1)>' });
      container.innerHTML = `<button @click="$el.innerHTML = xss">Click</button>`;
      app.mount(container);

      const button = container.querySelector('button') as HTMLButtonElement;

      // Clicking should throw security error instead of setting innerHTML
      expect(() => {
        button.click();
      }).toThrow(/Reflex Security.*innerHTML/);
    });

    it('should allow reading innerHTML from $el', () => {
      app = new Reflex({ test: 'safe' });
      container.innerHTML = `<div id="target"><span>Content</span></div>`;
      app.mount(container);

      // Reading innerHTML should work
      const fn = app._fn('$el.innerHTML', false);
      const element = container.querySelector('#target');
      const result = fn(app.state, {}, null, element);

      expect(result).toContain('<span>Content</span>');
    });

    it('should allow setting safe properties like textContent', () => {
      app = new Reflex({ text: 'Hello World' });
      container.innerHTML = `<button @click="$el.textContent = text">Click</button>`;
      app.mount(container);

      const button = container.querySelector('button') as HTMLButtonElement;
      button.click();

      expect(button.textContent).toBe('Hello World');
    });

    it('should block setting outerHTML on $el', () => {
      app = new Reflex({ xss: '<div>XSS</div>' });
      container.innerHTML = `<button @click="$el.outerHTML = xss">Click</button>`;
      app.mount(container);

      const button = container.querySelector('button') as HTMLButtonElement;

      expect(() => {
        button.click();
      }).toThrow(/Reflex Security/);
    });
  });

  describe('Issue #3: Broken Map/Set Sizing (Functional Defect)', () => {
    it('should return correct size for Map', () => {
      const myMap = new Map([['a', 1], ['b', 2], ['c', 3]]);
      app = new Reflex({ myMap });

      const fn = app._fn('myMap.size');
      const result = fn(app.state, {});

      expect(result).toBe(3);
    });

    it('should return correct size for Set', () => {
      const mySet = new Set([1, 2, 3, 4, 5]);
      app = new Reflex({ mySet });

      const fn = app._fn('mySet.size');
      const result = fn(app.state, {});

      expect(result).toBe(5);
    });

    it('should work with Map size in templates', () => {
      const items = new Map([['key1', 'value1'], ['key2', 'value2']]);
      app = new Reflex({ items });
      container.innerHTML = `<div m-text="items.size"></div>`;
      app.mount(container);

      expect(container.querySelector('div')?.textContent).toBe('2');
    });

    it('should work with Set size in templates', () => {
      const tags = new Set(['tag1', 'tag2', 'tag3']);
      app = new Reflex({ tags });
      container.innerHTML = `<div m-text="tags.size"></div>`;
      app.mount(container);

      expect(container.querySelector('div')?.textContent).toBe('3');
    });

    it('should update reactively when Map size changes', async () => {
      const myMap = new Map([['a', 1]]);
      app = new Reflex({ myMap });
      container.innerHTML = `<div m-text="myMap.size"></div>`;
      app.mount(container);

      expect(container.querySelector('div')?.textContent).toBe('1');

      myMap.set('b', 2);
      await app.nextTick();

      expect(container.querySelector('div')?.textContent).toBe('2');
    });
  });

  describe('Issue #4: Method Identity Instability (Performance/Logic)', () => {
    it('should return same function instance for repeated method access', () => {
      app = new Reflex({ items: [1, 2, 3] });

      const fn1 = app._fn('items.map');
      const fn2 = app._fn('items.map');

      const result1 = fn1(app.state, {});
      const result2 = fn2(app.state, {});

      // The same method should return the same function wrapper instance
      expect(result1).toBe(result2);
    });

    it('should maintain method identity for Map methods', () => {
      const myMap = new Map([['a', 1]]);
      app = new Reflex({ myMap });

      const fn = app._fn('myMap.get');
      const getter1 = fn(app.state, {});
      const getter2 = fn(app.state, {});

      expect(getter1).toBe(getter2);
    });

    it('should maintain method identity for Set methods', () => {
      const mySet = new Set([1, 2, 3]);
      app = new Reflex({ mySet });

      const fn = app._fn('mySet.has');
      const has1 = fn(app.state, {});
      const has2 = fn(app.state, {});

      expect(has1).toBe(has2);
    });

    it('should work correctly in useEffect-like scenarios', () => {
      app = new Reflex({ items: [1, 2, 3] });

      const fn = app._fn('items.map');

      // Simulate React's useEffect dependency checking
      const deps1 = [fn(app.state, {})];
      const deps2 = [fn(app.state, {})];

      // Dependencies should be strictly equal
      expect(deps1[0]).toBe(deps2[0]);
    });
  });

  describe('Issue #5: Promises are Unusable (Functional Defect)', () => {
    it('should support Promise.then method', async () => {
      const myPromise = Promise.resolve(42);
      app = new Reflex({ myPromise });

      const fn = app._fn('myPromise.then');
      const thenMethod = fn(app.state, {});

      expect(typeof thenMethod).toBe('function');

      // Should be able to use .then()
      const result = await thenMethod((x: number) => x * 2);
      expect(result).toBe(84);
    });

    it('should support Promise.catch method', async () => {
      const myPromise = Promise.reject(new Error('Test error'));
      app = new Reflex({ myPromise });

      const fn = app._fn('myPromise.catch');
      const catchMethod = fn(app.state, {});

      expect(typeof catchMethod).toBe('function');

      // Should be able to use .catch()
      const result = await catchMethod((err: Error) => err.message);
      expect(result).toBe('Test error');
    });

    it('should support Promise.finally method', async () => {
      let finallyCalled = false;
      const myPromise = Promise.resolve(123);
      app = new Reflex({ myPromise });

      const fn = app._fn('myPromise.finally');
      const finallyMethod = fn(app.state, {});

      expect(typeof finallyMethod).toBe('function');

      // Should be able to use .finally()
      const result = await finallyMethod(() => { finallyCalled = true; });
      expect(finallyCalled).toBe(true);
      expect(result).toBe(123);
    });

    it('should work with async workflows in templates', async () => {
      const fetchData = () => Promise.resolve({ name: 'Test' });
      app = new Reflex({ fetchData, data: null });

      container.innerHTML = `<button @click="fetchData().then(d => data = d)">Load</button>`;
      app.mount(container);

      const button = container.querySelector('button') as HTMLButtonElement;
      button.click();

      // Wait for promise to resolve
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(app.state.data).toEqual({ name: 'Test' });
    });
  });

  describe('Issue #6: Standard Mode vs CSP Mode Inconsistency', () => {
    it('should have consistent behavior for console access', () => {
      // Standard Mode
      const standardApp = new Reflex({ test: 'safe' });
      const standardFn = standardApp._fn('console');
      const standardResult = standardFn(standardApp.state, {});

      // CSP Mode
      const cspApp = new Reflex({ test: 'safe' });
      cspApp.configure({ cspSafe: true, parser: new SafeExprParser() });
      const cspFn = cspApp._fn('console');
      const cspResult = cspFn(cspApp.state, {});

      // Both should return console
      expect(standardResult).toBe(console);
      expect(cspResult).toBe(console);
    });

    it('should have consistent behavior for Array globals', () => {
      // Standard Mode
      const standardApp = new Reflex({ items: [1, 2, 3] });
      const standardFn = standardApp._fn('Array.isArray(items)');
      const standardResult = standardFn(standardApp.state, {});

      // CSP Mode
      const cspApp = new Reflex({ items: [1, 2, 3] });
      cspApp.configure({ cspSafe: true, parser: new SafeExprParser() });
      const cspFn = cspApp._fn('Array.isArray(items)');
      const cspResult = cspFn(cspApp.state, {});

      // Both should return true
      expect(standardResult).toBe(true);
      expect(cspResult).toBe(true);
    });

    it('should have consistent behavior for Map.size', () => {
      const myMap = new Map([['a', 1], ['b', 2]]);

      // Standard Mode
      const standardApp = new Reflex({ myMap });
      const standardFn = standardApp._fn('myMap.size');
      const standardResult = standardFn(standardApp.state, {});

      // CSP Mode
      const cspApp = new Reflex({ myMap });
      cspApp.configure({ cspSafe: true, parser: new SafeExprParser() });
      const cspFn = cspApp._fn('myMap.size');
      const cspResult = cspFn(cspApp.state, {});

      // Both should return 2
      expect(standardResult).toBe(2);
      expect(cspResult).toBe(2);
    });

    it('should have consistent behavior for Promise methods', async () => {
      const myPromise = Promise.resolve(42);

      // Standard Mode
      const standardApp = new Reflex({ myPromise });
      const standardFn = standardApp._fn('myPromise.then');
      const standardThen = standardFn(standardApp.state, {});

      // CSP Mode
      const cspApp = new Reflex({ myPromise });
      cspApp.configure({ cspSafe: true, parser: new SafeExprParser() });
      const cspFn = cspApp._fn('myPromise.then');
      const cspThen = cspFn(cspApp.state, {});

      // Both should return a function
      expect(typeof standardThen).toBe('function');
      expect(typeof cspThen).toBe('function');

      // Both should work correctly
      const standardResult = await standardThen((x: number) => x * 2);
      const cspResult = await cspThen((x: number) => x * 2);

      expect(standardResult).toBe(84);
      expect(cspResult).toBe(84);
    });

    it('should block dangerous globals consistently', () => {
      // Standard Mode
      const standardApp = new Reflex({ test: 'safe' });
      const standardWindowFn = standardApp._fn('window');
      const standardWindowResult = standardWindowFn(standardApp.state, {});

      // CSP Mode
      const cspApp = new Reflex({ test: 'safe' });
      cspApp.configure({ cspSafe: true, parser: new SafeExprParser() });
      const cspWindowFn = cspApp._fn('window');
      const cspWindowResult = cspWindowFn(cspApp.state, {});

      // Both should block window
      expect(standardWindowResult).toBeUndefined();
      expect(cspWindowResult).toBeUndefined();
    });
  });

  describe('Comprehensive Security Validation', () => {
    it('should block all prototype pollution vectors', () => {
      app = new Reflex({ obj: {} });

      // Try various prototype pollution attacks
      const attacks = [
        'obj.constructor',
        'obj.__proto__',
        'obj.prototype',
        'constructor.prototype',
        '__proto__.polluted'
      ];

      attacks.forEach(attack => {
        const fn = app._fn(attack);
        const result = fn(app.state, {});
        expect(result).toBeUndefined();
      });
    });

    it('should block all RCE vectors', () => {
      app = new Reflex({ test: 'safe' });

      const rceVectors = [
        'window.location.href',
        'window.eval',
        'Function("return process")()',
        'fetch("http://evil.com")',
        'XMLHttpRequest',
        'import',
        'require'
      ];

      rceVectors.forEach(vector => {
        const fn = app._fn(vector);
        expect(() => fn(app.state, {})).not.toThrow();
        // Should return undefined or fail safely
      });
    });

    it('should allow all safe operations', () => {
      app = new Reflex({
        count: 5,
        items: [1, 2, 3],
        myMap: new Map([['a', 1]]),
        mySet: new Set([1, 2, 3]),
        myPromise: Promise.resolve(42)
      });

      const safeOps = [
        { expr: 'count + 10', expected: 15 },
        { expr: 'items.length', expected: 3 },
        { expr: 'items.map', expected: 'function' },
        { expr: 'myMap.size', expected: 1 },
        { expr: 'mySet.size', expected: 3 },
        { expr: 'Math.PI', expected: Math.PI },
        { expr: 'myPromise.then', expected: 'function' }
      ];

      safeOps.forEach(({ expr, expected }) => {
        const fn = app._fn(expr);
        const result = fn(app.state, {});
        if (typeof expected === 'string') {
          expect(typeof result).toBe(expected);
        } else {
          expect(result).toBe(expected);
        }
      });
    });
  });
});
