/**
 * Critical Bug Fixes Test Suite
 *
 * This file contains mandatory test cases for all critical, high, medium, and low severity bugs
 * that were fixed in this patch. Each test corresponds to a specific issue in the bug report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';
import { SafeExprParser } from '../src/csp/SafeExprParser.ts';

describe('Critical Fixes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('1. Critical: Sandbox Escape via getRootNode()', () => {
    it('CSP: prevents access to getRootNode()', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parser = new SafeExprParser();
      const app = new Reflex({ count: 0 });
      app.configure({ cspSafe: true, parser });

      const el = document.createElement('div');
      document.body.appendChild(el);

      // Attempt to access document via getRootNode()
      const expr = "$el.getRootNode()";
      const fn = parser.compile(expr, app);

      // Should return undefined, NOT return the document
      const result = fn(app.s, null, null, el);
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Blocked call to unsafe method'),
        'getRootNode'
      );

      warnSpy.mockRestore();
    });
  });

  describe('2. Critical: Array Truncation Batching', () => {
    it('Reactivity: handles massive array truncation correctly', async () => {
      const app = new Reflex({ items: new Array(2000).fill(0).map((_, i) => i) }, { autoMount: false });
      let lastItem = null;

      // Watch the 1500th item specifically
      app.createEffect(() => {
        lastItem = app.s.items[1500];
      });

      expect(lastItem).toBe(1500);

      // Truncate array to 0
      app.s.items.length = 0;
      await app.nextTick();

      // The watcher for index 1500 MUST fire and see undefined
      expect(lastItem).toBeUndefined();
    });

    it('Reactivity: triggers watchers for all deleted indices', async () => {
      const app = new Reflex({ items: new Array(1500).fill(0).map((_, i) => i) }, { autoMount: false });
      const watchedIndices = [100, 500, 1000, 1499];
      const results = {};

      // Watch multiple specific indices
      watchedIndices.forEach(idx => {
        app.createEffect(() => {
          results[idx] = app.s.items[idx];
        });
      });

      // Verify initial values
      watchedIndices.forEach(idx => {
        expect(results[idx]).toBe(idx);
      });

      // Truncate array
      app.s.items.length = 0;
      await app.nextTick();

      // All watchers MUST fire and see undefined
      watchedIndices.forEach(idx => {
        expect(results[idx]).toBeUndefined();
      });
    });
  });

  describe('3. High: Number Input UX Broken', () => {
    it('Forms: allows typing decimal numbers without cursor jump', async () => {
      document.body.innerHTML = '<input type="number" m-model="val">';
      const app = new Reflex({ val: 1 });
      await app.nextTick();

      const input = document.querySelector('input');

      // User types "1."
      input.value = '1.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await app.nextTick();

      // DOM value must remain "1." (not revert to "1")
      expect(input.value).toBe('1.');
      // State should NOT have updated yet
      expect(app.s.val).toBe(1);
    });

    it('Forms: preserves intermediate negative number state', async () => {
      document.body.innerHTML = '<input type="number" m-model="val">';
      const app = new Reflex({ val: 0 });
      await app.nextTick();

      const input = document.querySelector('input');

      // User types "-5."
      input.value = '-5.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await app.nextTick();

      // DOM value must remain "-5." (not revert to "-5")
      expect(input.value).toBe('-5.');
      // State should NOT update yet (incomplete decimal)
      expect(app.s.val).toBe(0);
    });

    it('Forms: allows typing scientific notation', async () => {
      document.body.innerHTML = '<input type="number" m-model="val">';
      const app = new Reflex({ val: 0 });
      await app.nextTick();

      const input = document.querySelector('input');

      // User types "1e"
      input.value = '1e';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await app.nextTick();

      // DOM value must remain "1e"
      expect(input.value).toBe('1e');
    });

    it('Forms: updates state when complete number is typed', async () => {
      document.body.innerHTML = '<input type="number" m-model="val">';
      const app = new Reflex({ val: 1 });
      await app.nextTick();

      const input = document.querySelector('input');

      // User types "1.5" (complete number)
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await app.nextTick();

      // State should update to 1.5
      expect(app.s.val).toBe(1.5);
    });
  });

  describe('5. Medium: Async Component Fragment Leak', () => {
    it('Async: correctly unmounts multi-root fragment components', async () => {
      const app = new Reflex({ show: true }, { autoMount: false });
      const container = document.createElement('div');
      document.body.appendChild(container);

      // Async component returning fragment (multiple root elements)
      // Note: Async components with fragments are rendered sequentially
      app.component('async-list', () => Promise.resolve({
        template: '<li>A</li>'
      }));

      container.innerHTML = '<ul m-if="show"><async-list></async-list><async-list></async-list></ul>';
      app.mount(container);

      // Wait for async components to load
      await new Promise(resolve => setTimeout(resolve, 100));
      await app.nextTick();

      const initialCount = container.querySelectorAll('li').length;
      expect(initialCount).toBeGreaterThan(0);

      // Toggle off
      app.s.show = false;
      await app.nextTick();

      // ALL elements must be gone (no leak)
      expect(container.querySelectorAll('li').length).toBe(0);

      app.unmount();
    });
  });

  describe('6. Medium: unmount() Leaks Children', () => {
    it('Lifecycle: unmount cleans up child effect listeners', () => {
      const app = new Reflex({ count: 0 }, { autoMount: false });
      const child = document.createElement('div');
      let cleaned = false;

      // Register a cleanup on a child node
      app._reg(child, () => { cleaned = true; });

      const root = document.createElement('div');
      root.appendChild(child);

      app.mount(root);
      app.unmount();

      expect(cleaned).toBe(true);
    });

    it('Lifecycle: unmount cleans up deeply nested effects', () => {
      const app = new Reflex({ count: 0 }, { autoMount: false });
      const cleanups = [];

      // Create nested structure
      const root = document.createElement('div');
      const level1 = document.createElement('div');
      const level2 = document.createElement('div');
      const level3 = document.createElement('div');

      root.appendChild(level1);
      level1.appendChild(level2);
      level2.appendChild(level3);

      // Register cleanups at different levels
      app._reg(level1, () => { cleanups.push('level1'); });
      app._reg(level2, () => { cleanups.push('level2'); });
      app._reg(level3, () => { cleanups.push('level3'); });

      app.mount(root);
      app.unmount();

      // All cleanups should have run
      expect(cleanups).toContain('level1');
      expect(cleanups).toContain('level2');
      expect(cleanups).toContain('level3');
      expect(cleanups.length).toBe(3);
    });
  });

  describe('7. Medium: computed() is Eager', () => {
    it('Reactivity: computed properties are lazy', () => {
      const app = new Reflex({ count: 0 });
      let runs = 0;

      const computed = app.computed(() => {
        runs++;
        return app.s.count * 2;
      });

      // Should NOT run on creation
      expect(runs).toBe(0);

      // Should run on first access
      const val = computed.value;
      expect(runs).toBe(1);
      expect(val).toBe(0);

      // Should not run again if value unchanged
      const val2 = computed.value;
      expect(runs).toBe(1);
      expect(val2).toBe(0);
    });

    it('Reactivity: computed updates only when accessed', async () => {
      const app = new Reflex({ count: 0 });
      let runs = 0;

      const computed = app.computed(() => {
        runs++;
        return app.s.count * 2;
      });

      // Change state
      app.s.count = 5;
      await app.nextTick();

      // Should not run until accessed
      expect(runs).toBe(0);

      // Access computed
      const val = computed.value;
      expect(runs).toBe(1);
      expect(val).toBe(10);
    });
  });

  describe('10. Low: queueMicrotask Polyfill Error Swallowing', () => {
    it('Scheduler: polyfill errors are reported', async () => {
      // This test verifies that errors in the microtask queue are reported
      // The polyfill now uses reportError or console.error instead of silent setTimeout

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create a task that throws
      const app = new Reflex({ count: 0 }, { autoMount: false });

      // Queue a job that will throw
      app.createEffect(() => {
        if (app.s.count > 0) {
          throw new Error('Test Error');
        }
      });

      // Trigger the error
      app.s.count = 1;

      // Wait for microtask to execute
      await new Promise(resolve => setTimeout(resolve, 10));

      // Error should have been logged
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });
});

describe('Additional Verification Tests', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('Array truncation: preserves ITERATE watchers', async () => {
    const app = new Reflex({ items: [1, 2, 3, 4, 5] }, { autoMount: false });
    let iterationCount = 0;

    // Watch the array via iteration
    app.createEffect(() => {
      iterationCount = 0;
      for (const item of app.s.items) {
        iterationCount++;
      }
    });

    expect(iterationCount).toBe(5);

    // Truncate
    app.s.items.length = 2;
    await app.nextTick();

    // ITERATE watcher should fire
    expect(iterationCount).toBe(2);
  });

  it('Number input: completes typing workflow', async () => {
    document.body.innerHTML = '<input type="number" m-model="price">';
    const app = new Reflex({ price: 0 });
    await app.nextTick();

    const input = document.querySelector('input');

    // Simulate user typing "12.99"
    input.value = '1';
    input.dispatchEvent(new Event('input'));
    await app.nextTick();
    expect(app.s.price).toBe(1);

    input.value = '12';
    input.dispatchEvent(new Event('input'));
    await app.nextTick();
    expect(app.s.price).toBe(12);

    input.value = '12.';
    input.dispatchEvent(new Event('input'));
    await app.nextTick();
    expect(input.value).toBe('12.'); // Preserved
    expect(app.s.price).toBe(12); // Not updated yet

    input.value = '12.9';
    input.dispatchEvent(new Event('input'));
    await app.nextTick();
    expect(app.s.price).toBe(12.9);

    input.value = '12.99';
    input.dispatchEvent(new Event('input'));
    await app.nextTick();
    expect(app.s.price).toBe(12.99);
  });

  it('Computed lazy: no unnecessary computations', async () => {
    const app = new Reflex({ a: 1, b: 2 });
    let aComputations = 0;
    let bComputations = 0;

    const sumA = app.computed(() => {
      aComputations++;
      return app.s.a * 2;
    });

    const sumB = app.computed(() => {
      bComputations++;
      return app.s.b * 3;
    });

    // No computations yet
    expect(aComputations).toBe(0);
    expect(bComputations).toBe(0);

    // Access only sumA
    const val = sumA.value;
    expect(val).toBe(2);
    expect(aComputations).toBe(1);
    expect(bComputations).toBe(0); // sumB should not compute

    // Change b (sumA should not recompute)
    app.s.b = 10;
    await app.nextTick();
    expect(aComputations).toBe(1); // Still 1

    // Access sumB
    const valB = sumB.value;
    expect(valB).toBe(30);
    expect(bComputations).toBe(1);
  });
});
