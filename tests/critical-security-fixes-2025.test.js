/**
 * Critical Security and Bug Fixes Test Suite
 *
 * This test suite verifies all the critical security vulnerabilities
 * and bugs that were fixed in the 2025 security audit.
 *
 * Issues covered:
 * 1. Prototype Pollution via Object Literals in CSP Parser
 * 2. Runtime Crash due to Missing toRaw Implementation
 * 3. wrapArrayMethod Architecture (Documentation)
 * 4. Data Corruption via Map/Set.clear() Optimization
 * 5. m-ref Array Desync in Nested Structures
 * 6. Reactivity System Memory Leak
 * 7. XSS Vector via m-html Hydration Bypass
 * 8. Denial of Service via Unicode Identifiers
 * 9. Reactivity Gap for fill and copyWithin (Already fixed - verified)
 * 10. setInnerHTML Check Bypass (Documentation)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.js';
import { SafeExprParser } from '../src/csp/SafeExprParser.js';
import DOMPurify from 'dompurify';

describe('Critical Security Fixes 2025', () => {
  let app;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (app) {
      app.unmount?.();
      app = null;
    }
  });

  describe('Issue #1: Prototype Pollution via Object Literals in CSP Parser', () => {
    it('should block __proto__ in object literals', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      // Test malicious payload: {{ { ["__proto__"]: { polluted: true } } }}
      const compiled = parser.compile('{ ["__proto__"]: { polluted: true } }', reflex);
      const result = compiled({}, {});

      // Verify Object.prototype was not polluted
      expect(Object.prototype.polluted).toBeUndefined();

      // Verify the dangerous key was skipped
      expect(result).toBeDefined();
      expect(result.__proto__).toBeUndefined();
      expect('polluted' in Object.prototype).toBe(false);
    });

    it('should block constructor in object literals', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      // Test malicious payload: {{ { constructor: "hacked" } }}
      const compiled = parser.compile('{ constructor: "hacked" }', reflex);
      const result = compiled({}, {});

      // Verify the constructor key was blocked
      expect(result.constructor).not.toBe("hacked");
    });

    it('should allow safe object literals', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      const compiled = parser.compile('{ foo: "bar", baz: 123 }', reflex);
      const result = compiled({}, {});

      expect(result).toEqual({ foo: "bar", baz: 123 });
    });
  });

  describe('Issue #2: Runtime Crash due to Missing toRaw Implementation', () => {
    it('should not crash when calling array methods on reactive arrays', () => {
      app = new Reflex({
        state: { items: [1, 2, 3] }
      });

      // This should not throw "TypeError: engine.toRaw is not a function"
      expect(() => {
        app.s.items.push(4);
      }).not.toThrow();

      expect(app.s.items.length).toBe(4);
    });

    it('should implement toRaw correctly', () => {
      app = new Reflex({
        state: { obj: { foo: 'bar' } }
      });

      const proxy = app.s.obj;
      const raw = app.toRaw(proxy);

      // toRaw should return the underlying raw object
      expect(raw).toBeDefined();
      expect(raw.foo).toBe('bar');

      // The raw object should not be a proxy
      expect(raw[Symbol.for('rx.meta')]).toBeUndefined();
    });
  });

  describe('Issue #4: Data Corruption via Map/Set.clear() Optimization', () => {
    it('should notify ALL watchers when clearing large Maps', async () => {
      app = new Reflex({
        state: {
          bigMap: new Map(),
          watchedKey1500: null
        }
      });

      // Create a Map with 2000 items
      for (let i = 0; i < 2000; i++) {
        app.s.bigMap.set(`key${i}`, i);
      }

      // Watch item #1500 specifically
      let watcherFired = false;
      app.watch(
        () => app.s.bigMap.get('key1500'),
        (val) => {
          watcherFired = true;
        }
      );

      // Access the key to establish dependency
      const value = app.s.bigMap.get('key1500');
      expect(value).toBe(1500);

      // Clear the map
      app.s.bigMap.clear();

      // Wait for reactivity to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // CRITICAL: The watcher should have fired
      // Previous bug: only first 1000 keys were notified
      expect(watcherFired).toBe(true);
    });

    it('should notify watchers for Sets as well', async () => {
      app = new Reflex({
        state: {
          bigSet: new Set()
        }
      });

      // Create a Set with 2000 items
      for (let i = 0; i < 2000; i++) {
        app.s.bigSet.add(`item${i}`);
      }

      // Watch for existence of specific item
      let watcherFired = false;
      app.watch(
        () => app.s.bigSet.has('item1500'),
        (val) => {
          watcherFired = true;
        }
      );

      // Access the item to establish dependency
      const exists = app.s.bigSet.has('item1500');
      expect(exists).toBe(true);

      // Clear the set
      app.s.bigSet.clear();

      // Wait for reactivity to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // CRITICAL: The watcher should have fired
      expect(watcherFired).toBe(true);
    });
  });

  describe('Issue #5: m-ref Array Desync in Nested Structures', () => {
    it('should maintain correct order for nested m-ref elements after reordering', async () => {
      app = new Reflex({
        state: {
          items: [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
            { id: 3, name: 'C' }
          ],
          spanRefs: []
        }
      }).mount('#app');

      // Create HTML with nested m-ref
      document.getElementById('app').innerHTML = `
        <div m-for="item in items" m-key="item.id">
          <span m-ref="spanRefs" m-text="item.name"></span>
        </div>
      `;

      app._w(document.getElementById('app'));

      // Wait for initial render
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify initial order
      expect(app._refs.spanRefs).toHaveLength(3);
      expect(app._refs.spanRefs[0].textContent).toBe('A');
      expect(app._refs.spanRefs[1].textContent).toBe('B');
      expect(app._refs.spanRefs[2].textContent).toBe('C');

      // Reverse the array
      app.s.items.reverse();

      // Wait for reconciliation
      await new Promise(resolve => setTimeout(resolve, 100));

      // CRITICAL: Refs should match new DOM order
      expect(app._refs.spanRefs).toHaveLength(3);
      expect(app._refs.spanRefs[0].textContent).toBe('C');
      expect(app._refs.spanRefs[1].textContent).toBe('B');
      expect(app._refs.spanRefs[2].textContent).toBe('A');
    });
  });

  describe('Issue #6: Reactivity System Memory Leak', () => {
    it('should clean up empty dependency sets when effects are disposed', () => {
      app = new Reflex({
        state: { counter: 0 }
      });

      // Get the reactive metadata
      const meta = app.s[Symbol.for('rx.meta')];
      const initialDepCount = meta.d.size;

      // Create and immediately dispose multiple effects
      for (let i = 0; i < 100; i++) {
        const effect = app.createEffect(() => {
          // Access counter to create dependency
          const val = app.s.counter;
        });

        // Manually cleanup the effect
        app._cleanupEffect(effect);
      }

      // CRITICAL: Empty dependency sets should be removed
      // Without the fix, meta.d would have 100+ entries (all empty Sets)
      // With the fix, it should be close to the initial count
      expect(meta.d.size).toBeLessThanOrEqual(initialDepCount + 5);
    });
  });

  describe('Issue #7: XSS Vector via m-html Hydration Bypass', () => {
    it('should require DOMPurify for m-html by default', () => {
      app = new Reflex({
        state: { html: '<div>test</div>' }
      });

      document.getElementById('app').innerHTML = '<div m-html="html"></div>';

      // Without DOMPurify, should throw error
      expect(() => {
        app.mount('#app');
      }).toThrow(/DOMPurify/);
    });

    it('should sanitize HTML when DOMPurify is configured', () => {
      app = new Reflex({
        state: { html: '<img src=x onerror=alert(1)>' }
      }).configure({ domPurify: DOMPurify });

      document.getElementById('app').innerHTML = '<div m-html="html"></div>';
      app.mount('#app');

      // DOMPurify should strip the dangerous content
      const div = document.querySelector('[m-html]');
      expect(div.innerHTML).not.toContain('onerror');
    });

    it('should skip normalization during hydration when sanitization is disabled', async () => {
      app = new Reflex({
        state: { html: '<div>safe</div>' }
      }).configure({ sanitize: false });

      document.getElementById('app').innerHTML = '<div m-html="html"></div>';

      // Enable hydration mode
      app._hydrateMode = true;

      // This should not throw and should skip normalization
      const consoleWarnSpy = vitest.spyOn(console, 'warn').mockImplementation(() => {});

      app.mount('#app');

      // Should warn about skipping normalization
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Issue #8: Unicode Identifier Support', () => {
    it('should parse Unicode identifiers in CSP-safe mode', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      // Test with accented characters
      const state = { café: 'coffee' };
      const compiled = parser.compile('café', reflex);
      const result = compiled(state, {});

      expect(result).toBe('coffee');
    });

    it('should parse CJK identifiers', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      // Test with Chinese characters
      const state = { 名前: 'name' };
      const compiled = parser.compile('名前', reflex);
      const result = compiled(state, {});

      expect(result).toBe('name');
    });

    it('should parse Greek identifiers', () => {
      const parser = new SafeExprParser();
      const reflex = new Reflex();

      // Test with Greek characters
      const state = { μήνυμα: 'message' };
      const compiled = parser.compile('μήνυμα', reflex);
      const result = compiled(state, {});

      expect(result).toBe('message');
    });
  });

  describe('Issue #9: Reactivity for fill and copyWithin (Verification)', () => {
    it('should trigger reactivity when using fill()', async () => {
      app = new Reflex({
        state: { arr: [1, 2, 3, 4, 5] }
      }).mount('#app');

      document.getElementById('app').innerHTML = '<div m-text="arr.join(\',\')"></div>';
      app._w(document.getElementById('app'));

      await new Promise(resolve => setTimeout(resolve, 50));

      const div = document.querySelector('[m-text]');
      expect(div.textContent).toBe('1,2,3,4,5');

      // Use fill to change the array
      app.s.arr.fill(0);

      await new Promise(resolve => setTimeout(resolve, 50));

      // CRITICAL: UI should update
      expect(div.textContent).toBe('0,0,0,0,0');
    });

    it('should trigger reactivity when using copyWithin()', async () => {
      app = new Reflex({
        state: { arr: [1, 2, 3, 4, 5] }
      }).mount('#app');

      document.getElementById('app').innerHTML = '<div m-text="arr.join(\',\')"></div>';
      app._w(document.getElementById('app'));

      await new Promise(resolve => setTimeout(resolve, 50));

      const div = document.querySelector('[m-text]');
      expect(div.textContent).toBe('1,2,3,4,5');

      // Use copyWithin to modify the array
      app.s.arr.copyWithin(0, 3);

      await new Promise(resolve => setTimeout(resolve, 50));

      // CRITICAL: UI should update
      expect(div.textContent).toBe('4,5,3,4,5');
    });
  });

  describe('Issue #10: setInnerHTML Security Documentation', () => {
    it('should throw on obvious XSS patterns', () => {
      app = new Reflex().mount('#app');

      const element = document.createElement('div');

      // Should throw on <script> tags
      expect(() => {
        app._ren.setInnerHTML(element, '<script>alert(1)</script>');
      }).toThrow(/SECURITY ERROR/);

      // Should throw on javascript: URIs
      expect(() => {
        app._ren.setInnerHTML(element, '<a href="javascript:alert(1)">click</a>');
      }).toThrow(/SECURITY ERROR/);

      // Should throw on event handlers
      expect(() => {
        app._ren.setInnerHTML(element, '<img src=x onerror=alert(1)>');
      }).toThrow(/SECURITY ERROR/);
    });

    it('should warn in development mode even for safe content', () => {
      app = new Reflex().mount('#app');

      const consoleWarnSpy = vitest.spyOn(console, 'warn').mockImplementation(() => {});

      const element = document.createElement('div');
      app._ren.setInnerHTML(element, '<div>safe content</div>');

      // Should warn about using setInnerHTML
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('DOMPurify');

      consoleWarnSpy.mockRestore();
    });
  });
});
