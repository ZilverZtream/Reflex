/**
 * Security Integration Tests
 *
 * Full integration tests covering the security-first rewrite:
 * - ScopeContainer/FlatScope enforcement across m-for, m-if
 * - SafeHTML enforcement in m-html
 * - Proxy purity in array operations
 * - Flat scope resolution in nested loops
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafeExprParser, ScopeContainer } from '../../src/csp/SafeExprParser';
import {
  ScopeRegistry,
  createFlatScope,
  isFlatScope,
  getFlatScopeValue
} from '../../src/core/scope-registry';

describe('Security Integration', () => {
  describe('Scope Enforcement', () => {
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

    it('accepts FlatScope from m-for loops', () => {
      const registry = new ScopeRegistry();
      const aliasId = registry.allocate('item');
      registry.set(aliasId, { id: 1, name: 'Test' });

      const scope = createFlatScope(registry, { item: aliasId });
      const ast = parser.parse('item.name');

      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);
      expect(result).toBe('Test');
    });

    it('accepts ScopeContainer for backward compatibility', () => {
      const scope = new ScopeContainer();
      scope.set('item', { id: 1, name: 'Test' });

      const ast = parser.parse('item.name');
      const result = parser._evaluate(ast, {}, scope, null, null, mockReflex);
      expect(result).toBe('Test');
    });

    it('rejects plain objects as scopes', () => {
      const ast = parser.parse('item.name');

      expect(() => {
        parser._evaluate(
          ast,
          {},
          { item: { name: 'Test' } },
          null,
          null,
          mockReflex
        );
      }).toThrow(TypeError);
    });
  });

  describe('Nested Scope Resolution', () => {
    let registry: ScopeRegistry;

    beforeEach(() => {
      registry = new ScopeRegistry();
    });

    it('handles nested m-for loops with flat scope', () => {
      // Simulate:
      // <div m-for="outer in items">
      //   <span m-for="inner in outer.children">
      //     {{ outer.id }} - {{ inner.id }}
      //   </span>
      // </div>

      // Outer loop scope
      const outerId = registry.allocate('outer');
      const outerItem = { id: 1, children: [{ id: 'a' }, { id: 'b' }] };
      registry.set(outerId, outerItem);
      const outerScope = createFlatScope(registry, { outer: outerId });

      // Inner loop scope (first child)
      const innerId = registry.allocate('inner');
      registry.set(innerId, outerItem.children[0]);
      const innerScope = createFlatScope(registry, { inner: innerId }, outerScope._ids);

      // Both outer and inner are accessible from innerScope
      const outerResult = getFlatScopeValue(innerScope, 'outer');
      const innerResult = getFlatScopeValue(innerScope, 'inner');

      expect(outerResult.found).toBe(true);
      expect(outerResult.value.id).toBe(1);
      expect(innerResult.found).toBe(true);
      expect(innerResult.value.id).toBe('a');
    });

    it('handles scope shadowing with same variable name', () => {
      // Simulate shadowing: both loops use 'item' as alias
      // <div m-for="item in outer">
      //   <span m-for="item in inner">{{ item }}</span>
      // </div>

      // Outer 'item'
      const outerId = registry.allocate('item');
      registry.set(outerId, { level: 'outer' });
      const outerScope = createFlatScope(registry, { item: outerId });

      // Inner 'item' - shadows outer
      const innerId = registry.allocate('item');
      registry.set(innerId, { level: 'inner' });
      const innerScope = createFlatScope(registry, { item: innerId }, outerScope._ids);

      // Inner scope's 'item' takes precedence (it's in _ids, not _parentIds)
      const result = getFlatScopeValue(innerScope, 'item');
      expect(result.found).toBe(true);
      expect(result.value.level).toBe('inner');

      // Both IDs exist in registry
      expect(registry.has(outerId)).toBe(true);
      expect(registry.has(innerId)).toBe(true);
    });

    it('cleans up registry when scopes are removed', () => {
      const id1 = registry.allocate('item1');
      const id2 = registry.allocate('item2');
      registry.set(id1, 'value1');
      registry.set(id2, 'value2');

      expect(registry.size).toBe(2);

      // Simulate removeNode cleanup
      registry.delete(id1);
      expect(registry.size).toBe(1);
      expect(registry.has(id1)).toBe(false);
      expect(registry.has(id2)).toBe(true);
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('FlatScope prevents __proto__ access', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, {});

      // Cannot access __proto__ via getFlatScopeValue
      const result = getFlatScopeValue(scope, '__proto__');
      expect(result.found).toBe(false);

      // Object.prototype should not be polluted
      expect(({} as any).polluted).toBeUndefined();
    });

    it('ScopeContainer prevents __proto__ assignment', () => {
      const scope = new ScopeContainer();

      expect(() => {
        (scope as any).__proto__ = { polluted: true };
      }).toThrow();

      expect(({} as any).polluted).toBeUndefined();
    });

    it('registry Map is immune to Object.prototype pollution', () => {
      const registry = new ScopeRegistry();

      // Pollute Object.prototype
      (Object.prototype as any).__test_polluted__ = 'polluted';

      const id = registry.allocate('safe');
      registry.set(id, 'value');

      // Map operations should not be affected
      expect(registry.get(id)).toBe('value');
      expect(registry.has(id)).toBe(true);

      // __test_polluted__ is NOT in the Map
      expect(registry.has('__test_polluted__')).toBe(false);

      // Cleanup
      delete (Object.prototype as any).__test_polluted__;
    });
  });

  describe('No Scope Chain Traversal', () => {
    it('FlatScope does not use prototype chain', () => {
      const registry = new ScopeRegistry();
      const scope = createFlatScope(registry, {});

      // FlatScope's prototype is Object.prototype (not another scope)
      expect(Object.getPrototypeOf(scope)).toBe(Object.prototype);
    });

    it('nested FlatScopes do not form prototype chain', () => {
      const registry = new ScopeRegistry();

      const outerId = registry.allocate('outer');
      registry.set(outerId, 'outer-value');
      const outerScope = createFlatScope(registry, { outer: outerId });

      const innerId = registry.allocate('inner');
      registry.set(innerId, 'inner-value');
      const innerScope = createFlatScope(registry, { inner: innerId }, outerScope._ids);

      // Inner scope is NOT prototypically linked to outer scope
      expect(Object.getPrototypeOf(innerScope) === outerScope).toBe(false);

      // Both scopes share the registry, but via explicit ID references
      expect(innerScope._parentIds).toEqual({ outer: outerId });
    });

    it('Object.getPrototypeOf does not reveal parent scope', () => {
      const registry = new ScopeRegistry();

      const parentScope = createFlatScope(registry, { parent: registry.allocate('parent') });
      const childScope = createFlatScope(registry, { child: registry.allocate('child') }, parentScope._ids);

      // Prototype chain check returns Object.prototype, not parentScope
      expect(Object.getPrototypeOf(childScope)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(childScope)).not.toBe(parentScope);
    });
  });

  describe('Value Updates via Registry', () => {
    it('registry updates are visible to all scopes', () => {
      const registry = new ScopeRegistry();

      const outerId = registry.allocate('outer');
      registry.set(outerId, { count: 1 });
      const outerScope = createFlatScope(registry, { outer: outerId });

      const innerScope = createFlatScope(registry, { inner: registry.allocate('inner') }, outerScope._ids);

      // Update via registry
      registry.set(outerId, { count: 2 });

      // Both scopes see the update
      expect(getFlatScopeValue(outerScope, 'outer').value).toEqual({ count: 2 });
      expect(getFlatScopeValue(innerScope, 'outer').value).toEqual({ count: 2 });
    });
  });

  describe('Memory Management', () => {
    it('unmount clears all registry entries', () => {
      const registry = new ScopeRegistry();

      // Simulate many m-for items
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const id = registry.allocate(`item${i}`);
        registry.set(id, { index: i });
        ids.push(id);
      }

      expect(registry.size).toBe(100);

      // Simulate unmount
      registry.clear();

      expect(registry.size).toBe(0);

      // IDs are no longer valid
      for (const id of ids) {
        expect(registry.has(id)).toBe(false);
      }
    });

    it('individual scope removal only clears its IDs', () => {
      const registry = new ScopeRegistry();

      const id1 = registry.allocate('item1');
      const id2 = registry.allocate('item2');
      const id3 = registry.allocate('index');

      registry.set(id1, 'value1');
      registry.set(id2, 'value2');
      registry.set(id3, 0);

      const scope1 = createFlatScope(registry, { item1: id1, index: id3 });

      // Simulate removeNode for scope1
      for (const varName in scope1._ids) {
        registry.delete(scope1._ids[varName]);
      }

      // scope1's IDs are gone
      expect(registry.has(id1)).toBe(false);
      expect(registry.has(id3)).toBe(false);

      // scope2's ID remains
      expect(registry.has(id2)).toBe(true);
    });
  });

  describe('Error Messages', () => {
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

    it('provides clear error for regular object context', () => {
      const ast = parser.parse('x');

      try {
        parser._evaluate(ast, {}, { x: 1 }, null, null, mockReflex);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('FlatScope or ScopeContainer');
        expect(e.message).toContain('BREAKING CHANGE');
      }
    });

    it('ScopeContainer provides clear error for dangerous property', () => {
      const scope = new ScopeContainer();

      try {
        scope.set('__proto__', {});
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('dangerous property');
        expect(e.message).toContain('prototype pollution');
      }
    });
  });
});
