/**
 * Flat Scope Resolution Tests
 *
 * BREAKING CHANGE: Scope resolution now uses flat Map storage with unique IDs.
 * Prototype-based scope chains have been completely eliminated.
 *
 * This is a security-first design that prevents:
 * - Prototype pollution via __proto__
 * - Scope chain manipulation attacks
 * - Accidental scope shadowing exploits
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafeExprParser, ScopeContainer } from '../../src/csp/SafeExprParser';
import {
  ScopeRegistry,
  createFlatScope,
  isFlatScope,
  getFlatScopeValue,
  setFlatScopeValue,
  hasFlatScopeValue,
  FLAT_SCOPE_MARKER
} from '../../src/core/scope-registry';

describe('Flat Scope Resolution', () => {
  describe('ScopeRegistry', () => {
    it('allocates unique IDs for variables', () => {
      const registry = new ScopeRegistry();

      const id1 = registry.allocate('item');
      const id2 = registry.allocate('item');
      const id3 = registry.allocate('index');

      expect(id1).toBe('var_0_item');
      expect(id2).toBe('var_1_item');
      expect(id3).toBe('var_2_index');

      // All IDs should be unique
      expect(new Set([id1, id2, id3]).size).toBe(3);
    });

    it('stores and retrieves values correctly', () => {
      const registry = new ScopeRegistry();
      const id = registry.allocate('test');

      registry.set(id, { name: 'John' });
      expect(registry.get(id)).toEqual({ name: 'John' });
      expect(registry.has(id)).toBe(true);
    });

    it('returns undefined for non-existent IDs', () => {
      const registry = new ScopeRegistry();

      expect(registry.get('nonexistent')).toBeUndefined();
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('deletes values correctly', () => {
      const registry = new ScopeRegistry();
      const id = registry.allocate('temp');

      registry.set(id, 'value');
      expect(registry.has(id)).toBe(true);

      registry.delete(id);
      expect(registry.has(id)).toBe(false);
      expect(registry.get(id)).toBeUndefined();
    });

    it('clears all values and resets counter', () => {
      const registry = new ScopeRegistry();

      registry.set(registry.allocate('a'), 1);
      registry.set(registry.allocate('b'), 2);
      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);

      // Counter is reset
      const newId = registry.allocate('c');
      expect(newId).toBe('var_0_c');
    });

    it('tracks size correctly', () => {
      const registry = new ScopeRegistry();

      expect(registry.size).toBe(0);

      const id1 = registry.allocate('a');
      registry.set(id1, 1);
      expect(registry.size).toBe(1);

      const id2 = registry.allocate('b');
      registry.set(id2, 2);
      expect(registry.size).toBe(2);

      registry.delete(id1);
      expect(registry.size).toBe(1);
    });
  });

  describe('FlatScope', () => {
    it('creates a frozen FlatScope object', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, { item: 'var_0_item' });

      expect(scope._type).toBe('FlatScope');
      expect(scope[FLAT_SCOPE_MARKER]).toBe(true);
      // Proxies can't be frozen, but the internal _ids object should be frozen for immutability
      expect(Object.isFrozen(scope._ids)).toBe(true);
      // Verify the Proxy blocks modifications via the set trap
      const result = Reflect.set(scope, 'newProp', 'value');
      expect(result).toBe(false);
    });

    it('isFlatScope correctly identifies FlatScope objects', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, { item: 'var_0_item' });

      expect(isFlatScope(scope)).toBe(true);
      expect(isFlatScope({})).toBe(false);
      expect(isFlatScope(null)).toBe(false);
      expect(isFlatScope({ _type: 'FlatScope' })).toBe(false); // Missing marker
    });

    it('cannot be faked with duck typing', () => {
      const fake = {
        _type: 'FlatScope',
        _ids: {},
        _parentIds: null,
        _registry: new ScopeRegistry()
      };

      expect(isFlatScope(fake)).toBe(false);
    });

    it('stores IDs correctly', () => {
      const registry = new ScopeRegistry();
      const aliasId = registry.allocate('item');
      const indexId = registry.allocate('index');

      const scope = createFlatScope(registry, {
        item: aliasId,
        index: indexId
      });

      expect(scope._ids.item).toBe(aliasId);
      expect(scope._ids.index).toBe(indexId);
    });

    it('stores parent IDs for nested scopes', () => {
      const registry = new ScopeRegistry();

      // Outer loop
      const outerId = registry.allocate('outer');
      const outerScope = createFlatScope(registry, { outer: outerId });

      // Inner loop (nested)
      const innerId = registry.allocate('inner');
      const innerScope = createFlatScope(registry, { inner: innerId }, outerScope._ids);

      expect(innerScope._ids.inner).toBe(innerId);
      expect(innerScope._parentIds).toEqual({ outer: outerId });
    });
  });

  describe('FlatScope Value Access', () => {
    let registry: ScopeRegistry;

    beforeEach(() => {
      registry = new ScopeRegistry();
    });

    it('getFlatScopeValue retrieves values from current scope', () => {
      const aliasId = registry.allocate('item');
      registry.set(aliasId, { name: 'John' });

      const scope = createFlatScope(registry, { item: aliasId });

      const result = getFlatScopeValue(scope, 'item');
      expect(result.found).toBe(true);
      expect(result.value).toEqual({ name: 'John' });
    });

    it('getFlatScopeValue retrieves values from parent scope', () => {
      const outerId = registry.allocate('outer');
      registry.set(outerId, { id: 1 });

      const outerScope = createFlatScope(registry, { outer: outerId });

      const innerId = registry.allocate('inner');
      registry.set(innerId, { id: 'a' });

      const innerScope = createFlatScope(registry, { inner: innerId }, outerScope._ids);

      // Can access inner scope value
      const innerResult = getFlatScopeValue(innerScope, 'inner');
      expect(innerResult.found).toBe(true);
      expect(innerResult.value).toEqual({ id: 'a' });

      // Can access parent scope value via parentIds
      const outerResult = getFlatScopeValue(innerScope, 'outer');
      expect(outerResult.found).toBe(true);
      expect(outerResult.value).toEqual({ id: 1 });
    });

    it('getFlatScopeValue returns not found for non-existent variables', () => {
      const scope = createFlatScope(registry, {});

      const result = getFlatScopeValue(scope, 'nonexistent');
      expect(result.found).toBe(false);
      expect(result.value).toBeUndefined();
    });

    it('setFlatScopeValue updates values in registry', () => {
      const aliasId = registry.allocate('item');
      registry.set(aliasId, { name: 'John' });

      const scope = createFlatScope(registry, { item: aliasId });

      const updated = setFlatScopeValue(scope, 'item', { name: 'Jane' });
      expect(updated).toBe(true);
      expect(registry.get(aliasId)).toEqual({ name: 'Jane' });
    });

    it('setFlatScopeValue updates parent scope values', () => {
      const outerId = registry.allocate('outer');
      registry.set(outerId, { count: 1 });

      const outerScope = createFlatScope(registry, { outer: outerId });
      const innerScope = createFlatScope(registry, { inner: registry.allocate('inner') }, outerScope._ids);

      const updated = setFlatScopeValue(innerScope, 'outer', { count: 2 });
      expect(updated).toBe(true);
      expect(registry.get(outerId)).toEqual({ count: 2 });
    });

    it('setFlatScopeValue returns false for non-existent variables', () => {
      const scope = createFlatScope(registry, {});

      const updated = setFlatScopeValue(scope, 'nonexistent', 'value');
      expect(updated).toBe(false);
    });

    it('hasFlatScopeValue checks existence correctly', () => {
      const aliasId = registry.allocate('item');
      registry.set(aliasId, 'value');

      const scope = createFlatScope(registry, { item: aliasId });

      expect(hasFlatScopeValue(scope, 'item')).toBe(true);
      expect(hasFlatScopeValue(scope, 'nonexistent')).toBe(false);
    });
  });

  describe('SafeExprParser Integration', () => {
    let parser: SafeExprParser;
    let mockReflex: any;
    let registry: ScopeRegistry;

    beforeEach(() => {
      parser = new SafeExprParser();
      registry = new ScopeRegistry();
      mockReflex = {
        trackDependency: vi.fn(),
        _mf: new WeakMap(),
        _refs: {},
        _dispatch: vi.fn(),
        nextTick: vi.fn()
      };
    });

    it('accepts FlatScope as context', () => {
      const aliasId = registry.allocate('item');
      registry.set(aliasId, { name: 'test' });

      const scope = createFlatScope(registry, { item: aliasId });
      const ast = parser.parse('item.name');

      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);
      expect(result).toBe('test');
    });

    it('falls through to state lookup when not in FlatScope', () => {
      const scope = createFlatScope(registry, {});
      const state = { count: 42 };
      const ast = parser.parse('count');

      const result = parser._evaluate(ast, state, scope, null, null, mockReflex);
      expect(result).toBe(42);
    });

    it('handles nested FlatScope lookups', () => {
      // Outer scope: outer = { id: 1, children: [...] }
      const outerId = registry.allocate('outer');
      registry.set(outerId, { id: 1, children: [{ id: 'a' }, { id: 'b' }] });
      const outerScope = createFlatScope(registry, { outer: outerId });

      // Inner scope: inner = { id: 'a' }
      const innerId = registry.allocate('inner');
      registry.set(innerId, { id: 'a' });
      const innerScope = createFlatScope(registry, { inner: innerId }, outerScope._ids);

      // Can access both outer and inner from innerScope
      const outerAst = parser.parse('outer.id');
      const innerAst = parser.parse('inner.id');

      expect(parser._evaluate(outerAst, {}, innerScope, null, null, mockReflex)).toBe(1);
      expect(parser._evaluate(innerAst, {}, innerScope, null, null, mockReflex)).toBe('a');
    });

    it('still accepts ScopeContainer for backward compatibility', () => {
      const scope = new ScopeContainer();
      scope.set('item', { name: 'legacy' });

      const ast = parser.parse('item.name');
      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);

      expect(result).toBe('legacy');
    });

    it('rejects regular objects as context', () => {
      const ast = parser.parse('item');

      expect(() => {
        parser._evaluate(ast, {}, { item: 'value' }, null, null, mockReflex);
      }).toThrow(TypeError);
    });
  });

  describe('Security: Prototype Chain Prevention', () => {
    it('FlatScope has no prototype chain to exploit', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, {});

      // FlatScope is a frozen object, not a class instance with prototype
      expect(Object.getPrototypeOf(scope._registry.store)).toBe(Map.prototype);

      // Cannot modify prototype
      expect(() => {
        Object.setPrototypeOf(scope as any, { malicious: true });
      }).toThrow();
    });

    it('registry uses Map which is immune to prototype pollution', () => {
      const registry = new ScopeRegistry();

      // Even if Object.prototype is polluted, Map operations are safe
      (Object.prototype as any).__polluted__ = true;

      const id = registry.allocate('test');
      registry.set(id, 'value');

      // Map operations work correctly despite prototype pollution
      expect(registry.get(id)).toBe('value');
      expect(registry.has(id)).toBe(true);

      // Cleanup
      delete (Object.prototype as any).__polluted__;
    });

    it('scope IDs are frozen and cannot be modified', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, { item: 'var_0_item' });

      expect(() => {
        (scope._ids as any).malicious = 'injected';
      }).toThrow();

      expect(() => {
        (scope._ids as any).item = 'hijacked';
      }).toThrow();
    });
  });

  describe('Scope Shadowing Prevention', () => {
    it('same variable name in nested scopes gets unique IDs', () => {
      const registry = new ScopeRegistry();

      // Outer loop: item = { id: 1 }
      const outerId = registry.allocate('item');
      registry.set(outerId, { id: 1 });
      const outerScope = createFlatScope(registry, { item: outerId });

      // Inner loop: item = { id: 'a' } (same variable name!)
      const innerId = registry.allocate('item');
      registry.set(innerId, { id: 'a' });
      const innerScope = createFlatScope(registry, { item: innerId }, outerScope._ids);

      // IDs are different despite same variable name
      expect(outerId).not.toBe(innerId);

      // Each scope has its own 'item'
      expect(getFlatScopeValue(outerScope, 'item').value).toEqual({ id: 1 });
      expect(getFlatScopeValue(innerScope, 'item').value).toEqual({ id: 'a' });

      // Inner scope's 'item' shadows outer scope's 'item' (correct behavior)
      // The inner scope's _ids has 'item' which takes precedence over _parentIds
    });

    it('no prototype chain traversal - direct ID lookup only', () => {
      const registry = new ScopeRegistry();

      const outerId = registry.allocate('outer');
      registry.set(outerId, 'outer-value');

      const outerScope = createFlatScope(registry, { outer: outerId });
      const innerScope = createFlatScope(registry, {}, outerScope._ids);

      // Can access parent via parentIds
      expect(getFlatScopeValue(innerScope, 'outer').found).toBe(true);

      // But there's no prototype chain to traverse
      expect(Object.getPrototypeOf(innerScope)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(innerScope) === outerScope).toBe(false);
    });
  });

  describe('Memory Cleanup', () => {
    it('registry IDs can be deleted on scope removal', () => {
      const registry = new ScopeRegistry();

      const id1 = registry.allocate('item');
      const id2 = registry.allocate('index');
      registry.set(id1, 'value1');
      registry.set(id2, 'value2');

      expect(registry.size).toBe(2);

      // Simulate m-for item removal
      registry.delete(id1);
      registry.delete(id2);

      expect(registry.size).toBe(0);
    });

    it('clear() removes all entries efficiently', () => {
      const registry = new ScopeRegistry();

      // Simulate many m-for items
      for (let i = 0; i < 1000; i++) {
        const id = registry.allocate(`item${i}`);
        registry.set(id, { index: i });
      }

      expect(registry.size).toBe(1000);

      // Simulate app unmount
      registry.clear();

      expect(registry.size).toBe(0);
    });
  });
});
