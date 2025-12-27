# Reflex

**The Direct Reactive Engine** - Zero Dependencies, Zero Build, Zero VDOM

A lightweight (~20KB minified) reactive framework that compiles templates directly to DOM operations. No virtual DOM, no build step required, and optionally CSP-safe.

[![CI](https://github.com/ZilverZtream/Reflex/actions/workflows/ci.yml/badge.svg)](https://github.com/ZilverZtream/Reflex/actions/workflows/ci.yml)

## Features

### Core Reactivity
- **Proxy-based reactivity** with automatic dependency tracking
- **Direct DOM manipulation** - no virtual DOM overhead
- **Quantum Cloning** - O(1) deep watchers without recursive traversal
- **Computed properties** with automatic caching and lazy evaluation
- **Batching support** - group multiple state changes into one update
- **Maps and Sets** - full reactive support for collections

### Performance & Optimization
- **Cooperative scheduling (time slicing)** - yields to browser every 5ms to prevent UI freezes
- **Double-buffered job queue** - reduces GC pressure during updates
- **LIS-based reconciliation** - optimal list updates with minimal DOM operations
- **Expression caching** - compiled expressions cached with FIFO eviction
- **Fast-path expressions** - simple property access bypasses full compilation
- **Static proxy handlers** - handlers defined once and reused

### Security & Safety
- **Iron Membrane sandbox** - unbypassable proxy-based expression sandboxing
- **Prototype pollution prevention** - blocks `__proto__`, `constructor`, `prototype` access
- **URL sanitization** - blocks `javascript:`, `vbscript:`, `data:` protocols
- **HTML sanitization** - DOMPurify integration for safe m-html rendering
- **CSP-safe mode** - optional parser without `new Function()`

### Developer Experience
- **Zero dependencies** - works standalone
- **No build step required** - use directly in browser or Node.js
- **Small footprint** - ~20KB minified, ~8KB gzipped
- **TypeScript declarations** included
- **Tree-shakable plugins** - only bundle what you use
- **Hot Module Replacement** - full HMR support for development

### Advanced Features
- **SSR hydration** - attach reactivity to server-rendered HTML
- **Scoped CSS** - zero-runtime CSS scoping (build-time transform)
- **Auto-cleanup plugin** - MutationObserver-based automatic cleanup for external DOM changes
- **Template directives** - `<template>` support for structural directives
- **Custom directives** - extend the framework with your own directives
- **Plugin system** - extensible architecture with mixin support
- **Async components** - dynamic component loading with suspense-like behavior

## Installation

```bash
npm install reflex
```

Or use directly in browser:

```html
<script src="https://unpkg.com/reflex/dist/reflex.min.js"></script>
```

## Quick Start

```html
<div id="app">
  <h1>{{ message }}</h1>
  <button @click="count++">Clicked {{ count }} times</button>
  <ul>
    <li m-for="item in items" m-key="item.id">{{ item.name }}</li>
  </ul>
</div>

<script type="module">
  import { Reflex } from 'reflex';

  const app = new Reflex({
    message: 'Hello, Reflex!',
    count: 0,
    items: [
      { id: 1, name: 'Apple' },
      { id: 2, name: 'Banana' },
      { id: 3, name: 'Cherry' }
    ]
  });
</script>
```

## API

### Creating an Application

```javascript
const app = new Reflex({
  // Initial state
  count: 0,
  user: { name: 'John' }
});

// Access reactive state
app.s.count++;
app.s.user.name = 'Jane';
```

### Configuration

```javascript
app.configure({
  sanitize: true,      // Enable HTML sanitization (default: true)
  cspSafe: false,      // Use CSP-safe parser (default: false)
  cacheSize: 1000,     // Expression cache size (default: 1000)
  parser: null         // Custom expression parser for CSP mode
});
```

### CSP-Safe Mode

For environments with strict Content Security Policy:

```javascript
import { Reflex } from 'reflex';
import { SafeExprParser } from 'reflex/csp';

const app = new Reflex({ count: 0 });
app.configure({
  cspSafe: true,
  parser: new SafeExprParser()
});
```

> **Note:** Standard mode uses `new Function()` for best performance.
> CSP-safe mode evaluates expressions without `eval()` or `new Function()`,
> but has slightly higher overhead.

### Computed Properties

```javascript
const double = app.computed(state => state.count * 2);
console.log(double.value); // Reactive computed value
```

### Watchers

```javascript
app.watch(
  () => app.s.count,
  (newVal, oldVal) => {
    console.log(`count changed: ${oldVal} -> ${newVal}`);
  },
  { immediate: true, deep: false }
);
```

### Batching Updates

```javascript
app.batch(() => {
  app.s.a = 1;
  app.s.b = 2;
  app.s.c = 3;
}); // Only triggers one update
```

### Custom Directives

```javascript
app.directive('focus', (el, { value }) => {
  if (value) el.focus();
  return () => {
    // Cleanup function (optional)
  };
});
```

```html
<input m-focus="shouldFocus">
```

### Components

```javascript
app.component('my-button', {
  template: '<button @click="$emit(\'click\')">{{ label }}</button>',
  props: ['label'],
  setup(props, { emit }) {
    return {
      // Additional reactive state
    };
  }
});
```

### SSR Hydration

Attach reactivity to server-rendered HTML without re-creating the DOM:

```javascript
import { Reflex } from 'reflex';
import { withHydration } from 'reflex/hydration';

const app = new Reflex({ count: 0 });
app.use(withHydration);
app.hydrate(document.getElementById('app')); // Hydrates instead of mounting
```

**Benefits:**
- Faster time-to-interactive (TTI)
- SEO-friendly server-rendered HTML
- Progressive enhancement support

### Scoped CSS

Zero-runtime CSS scoping for components (build-time transform):

```javascript
// Build tool integration
import { scopedCSSPlugin } from 'reflex/scoped-css';

// Vite
export default {
  plugins: [viteScopedCSS()]
};

// esbuild
esbuild.build({
  plugins: [scopedCSSPlugin()]
});
```

**Component with scoped styles:**
```javascript
app.component('card', {
  template: `
    <div class="card">
      <h2>{{ title }}</h2>
      <p>{{ content }}</p>
    </div>
  `,
  styles: `
    .card { border: 1px solid #ccc; }
    h2 { color: blue; }
  `,
  props: ['title', 'content']
});
```

### Auto-Cleanup Plugin

Automatically clean up when elements are removed by external scripts (jQuery, HTMX, etc.):

```javascript
import { withAutoCleanup } from 'reflex/observer';

const app = new Reflex({ count: 0 });
app.use(withAutoCleanup);

// Now external removals trigger cleanup automatically:
// $('#my-element').remove(); // ← Listeners automatically cleaned up!
```

**Features:**
- MutationObserver-based detection
- O(1) element lookup using markers
- Batched cleanup in microtasks
- Zero overhead until elements are removed

### Template Directives

Use `<template>` tags for cleaner structural directives:

```html
<!-- Before -->
<div m-if="show">
  <div m-for="item in items" m-key="item.id">
    {{ item.name }}
  </div>
</div>

<!-- With <template> -->
<template m-if="show">
  <template m-for="item in items" m-key="item.id">
    <div>{{ item.name }}</div>
  </template>
</template>
```

**Benefits:**
- No wrapper elements in DOM
- Better semantic structure
- Matches Vue 3 and Svelte patterns

### Async Components

Load components dynamically with automatic loading states:

```javascript
app.component('lazy-chart', {
  async: () => import('./Chart.js'),
  loading: '<div>Loading chart...</div>',
  error: '<div>Failed to load</div>',
  timeout: 3000
});
```

## Directives

| Directive | Description | Example |
|-----------|-------------|---------|
| `m-if` | Conditional rendering | `<div m-if="isVisible">` |
| `m-for` | List rendering | `<li m-for="item in items">` |
| `m-key` | Unique key for list items | `m-key="item.id"` |
| `m-show` | Toggle visibility | `<div m-show="isActive">` |
| `m-model` | Two-way binding | `<input m-model="text">` |
| `m-text` | Text content | `<span m-text="message">` |
| `m-html` | HTML content (sanitized) | `<div m-html="content">` |
| `m-ref` | Element reference | `<input m-ref="myInput">` |
| `m-trans` | Transition name | `<div m-if="show" m-trans="fade">` |
| `m-effect` | Side effects | `<div m-effect="console.log(count)">` |
| `m-ignore` | Skip subtree | `<div m-ignore>` |
| `:attr` | Bind attribute | `:class="{ active: isActive }"` |
| `@event` | Event handler | `@click="handleClick"` |
| `{{ }}` | Text interpolation | `{{ user.name }}` |

## Event Modifiers

| Modifier | Description |
|----------|-------------|
| `.prevent` | Call `preventDefault()` |
| `.stop` | Call `stopPropagation()` |
| `.once` | Only trigger once |
| `.self` | Only if event target is element itself |
| `.window` | Listen on window |
| `.document` | Listen on document |
| `.outside` | Trigger when clicking outside element |
| `.debounce.Nms` | Debounce handler (default 300ms) |
| `.throttle.Nms` | Throttle handler (default 300ms) |

Example:
```html
<input @input.debounce.300ms="search">
<button @click.prevent.once="submit">Submit</button>
<div @click.outside="closeModal">Modal</div>
```

## Transitions

Add CSS transitions with `m-trans`:

```html
<div m-if="show" m-trans="fade">Content</div>
```

```css
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
```

## Magic Properties

Available in all expressions:

| Property | Description |
|----------|-------------|
| `$refs` | Object containing elements with `m-ref` |
| `$event` | Current event object (in event handlers) |
| `$el` | Current element (in event handlers) |
| `$dispatch` | Dispatch custom event |
| `$nextTick` | Wait for next DOM update |

## Architecture

### Module Structure

```
src/
├── core/
│   ├── symbols.ts      # Shared symbols and constants
│   ├── reactivity.ts   # Proxy handlers, Quantum Cloning, dependency tracking
│   ├── scheduler.ts    # Effect system, cooperative scheduling, job queue
│   ├── expr.ts         # Expression compilation, Iron Membrane sandbox
│   ├── compiler.ts     # DOM walking, directive processing, transitions
│   ├── reconcile.ts    # LIS-based list reconciliation
│   └── reflex.ts       # Main Reflex class, plugin system
├── csp/
│   ├── SafeExprParser.ts  # CSP-safe expression parser
│   └── index.ts
├── hydration/
│   ├── withHydration.ts   # SSR hydration support
│   └── index.ts
├── scoped-css/
│   ├── css-transform.ts      # CSS scoping transform
│   ├── template-transform.ts # Template attribute injection
│   ├── component-transform.ts # Component processing
│   ├── plugins.ts           # Build tool plugins (esbuild, Vite)
│   └── index.ts
├── observer/
│   ├── withAutoCleanup.ts # MutationObserver-based auto-cleanup
│   └── index.ts
└── index.ts            # Public exports
```

### Reactivity System

Reflex uses ES6 Proxies with static handlers to minimize memory allocation.
Each reactive object stores metadata in a Symbol property or WeakMap (for
non-extensible objects).

**Quantum Cloning** enables O(1) deep watchers by using structural sharing:
when you watch an object deeply, Reflex creates shallow clones of nested
structures. Changes trigger updates without recursive traversal, enabling
efficient deep watching of objects with 1000+ levels of nesting.

### Scheduler

Effects are batched using a double-buffered queue to reduce garbage collection
pressure. The scheduler uses microtasks (via `queueMicrotask`) for automatic
batching.

**Cooperative Scheduling (Time Slicing)** prevents UI freezes during large
updates by yielding to the browser every 5ms. This maintains 60fps rendering
even when processing thousands of DOM updates, similar to React's Concurrent
Mode.

### List Reconciliation

The `m-for` directive uses the **Longest Increasing Subsequence (LIS)** algorithm
to minimize DOM operations when reordering lists. Nodes in the LIS don't need to
move, reducing the number of DOM mutations.

## Security

### Expression Sandboxing (Iron Membrane)

Reflex uses **"The Iron Membrane"** - an unbypassable proxy-based sandbox that
wraps ALL expression results, preventing security exploits even with complex
obfuscation:

- **Runtime protection**: Blocks access to `__proto__`, `constructor`, `prototype`
  at runtime using proxy traps
- **Recursive wrapping**: All nested objects/arrays are automatically wrapped
- **Array method safety**: Array methods like `map`, `filter`, `forEach` return
  wrapped results
- **Obfuscation-resistant**: Blocks tricks like `['constr'+'uctor']` and
  string concatenation exploits
- **No eval/Function**: Standard mode uses `new Function()` but sanitizes the
  execution context

### URL Sanitization

- Blocks `javascript:`, `vbscript:`, and `data:` protocols in URL attributes
- Applies to `href`, `src`, `action`, `formaction`, `xlink:href`

### HTML Sanitization

When `m-html` is used:
- If DOMPurify is available, content is sanitized
- Otherwise, HTML entities are escaped
- Set `sanitize: false` to disable (not recommended)

## Influences / Credits

Reflex draws inspiration from and acknowledges the following projects:

### Directive Syntax
The directive syntax (`m-if`, `m-for`, `:attr`, `@event`) follows conventions
established by [Vue.js](https://vuejs.org/) and [Alpine.js](https://alpinejs.dev/).

### LIS Reconciliation
The keyed list reconciliation algorithm uses the Longest Increasing Subsequence
technique, similar to implementations in:
- [Vue 3](https://github.com/vuejs/core) runtime-core
- [Inferno](https://github.com/infernojs/inferno)

The algorithm is based on the patience sorting approach for computing LIS in
O(n log n) time complexity.

### Transition System
The transition naming convention (`{name}-enter-from`, `{name}-enter-active`,
`{name}-enter-to`) follows [Vue's transition system](https://vuejs.org/guide/built-ins/transition.html).

## Performance Notes

### Reactivity Optimizations
- **Static proxy handlers**: Handlers are defined once and reused, eliminating
  per-object closure allocation
- **Quantum Cloning**: O(1) deep watchers using structural sharing instead of
  recursive traversal - enables watching 1000+ nested levels without stack overflow
- **Lazy computed properties**: Only re-compute when dependencies change AND
  value is accessed

### Scheduler Optimizations
- **Cooperative scheduling (time slicing)**: Yields to browser every 5ms during
  large updates to maintain 60fps rendering
- **Double-buffered job queue**: Reduces GC pressure by reusing arrays instead
  of creating new ones each flush
- **O(1) deduplication**: Uses bitflags (QUEUED) instead of Set.has() for
  instant duplicate detection

### Compilation Optimizations
- **Expression caching**: Compiled expressions cached with FIFO eviction (1000 entry default)
- **Fast-path expressions**: Simple property access like `{{ count }}` bypasses
  full compilation
- **WeakMap for lifecycle**: Cleanup functions stored in WeakMap to avoid
  modifying DOM node properties

### Reconciliation Optimizations
- **LIS algorithm**: Longest Increasing Subsequence for optimal list reordering
  with minimal DOM moves (O(n log n))
- **Keyed reconciliation**: Reuses DOM nodes when keys match, only moving/patching
  changed elements
- **TreeWalker for cleanup**: Efficient subtree traversal in auto-cleanup plugin

## Browser Support

Reflex requires ES6 Proxy support:
- Chrome 49+
- Firefox 18+
- Safari 10+
- Edge 12+

For older browsers, use a Proxy polyfill (with limitations).

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build

# Lint
npm run lint

# Format
npm run format
```

## License

MIT

## Contributing

Contributions are welcome! Please read the contributing guidelines before
submitting a pull request.
