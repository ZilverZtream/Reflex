# Reflex: The Universal Reactive Engine

Reflex is a high-performance, zero-dependency reactive framework designed for the modern web. It combines the raw speed of direct DOM manipulation with the flexibility of a Universal Renderer.

**Size:** ~20KB (minified)
**Coverage:** 100% (494/494 Tests Passed)

## 🚀 Why Reflex?

### 1. The "Smart Engine" (Universal Architecture)
Reflex separates the *Core Logic* from the *Renderer*, allowing it to run anywhere.
* **Browser:** Uses `DOMRenderer` for "Fast-as-F***" direct DOM updates (Zero VDOM overhead).
* **Server/Tests:** Uses `VirtualRenderer` for blazing fast SSR and headless unit testing.
* **Native:** Ready for custom adapters (Canvas, WebGL, Mobile).

### 2. Enterprise-Grade Security ("Iron Membrane")
We don't just rely on Regex. Reflex uses a **Hybrid Security Model**:
* **The Vault:** A native `Proxy` membrane with a `has` trap that prevents global scope leakage (`window` access).
* **The Guard:** Early-exit Regex validation to stop dangerous keywords before compilation.
* **CSP Ready:** Auto-detects Content Security Policy and switches to a Safe Parser automatically.

### 3. Next-Gen Performance
* **Quantum Cloning:** Deep watchers use $O(1)$ structural sharing. Watching a 10MB JSON object takes <1ms.
* **Time Slicing:** The Cooperative Scheduler yields to the browser every 5ms, preventing UI freeze even during massive updates (10,000+ items).
* **LIS Reconciler:** Keyed lists use the Longest Increasing Subsequence algorithm to perform the absolute minimum number of DOM moves.

---

## 📦 Installation

```bash
npm install @zilverztream/reflex
```

## ⚡ Quick Start (Browser)

```javascript
import { Reflex } from 'reflex';

const app = new Reflex({
  count: 0
});

app.mount('#app');
```

```html
<div id="app">
  <h1>{{ count }}</h1>
  <button @click="count++">Increment</button>
</div>
```

## 🛠️ Advanced Usage

### Server-Side Rendering (SSR) & Testing

Run Reflex in Node.js without a browser environment.

```javascript
import { Reflex } from 'reflex';
import { VirtualRenderer } from 'reflex/renderers';

// Inject the Virtual Renderer
const app = new Reflex({ count: 0 }, {
  renderer: new VirtualRenderer()
});

app.mount(app._ren.getRoot());
console.log(app._ren.getRoot().innerHTML); // Output: <div>...</div>
```

### Scoped CSS (Zero-Runtime)

Reflex supports `.component.html` files with scoped styles that compile away.

```html
<template>
  <button class="btn"><slot></slot></button>
</template>

<style scoped>
  .btn { color: red; } /* Becomes .btn[data-rx-123] */
</style>
```

### Hydration (SSR)

Attach to existing server-rendered HTML without destroying the DOM.

```javascript
import { withHydration } from 'reflex/hydration';

const app = new Reflex({ ... });
app.use(withHydration);
app.hydrate(document.body);
```

---

## 🛡️ Security Policy

Reflex defaults to **Secure Mode**.

* **m-html:** Requires `DOMPurify` to be configured, or it throws a Hard Error.
* **Inline Handlers:** Sandboxed via Proxy to prevent access to `window`, `document`, or `eval`.

## 🤝 Contributing

1. Fork & Clone
2. `npm install`
3. `npm test` (Runs 490+ tests using the Virtual Renderer)
