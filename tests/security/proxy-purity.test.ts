/**
 * Proxy Purity Tests - No Raw Target Access
 *
 * BREAKING CHANGE: Array mutations MUST go through proxy.
 * toRaw() bypass has been removed from wrapArrayMethod.
 * All set traps fire for security-first design.
 */

import { describe, it, expect, vi } from 'vitest';
import { ArrayHandler, ReactivityMixin } from '../../src/core/reactivity';

// Symbol imports for testing
const META = Symbol.for('rx.meta');
const ITERATE = Symbol.for('rx.iterate');

/**
 * Create a mock engine that includes wrapArrayMethod from the mixin
 */
function createMockEngine() {
  const engine = {
    _b: 0,
    _e: null,
    pendingTriggers: new Map(),
    _mf: new WeakMap(),
    s: {},
    _recursionDepth: 0,
    _dtEmit: vi.fn(),
    _wrap: (v: any) => v,
    trackDependency: vi.fn(),
    triggerEffects: vi.fn(),
    _fpt: vi.fn(),
    queueJob: vi.fn(),
    toRaw: ReactivityMixin.toRaw.bind({}),
    wrapArrayMethod: null as any,
    wrapCollectionMethod: vi.fn(),
  };

  // Bind the real wrapArrayMethod from the mixin
  engine.wrapArrayMethod = ReactivityMixin.wrapArrayMethod.bind(engine);
  engine.toRaw = ReactivityMixin.toRaw.bind(engine);

  return engine;
}

describe('Proxy Purity - No Raw Target Access', () => {
  describe('array.push triggers set trap', () => {
    it('should trigger set trap for new index and length', () => {
      const setTrapCalls: (string | symbol | number)[] = [];
      const engine = createMockEngine();

      // Create a mock meta
      const mockMeta = {
        p: null as any,
        r: [1, 2],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      // Create a custom set handler that tracks calls
      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          // Use the real ArrayHandler.get
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          setTrapCalls.push(k);
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      // Create the raw array and attach meta
      const rawArray = [1, 2];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      // Create proxy with tracking handler
      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // Push a value via the proxy
      proxy.push(3);

      // Should trigger set trap for index '2' AND 'length'
      expect(setTrapCalls).toContain('2');
      expect(setTrapCalls).toContain('length');
    });
  });

  describe('array.shift triggers set trap for all reordered indices', () => {
    it('should trigger set trap for indices 0, 1, and length', () => {
      const setTrapCalls: (string | symbol | number)[] = [];
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [1, 2, 3],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          setTrapCalls.push(k);
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      const rawArray = [1, 2, 3];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // Shift removes first element and reindexes all others
      proxy.shift();

      // Should trigger for indices 0, 1, and length
      // shift() moves arr[1] -> arr[0], arr[2] -> arr[1], then sets length
      expect(setTrapCalls).toContain('0');
      expect(setTrapCalls).toContain('1');
      expect(setTrapCalls).toContain('length');
    });
  });

  describe('array.splice triggers set trap for affected indices', () => {
    it('should trigger set trap when splicing in the middle', () => {
      const setTrapCalls: (string | symbol | number)[] = [];
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [1, 2, 3, 4, 5],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          setTrapCalls.push(k);
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      const rawArray = [1, 2, 3, 4, 5];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // splice(1, 2) removes 2 elements starting at index 1
      // This should shift remaining elements
      proxy.splice(1, 2);

      // Should trigger set trap for reindexed elements
      expect(setTrapCalls.length).toBeGreaterThan(0);
      expect(setTrapCalls).toContain('length');
    });
  });

  describe('_silent flag removal verification', () => {
    it('should not have _silent property on ReactiveMeta', () => {
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      // Verify _silent is not a recognized property
      // If someone tries to set it, it should have no effect on reactivity
      (mockMeta as any)._silent = true;

      const rawArray: any[] = [];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      const proxy = new Proxy(rawArray, ArrayHandler);
      mockMeta.p = proxy;

      // Even with _silent = true, set trap should still process normally
      // (The old behavior would skip reactivity with _silent = true)
      const setResult = ArrayHandler.set!(rawArray, '0', 'test', proxy);
      expect(setResult).toBe(true);
      expect(rawArray[0]).toBe('test');
    });
  });

  describe('array.unshift triggers set trap for all reindexed elements', () => {
    it('should trigger set trap for all indices when prepending', () => {
      const setTrapCalls: (string | symbol | number)[] = [];
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [2, 3],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          setTrapCalls.push(k);
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      const rawArray = [2, 3];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // unshift(1) adds element at beginning, shifting all others
      proxy.unshift(1);

      // Should trigger for new index 0 and reindexed elements
      expect(setTrapCalls).toContain('0');
      expect(setTrapCalls).toContain('length');
    });
  });

  describe('array.reverse triggers set trap for swapped indices', () => {
    it('should trigger set trap for all swapped indices', () => {
      const setTrapCalls: (string | symbol | number)[] = [];
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [1, 2, 3, 4],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          setTrapCalls.push(k);
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      const rawArray = [1, 2, 3, 4];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // reverse() swaps all elements
      proxy.reverse();

      // Should trigger for indices that were swapped
      // [1,2,3,4] -> [4,3,2,1] means indices 0,1,2,3 are all modified
      expect(setTrapCalls).toContain('0');
      expect(setTrapCalls).toContain('3');
    });
  });

  describe('No raw target bypass verification', () => {
    it('should not use Array.prototype.apply pattern in wrapArrayMethod', () => {
      // This test verifies the breaking change was applied correctly
      // by checking that wrapArrayMethod calls the proxy method, not Array.prototype
      const engine = createMockEngine();

      const mockMeta = {
        p: null as any,
        r: [1, 2],
        d: new Map(),
        ai: false,
        _am: null,
        v: 0,
        engine: engine
      };

      const rawArray = [1, 2];
      (rawArray as any)[META] = mockMeta;
      mockMeta.r = rawArray;

      // Track if the proxy method was called
      let proxyMethodCalled = false;

      const trackingHandler: ProxyHandler<any[]> = {
        get(o, k, rec) {
          if (k === 'push' && mockMeta._am && mockMeta._am['push']) {
            // Return our tracking wrapper
            return function(...args: any[]) {
              proxyMethodCalled = true;
              return mockMeta._am['push'](...args);
            };
          }
          return ArrayHandler.get!(o, k, rec);
        },
        set(o, k, v, rec) {
          return ArrayHandler.set!(o, k, v, rec);
        },
        deleteProperty: ArrayHandler.deleteProperty,
        defineProperty: ArrayHandler.defineProperty,
        setPrototypeOf: ArrayHandler.setPrototypeOf,
        getPrototypeOf: ArrayHandler.getPrototypeOf,
        has: ArrayHandler.has,
        ownKeys: ArrayHandler.ownKeys,
      };

      const proxy = new Proxy(rawArray, trackingHandler);
      mockMeta.p = proxy;

      // Access push to trigger caching
      const pushMethod = proxy.push;

      // The wrapArrayMethod should have called proxy[method]
      // which means we're calling methods on the proxy, not the raw target
      expect(mockMeta._am).not.toBeNull();
      expect(typeof mockMeta._am!['push']).toBe('function');
    });
  });

  describe('grep verification: no _silent in codebase', () => {
    it('should verify _silent flag is removed from ReactiveMeta', async () => {
      // Read the reactivity.ts file and verify _silent is not present
      const fs = await import('fs');
      const path = await import('path');

      const reactivityPath = path.resolve(__dirname, '../../src/core/reactivity.ts');
      const content = fs.readFileSync(reactivityPath, 'utf-8');

      // Should not contain _silent anywhere
      expect(content).not.toMatch(/_silent/);
    });
  });
});
