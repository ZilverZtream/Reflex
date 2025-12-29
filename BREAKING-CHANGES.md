# Breaking Changes - Security-First Rewrite

This document describes the breaking changes introduced in the security-first rewrite of Reflex. These changes are intentional and necessary to eliminate security vulnerabilities.

## Overview

The security-first rewrite addresses four critical areas:

1. **ScopeContainer is Mandatory** - Prevents prototype pollution
2. **SafeHTML is Mandatory** - Prevents XSS attacks
3. **Proxy Purity Enforced** - Prevents reactivity bypass
4. **Flat Scope Resolution** - Eliminates scope chain attacks

---

## 1. ScopeContainer is Mandatory

### What Changed

- `Object.create()` scopes are **NO LONGER SUPPORTED**
- All scope contexts must be `ScopeContainer` or `FlatScope` instances
- Regular objects passed as contexts will throw `TypeError`

### Why

Using `Object.create()` for scopes allowed prototype pollution attacks:

```javascript
// BEFORE: Vulnerable to prototype pollution
const scope = Object.create(parentScope);
scope['__proto__']['polluted'] = true; // Pollutes Object.prototype!
```

### Migration

Scopes are now created automatically by `m-for`. If you were manually creating scopes:

```javascript
// OLD (No longer works)
const scope = Object.create(parentScope);
scope.item = value;

// NEW (Automatic - no code change needed for m-for)
// Reflex handles scope creation internally using ScopeContainer or FlatScope
```

---

## 2. SafeHTML is Mandatory

### What Changed

- `setInnerHTML()` **NO LONGER accepts strings**
- `m-html` directive requires `SafeHTML` wrapped content
- Raw strings will throw `TypeError`

### Why

Raw HTML strings enable XSS attacks:

```html
<!-- BEFORE: XSS vulnerable -->
<div m-html="userInput"></div>
<!-- If userInput = "<script>steal(cookies)</script>", it executes! -->
```

### Migration

```javascript
// OLD (No longer works)
app.s.html = '<b>Hello</b>';

// NEW (Use SafeHTML.sanitize)
import { SafeHTML } from 'reflex';
app.s.html = SafeHTML.sanitize('<b>Hello</b>');

// Or configure DOMPurify globally
import DOMPurify from 'dompurify';
app.configure({ domPurify: DOMPurify });
```

---

## 3. Proxy Purity Enforced

### What Changed

- `toRaw()` bypass for array mutations is **REMOVED**
- All array mutations go through the reactive proxy
- May have minor performance impact on large array operations

### Why

Bypassing the proxy broke reactivity in edge cases:

```javascript
// BEFORE: Silent reactivity failure
const raw = toRaw(app.s.items);
raw.push(newItem); // UI doesn't update!
```

### Migration

No code changes needed. Arrays now correctly trigger reactivity:

```javascript
// Works correctly now
app.s.items.push(newItem); // UI updates!
```

If you need to batch updates for performance:

```javascript
// Batch multiple operations
app.batch(() => {
  for (const item of newItems) {
    app.s.items.push(item);
  }
}); // Single UI update after batch
```

---

## 4. Flat Scope Resolution

### What Changed

- Prototype-based scope chains are **DELETED**
- Scopes now use flat `Map` storage with unique IDs
- `ScopeContainer` parent chains are replaced with `FlatScope`
- Zero instances of `Object.getPrototypeOf(scope)` for chain traversal

### Why

Prototype chains enabled scope manipulation attacks:

```javascript
// BEFORE: Scope chain could be exploited
const scope = Object.create(parent);
Object.setPrototypeOf(scope, maliciousObject); // Hijacks lookups!
```

### Migration

Migration is **automatic**. The new `FlatScope` system:

- Uses unique IDs for each variable (`var_0_item`, `var_1_index`)
- Stores all values in a single flat `Map`
- Nested scopes reference parent IDs without prototype chains

```javascript
// How it works internally (no code changes needed)
const registry = new ScopeRegistry();
const aliasId = registry.allocate('item');    // 'var_0_item'
registry.set(aliasId, { id: 1 });

const scope = createFlatScope(registry, { item: aliasId });
// Lookup: scope._ids['item'] -> 'var_0_item' -> registry.get('var_0_item')
```

### Behavior Changes

1. **Scope Shadowing**: Same variable name in nested loops now gets unique IDs
   - Previously, inner `item` would shadow outer `item` via prototype chain
   - Now, both are distinct entries in the registry

2. **No Parent Traversal**: Variable lookup is O(1), not O(n) chain walk
   - Parent values are accessible via merged `_parentIds`

---

## Verification Commands

Run these commands to verify your codebase is compliant:

```bash
# No legacy patterns
! grep -r "Object.create.*[Ss]cope" src/
! grep -r "setInnerHTML.*string" src/
! grep -r "_silent" src/core/reactivity.ts
! grep -r "toRaw.*apply" src/core/reactivity.ts
! grep -r "DEFENSE-IN-DEPTH" src/
! grep -r "legacy path" src/ -i
! grep -r "backward compat" src/ -i

# Security enforcements exist
grep -r "throw new TypeError.*ScopeContainer" src/csp/
grep -r "throw new TypeError.*SafeHTML" src/renderers/
grep -r "class ScopeRegistry" src/core/

# Build passes
npm run build

# Tests pass
npm test
```

---

## Error Messages

### ScopeContainer/FlatScope Required

```
TypeError: Reflex Security: Context must be a FlatScope or ScopeContainer instance.
Received: object Object

BREAKING CHANGE: Regular objects are no longer allowed as scopes.
Migration: Scopes are now created automatically by m-for.
```

### SafeHTML Required

```
TypeError: Reflex Security: setInnerHTML requires SafeHTML instance.
Received: string

BREAKING CHANGE: Raw strings are no longer allowed for HTML injection.
Migration: Use SafeHTML.sanitize(html) or SafeHTML.trusted(html)
```

---

## Support

If you encounter issues during migration:

1. Check this document for migration guides
2. Review the test files in `tests/security/` for examples
3. File an issue at https://github.com/ZilverZtream/Reflex/issues

These breaking changes are permanent and will not be reverted. Security is not optional.
