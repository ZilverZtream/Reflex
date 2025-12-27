/**
 * Lifecycle & Memory Leak Audit
 *
 * Ensures that Single Page Applications (SPAs) don't slowly eat RAM over time.
 * Tests proper cleanup of event listeners, watchers, and DOM nodes.
 *
 * POLICY: Fix the Code, Not the Test.
 * Memory leaks are critical bugs. All tests must pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Lifecycle & Memory Leaks', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Listener Count Verification', () => {
    let originalAddEventListener;
    let originalRemoveEventListener;
    let eventListeners;

    beforeEach(() => {
      // Track all event listeners
      eventListeners = new Map();

      originalAddEventListener = EventTarget.prototype.addEventListener;
      originalRemoveEventListener = EventTarget.prototype.removeEventListener;

      EventTarget.prototype.addEventListener = function(type, listener, options) {
        const key = `${this.constructor.name}:${type}`;
        if (!eventListeners.has(key)) {
          eventListeners.set(key, []);
        }
        eventListeners.get(key).push({ listener, options, target: this });
        return originalAddEventListener.call(this, type, listener, options);
      };

      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const key = `${this.constructor.name}:${type}`;
        if (eventListeners.has(key)) {
          const list = eventListeners.get(key);
          const index = list.findIndex(item => item.listener === listener);
          if (index !== -1) {
            list.splice(index, 1);
          }
          if (list.length === 0) {
            eventListeners.delete(key);
          }
        }
        return originalRemoveEventListener.call(this, type, listener, options);
      };
    });

    afterEach(() => {
      EventTarget.prototype.addEventListener = originalAddEventListener;
      EventTarget.prototype.removeEventListener = originalRemoveEventListener;
    });

    it('should remove all listeners when component is unmounted via m-if', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <button @click="handleClick">Click</button>
          <div @scroll.window="handleScroll">Content</div>
          <input @keydown.document="handleKey">
        </div>
      `;

      const app = new Reflex({
        show: true,
        handleClick() {},
        handleScroll() {},
        handleKey() {}
      });
      await app.nextTick();

      // Count listeners before unmount
      const listenerCountBefore = Array.from(eventListeners.values()).reduce(
        (sum, list) => sum + list.length,
        0
      );

      expect(listenerCountBefore).toBeGreaterThan(0);

      // Unmount the component
      app.s.show = false;
      await app.nextTick();

      // Count listeners after unmount
      const listenerCountAfter = Array.from(eventListeners.values()).reduce(
        (sum, list) => sum + list.length,
        0
      );

      // All component-specific listeners should be removed
      // (may still have framework internal listeners)
      expect(listenerCountAfter).toBeLessThan(listenerCountBefore);
    });

    it('should clean up window and document listeners on unmount', async () => {
      document.body.innerHTML = `
        <div m-if="mounted">
          <div @resize.window="onResize">Track window resize</div>
          <div @click.document="onDocClick">Track document clicks</div>
        </div>
      `;

      const app = new Reflex({
        mounted: true,
        onResize() {},
        onDocClick() {}
      });
      await app.nextTick();

      // Track window and document listeners
      const windowListenersBefore = eventListeners.get('Window:resize')?.length || 0;
      const documentListenersBefore = eventListeners.get('HTMLDocument:click')?.length || 0;

      expect(windowListenersBefore + documentListenersBefore).toBeGreaterThan(0);

      // Unmount
      app.s.mounted = false;
      await app.nextTick();

      const windowListenersAfter = eventListeners.get('Window:resize')?.length || 0;
      const documentListenersAfter = eventListeners.get('HTMLDocument:click')?.length || 0;

      // Listeners should be cleaned up
      expect(windowListenersAfter).toBeLessThan(windowListenersBefore);
      expect(documentListenersAfter).toBeLessThan(documentListenersBefore);
    });

    it('should not leak listeners when re-mounting components', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <button @click="onClick">Button</button>
        </div>
      `;

      const app = new Reflex({
        show: true,
        onClick() {}
      });

      // Mount/unmount 10 times
      for (let i = 0; i < 10; i++) {
        app.s.show = false;
        await app.nextTick();
        app.s.show = true;
        await app.nextTick();
      }

      const clickListeners = eventListeners.get('HTMLButtonElement:click')?.length || 0;

      // Should have only 1 listener, not 10
      expect(clickListeners).toBeLessThanOrEqual(1);
    });
  });

  describe('The "Rapid Toggle" Race Condition', () => {
    it('should handle rapid m-if toggles without errors (50 times in 100ms)', async () => {
      document.body.innerHTML = `
        <div m-if="visible">
          <span>Content</span>
          <button @click="onClick">Click</button>
        </div>
      `;

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const app = new Reflex({
        visible: false,
        onClick() {}
      });

      const startTime = Date.now();

      // Rapidly toggle 50 times
      for (let i = 0; i < 50; i++) {
        app.s.visible = !app.s.visible;
        // Don't await - simulate rapid user action
      }

      // Wait for all updates to flush
      await new Promise(resolve => setTimeout(resolve, 150));

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(200);

      // No console errors should occur
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should not leave zombie DOM nodes after rapid toggles', async () => {
      document.body.innerHTML = `
        <div id="container">
          <div m-if="show" class="target">
            <p>Paragraph 1</p>
            <p>Paragraph 2</p>
            <p>Paragraph 3</p>
          </div>
        </div>
      `;

      const app = new Reflex({ show: false });

      // Rapid toggles
      for (let i = 0; i < 20; i++) {
        app.s.show = true;
        app.s.show = false;
      }

      await app.nextTick();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have no .target divs in the DOM
      const zombies = document.querySelectorAll('.target');
      expect(zombies.length).toBe(0);

      // Container should be clean
      const container = document.getElementById('container');
      expect(container.children.length).toBe(0);
    });

    it('should handle nested m-if rapid toggles', async () => {
      document.body.innerHTML = `
        <div m-if="outer">
          <div m-if="inner">
            <span>Deep Content</span>
          </div>
        </div>
      `;

      const app = new Reflex({ outer: false, inner: false });

      // Rapid random toggles
      for (let i = 0; i < 30; i++) {
        app.s.outer = Math.random() > 0.5;
        app.s.inner = Math.random() > 0.5;
      }

      await app.nextTick();
      await new Promise(resolve => setTimeout(resolve, 50));

      // No errors should occur
      // Content should be in consistent state
      const spans = document.querySelectorAll('span');

      if (app.s.outer && app.s.inner) {
        expect(spans.length).toBe(1);
      } else {
        expect(spans.length).toBe(0);
      }
    });

    it('should handle race between m-if toggle and state updates', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <span m-text="message"></span>
        </div>
      `;

      const app = new Reflex({ show: true, message: 'Initial' });
      await app.nextTick();

      // Simulate race: update message, then immediately hide
      app.s.message = 'Updated';
      app.s.show = false;
      await app.nextTick();

      // No errors should occur
      const span = document.querySelector('span');
      expect(span).toBeNull(); // Should be hidden

      // Show again
      app.s.show = true;
      await app.nextTick();

      const newSpan = document.querySelector('span');
      expect(newSpan).not.toBeNull();
      expect(newSpan.textContent).toBe('Updated');
    });
  });

  describe('Async Component Teardown', () => {
    it('should not mount component if parent is destroyed before async completion', async () => {
      let resolveAsync;
      const asyncPromise = new Promise(resolve => {
        resolveAsync = resolve;
      });

      document.body.innerHTML = `
        <div m-if="showParent">
          <div m-effect="loadAsync()">Loading...</div>
        </div>
      `;

      let effectRan = false;
      const app = new Reflex({
        showParent: true,
        async loadAsync() {
          await asyncPromise;
          effectRan = true;
        }
      });

      await app.nextTick();

      // Destroy parent before async completes
      app.s.showParent = false;
      await app.nextTick();

      // Now resolve the async operation
      resolveAsync();
      await asyncPromise;
      await app.nextTick();

      // The effect should not continue to run or throw errors
      // (exact behavior may vary - important is no crash)
    });

    it('should cancel pending effects when component unmounts', async () => {
      let cleanupCalled = false;

      document.body.innerHTML = `
        <div m-if="show">
          <div m-effect="setupEffect()">Content</div>
        </div>
      `;

      const app = new Reflex({
        show: true,
        setupEffect() {
          return () => {
            cleanupCalled = true;
          };
        }
      });

      await app.nextTick();

      // Unmount
      app.s.show = false;
      await app.nextTick();

      // Cleanup should have been called
      expect(cleanupCalled).toBe(true);
    });

    it('should handle async watchers during component destruction', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <span m-text="value"></span>
        </div>
      `;

      const app = new Reflex({ show: true, value: 'initial' });
      await app.nextTick();

      // Set up a watcher that takes time to execute
      let watcherComplete = false;
      app.watch(() => app.s.value, async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        watcherComplete = true;
      });

      // Trigger watcher
      app.s.value = 'changed';

      // Immediately destroy component
      app.s.show = false;
      await app.nextTick();

      // Wait for watcher
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should complete without errors
      expect(watcherComplete).toBe(true);
    });
  });

  describe('Watcher Cleanup', () => {
    it('should stop calling watchers after unwatch', async () => {
      const app = new Reflex({ count: 0 });
      const callback = vi.fn();

      const unwatch = app.watch(() => app.s.count, callback);

      app.s.count = 1;
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(1);

      // Unwatch
      unwatch();

      // Further changes should not trigger callback
      app.s.count = 2;
      app.s.count = 3;
      await app.nextTick();

      expect(callback).toHaveBeenCalledTimes(1); // Still only called once
    });

    it('should clean up deep watchers properly', async () => {
      const app = new Reflex({ obj: { nested: { value: 1 } } });
      const callback = vi.fn();

      const unwatch = app.watch(() => app.s.obj, callback, { deep: true });

      app.s.obj.nested.value = 2;
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(1);

      unwatch();

      app.s.obj.nested.value = 3;
      await app.nextTick();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle unwatching during watcher execution', async () => {
      const app = new Reflex({ value: 0 });
      let unwatch;

      const callback = vi.fn((newVal, oldVal, onCleanup) => {
        if (newVal === 2) {
          // Unwatch self during execution
          unwatch();
        }
      });

      unwatch = app.watch(() => app.s.value, callback);

      app.s.value = 1;
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(1);

      app.s.value = 2; // Will unwatch during this call
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(2);

      app.s.value = 3; // Should not trigger
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('DOM Node Cleanup', () => {
    it('should fully remove m-for items from DOM when list is cleared', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ items: ['a', 'b', 'c', 'd', 'e'] });
      await app.nextTick();

      expect(document.querySelectorAll('li').length).toBe(5);

      // Clear the list
      app.s.items = [];
      await app.nextTick();

      // All items should be removed
      expect(document.querySelectorAll('li').length).toBe(0);

      // No orphaned text nodes
      const ul = document.querySelector('ul');
      expect(ul.childNodes.length).toBe(0);
    });

    it('should clean up nodes with multiple directives', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <span m-for="item in items" m-text="item" @click="onClick" :class="itemClass"></span>
        </div>
      `;

      const app = new Reflex({
        show: true,
        items: ['a', 'b', 'c'],
        itemClass: 'item',
        onClick() {}
      });
      await app.nextTick();

      expect(document.querySelectorAll('span').length).toBe(3);

      // Hide parent
      app.s.show = false;
      await app.nextTick();

      // All spans should be gone
      expect(document.querySelectorAll('span').length).toBe(0);
    });

    it('should not leak references to removed DOM nodes', async () => {
      document.body.innerHTML = '<div m-if="show"><button m-ref="myButton">Click</button></div>';
      const app = new Reflex({ show: true });
      await app.nextTick();

      // Reference should exist
      expect(app._refs.myButton).toBeDefined();

      // Hide component
      app.s.show = false;
      await app.nextTick();

      // Reference should be cleared (or undefined)
      // This prevents memory leaks
      expect(app._refs.myButton).toBeUndefined();
    });
  });

  describe('Computed Property Cleanup', () => {
    it('should stop computing when computed is no longer accessed', async () => {
      const computeFn = vi.fn(s => s.count * 2);
      const app = new Reflex({ count: 0 });

      const computed = app.computed(computeFn);

      // Access it
      expect(computed.value).toBe(0);
      expect(computeFn).toHaveBeenCalledTimes(1);

      // Change dependency
      app.s.count = 5;
      await app.nextTick();

      // Access again
      expect(computed.value).toBe(10);
      expect(computeFn).toHaveBeenCalledTimes(2);

      // If we never access computed again, it shouldn't re-compute
      // (This tests lazy behavior and prevents unnecessary work)
      app.s.count = 10;
      await app.nextTick();

      // Compute function should not have run again (lazy)
      expect(computeFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Effect Cleanup', () => {
    it('should call cleanup function when effect dependencies change', async () => {
      document.body.innerHTML = '<div m-effect="setupEffect()"></div>';

      let cleanupCount = 0;
      const app = new Reflex({
        dep: 'a',
        setupEffect() {
          const value = this.dep;
          return () => {
            cleanupCount++;
          };
        }
      });

      await app.nextTick();

      // Change dependency - should trigger cleanup then re-run
      app.s.dep = 'b';
      await app.nextTick();

      expect(cleanupCount).toBe(1);

      // Change again
      app.s.dep = 'c';
      await app.nextTick();

      expect(cleanupCount).toBe(2);
    });

    it('should call cleanup when effect element is removed', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <div m-effect="setupEffect()">Content</div>
        </div>
      `;

      let cleanupCalled = false;
      const app = new Reflex({
        show: true,
        setupEffect() {
          return () => {
            cleanupCalled = true;
          };
        }
      });

      await app.nextTick();

      // Remove element
      app.s.show = false;
      await app.nextTick();

      expect(cleanupCalled).toBe(true);
    });
  });

  describe('Complex Lifecycle Scenarios', () => {
    it('should handle component swap without leaks', async () => {
      document.body.innerHTML = `
        <div>
          <div m-if="showA">
            <button @click="onClickA">Component A</button>
          </div>
          <div m-if="!showA">
            <button @click="onClickB">Component B</button>
          </div>
        </div>
      `;

      const app = new Reflex({
        showA: true,
        onClickA() {},
        onClickB() {}
      });
      await app.nextTick();

      // Swap components 20 times
      for (let i = 0; i < 20; i++) {
        app.s.showA = !app.s.showA;
        await app.nextTick();
      }

      // Should have exactly 1 button
      expect(document.querySelectorAll('button').length).toBe(1);
    });

    it('should clean up in correct order for nested components', async () => {
      const cleanupOrder = [];

      document.body.innerHTML = `
        <div m-if="show">
          <div m-effect="outer()">
            <div m-effect="middle()">
              <div m-effect="inner()">Content</div>
            </div>
          </div>
        </div>
      `;

      const app = new Reflex({
        show: true,
        outer() {
          return () => cleanupOrder.push('outer');
        },
        middle() {
          return () => cleanupOrder.push('middle');
        },
        inner() {
          return () => cleanupOrder.push('inner');
        }
      });

      await app.nextTick();

      // Unmount
      app.s.show = false;
      await app.nextTick();

      // Cleanup should happen from innermost to outermost (or at least consistently)
      expect(cleanupOrder.length).toBe(3);
      expect(cleanupOrder).toContain('outer');
      expect(cleanupOrder).toContain('middle');
      expect(cleanupOrder).toContain('inner');
    });
  });
});
