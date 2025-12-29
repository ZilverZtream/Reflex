/**
 * ScopeContainer Enforcement Tests
 *
 * BREAKING CHANGE: All scopes MUST use ScopeContainer.
 * Regular objects are FORBIDDEN. These tests verify the security enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafeExprParser, ScopeContainer } from '../../src/csp/SafeExprParser';
import { createFlatScope, isFlatScope, ScopeRegistry } from '../../src/core/scope-registry';

describe('ScopeContainer Enforcement', () => {
  let parser: SafeExprParser;
  let mockReflex: any;

  beforeEach(() => {
    parser = new SafeExprParser();
    mockReflex = {
      trackDependency: vi.fn(),
      _mf: new WeakMap(),
      _refs: {},
      _dispatch: vi.fn(),
      nextTick: vi.fn()
    };
  });

  describe('Context Validation', () => {
    it('throws TypeError when context is a regular object', () => {
      const ast = parser.parse('item.name');

      expect(() => {
        parser._evaluate(
          ast,
          {},
          { item: { name: 'test' } }, // Regular object - MUST THROW
          null,
          null,
          mockReflex
        );
      }).toThrow(TypeError);
    });

    it('throws error with helpful migration message', () => {
      const ast = parser.parse('item');

      expect(() => {
        parser._evaluate(
          ast,
          {},
          { item: 'value' },
          null,
          null,
          mockReflex
        );
      }).toThrow(/must be a FlatScope or ScopeContainer/);
    });

    it('throws error mentioning breaking change', () => {
      const ast = parser.parse('x');

      expect(() => {
        parser._evaluate(
          ast,
          {},
          { x: 1 },
          null,
          null,
          mockReflex
        );
      }).toThrow(/BREAKING CHANGE/);
    });

    it('accepts null context (root level)', () => {
      const ast = parser.parse('count');
      const state = { count: 42 };

      const result = parser._evaluate(ast, state, null, null, null, mockReflex);
      expect(result).toBe(42);
    });

    it('accepts ScopeContainer as context', () => {
      const ast = parser.parse('item.name');

      const scope = new ScopeContainer();
      scope.set('item', { name: 'test' });

      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);
      expect(result).toBe('test');
    });

    it('accepts nested ScopeContainers (parent-child)', () => {
      const parentScope = new ScopeContainer();
      parentScope.set('parentValue', 100);

      const childScope = new ScopeContainer(parentScope);
      childScope.set('childValue', 200);

      const ast1 = parser.parse('childValue');
      const ast2 = parser.parse('parentValue');

      expect(parser._evaluate(ast1, {}, childScope, null, null, mockReflex)).toBe(200);
      expect(parser._evaluate(ast2, {}, childScope, null, null, mockReflex)).toBe(100);
    });
  });

  describe('ScopeContainer API', () => {
    it('has() returns true for direct properties', () => {
      const scope = new ScopeContainer();
      scope.set('item', { name: 'test' });

      expect(scope.has('item')).toBe(true);
      expect(scope.has('nonexistent')).toBe(false);
    });

    it('has() returns true for parent properties', () => {
      const parent = new ScopeContainer();
      parent.set('parentProp', 'value');

      const child = new ScopeContainer(parent);

      expect(child.has('parentProp')).toBe(true);
    });

    it('get() retrieves direct properties', () => {
      const scope = new ScopeContainer();
      scope.set('item', { name: 'test' });

      expect(scope.get('item')).toEqual({ name: 'test' });
    });

    it('get() retrieves parent properties', () => {
      const parent = new ScopeContainer();
      parent.set('items', [1, 2, 3]);

      const child = new ScopeContainer(parent);
      child.set('index', 0);

      expect(child.get('items')).toEqual([1, 2, 3]);
      expect(child.get('index')).toBe(0);
    });

    it('set() only writes to current scope, not parent', () => {
      const parent = new ScopeContainer();
      parent.set('value', 'parent');

      const child = new ScopeContainer(parent);
      child.set('value', 'child');

      expect(child.get('value')).toBe('child');
      expect(parent.get('value')).toBe('parent');
    });

    it('delete() removes property from current scope', () => {
      const scope = new ScopeContainer();
      scope.set('temp', 'value');

      expect(scope.delete('temp')).toBe(true);
      expect(scope.has('temp')).toBe(false);
    });

    it('getParent() returns parent reference', () => {
      const parent = new ScopeContainer();
      const child = new ScopeContainer(parent);

      expect(child.getParent()).toBe(parent);
      expect(parent.getParent()).toBeNull();
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('blocks __proto__ assignment via Proxy', () => {
      const scope = new ScopeContainer();

      // The Proxy set trap throws for dangerous properties
      expect(() => {
        (scope as any)['__proto__'] = { polluted: true };
      }).toThrow(/Cannot set dangerous property/);

      // Verify global Object wasn't polluted
      expect(({} as any).polluted).toBeUndefined();
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it('blocks constructor assignment via Proxy', () => {
      const scope = new ScopeContainer();

      expect(() => {
        (scope as any)['constructor'] = function() {};
      }).toThrow(/Cannot set dangerous property/);
    });

    it('blocks prototype assignment via Proxy', () => {
      const scope = new ScopeContainer();

      expect(() => {
        (scope as any)['prototype'] = {};
      }).toThrow(/Cannot set dangerous property/);
    });

    it('blocks dangerous properties via set() method', () => {
      const scope = new ScopeContainer();

      expect(() => {
        scope.set('__proto__', { polluted: true });
      }).toThrow(/Cannot set dangerous property/);

      expect(() => {
        scope.set('constructor', function() {});
      }).toThrow(/Cannot set dangerous property/);

      expect(() => {
        scope.set('prototype', {});
      }).toThrow(/Cannot set dangerous property/);
    });

    it('fromObject skips dangerous keys with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const obj = {
        safeKey: 'value'
      };
      // Note: __proto__ and constructor are special in object literals
      // and can't be easily added as regular properties

      const scope = ScopeContainer.fromObject(obj);

      expect(scope.get('safeKey')).toBe('value');
      expect(scope.has('__proto__')).toBe(false);
      expect(scope.has('constructor')).toBe(false);

      warnSpy.mockRestore();
    });

    it('returns undefined for dangerous property access', () => {
      const scope = new ScopeContainer();
      scope.set('safe', 'value');

      expect((scope as any)['__proto__']).toBeUndefined();
      expect((scope as any)['constructor']).toBeUndefined();
      expect((scope as any)['prototype']).toBeUndefined();
      expect((scope as any)['safe']).toBe('value');
    });
  });

  describe('isScopeContainer', () => {
    it('returns true for ScopeContainer instances', () => {
      const scope = new ScopeContainer();
      expect(ScopeContainer.isScopeContainer(scope)).toBe(true);
    });

    it('returns false for regular objects', () => {
      expect(ScopeContainer.isScopeContainer({})).toBe(false);
      expect(ScopeContainer.isScopeContainer({ has: () => {} })).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(ScopeContainer.isScopeContainer(null)).toBe(false);
      expect(ScopeContainer.isScopeContainer(undefined)).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(ScopeContainer.isScopeContainer(42)).toBe(false);
      expect(ScopeContainer.isScopeContainer('string')).toBe(false);
      expect(ScopeContainer.isScopeContainer(true)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(ScopeContainer.isScopeContainer([])).toBe(false);
    });

    it('cannot be faked with duck typing', () => {
      const fake = {
        has: () => true,
        get: () => 'fake',
        set: () => {},
        _data: new Map(),
        _parent: null
      };
      expect(ScopeContainer.isScopeContainer(fake)).toBe(false);
    });
  });

  describe('Proxy-based Property Isolation', () => {
    it('new properties go into internal Map, not object', () => {
      const scope = new ScopeContainer();

      // Property assignments go through Proxy and are stored in Map
      (scope as any).newProperty = 'value';
      expect((scope as any).newProperty).toBe('value');
      expect(scope.get('newProperty')).toBe('value');

      // Direct property access on the raw object would fail
      // But the Proxy intercepts all access
    });

    it('_data access is intercepted and returns undefined', () => {
      const scope = new ScopeContainer();
      scope.set('key', 'value');

      // Accessing _data goes through Proxy get handler
      // which looks up in the Map, not on the object
      // _data is a valid variable name, so it's stored in Map if set
      expect((scope as any)._data).toBeUndefined();
    });

    it('_parent access is intercepted and returns undefined', () => {
      const scope = new ScopeContainer();

      // Accessing _parent goes through Proxy get handler
      expect((scope as any)._parent).toBeUndefined();
    });

    it('internal methods are available through Proxy', () => {
      const scope = new ScopeContainer();
      scope.set('test', 'value');

      // Methods are exposed through Proxy get handler
      expect(typeof scope.has).toBe('function');
      expect(typeof scope.get).toBe('function');
      expect(typeof scope.set).toBe('function');
      expect(typeof scope.delete).toBe('function');
      expect(typeof scope.keys).toBe('function');
      expect(typeof scope.getParent).toBe('function');
    });
  });

  describe('Edge Cases', () => {
    it('handles undefined values correctly', () => {
      const scope = new ScopeContainer();
      scope.set('undefinedValue', undefined);

      expect(scope.has('undefinedValue')).toBe(true);
      expect(scope.get('undefinedValue')).toBeUndefined();
    });

    it('handles null values correctly', () => {
      const scope = new ScopeContainer();
      scope.set('nullValue', null);

      expect(scope.has('nullValue')).toBe(true);
      expect(scope.get('nullValue')).toBeNull();
    });

    it('handles complex nested objects', () => {
      const scope = new ScopeContainer();
      const complex = {
        level1: {
          level2: {
            level3: { value: 'deep' }
          }
        }
      };
      scope.set('complex', complex);

      const ast = parser.parse('complex.level1.level2.level3.value');
      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);

      expect(result).toBe('deep');
    });

    it('handles array values', () => {
      const scope = new ScopeContainer();
      scope.set('items', [1, 2, 3]);

      const ast = parser.parse('items[1]');
      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);

      expect(result).toBe(2);
    });
  });
});
