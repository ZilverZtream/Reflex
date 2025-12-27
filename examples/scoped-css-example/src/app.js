/**
 * Example App: Using Scoped CSS Components
 *
 * This demonstrates how scoped CSS works at runtime:
 * - Each component has isolated styles
 * - No style bleeding between components
 * - Zero runtime overhead (all scoping done at build time)
 */

// Note: In a real build, these would be bundled and transformed
// by the scopedCSSPlugin during the build process

import { Reflex } from '../../../dist/reflex.esm.js';

// Create the app
const app = new Reflex({
  cards: [
    {
      id: 1,
      title: 'Getting Started',
      description: 'Learn how to use Reflex with zero-runtime scoped CSS for component isolation.',
      badge: 'New',
      featured: true
    },
    {
      id: 2,
      title: 'Build Integration',
      description: 'Integrate the scoped CSS plugin with esbuild, Vite, or Rollup.',
      badge: null,
      featured: false
    },
    {
      id: 3,
      title: 'Advanced Selectors',
      description: 'Use :deep() and :global() modifiers for advanced styling scenarios.',
      badge: 'Pro',
      featured: false
    }
  ],
  buttons: [
    { label: 'Primary', primary: true, disabled: false },
    { label: 'Secondary', primary: false, disabled: false },
    { label: 'Disabled', primary: true, disabled: true }
  ]
});

// Register components (in a real app, these would be imported)
// The templates would already have data-v-xxx attributes injected by the build plugin

app.component('my-button', {
  template: `<button class="btn" :class="{ primary: primary, disabled: disabled }">
    <span class="label">{{ label }}</span>
  </button>`,
  props: ['label', 'primary', 'disabled']
});

app.component('my-card', {
  template: `<article class="card" :class="{ featured: featured }">
    <header class="card-header">
      <h3 class="title">{{ title }}</h3>
      <span class="badge" m-if="badge">{{ badge }}</span>
    </header>
    <div class="card-body">
      <p class="description">{{ description }}</p>
    </div>
  </article>`,
  props: ['title', 'description', 'badge', 'featured']
});

export default app;
