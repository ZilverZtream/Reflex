/**
 * Reflex Core - Scope Registry
 *
 * Flat scope storage with unique variable IDs.
 * Replaces prototype-based scope chains for security.
 *
 * BREAKING CHANGE: This is part of the security-first rewrite.
 * Prototype-based scopes have been completely removed to prevent
 * prototype pollution attacks.
 *
 * Key benefits:
 * - No prototype chain traversal (eliminates __proto__ attacks)
 * - O(1) variable lookup via unique IDs
 * - Explicit scope boundaries (no accidental shadowing)
 * - Deterministic behavior in nested loops
 */

/**
 * ScopeRegistry - Flat scope storage with unique variable IDs
 *
 * This class provides a centralized Map-based storage for all scope variables.
 * Each variable is assigned a unique ID during compilation, which is then
 * used for direct O(1) lookup during expression evaluation.
 *
 * @example
 * const registry = new ScopeRegistry();
 * const id = registry.allocate('item');    // Returns 'var_0_item'
 * registry.set(id, { name: 'John' });
 * registry.get(id);                        // Returns { name: 'John' }
 */
export class ScopeRegistry {
  private store: Map<string, any> = new Map();
  private idCounter = 0;

  /**
   * Allocate a unique ID for a variable.
   *
   * The ID format is 'var_{counter}_{varName}' which:
   * - Provides uniqueness via counter
   * - Preserves variable name for debugging
   * - Is guaranteed to not conflict with any user data
   *
   * @param varName - Variable name (for debugging)
   * @returns Unique scope ID
   */
  allocate(varName: string): string {
    const id = `var_${this.idCounter++}_${varName}`;
    return id;
  }

  /**
   * Set a value in the flat scope.
   *
   * @param id - The unique variable ID from allocate()
   * @param value - The value to store
   */
  set(id: string, value: any): void {
    this.store.set(id, value);
  }

  /**
   * Get a value from the flat scope.
   *
   * @param id - The unique variable ID
   * @returns The stored value, or undefined if not found
   */
  get(id: string): any {
    return this.store.get(id);
  }

  /**
   * Check if a variable exists in the registry.
   *
   * @param id - The unique variable ID
   * @returns true if the variable exists
   */
  has(id: string): boolean {
    return this.store.has(id);
  }

  /**
   * Delete a variable from the registry.
   *
   * This should be called during cleanup when scopes are destroyed
   * (e.g., when m-for items are removed).
   *
   * @param id - The unique variable ID
   */
  delete(id: string): void {
    this.store.delete(id);
  }

  /**
   * Clear all variables from the registry.
   *
   * This should only be called during app unmount or full reset.
   */
  clear(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  /**
   * Get the current number of stored variables.
   * Useful for debugging and testing.
   */
  get size(): number {
    return this.store.size;
  }
}

/**
 * Symbol to identify FlatScope instances
 */
export const FLAT_SCOPE_MARKER = Symbol.for('reflex.FlatScope');

/**
 * FlatScope - A scope object that uses flat registry lookup
 *
 * This replaces the prototype-chain based ScopeContainer for m-for loops.
 * Instead of traversing parent chains, it uses unique IDs to look up
 * values directly in the ScopeRegistry.
 *
 * SECURITY: This design completely eliminates:
 * - Prototype pollution via __proto__
 * - Scope chain manipulation
 * - Accidental scope shadowing
 */
export interface FlatScopeIds {
  [varName: string]: string;  // varName -> unique ID in registry
}

export interface FlatScope {
  /** Marker to identify this as a FlatScope */
  readonly _type: 'FlatScope';
  /** Marker symbol for fast type checking */
  readonly [FLAT_SCOPE_MARKER]: true;
  /** Map of variable names to their unique registry IDs */
  readonly _ids: FlatScopeIds;
  /** Reference to the parent scope's IDs (for nested loops) */
  readonly _parentIds: FlatScopeIds | null;
  /** Reference to the ScopeRegistry */
  readonly _registry: ScopeRegistry;
}

/**
 * Create a FlatScope object.
 *
 * FlatScope is wrapped in a Proxy that intercepts property access,
 * allowing it to work with JavaScript's `with` statement (used in
 * standard expression compilation mode).
 *
 * The Proxy exposes scope variables as properties by looking them up
 * in the flat registry using their unique IDs.
 *
 * @param registry - The ScopeRegistry instance
 * @param ids - Map of variable names to registry IDs for this scope
 * @param parentIds - Parent scope's IDs (for nested lookup)
 */
export function createFlatScope(
  registry: ScopeRegistry,
  ids: FlatScopeIds,
  parentIds: FlatScopeIds | null = null
): FlatScope {
  const scopeData = {
    _type: 'FlatScope' as const,
    [FLAT_SCOPE_MARKER]: true as const,
    _ids: Object.freeze({ ...ids }),
    _parentIds: parentIds ? Object.freeze({ ...parentIds }) : null,
    _registry: registry
  };

  // Freeze the scope data to prevent modifications
  Object.freeze(scopeData);

  // Wrap in a Proxy to make scope variables accessible as properties
  // This allows the scope to work with JavaScript's `with` statement
  const proxy = new Proxy(scopeData, {
    get(target, prop, receiver) {
      // Symbol access
      if (typeof prop === 'symbol') {
        if (prop === FLAT_SCOPE_MARKER) return true;
        return Reflect.get(target, prop, receiver);
      }

      // Internal properties (_type, _ids, _parentIds, _registry)
      if (prop.startsWith('_')) {
        return Reflect.get(target, prop, receiver);
      }

      // Scope variable lookup - check current scope IDs first
      const id = target._ids[prop];
      if (id !== undefined && target._registry.has(id)) {
        return target._registry.get(id);
      }

      // Check parent scope IDs
      if (target._parentIds) {
        const parentId = target._parentIds[prop];
        if (parentId !== undefined && target._registry.has(parentId)) {
          return target._registry.get(parentId);
        }
      }

      return undefined;
    },

    has(target, prop) {
      // Symbol access
      if (typeof prop === 'symbol') {
        return prop === FLAT_SCOPE_MARKER;
      }

      // Internal properties
      if (prop.startsWith('_')) {
        return Reflect.has(target, prop);
      }

      // Check if variable exists in current scope
      if (target._ids[prop] !== undefined && target._registry.has(target._ids[prop])) {
        return true;
      }

      // Check parent scope
      if (target._parentIds && target._parentIds[prop] !== undefined) {
        return target._registry.has(target._parentIds[prop]);
      }

      return false;
    },

    set(target, prop, value, receiver) {
      // Block all sets to enforce immutability
      // Scope values should only be updated via setFlatScopeValue()
      return false;
    },

    ownKeys(target) {
      // Return only keys that actually exist on the target object
      // Virtual scope variables from _ids are not included to allow freezing
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, prop) {
      // For symbols, return the descriptor from the target
      // This is required to satisfy Proxy invariants when target is non-extensible
      if (typeof prop === 'symbol') {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }

      // Internal properties
      if (prop.startsWith('_')) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }

      // CRITICAL FIX: Scope variables are virtual (stored in registry, not on target)
      // When target is frozen/non-extensible, we cannot claim properties exist on it
      // Return undefined to indicate they're not own properties
      // The `has` and `get` traps will still make them accessible via prototype chain lookup
      return undefined;
    },

    setPrototypeOf(target, proto) {
      // SECURITY: Block prototype modification to prevent prototype pollution attacks
      throw new TypeError(
        'Reflex Security: Cannot set prototype of FlatScope.\n' +
        'FlatScope is immutable and protected against prototype pollution.'
      );
    }
  });

  return proxy as FlatScope;
}

/**
 * Check if an object is a FlatScope
 */
export function isFlatScope(obj: any): obj is FlatScope {
  return obj !== null &&
         typeof obj === 'object' &&
         obj._type === 'FlatScope' &&
         obj[FLAT_SCOPE_MARKER] === true;
}

/**
 * Get a value from a FlatScope by variable name.
 *
 * This performs O(1) lookup in the registry using the pre-allocated ID.
 * If not found in current scope's IDs, checks parent IDs.
 *
 * @param scope - The FlatScope to search
 * @param name - The variable name to look up
 * @returns The value, or undefined if not found
 */
export function getFlatScopeValue(scope: FlatScope, name: string): { found: boolean; value: any } {
  // Check current scope first
  const id = scope._ids[name];
  if (id !== undefined && scope._registry.has(id)) {
    return { found: true, value: scope._registry.get(id) };
  }

  // Check parent scope IDs
  if (scope._parentIds) {
    const parentId = scope._parentIds[name];
    if (parentId !== undefined && scope._registry.has(parentId)) {
      return { found: true, value: scope._registry.get(parentId) };
    }
  }

  return { found: false, value: undefined };
}

/**
 * Set a value in a FlatScope by variable name.
 *
 * This updates the value in the registry using the pre-allocated ID.
 * Only updates variables that exist in the current scope's IDs.
 *
 * @param scope - The FlatScope to update
 * @param name - The variable name
 * @param value - The new value
 * @returns true if the value was set, false if variable not found
 */
export function setFlatScopeValue(scope: FlatScope, name: string, value: any): boolean {
  const id = scope._ids[name];
  if (id !== undefined) {
    scope._registry.set(id, value);
    return true;
  }

  // Check parent scope IDs for update
  if (scope._parentIds) {
    const parentId = scope._parentIds[name];
    if (parentId !== undefined) {
      scope._registry.set(parentId, value);
      return true;
    }
  }

  return false;
}

/**
 * Check if a FlatScope has a variable.
 *
 * @param scope - The FlatScope to check
 * @param name - The variable name
 * @returns true if the variable exists
 */
export function hasFlatScopeValue(scope: FlatScope, name: string): boolean {
  if (scope._ids[name] !== undefined) {
    return scope._registry.has(scope._ids[name]);
  }
  if (scope._parentIds && scope._parentIds[name] !== undefined) {
    return scope._registry.has(scope._parentIds[name]);
  }
  return false;
}
