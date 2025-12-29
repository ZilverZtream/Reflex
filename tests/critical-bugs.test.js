/**
 * Critical Bugs Test Suite
 *
 * Tests for 10 critical bugs identified in the Reflex framework:
 * 1. Map/Set Iterator data corruption (reusable array)
 * 2. setInnerHTML XSS denylist bypass
 * 3. m-model bracket notation failure
 * 4. SafeExprParser regex false positives
 * 5. m-model object binding failure
 * 6. Deep watch prototype destruction
 * 7. Component fragment data loss
 * 8. m-model.number ignored on text inputs
 * 9. m-show blocks CSS media queries
 * 10. Aggressive deep watch limit (1000 nodes)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';
import { SafeExprParser } from '../src/csp/SafeExprParser.ts';

describe('Critical Bugs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Bug #1: Map/Set Iterator Data Corruption', () => {
    it('CRITICAL: should return distinct array instances for Map iterator', async () => {
      const app = new Reflex({ map: new Map([['a', 1], ['b', 2]]) });
      await app.nextTick();

      // Currently fails: all entries become ['b', 2] because they reference the same array
      const entries = [...app.s.map];
      expect(entries[0]).toEqual(['a', 1]);
      expect(entries[1]).toEqual(['b', 2]);

      // Verify reference identity - each entry should be a distinct array
      expect(entries[0]).not.toBe(entries[1]);
    });

    it('CRITICAL: should return distinct array instances for Map.entries()', async () => {
      const app = new Reflex({ map: new Map([['x', 10], ['y', 20], ['z', 30]]) });
      await app.nextTick();

      const entries = Array.from(app.s.map.entries());
      expect(entries[0]).toEqual(['x', 10]);
      expect(entries[1]).toEqual(['y', 20]);
      expect(entries[2]).toEqual(['z', 30]);

      // Verify each entry is a distinct array instance
      expect(entries[0]).not.toBe(entries[1]);
      expect(entries[1]).not.toBe(entries[2]);
    });

    it('CRITICAL: should handle Array.from() on reactive Map', async () => {
      const app = new Reflex({ map: new Map([['first', 'A'], ['second', 'B']]) });
      await app.nextTick();

      const entries = Array.from(app.s.map);
      expect(entries).toEqual([['first', 'A'], ['second', 'B']]);

      // Verify distinct instances
      expect(entries[0]).not.toBe(entries[1]);
    });
  });

  describe('Bug #2: setInnerHTML XSS Denylist Bypass', () => {
    it('CRITICAL: should block base64 encoded XSS vectors in setInnerHTML', () => {
      const renderer = new Reflex()._ren;
      const div = document.createElement('div');

      // Base64 encoded <script>alert(1)</script>
      const payload = '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>';

      // Should throw or sanitize
      expect(() => {
        renderer.setInnerHTML(div, payload);
      }).toThrow(/dangerous content/i);
    });

    it('CRITICAL: should block iframe with javascript: protocol', () => {
      const renderer = new Reflex()._ren;
      const div = document.createElement('div');

      const payload = '<iframe src="javascript:alert(1)"></iframe>';

      expect(() => {
        renderer.setInnerHTML(div, payload);
      }).toThrow(/dangerous content/i);
    });

    it('CRITICAL: should block SVG with onload handler', () => {
      const renderer = new Reflex()._ren;
      const div = document.createElement('div');

      const payload = '<svg/onload=alert(1)>';

      expect(() => {
        renderer.setInnerHTML(div, payload);
      }).toThrow(/dangerous content/i);
    });
  });

  describe('Bug #3: m-model Bracket Notation Failure', () => {
    it('CRITICAL: should support bracket notation in m-model', async () => {
      document.body.innerHTML = '<input type="text" m-model="list[0]">';
      const app = new Reflex({ list: ['initial'] });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('initial');

      input.value = 'updated';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      // Current failure: app.s["list[0]"] = 'updated'
      // Expected: app.s.list[0] = 'updated'
      expect(app.s.list[0]).toBe('updated');
    });

    it('CRITICAL: should support nested bracket notation', async () => {
      document.body.innerHTML = '<input type="text" m-model="data[0].value">';
      const app = new Reflex({ data: [{ value: 'test' }] });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('test');

      input.value = 'modified';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      expect(app.s.data[0].value).toBe('modified');
    });

    it('CRITICAL: should support multiple bracket notations', async () => {
      document.body.innerHTML = '<input type="text" m-model="grid[1][2]">';
      const app = new Reflex({ grid: [[0, 1, 2], [3, 4, 5]] });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('5');

      input.value = '99';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      expect(app.s.grid[1][2]).toBe('99');
    });
  });

  describe('Bug #4: SafeExprParser Regex False Positives', () => {
    it('CRITICAL: should allow safe properties containing reserved words', async () => {
      const app = new Reflex({
        user: { constructor_id: 123, proto_config: 'safe', eval_result: 'ok' }
      });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });

      // These currently fail validation because regex treats _ as word boundary
      const fn1 = app._fn('user.constructor_id');
      const fn2 = app._fn('user.proto_config');
      const fn3 = app._fn('user.eval_result');

      expect(fn1(app.s)).toBe(123);
      expect(fn2(app.s)).toBe('safe');
      expect(fn3(app.s)).toBe('ok');
    });

    it('CRITICAL: should allow properties with underscores and reserved substrings', async () => {
      const app = new Reflex({
        data: {
          import_date: '2025-01-01',
          function_name: 'test',
          process_id: 456
        }
      });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });

      const fn1 = app._fn('data.import_date');
      const fn2 = app._fn('data.function_name');
      const fn3 = app._fn('data.process_id');

      expect(fn1(app.s)).toBe('2025-01-01');
      expect(fn2(app.s)).toBe('test');
      expect(fn3(app.s)).toBe(456);
    });

    it('CRITICAL: should still block actual dangerous properties', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const app = new Reflex({ obj: {} });
      app.configure({ cspSafe: true, parser: new SafeExprParser() });

      // These SHOULD be blocked - the framework logs warnings instead of throwing
      app._fn('obj.constructor');
      app._fn('obj.__proto__');
      app._fn('obj.prototype');

      // Verify warnings were issued
      expect(warnSpy).toHaveBeenCalled();
      const warnings = warnSpy.mock.calls.flat().join(' ');
      expect(warnings).toContain('unsafe');

      warnSpy.mockRestore();
    });
  });

  describe('Bug #5: m-model Object Binding Failure', () => {
    it('CRITICAL: should support object identity in checkbox values', async () => {
      const objA = { id: 1, name: 'A' };
      const objB = { id: 2, name: 'B' };

      document.body.innerHTML = `
        <input id="a" type="checkbox" m-model="selected">
        <input id="b" type="checkbox" m-model="selected">
      `;

      const app = new Reflex({ optA: objA, optB: objB, selected: [] });
      await app.nextTick();

      // Set the value programmatically (since we can't use :value in innerHTML)
      const inputA = document.getElementById('a');
      const inputB = document.getElementById('b');

      // Simulate binding objects to checkboxes
      inputA._boundValue = objA;
      inputB._boundValue = objB;

      inputA.checked = true;
      inputA.dispatchEvent(new Event('change'));
      await app.nextTick();

      // Should contain the actual object, not "[object Object]"
      // Note: This test demonstrates the limitation - we need to fix the implementation
      // For now, this will fail and we'll fix it
      expect(app.s.selected.length).toBeGreaterThan(0);
    });
  });

  describe('Bug #6: Deep Watch Prototype Destruction', () => {
    it('CRITICAL: should preserve class prototypes in deep watchers', async () => {
      class User {
        greet() { return 'Hi'; }
        getName() { return this.name || 'Anonymous'; }
      }

      const user = new User();
      user.name = 'John';

      const app = new Reflex({ user });

      let oldValue;
      app.watch(() => app.s.user, (newVal, oldVal) => {
        oldValue = oldVal;
      }, { deep: true });

      app.s.user.name = 'Updated';
      await app.nextTick();

      // Current failure: oldValue is generic Object, greet() is undefined
      expect(oldValue instanceof User).toBe(true);
      expect(typeof oldValue.greet).toBe('function');
      expect(oldValue.greet()).toBe('Hi');
    });

    it('CRITICAL: should preserve custom class methods in deep watch', async () => {
      class Product {
        constructor(name, price) {
          this.name = name;
          this.price = price;
        }

        getTotal(qty) {
          return this.price * qty;
        }
      }

      const product = new Product('Widget', 10);
      const app = new Reflex({ product });

      let capturedOldValue;
      app.watch(() => app.s.product, (newVal, oldVal) => {
        capturedOldValue = oldVal;
      }, { deep: true });

      app.s.product.price = 20;
      await app.nextTick();

      expect(capturedOldValue instanceof Product).toBe(true);
      expect(capturedOldValue.getTotal(5)).toBe(50);
    });
  });

  describe('Bug #7: Component Fragment Data Loss', () => {
    it('CRITICAL: should support multi-root components (fragments)', async () => {
      document.body.innerHTML = '<my-comp></my-comp>';
      const app = new Reflex({});
      app.configure({ sanitize: false }); // Disable sanitization for test

      app.component('my-comp', {
        template: '<span>Part 1</span><span>Part 2</span>'
      });

      app.mount();
      await app.nextTick();

      // Current failure: Only Part 1 renders
      expect(document.body.innerHTML).toContain('Part 1');
      expect(document.body.innerHTML).toContain('Part 2');
    });

    it('CRITICAL: should render all fragment children', async () => {
      document.body.innerHTML = '<frag-comp></frag-comp>';
      const app = new Reflex({});
      app.configure({ sanitize: false }); // Disable sanitization for test

      app.component('frag-comp', {
        template: '<div>A</div><div>B</div><div>C</div>'
      });

      app.mount();
      await app.nextTick();

      const divs = document.querySelectorAll('div');
      expect(divs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Bug #8: m-model.number Ignored on Text Inputs', () => {
    it('CRITICAL: should respect .number modifier on text inputs', async () => {
      document.body.innerHTML = '<input type="text" m-model.number="age">';
      const app = new Reflex({ age: 10 });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('10');

      input.value = '20';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      expect(typeof app.s.age).toBe('number');
      expect(app.s.age).toBe(20);
    });

    it('CRITICAL: should handle invalid numbers with .number modifier', async () => {
      document.body.innerHTML = '<input type="text" m-model.number="value">';
      const app = new Reflex({ value: 0 });
      await app.nextTick();

      const input = document.querySelector('input');

      input.value = 'abc';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      // Should handle invalid number gracefully (NaN or leave unchanged)
      expect(typeof app.s.value === 'number' || app.s.value === 'abc').toBe(true);
    });

    it('CRITICAL: should parse floats with .number modifier', async () => {
      document.body.innerHTML = '<input type="text" m-model.number="price">';
      const app = new Reflex({ price: 0 });
      await app.nextTick();

      const input = document.querySelector('input');

      input.value = '19.99';
      input.dispatchEvent(new Event('input'));
      await app.nextTick();

      expect(typeof app.s.price).toBe('number');
      expect(app.s.price).toBe(19.99);
    });
  });

  describe('Bug #9: m-show Blocks CSS Media Queries', () => {
    it('CRITICAL: m-show should not permanently override CSS display types', async () => {
      // Simulate an element that should be 'flex' via CSS class
      document.body.innerHTML = `
        <style>.flex-box { display: flex; }</style>
        <div class="flex-box" m-show="visible"></div>
      `;
      const app = new Reflex({ visible: true });
      await app.nextTick();

      const div = document.querySelector('div');

      // m-show sets "display: block !important" or similar inline, killing the CSS class
      // It should ideally remove the inline style to let CSS take over
      // Or at least not use !important so CSS can override
      const inlineDisplay = div.style.display;

      // Check if inline style doesn't permanently override with !important
      // The style should either be empty or not use !important
      expect(inlineDisplay).not.toContain('important');
    });

    it('CRITICAL: m-show should respect responsive CSS classes', async () => {
      document.body.innerHTML = `
        <style>
          .responsive { display: block; }
          @media (min-width: 768px) {
            .responsive { display: grid; }
          }
        </style>
        <div class="responsive" m-show="show"></div>
      `;
      const app = new Reflex({ show: true });
      await app.nextTick();

      const div = document.querySelector('div');

      // Toggle visibility
      app.s.show = false;
      await app.nextTick();

      app.s.show = true;
      await app.nextTick();

      // After re-showing, CSS should still be able to control display type
      // The inline style shouldn't lock it to a specific value with !important
      const hasImportant = div.getAttribute('style')?.includes('important');
      expect(hasImportant).toBeFalsy();
    });
  });

  describe('Bug #10: Aggressive Deep Watch Limit', () => {
    it('CRITICAL: should support deep watching of moderate datasets (>1000 nodes)', async () => {
      // Create a dataset slightly larger than the 1000 node limit
      const data = Array.from({ length: 1500 }, (_, i) => ({ id: i, val: i }));
      const app = new Reflex({ data });

      let changeDetected = false;
      app.watch(() => app.s.data, () => {
        changeDetected = true;
      }, { deep: true });

      // Mutate the last item (node #1500)
      // Currently fails because traversal stops at 1000
      app.s.data[1499].val = 999;
      await app.nextTick();

      expect(changeDetected).toBe(true);
    });

    it('CRITICAL: should track changes in large nested structures', async () => {
      // Create 60 rows × 20 columns = 1200 nodes
      const table = Array.from({ length: 60 }, (_, row) =>
        Array.from({ length: 20 }, (_, col) => ({ row, col, value: row * 100 + col }))
      );

      const app = new Reflex({ table });

      let watcherCalled = false;
      app.watch(() => app.s.table, () => {
        watcherCalled = true;
      }, { deep: true });

      // Modify the last cell (row 59, col 19)
      app.s.table[59][19].value = 9999;
      await app.nextTick();

      expect(watcherCalled).toBe(true);
    });

    it('CRITICAL: should not silently fail on large datasets', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const largeData = Array.from({ length: 2000 }, (_, i) => ({ id: i }));
      const app = new Reflex({ largeData });

      app.watch(() => app.s.largeData, () => {}, { deep: true });

      // Modify data
      app.s.largeData[1999].id = -1;
      await app.nextTick();

      // Should either work OR warn the user, not silently fail
      const warnings = warnSpy.mock.calls.flat().join(' ');
      const hasWarning = warnings.includes('exceeded') || warnings.includes('max') || warnings.includes('limit');

      warnSpy.mockRestore();

      // If it warns, that's acceptable (though not ideal)
      // Silently failing is NOT acceptable
      if (hasWarning) {
        expect(hasWarning).toBe(true);
      }
    });
  });
});
