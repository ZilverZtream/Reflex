/**
 * Async Components & Suspense Tests
 *
 * Tests the async component loading with suspense support:
 * - Async component registration with factory functions
 * - Lazy loading via dynamic import simulation
 * - Fallback placeholder rendering
 * - Caching of resolved components
 * - Error handling
 * - Multiple instances sharing the same loading promise
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Async Components', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Registration', () => {
    it('should register async component with factory function', () => {
      const app = new Reflex({});
      const factory = () => Promise.resolve({
        template: '<div>Loaded</div>'
      });

      app.component('lazy-comp', factory);

      expect(app._acp.has('lazy-comp')).toBe(true);
      expect(app._cp.has('lazy-comp')).toBe(false);
    });

    it('should register sync component with object definition', () => {
      const app = new Reflex({});

      app.component('sync-comp', {
        template: '<div>Sync</div>'
      });

      expect(app._cp.has('sync-comp')).toBe(true);
      expect(app._acp.has('sync-comp')).toBe(false);
    });

    it('should store fallback template for async components', () => {
      const app = new Reflex({});
      const factory = () => Promise.resolve({ template: '<div>Loaded</div>' });

      app.component('lazy-comp', factory, {
        fallback: '<div class="loading">Loading...</div>'
      });

      expect(app._acp.get('lazy-comp').fallback).toBe('<div class="loading">Loading...</div>');
    });
  });

  describe('Loading', () => {
    it('should load async component when encountered in DOM', async () => {
      document.body.innerHTML = '<lazy-comp></lazy-comp>';

      const app = new Reflex({});
      app.component('lazy-comp', () => Promise.resolve({
        template: '<div class="loaded">Component Loaded</div>'
      }));
      await app.nextTick();

      // Wait for async loading
      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(document.querySelector('.loaded')).not.toBeNull();
      expect(document.body.textContent).toContain('Component Loaded');
    });

    it('should support default export from modules', async () => {
      document.body.innerHTML = '<module-comp></module-comp>';

      const app = new Reflex({});
      app.component('module-comp', () => Promise.resolve({
        default: {
          template: '<div class="module">From Module</div>'
        }
      }));
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(document.querySelector('.module')).not.toBeNull();
    });

    it('should pass through attributes to loaded component', async () => {
      document.body.innerHTML = '<lazy-button :label="buttonLabel" @click="onClick"></lazy-button>';

      const onClick = vi.fn();
      const app = new Reflex({ buttonLabel: 'Click Me', onClick });
      app.component('lazy-button', () => Promise.resolve({
        template: '<button>{{ label }}</button>',
        props: ['label']
      }));
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      const button = document.querySelector('button');
      expect(button).not.toBeNull();
      expect(button.textContent).toBe('Click Me');
    });
  });

  describe('Suspense (Fallback)', () => {
    it('should show fallback while loading', async () => {
      document.body.innerHTML = '<slow-comp></slow-comp>';

      let resolveComponent = (_v) => {};
      const loadPromise = new Promise(resolve => {
        resolveComponent = resolve;
      });

      const app = new Reflex({});
      app.component('slow-comp', () => loadPromise, {
        fallback: '<div class="fallback">Loading...</div>'
      });
      await app.nextTick();

      // Fallback should be visible
      expect(document.querySelector('.fallback')).not.toBeNull();
      expect(document.body.textContent).toContain('Loading...');

      // Resolve the component
      resolveComponent({ template: '<div class="real">Real Component</div>' });
      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      // Fallback should be gone, real component should be visible
      expect(document.querySelector('.fallback')).toBeNull();
      expect(document.querySelector('.real')).not.toBeNull();
    });

    it('should bind reactive data in fallback', async () => {
      document.body.innerHTML = '<slow-comp></slow-comp>';

      let resolveComponent = (_v) => {};
      const loadPromise = new Promise(resolve => {
        resolveComponent = resolve;
      });

      const app = new Reflex({ loadingText: 'Please wait...' });
      app.component('slow-comp', () => loadPromise, {
        fallback: '<div class="fallback">{{ loadingText }}</div>'
      });
      await app.nextTick();

      expect(document.body.textContent).toContain('Please wait...');

      // Update loading text reactively
      app.s.loadingText = 'Almost there...';
      await app.nextTick();

      expect(document.body.textContent).toContain('Almost there...');

      resolveComponent({ template: '<div>Done</div>' });
    });

    it('should work without fallback (renders nothing while loading)', async () => {
      document.body.innerHTML = '<span>Before</span><no-fallback></no-fallback><span>After</span>';

      let resolveComponent = (_v) => {};
      const loadPromise = new Promise(resolve => {
        resolveComponent = resolve;
      });

      const app = new Reflex({});
      app.component('no-fallback', () => loadPromise);
      await app.nextTick();

      // Only the surrounding spans should be visible
      expect(document.body.textContent.trim()).toBe('BeforeAfter');

      resolveComponent({ template: '<div>Loaded</div>' });
      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(document.body.textContent).toContain('Loaded');
    });
  });

  describe('Caching', () => {
    it('should cache resolved component definition', async () => {
      document.body.innerHTML = '<cached-comp></cached-comp>';

      const factory = vi.fn(() => Promise.resolve({
        template: '<div>Cached</div>'
      }));

      const app = new Reflex({});
      app.component('cached-comp', factory);
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(factory).toHaveBeenCalledTimes(1);
      expect(app._acp.get('cached-comp').resolved).not.toBeNull();
    });

    it('should use cached definition for subsequent instances', async () => {
      document.body.innerHTML = '<cached-comp></cached-comp>';

      const factory = vi.fn(() => Promise.resolve({
        template: '<div class="instance">Instance</div>'
      }));

      const app = new Reflex({});
      app.component('cached-comp', factory);
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      // Add another instance dynamically
      const second = document.createElement('cached-comp');
      document.body.appendChild(second);
      app._w(document.body, null);
      await app.nextTick();

      // Factory should only be called once
      expect(factory).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('.instance').length).toBe(2);
    });

    it('should share pending promise for concurrent requests', async () => {
      document.body.innerHTML = '<shared-comp></shared-comp><shared-comp></shared-comp>';

      let resolveCount = 0;
      const factory = vi.fn(() => {
        resolveCount++;
        return Promise.resolve({ template: '<div>Shared</div>' });
      });

      const app = new Reflex({});
      app.component('shared-comp', factory);
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      // Factory should only be called once even for two components
      expect(factory).toHaveBeenCalledTimes(1);
      expect(resolveCount).toBe(1);
    });
  });

  describe('Setup Function', () => {
    it('should call setup function of async component', async () => {
      // Create app first, register component, then set DOM and mount
      const setup = vi.fn(() => ({ count: 0 }));
      const app = new Reflex({});
      app.component('setup-comp', () => Promise.resolve({
        template: '<div>{{ count }}</div>',
        setup
      }));

      // Set DOM and mount explicitly
      document.body.innerHTML = '<setup-comp></setup-comp>';
      app.mount(document.body);

      // Wait for async loading
      await new Promise(r => setTimeout(r, 50));
      await app.nextTick();

      expect(setup).toHaveBeenCalled();
    });

    it('should make setup return values reactive', async () => {
      // First test with a SYNC component to make sure text interpolation works
      document.body.innerHTML = '<div id="sync-test"><sync-comp></sync-comp></div>';
      const syncContainer = document.getElementById('sync-test');
      const syncApp = new Reflex({});
      syncApp.component('sync-comp', {
        template: '<span class="sync-count">{{ count }}</span>',
        setup() {
          return { count: 42 };
        }
      });
      syncApp.mount(syncContainer);
      await syncApp.nextTick();

      const syncCountEl = document.querySelector('.sync-count');
      expect(syncCountEl).not.toBeNull();
      expect(syncCountEl.textContent).toBe('42');

      // Now test with async component
      document.body.innerHTML = '<div id="test-mount"><reactive-comp></reactive-comp></div>';
      const container = document.getElementById('test-mount');

      const app = new Reflex({});
      app.component('reactive-comp', () => Promise.resolve({
        template: '<span class="count">{{ count }}</span>',
        setup() {
          return { count: 0 };
        }
      }));

      app.mount(container);

      // Wait for async loading
      await new Promise(r => setTimeout(r, 100));
      await app.nextTick();

      const countEl = document.querySelector('.count');
      expect(countEl).not.toBeNull();
      expect(countEl.textContent).toBe('0');
    });
  });

  describe('Error Handling', () => {
    it('should call error handler on load failure', async () => {
      document.body.innerHTML = '<error-comp></error-comp>';

      const onError = vi.fn();
      const app = new Reflex({});
      app.configure({ onError });

      app.component('error-comp', () => Promise.reject(new Error('Load failed')));
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toBe('Load failed');
    });

    it('should remove fallback on error', async () => {
      document.body.innerHTML = '<error-comp></error-comp>';

      const app = new Reflex({});
      app.configure({ onError: () => {} }); // Suppress error output

      app.component('error-comp', () => Promise.reject(new Error('Failed')), {
        fallback: '<div class="fallback">Loading...</div>'
      });
      await app.nextTick();

      expect(document.querySelector('.fallback')).not.toBeNull();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      expect(document.querySelector('.fallback')).toBeNull();
    });

    it('should allow retry after error', async () => {
      document.body.innerHTML = '<retry-comp></retry-comp>';

      let attempts = 0;
      const factory = vi.fn(() => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new Error('First attempt failed'));
        }
        return Promise.resolve({ template: '<div class="success">Success</div>' });
      });

      const app = new Reflex({});
      app.configure({ onError: () => {} });

      app.component('retry-comp', factory);
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      // First attempt failed, pending should be cleared
      expect(app._acp.get('retry-comp').pending).toBeNull();
      expect(app._acp.get('retry-comp').resolved).toBeNull();
    });
  });

  describe('Integration with Directives', () => {
    it('should work with m-if on async component', async () => {
      // Register component first
      const app = new Reflex({ showWidget: true });
      app.component('lazy-widget', () => Promise.resolve({
        template: '<div class="widget">Widget</div>'
      }));

      // Set DOM and mount explicitly
      document.body.innerHTML = '<lazy-widget m-if="showWidget"></lazy-widget>';
      app.mount(document.body);

      await new Promise(r => setTimeout(r, 50));
      await app.nextTick();

      expect(document.querySelector('.widget')).not.toBeNull();

      app.s.showWidget = false;
      await app.nextTick();

      // Widget should be removed
      expect(document.querySelector('.widget')).toBeNull();
    });

    it('should work with m-for on async component', async () => {
      // Register component first
      const app = new Reflex({ items: [1, 2, 3] });
      app.component('lazy-item', () => Promise.resolve({
        template: '<span class="item">{{ data }}</span>',
        props: ['data']
      }));

      // Set DOM and mount explicitly
      document.body.innerHTML = '<lazy-item m-for="item in items" :data="item"></lazy-item>';
      app.mount(document.body);

      await new Promise(r => setTimeout(r, 50));
      await app.nextTick();

      // Should have 3 items rendered
      expect(document.querySelectorAll('.item').length).toBe(3);
    });
  });

  describe('Performance', () => {
    it('should not load async handler code until first async component is used', () => {
      // Create app without any async components
      const app = new Reflex({});
      app.component('sync-only', {
        template: '<div>Sync</div>'
      });

      // _acp should be an empty Map (initialized but no entries)
      expect(app._acp.size).toBe(0);
    });

    it('should register component to sync map after loading (fast subsequent renders)', async () => {
      document.body.innerHTML = '<optimized-comp></optimized-comp>';

      const app = new Reflex({});
      app.component('optimized-comp', () => Promise.resolve({
        template: '<div>Optimized</div>'
      }));
      await app.nextTick();

      await new Promise(r => setTimeout(r, 10));
      await app.nextTick();

      // After loading, component should be in sync map
      expect(app._cp.has('optimized-comp')).toBe(true);
    });
  });
});
