# @reflex/compiler

AOT (Ahead-of-Time) compiler for the Reflex framework. Transforms Reflex templates into optimized JavaScript at build time, achieving SolidJS-class performance with ~50% bundle size reduction.

## Features

- **Zero Runtime Parsing**: No `SafeExprParser` or `WalkerMixin` in production bundles
- **Static Component Resolution**: Components imported as ES modules instead of runtime string lookups
- **Tree-Shaking**: Unused components automatically excluded from bundles
- **Static Hoisting**: Static DOM nodes created once and cloned
- **Optimized List Rendering**: Direct callbacks instead of FlatScope overhead
- **Transition Support**: Full compatibility with m-trans directives

## Installation

```bash
npm install @reflex/compiler
```

## Usage

### With Vite

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import reflex from '@reflex/compiler/vite';

export default defineConfig({
  plugins: [
    reflex({
      hoistStatic: true,
      compile: true,
    }),
  ],
});
```

### Programmatic API

```javascript
import { compile } from '@reflex/compiler';

const result = compile(`
  <div>
    <h1>{{ title }}</h1>
    <ul>
      <li m-for="item in items" :key="item.id">{{ item.name }}</li>
    </ul>
  </div>
`, {
  hoistStatic: true,
  whitespace: 'condense',
});

console.log(result.code);
```

## Architecture

### Current (Runtime Mode)

```
Template String
  → WalkerMixin (DOM traversal)
  → ExprMixin (string parsing)
  → Global Registry (component lookup)
  → ReactivityMixin (effect binding)
```

### New (Compiled Mode)

```
Template String
  → Vite Plugin (build-time)
  → Compiler (HTML → JS AST)
  → Static Imports (tree-shakeable)
  → Runtime Helpers (minimal overhead)
```

## Compilation Examples

### Input Template

```html
<div m-if="show" m-trans="fade">
  <ul>
    <li m-for="item in items" :key="item.id">
      {{ item.name }}
    </li>
  </ul>
</div>
```

### Compiled Output

```javascript
import { createKeyedList, runTransition } from 'reflex/runtime-helpers';

export function render(ctx, _ren) {
  const fragment = _ren.createComment('fragment');
  const anchor0 = _ren.createComment('if');
  _ren.insertBefore(fragment, anchor0);
  let currentEl1 = null;

  ctx.createEffect(() => {
    const shouldShow = !!(ctx.s.show);

    if (shouldShow && !currentEl1) {
      const el2 = _ren.createElement('div');
      const ul3 = _ren.createElement('ul');
      const anchor4 = _ren.createComment('for');

      _ren.appendChild(ul3, anchor4);
      _ren.appendChild(el2, ul3);

      createKeyedList(
        ctx,
        anchor4,
        () => ctx.s.items,
        (item) => item.id,
        (item, index) => {
          const li5 = _ren.createElement('li');
          ctx.createEffect(() => {
            _ren.setTextContent(li5, String(item.name));
          });
          return li5;
        }
      );

      _ren.insertBefore(anchor0, el2);
      currentEl1 = el2;
      runTransition(currentEl1, 'fade', 'enter');
    } else if (!shouldShow && currentEl1) {
      const elToRemove = currentEl1;
      currentEl1 = null;
      runTransition(elToRemove, 'fade', 'leave', () => {
        _ren.removeChild(elToRemove);
      });
    }
  });

  return fragment;
}
```

## Compiler Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hoistStatic` | boolean | `false` | Enable static node hoisting optimization |
| `whitespace` | `'preserve' \| 'condense'` | `'preserve'` | Whitespace handling strategy |
| `sourceMap` | boolean | `false` | Generate source maps |
| `dev` | boolean | `false` | Development mode (more checks) |
| `basePath` | string | `undefined` | Base path for component resolution |
| `resolveComponent` | function | `undefined` | Custom component resolver |

## Vite Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `include` | string[] | `['.rfx']` | File extensions to process |
| `exclude` | string[] | `[]` | File patterns to exclude |
| `compile` | boolean | `true` in prod | Enable compiled mode |

## Runtime Helpers

The compiler generates code that uses tree-shakeable runtime helpers:

### `createKeyedList(ctx, anchor, getItems, getKey, renderItem)`

Handles m-for directive with efficient LIS-based reconciliation.

**Parameters:**
- `ctx`: Reflex instance
- `anchor`: Comment node for insertion point
- `getItems`: Function returning the list
- `getKey`: Function extracting key from item
- `renderItem`: Function rendering each item

### `runTransition(el, name, phase, onComplete)`

Handles m-trans directive with Vue-style transition classes.

**Parameters:**
- `el`: Element to transition
- `name`: Transition name (class prefix)
- `phase`: `'enter'` or `'leave'`
- `onComplete`: Callback when transition completes

### `toDisplayString(val)`

Converts values to display strings for interpolations.

## Performance Benefits

1. **Bundle Size**: ~50% reduction by excluding runtime parser
2. **Initial Render**: Faster due to no DOM walking or expression parsing
3. **List Rendering**: SolidJS-class performance with direct callbacks
4. **Tree-Shaking**: Unused components automatically excluded

## Compatibility

- ✅ Maintains full `ReactivityMixin` compatibility
- ✅ Works with `DOMRenderer` and `VirtualRenderer`
- ✅ Supports all existing directives (m-if, m-for, m-show, m-trans, etc.)
- ✅ Compatible with existing Reflex apps (can be adopted incrementally)

## Migration Guide

### Step 1: Install compiler

```bash
npm install @reflex/compiler
```

### Step 2: Update Vite config

```javascript
import reflex from '@reflex/compiler/vite';

export default defineConfig({
  plugins: [reflex()],
});
```

### Step 3: Use .rfx files (optional)

```html
<!-- UserProfile.rfx -->
<template>
  <div class="profile">
    <h1>{{ user.name }}</h1>
    <p>{{ user.email }}</p>
  </div>
</template>

<script>
export default {
  props: ['user'],
  setup(props) {
    return {};
  }
}
</script>
```

### Step 4: Build and verify

```bash
npm run build
```

Check that `dist/` bundle doesn't include `SafeExprParser` or `WalkerMixin`.

## Development

```bash
# Install dependencies
npm install

# Build compiler
npm run build

# Watch mode
npm run dev
```

## License

MIT
