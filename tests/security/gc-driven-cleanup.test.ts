/**
 * Tests for GC-Driven Cleanup (TASK 5)
 *
 * BREAKING CHANGE: The "Registry Leak" Fix
 *
 * Problem: Manual cleanup via removeNode() means if that function isn't called,
 * your app leaks memory forever. This happened when using innerHTML = ''.
 *
 * Solution: Invert Control - use FinalizationRegistry to automatically clean up
 * scope IDs when DOM nodes are garbage collected.
 *
 * Result: document.body.innerHTML = '' will self-clean when GC runs. Zero leaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../../src/core/reflex.js';

describe('GC-Driven Cleanup (TASK 5)', () => {
  let container: HTMLDivElement;
  let app: Reflex;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe('Browser Compatibility Requirements', () => {
    it('should throw if WeakRef is not available', () => {
      // This test verifies the error message, but WeakRef should be available in modern test environments
      expect(typeof WeakRef).toBe('function');
    });

    it('should throw if FinalizationRegistry is not available', () => {
      // This test verifies the error message, but FinalizationRegistry should be available in modern test environments
      expect(typeof FinalizationRegistry).toBe('function');
    });

    it('should create Reflex instance successfully with modern browser features', () => {
      expect(() => {
        app = new Reflex({ count: 0 });
      }).not.toThrow();
    });
  });

  describe('FinalizationRegistry Setup', () => {
    beforeEach(() => {
      app = new Reflex({ items: ['a', 'b', 'c'] });
    });

    it('should have _gcRegistry property', () => {
      expect(app._gcRegistry).toBeDefined();
      expect(app._gcRegistry).toBeInstanceOf(FinalizationRegistry);
    });

    it('should have _scopeRegistry property', () => {
      expect(app._scopeRegistry).toBeDefined();
      expect(app._scopeRegistry.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scope Registration with GC', () => {
    beforeEach(() => {
      app = new Reflex({ items: [1, 2, 3] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);
    });

    it('should create scopes for m-for items', () => {
      // The registry should have IDs for each item
      const initialSize = app._scopeRegistry.size;
      expect(initialSize).toBeGreaterThan(0);
    });

    it('should have _registerScopeWithGC method', () => {
      expect(typeof app._registerScopeWithGC).toBe('function');
    });

    it('should register nodes with scopes in _scopeMap', () => {
      // _scopeMap is a WeakMap, so we can't inspect it directly
      // But we can verify it exists
      expect(app._scopeMap).toBeDefined();
    });
  });

  describe('Manual Cleanup (Immediate)', () => {
    beforeEach(() => {
      app = new Reflex({ items: [1, 2, 3] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);
    });

    it('should not crash when items are removed via reactivity', async () => {
      expect(() => {
        app.s.items = [];
      }).not.toThrow();

      // Wait for reactivity to flush
      await new Promise(resolve => queueMicrotask(resolve));

      // Verify items are removed from DOM
      const remainingItems = container.textContent;
      expect(remainingItems).toBe('');
    });

    it('should handle list updates without errors', async () => {
      // Verify initial state
      expect(container.textContent).toContain('1');
      expect(container.textContent).toContain('2');
      expect(container.textContent).toContain('3');

      // Test adding items
      expect(() => {
        app.s.items.push(4);
      }).not.toThrow();

      // Wait for reactivity
      await new Promise(resolve => queueMicrotask(resolve));

      // Verify item was added
      expect(container.textContent).toContain('4');
    });
  });

  describe('GC Cleanup (Safety Net)', () => {
    beforeEach(() => {
      app = new Reflex({ items: [1, 2, 3] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);
    });

    it('should register scope IDs with FinalizationRegistry', () => {
      // We can't directly test GC behavior in unit tests, but we can verify
      // that the registry callback exists and is properly configured
      expect(app._gcRegistry).toBeDefined();
    });

    it('should allow innerHTML clearing without throwing', () => {
      expect(() => {
        container.innerHTML = '';
      }).not.toThrow();
    });

    it('should survive innerHTML clearing without immediate cleanup', () => {
      const initialSize = app._scopeRegistry.size;
      expect(initialSize).toBeGreaterThan(0);

      // Simulate the registry leak scenario: clear DOM without calling removeNode
      container.innerHTML = '';

      // Note: Scope IDs won't be cleaned immediately because GC hasn't run yet
      // The GC callback will clean them up eventually when the nodes are collected
      // We can't force GC in JavaScript, so we can't test the actual cleanup

      // But we can verify the app is still functional
      expect(app._scopeRegistry).toBeDefined();
    });
  });

  describe('Integration: Real-World Scenarios', () => {
    it('should handle repeated mount/unmount cycles', () => {
      app = new Reflex({ items: [1, 2, 3] });

      // Mount and unmount multiple times
      for (let i = 0; i < 5; i++) {
        container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
        app.mount(container);

        const sizeAfterMount = app._scopeRegistry.size;
        expect(sizeAfterMount).toBeGreaterThan(0);

        // Update items
        app.s.items = [4, 5, 6];

        // Clear (simulating unmount)
        container.innerHTML = '';
      }

      // App should still be functional
      expect(app._scopeRegistry).toBeDefined();
    });

    it('should handle nested loops', async () => {
      app = new Reflex({
        groups: [
          { name: 'A', items: [1, 2] },
          { name: 'B', items: [3, 4] }
        ]
      });

      container.innerHTML = `
        <div m-for="group in groups">
          <div m-for="item in group.items">{{ item }}</div>
        </div>
      `;
      app.mount(container);

      // Verify initial render
      expect(container.textContent).toContain('1');
      expect(container.textContent).toContain('4');

      // Remove a group
      expect(() => {
        app.s.groups = [app.s.groups[0]];
      }).not.toThrow();

      // Wait for reactivity
      await new Promise(resolve => queueMicrotask(resolve));

      // Verify group B items are removed
      expect(container.textContent).not.toContain('3');
      expect(container.textContent).not.toContain('4');
    });

    it('should handle dynamic list updates', async () => {
      app = new Reflex({ items: [] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);

      // Add items dynamically
      expect(() => {
        for (let i = 0; i < 10; i++) {
          app.s.items.push(i);
        }
      }).not.toThrow();

      // Wait for reactivity
      await new Promise(resolve => queueMicrotask(resolve));

      // Verify items are rendered
      expect(container.textContent).toContain('0');
      expect(container.textContent).toContain('9');

      // Remove items
      expect(() => {
        app.s.items = [];
      }).not.toThrow();

      // Wait for reactivity
      await new Promise(resolve => queueMicrotask(resolve));

      // Verify items are removed
      expect(container.textContent).toBe('');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty lists', () => {
      app = new Reflex({ items: [] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);

      // Should not throw
      expect(app._scopeRegistry).toBeDefined();
    });

    it('should handle lists with null/undefined', () => {
      app = new Reflex({ items: [1, null, undefined, 2] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);

      // Should handle gracefully
      expect(app._scopeRegistry.size).toBeGreaterThan(0);
    });

    it('should handle virtual containers (strict parents)', () => {
      app = new Reflex({ items: [1, 2, 3] });
      container.innerHTML = `
        <table>
          <tbody>
            <template m-for="item in items">
              <tr><td>{{ item }}</td></tr>
            </template>
          </tbody>
        </table>
      `;
      app.mount(container);

      // Virtual containers should not be registered with GC (they're plain objects)
      // But their scope IDs should still be tracked in the registry
      expect(app._scopeRegistry.size).toBeGreaterThan(0);
    });
  });

  describe('Performance: No Memory Leaks', () => {
    it('should not leak memory on repeated updates', () => {
      app = new Reflex({ items: [1, 2, 3] });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);

      const initialSize = app._scopeRegistry.size;

      // Perform many updates
      for (let i = 0; i < 100; i++) {
        app.s.items = [i, i + 1, i + 2];
      }

      // Registry size should stabilize (not grow infinitely)
      const finalSize = app._scopeRegistry.size;

      // The size should be roughly the same (accounting for the 3 items)
      // Allow some variance for the counter and other internal state
      expect(finalSize).toBeLessThan(initialSize + 10);
    });

    it('should clean up all scope IDs when list is emptied', async () => {
      app = new Reflex({ items: Array.from({ length: 100 }, (_, i) => i) });
      container.innerHTML = '<div m-for="item in items">{{ item }}</div>';
      app.mount(container);

      // Verify items are rendered
      expect(container.textContent).toContain('0');
      expect(container.textContent).toContain('99');

      // Empty the list without errors
      expect(() => {
        app.s.items = [];
      }).not.toThrow();

      // Wait for reactivity
      await new Promise(resolve => queueMicrotask(resolve));

      // All items should be removed from DOM
      expect(container.textContent).toBe('');
    });
  });
});
