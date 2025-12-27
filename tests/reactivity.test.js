/**
 * Reactivity System Tests
 *
 * Tests the core proxy-based reactivity system including:
 * - Property tracking and triggering
 * - Array mutations
 * - Map/Set collections
 * - Computed properties
 * - Watchers
 * - Batching
 */

import { describe, it, expect, vi } from 'vitest';
import { Reflex } from '../src/index.js';

describe('Reactivity', () => {
  describe('Basic Proxy', () => {
    it('should make objects reactive', () => {
      const app = new Reflex({ count: 0 });
      expect(app.s.count).toBe(0);
      app.s.count = 5;
      expect(app.s.count).toBe(5);
    });

    it('should track nested objects', () => {
      const app = new Reflex({
        user: { name: 'John', profile: { age: 30 } }
      });
      expect(app.s.user.name).toBe('John');
      expect(app.s.user.profile.age).toBe(30);
      app.s.user.profile.age = 31;
      expect(app.s.user.profile.age).toBe(31);
    });

    it('should handle property deletion', () => {
      const app = new Reflex({ a: 1, b: 2 });
      delete app.s.a;
      expect(app.s.a).toBeUndefined();
      expect('a' in app.s).toBe(false);
    });

    it('should extract raw object with toRaw', () => {
      const original = { count: 0 };
      const app = new Reflex(original);
      const raw = app.toRaw(app.s);
      expect(raw).toBe(original);
    });
  });

  describe('Array Reactivity', () => {
    it('should track array length', () => {
      const app = new Reflex({ items: [1, 2, 3] });
      expect(app.s.items.length).toBe(3);
      app.s.items.push(4);
      expect(app.s.items.length).toBe(4);
    });

    it('should track array index access', () => {
      const app = new Reflex({ items: ['a', 'b', 'c'] });
      expect(app.s.items[0]).toBe('a');
      app.s.items[0] = 'x';
      expect(app.s.items[0]).toBe('x');
    });

    it('should handle push/pop correctly', () => {
      const app = new Reflex({ items: [] });
      app.s.items.push(1);
      app.s.items.push(2);
      expect(app.s.items).toEqual([1, 2]);
      app.s.items.pop();
      expect(app.s.items).toEqual([1]);
    });

    it('should handle splice correctly', () => {
      const app = new Reflex({ items: [1, 2, 3, 4, 5] });
      app.s.items.splice(1, 2, 'a', 'b');
      expect(app.s.items).toEqual([1, 'a', 'b', 4, 5]);
    });

    it('should handle sort correctly', () => {
      const app = new Reflex({ items: [3, 1, 2] });
      app.s.items.sort();
      expect(app.s.items).toEqual([1, 2, 3]);
    });

    it('should handle reverse correctly', () => {
      const app = new Reflex({ items: [1, 2, 3] });
      app.s.items.reverse();
      expect(app.s.items).toEqual([3, 2, 1]);
    });
  });

  describe('Map Reactivity', () => {
    it('should track Map get/set', () => {
      const app = new Reflex({ map: new Map() });
      app.s.map.set('key', 'value');
      expect(app.s.map.get('key')).toBe('value');
    });

    it('should track Map size', () => {
      const app = new Reflex({ map: new Map([['a', 1]]) });
      expect(app.s.map.size).toBe(1);
      app.s.map.set('b', 2);
      expect(app.s.map.size).toBe(2);
    });

    it('should track Map has', () => {
      const app = new Reflex({ map: new Map([['a', 1]]) });
      expect(app.s.map.has('a')).toBe(true);
      expect(app.s.map.has('b')).toBe(false);
    });

    it('should track Map delete', () => {
      const app = new Reflex({ map: new Map([['a', 1]]) });
      app.s.map.delete('a');
      expect(app.s.map.has('a')).toBe(false);
    });

    it('should track Map iteration', () => {
      const app = new Reflex({ map: new Map([['a', 1], ['b', 2]]) });
      const entries = [];
      for (const [k, v] of app.s.map) {
        entries.push([k, v]);
      }
      expect(entries).toEqual([['a', 1], ['b', 2]]);
    });
  });

  describe('Set Reactivity', () => {
    it('should track Set add/has', () => {
      const app = new Reflex({ set: new Set() });
      app.s.set.add('item');
      expect(app.s.set.has('item')).toBe(true);
    });

    it('should track Set size', () => {
      const app = new Reflex({ set: new Set([1]) });
      expect(app.s.set.size).toBe(1);
      app.s.set.add(2);
      expect(app.s.set.size).toBe(2);
    });

    it('should track Set delete', () => {
      const app = new Reflex({ set: new Set([1]) });
      app.s.set.delete(1);
      expect(app.s.set.has(1)).toBe(false);
    });
  });

  describe('Computed Properties', () => {
    it('should compute derived values', () => {
      const app = new Reflex({ count: 2 });
      const double = app.computed(s => s.count * 2);
      expect(double.value).toBe(4);
    });

    it('should update when dependencies change', async () => {
      const app = new Reflex({ count: 2 });
      const double = app.computed(s => s.count * 2);
      expect(double.value).toBe(4);
      app.s.count = 5;
      await app.nextTick();
      expect(double.value).toBe(10);
    });

    it('should be lazy evaluated', () => {
      const fn = vi.fn(s => s.count * 2);
      const app = new Reflex({ count: 2 });
      const double = app.computed(fn);
      // Initially called once for eager eval
      expect(fn).toHaveBeenCalledTimes(1);
      // Accessing value should not re-run if not dirty
      double.value;
      double.value;
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Watchers', () => {
    it('should call callback when watched value changes', async () => {
      const app = new Reflex({ count: 0 });
      const callback = vi.fn();
      app.watch(() => app.s.count, callback);
      app.s.count = 5;
      await app.nextTick();
      expect(callback).toHaveBeenCalledWith(5, 0, expect.any(Function));
    });

    it('should support immediate option', () => {
      const app = new Reflex({ count: 0 });
      const callback = vi.fn();
      app.watch(() => app.s.count, callback, { immediate: true });
      expect(callback).toHaveBeenCalledWith(0, undefined, expect.any(Function));
    });

    it('should support deep watching', async () => {
      const app = new Reflex({ user: { name: 'John' } });
      const callback = vi.fn();
      app.watch(() => app.s.user, callback, { deep: true });
      app.s.user.name = 'Jane';
      await app.nextTick();
      expect(callback).toHaveBeenCalled();
    });

    it('should return unwatch function', async () => {
      const app = new Reflex({ count: 0 });
      const callback = vi.fn();
      const unwatch = app.watch(() => app.s.count, callback);
      unwatch();
      app.s.count = 5;
      await app.nextTick();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Batching', () => {
    it('should batch multiple updates', async () => {
      const app = new Reflex({ a: 0, b: 0 });
      const callback = vi.fn();
      app.watch(() => app.s.a + app.s.b, callback);

      app.batch(() => {
        app.s.a = 1;
        app.s.b = 2;
      });

      await app.nextTick();
      // Should only be called once after batch
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(3, 0, expect.any(Function));
    });
  });

  describe('nextTick', () => {
    it('should execute callback after flush', async () => {
      const app = new Reflex({ count: 0 });
      let value;
      app.watch(() => app.s.count, (v) => { value = v; });
      app.s.count = 5;
      await app.nextTick();
      expect(value).toBe(5);
    });

    it('should return a promise', async () => {
      const app = new Reflex({});
      const result = app.nextTick();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
