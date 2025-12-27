/**
 * Auto-Cleanup (MutationObserver) Plugin Tests
 *
 * Tests the withAutoCleanup plugin that automatically detects when elements
 * are removed by external scripts (jQuery, HTMX, vanilla el.remove()) and
 * cleans up their listeners/memory.
 *
 * Key scenarios:
 * - External DOM removal triggers cleanup
 * - Window/document listeners are cleaned up
 * - Performance: 1000 non-Reflex elements don't trigger expensive cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';
import { withAutoCleanup, RX_MARKER } from '../src/observer/index.ts';

describe('Auto-Cleanup (MutationObserver) Plugin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('External DOM Removal Cleanup', () => {
    it('should clean up window listeners when element is removed via el.remove()', async () => {
      // Setup: Track window click listeners
      let windowClickCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);
      const windowListeners = new Map();

      window.addEventListener = function(type, fn, opts) {
        if (type === 'click') {
          windowClickCount++;
          windowListeners.set(fn, true);
        }
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'click' && windowListeners.has(fn)) {
          windowClickCount--;
          windowListeners.delete(fn);
        }
        return originalWindowRemove(type, fn, opts);
      };

      try {
        // Create component with @click.window
        document.body.innerHTML = `
          <div id="comp" @click.window="count++">
            <span>Count: {{ count }}</span>
          </div>
        `;

        const app = new Reflex({ count: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        // Verify the listener was added
        const initialListenerCount = windowClickCount;
        expect(initialListenerCount).toBeGreaterThan(0);

        // Verify clicking window increments count
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await app.nextTick();
        expect(app.s.count).toBe(1);

        // THE ACTION: Remove component using vanilla JS (NOT m-if)
        const comp = document.querySelector('#comp');
        comp.remove();

        // Wait for MutationObserver (next microtask)
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // VERIFICATION: Click window again
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await app.nextTick();

        // RESULT: Count MUST NOT increment (listener was cleaned up)
        expect(app.s.count).toBe(1);

        // Additional check: listener count should be reduced
        expect(windowClickCount).toBeLessThan(initialListenerCount);
      } finally {
        // Cleanup
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });

    it('should clean up document listeners when element is removed externally', async () => {
      let documentKeydownCount = 0;
      const originalDocAdd = document.addEventListener.bind(document);
      const originalDocRemove = document.removeEventListener.bind(document);
      const docListeners = new Map();

      document.addEventListener = function(type, fn, opts) {
        if (type === 'keydown') {
          documentKeydownCount++;
          docListeners.set(fn, true);
        }
        return originalDocAdd(type, fn, opts);
      };

      document.removeEventListener = function(type, fn, opts) {
        if (type === 'keydown' && docListeners.has(fn)) {
          documentKeydownCount--;
          docListeners.delete(fn);
        }
        return originalDocRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="keyboard-handler" @keydown.document="lastKey = $event.key">
            Last key: {{ lastKey }}
          </div>
        `;

        const app = new Reflex({ lastKey: '' });
        app.use(withAutoCleanup);
        await app.nextTick();

        // Verify listener was added
        expect(documentKeydownCount).toBeGreaterThan(0);
        const initialCount = documentKeydownCount;

        // Trigger keydown
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await app.nextTick();
        expect(app.s.lastKey).toBe('Enter');

        // Remove element externally
        document.querySelector('#keyboard-handler').remove();

        // Wait for cleanup
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Trigger keydown again
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await app.nextTick();

        // Should not update (listener cleaned up)
        expect(app.s.lastKey).toBe('Enter');
        expect(documentKeydownCount).toBeLessThan(initialCount);
      } finally {
        document.addEventListener = originalDocAdd;
        document.removeEventListener = originalDocRemove;
      }
    });

    it('should clean up nested elements when parent is removed', async () => {
      let windowScrollCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);
      const scrollListeners = new Map();

      window.addEventListener = function(type, fn, opts) {
        if (type === 'scroll') {
          windowScrollCount++;
          scrollListeners.set(fn, true);
        }
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'scroll' && scrollListeners.has(fn)) {
          windowScrollCount--;
          scrollListeners.delete(fn);
        }
        return originalWindowRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="parent-container">
            <div class="child" @click="clicks++">
              <span @scroll.window="scrolls++">Nested content</span>
            </div>
            <div class="another-child" @click.window="windowClicks++"></div>
          </div>
        `;

        const app = new Reflex({ clicks: 0, scrolls: 0, windowClicks: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        const initialScrollCount = windowScrollCount;
        expect(initialScrollCount).toBeGreaterThan(0);

        // Remove parent container (all children should be cleaned up)
        document.querySelector('#parent-container').remove();

        // Wait for cleanup
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Verify scroll listener was cleaned up
        expect(windowScrollCount).toBeLessThan(initialScrollCount);
      } finally {
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });

    it('should clean up effect cleanup functions when element is removed', async () => {
      const cleanupSpy = vi.fn();

      document.body.innerHTML = `
        <div id="effect-comp" m-effect="setupEffect()"></div>
      `;

      const app = new Reflex({
        setupEffect() {
          // Return cleanup function
          return cleanupSpy;
        }
      });
      app.use(withAutoCleanup);
      await app.nextTick();

      expect(cleanupSpy).not.toHaveBeenCalled();

      // Remove element externally
      document.querySelector('#effect-comp').remove();

      // Wait for cleanup
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle removal of multiple elements simultaneously', async () => {
      let windowResizeCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);
      const resizeListeners = new Map();

      window.addEventListener = function(type, fn, opts) {
        if (type === 'resize') {
          windowResizeCount++;
          resizeListeners.set(fn, true);
        }
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'resize' && resizeListeners.has(fn)) {
          windowResizeCount--;
          resizeListeners.delete(fn);
        }
        return originalWindowRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="comp1" @resize.window="c1++"></div>
          <div id="comp2" @resize.window="c2++"></div>
          <div id="comp3" @resize.window="c3++"></div>
        `;

        const app = new Reflex({ c1: 0, c2: 0, c3: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        const initialCount = windowResizeCount;
        expect(initialCount).toBeGreaterThanOrEqual(3);

        // Remove all elements simultaneously
        document.querySelectorAll('[id^="comp"]').forEach(el => el.remove());

        // Wait for cleanup
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Verify all listeners were cleaned up
        expect(windowResizeCount).toBe(initialCount - 3);
      } finally {
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });
  });

  describe('RX Marker', () => {
    it('should add __rx marker to elements with cleanup registered', async () => {
      document.body.innerHTML = `
        <div id="marked" @click.window="count++">Content</div>
        <div id="unmarked">Plain content</div>
      `;

      const app = new Reflex({ count: 0 });
      app.use(withAutoCleanup);
      await app.nextTick();

      const marked = document.querySelector('#marked');
      const unmarked = document.querySelector('#unmarked');

      // Element with @click.window should have marker
      expect(marked[RX_MARKER]).toBe(true);

      // Plain element should not have marker (no cleanup needed)
      // Note: text interpolation doesn't add cleanup in this simple case
      expect(unmarked[RX_MARKER]).toBeFalsy();
    });

    it('should remove __rx marker after cleanup', async () => {
      document.body.innerHTML = `
        <div id="target" @click.window="count++">Content</div>
      `;

      const app = new Reflex({ count: 0 });
      app.use(withAutoCleanup);
      await app.nextTick();

      const target = document.querySelector('#target');
      expect(target[RX_MARKER]).toBe(true);

      // Remove element
      target.remove();

      // Wait for cleanup
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      // Marker should be removed
      expect(target[RX_MARKER]).toBeFalsy();
    });
  });

  describe('Performance', () => {
    it('should NOT trigger expensive cleanup for 1000 non-Reflex elements', async () => {
      // Setup spy to track cleanup calls
      let cleanupCallCount = 0;

      document.body.innerHTML = `<div id="container"></div>`;

      const app = new Reflex({ count: 0 });
      app.use(withAutoCleanup);

      // Spy on _kill method
      const originalKill = app._kill.bind(app);
      app._kill = function(node) {
        cleanupCallCount++;
        return originalKill(node);
      };

      await app.nextTick();

      const container = document.querySelector('#container');

      // Insert 1000 non-Reflex elements
      const startInsert = performance.now();
      for (let i = 0; i < 1000; i++) {
        const div = document.createElement('div');
        div.textContent = `Element ${i}`;
        div.className = 'non-reflex-element';
        container.appendChild(div);
      }
      const insertTime = performance.now() - startInsert;

      // Wait for any observer callbacks
      await new Promise(resolve => queueMicrotask(resolve));

      // Now remove all 1000 elements
      const startRemove = performance.now();
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      const removeTime = performance.now() - startRemove;

      // Wait for observer callbacks
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      // VERIFY: No cleanup calls for non-Reflex elements
      expect(cleanupCallCount).toBe(0);

      // Performance check: removal should be fast (< 100ms for 1000 elements)
      // This ensures the observer doesn't add significant overhead
      expect(removeTime).toBeLessThan(100);

      // Log performance for debugging
      console.log(`Insert 1000 elements: ${insertTime.toFixed(2)}ms`);
      console.log(`Remove 1000 elements: ${removeTime.toFixed(2)}ms`);
      console.log(`Cleanup calls: ${cleanupCallCount}`);
    });

    it('should efficiently handle mixed Reflex and non-Reflex elements', async () => {
      // Track actual cleanup function executions, not _kill traversals
      let actualCleanupCount = 0;

      document.body.innerHTML = `<div id="mixed-container"></div>`;

      const app = new Reflex({ count: 0 });
      app.use(withAutoCleanup);

      // Spy on actual cleanup by tracking elements with cleanup registered
      const originalReg = app._reg.bind(app);
      const registeredNodes = new Set();
      app._reg = function(node, fn) {
        registeredNodes.add(node);
        // Wrap the cleanup function to count actual executions
        const wrappedFn = () => {
          actualCleanupCount++;
          return fn();
        };
        return originalReg(node, wrappedFn);
      };

      await app.nextTick();

      const container = document.querySelector('#mixed-container');

      // Insert mix of Reflex and non-Reflex elements
      for (let i = 0; i < 100; i++) {
        // Non-Reflex element
        const plainDiv = document.createElement('div');
        plainDiv.textContent = `Plain ${i}`;
        container.appendChild(plainDiv);

        // Reflex element (every 10th element)
        if (i % 10 === 0) {
          const reflexDiv = document.createElement('div');
          reflexDiv.setAttribute('@click.window', 'count++');
          reflexDiv.textContent = `Reflex ${i}`;
          container.appendChild(reflexDiv);

          // Process the Reflex element
          app._bnd(reflexDiv, null);
          app._w(reflexDiv, null);
        }
      }

      await app.nextTick();

      // Get the count of Reflex elements (10 elements)
      const reflexElementCount = registeredNodes.size;

      // Remove all elements
      actualCleanupCount = 0; // Reset counter
      const startRemove = performance.now();
      container.innerHTML = '';
      const removeTime = performance.now() - startRemove;

      // Wait for cleanup
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      // All registered nodes should have their cleanup called
      expect(actualCleanupCount).toBe(reflexElementCount);

      // Should still be performant
      expect(removeTime).toBeLessThan(50);
    });

    it('should not block DOM operations with synchronous cleanup', async () => {
      document.body.innerHTML = `
        <div id="sync-test" @click.window="count++"></div>
      `;

      const app = new Reflex({ count: 0 });
      app.use(withAutoCleanup);
      await app.nextTick();

      const target = document.querySelector('#sync-test');

      // Measure removal time
      const start = performance.now();
      target.remove();
      const removeTime = performance.now() - start;

      // Removal should be near-instant (cleanup is batched in microtask)
      expect(removeTime).toBeLessThan(5);

      // Wait for actual cleanup
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();
    });
  });

  describe('Edge Cases', () => {
    it('should not double-cleanup if element is re-added to DOM', async () => {
      let cleanupCallCount = 0;
      const cleanupSpy = vi.fn(() => { cleanupCallCount++; });

      document.body.innerHTML = `
        <div id="reattach-target" m-effect="setupEffect()"></div>
      `;

      const app = new Reflex({
        setupEffect() {
          return cleanupSpy;
        }
      });
      app.use(withAutoCleanup);
      await app.nextTick();

      const target = document.querySelector('#reattach-target');
      const parent = target.parentNode;

      // Remove element
      target.remove();

      // Immediately re-add before microtask runs
      parent.appendChild(target);

      // Wait for observer
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      // Cleanup should NOT have been called (element is still connected)
      expect(cleanupCallCount).toBe(0);
    });

    it('should handle multiple apps with withAutoCleanup', async () => {
      // Start with empty body to prevent auto-mount issues
      document.body.innerHTML = '';

      // Create and mount app1 first, wait for it to be fully initialized
      const app1Root = document.createElement('div');
      app1Root.id = 'app1-root';
      app1Root.innerHTML = `<div id="app1-comp" @click.window="count++"></div>`;
      document.body.appendChild(app1Root);

      const app1 = new Reflex({ count: 0 });
      app1.use(withAutoCleanup);
      app1.mount(app1Root);
      await app1.nextTick();
      // Wait for auto-mount microtask to complete
      await new Promise(resolve => queueMicrotask(resolve));

      // Now create app2 in a separate subtree (not yet in DOM to avoid app1 seeing it)
      const app2Root = document.createElement('div');
      app2Root.id = 'app2-root';
      app2Root.innerHTML = `<div id="app2-comp" @click.window="count++"></div>`;
      document.body.appendChild(app2Root);

      const app2 = new Reflex({ count: 0 });
      app2.use(withAutoCleanup);
      app2.mount(app2Root);
      await app2.nextTick();
      await new Promise(resolve => queueMicrotask(resolve));

      // Baseline check - both apps should have count 0
      expect(app1.s.count).toBe(0);
      expect(app2.s.count).toBe(0);

      // Verify both apps work - window click should increment both
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.all([app1.nextTick(), app2.nextTick()]);

      // Both should have incremented
      const app1CountAfterClick = app1.s.count;
      const app2CountAfterClick = app2.s.count;
      expect(app1CountAfterClick).toBeGreaterThan(0);
      expect(app2CountAfterClick).toBeGreaterThan(0);

      // Remove app1's component
      document.querySelector('#app1-comp').remove();
      await new Promise(resolve => queueMicrotask(resolve));
      await Promise.all([app1.nextTick(), app2.nextTick()]);

      // Click again
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.all([app1.nextTick(), app2.nextTick()]);

      // app1's count should not increment (cleaned up)
      // app2's count should increment (still active)
      expect(app1.s.count).toBe(app1CountAfterClick); // No change
      expect(app2.s.count).toBeGreaterThan(app2CountAfterClick); // Incremented
    });

    it('should handle stopAutoCleanup correctly', async () => {
      let windowClickCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);

      window.addEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount++;
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount--;
        return originalWindowRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="stop-test" @click.window="count++"></div>
        `;

        const app = new Reflex({ count: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        const initialCount = windowClickCount;

        // Stop auto cleanup
        app.stopAutoCleanup();

        // Remove element
        document.querySelector('#stop-test').remove();

        // Wait for observer (which should NOT trigger cleanup now)
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Listener should NOT be cleaned up (observer is stopped)
        expect(windowClickCount).toBe(initialCount);
      } finally {
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });

    it('should work with deeply nested Reflex elements', async () => {
      const cleanupSpies = [];

      document.body.innerHTML = `
        <div id="deep-root">
          <div class="level-1">
            <div class="level-2">
              <div class="level-3">
                <div class="level-4">
                  <div class="level-5" m-effect="setupEffect(0)"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const app = new Reflex({
        setupEffect(id) {
          const spy = vi.fn();
          cleanupSpies[id] = spy;
          return spy;
        }
      });
      app.use(withAutoCleanup);
      await app.nextTick();

      expect(cleanupSpies[0]).not.toHaveBeenCalled();

      // Remove root (5 levels deep)
      document.querySelector('#deep-root').remove();

      // Wait for cleanup
      await new Promise(resolve => queueMicrotask(resolve));
      await app.nextTick();

      // Deeply nested cleanup should have been called
      expect(cleanupSpies[0]).toHaveBeenCalledTimes(1);
    });
  });

  describe('jQuery/HTMX Simulation', () => {
    it('should clean up when element is removed jQuery-style', async () => {
      let windowClickCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);

      window.addEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount++;
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount--;
        return originalWindowRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="jquery-target" @click.window="count++">jQuery Target</div>
        `;

        const app = new Reflex({ count: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        const initialCount = windowClickCount;

        // Simulate jQuery's .remove() behavior (sets innerHTML)
        const parent = document.querySelector('#jquery-target').parentNode;
        parent.innerHTML = '';

        // Wait for cleanup
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Listener should be cleaned up
        expect(windowClickCount).toBeLessThan(initialCount);
      } finally {
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });

    it('should clean up when element is replaced (HTMX swap style)', async () => {
      let windowClickCount = 0;
      const originalWindowAdd = window.addEventListener.bind(window);
      const originalWindowRemove = window.removeEventListener.bind(window);

      window.addEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount++;
        return originalWindowAdd(type, fn, opts);
      };

      window.removeEventListener = function(type, fn, opts) {
        if (type === 'click') windowClickCount--;
        return originalWindowRemove(type, fn, opts);
      };

      try {
        document.body.innerHTML = `
          <div id="htmx-container">
            <div id="htmx-target" @click.window="count++">HTMX Target</div>
          </div>
        `;

        const app = new Reflex({ count: 0 });
        app.use(withAutoCleanup);
        await app.nextTick();

        const initialCount = windowClickCount;

        // Simulate HTMX swap (replaces innerHTML)
        document.querySelector('#htmx-container').innerHTML = `
          <div id="new-content">New content from server</div>
        `;

        // Wait for cleanup
        await new Promise(resolve => queueMicrotask(resolve));
        await app.nextTick();

        // Listener should be cleaned up
        expect(windowClickCount).toBeLessThan(initialCount);
      } finally {
        window.addEventListener = originalWindowAdd;
        window.removeEventListener = originalWindowRemove;
      }
    });
  });
});
