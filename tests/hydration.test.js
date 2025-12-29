/**
 * Hydration Tests
 *
 * Tests the hydration module and plugin system:
 * - Plugin system (app.use())
 * - SSR hydration (app.hydrate())
 * - Reactive binding attachment to existing DOM
 * - Event listener attachment
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';
import { withHydration } from '../src/hydration/index.ts';

describe('Plugin System', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should install function plugins', () => {
    const app = new Reflex({});
    const pluginFn = vi.fn();

    app.use(pluginFn);

    expect(pluginFn).toHaveBeenCalledWith(app, undefined);
  });

  it('should install function plugins with options', () => {
    const app = new Reflex({});
    const pluginFn = vi.fn();
    const opts = { debug: true };

    app.use(pluginFn, opts);

    expect(pluginFn).toHaveBeenCalledWith(app, opts);
  });

  it('should install object plugins with install method', () => {
    const app = new Reflex({});
    const plugin = {
      install: vi.fn()
    };

    app.use(plugin);

    expect(plugin.install).toHaveBeenCalledWith(app, undefined);
  });

  it('should install mixin plugins', () => {
    const app = new Reflex({});
    const plugin = {
      mixin: {
        customMethod() { return 'custom'; }
      }
    };

    app.use(plugin);

    expect(app.customMethod).toBeDefined();
    expect(app.customMethod()).toBe('custom');
  });

  it('should call init on mixin plugins', () => {
    const app = new Reflex({});
    const initFn = vi.fn();
    const plugin = {
      mixin: {
        customMethod() { return 'custom'; }
      },
      init: initFn
    };

    app.use(plugin);

    expect(initFn).toHaveBeenCalledWith(app, undefined);
  });

  it('should not install the same plugin twice', () => {
    const app = new Reflex({});
    const pluginFn = vi.fn();

    app.use(pluginFn);
    app.use(pluginFn);

    expect(pluginFn).toHaveBeenCalledTimes(1);
  });

  it('should return this for chaining', () => {
    const app = new Reflex({});
    const result = app.use(() => {});

    expect(result).toBe(app);
  });
});

describe('withHydration Plugin', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should add hydrate method to Reflex instance', () => {
    const app = new Reflex({});
    app.use(withHydration);

    expect(app.hydrate).toBeDefined();
    expect(typeof app.hydrate).toBe('function');
  });

  it('should add internal hydration methods', () => {
    const app = new Reflex({});
    app.use(withHydration);

    expect(app._hydrateWalk).toBeDefined();
    expect(app._hydrateNode).toBeDefined();
    expect(app._hydrateText).toBeDefined();
    expect(app._hydrateIf).toBeDefined();
    expect(app._hydrateFor).toBeDefined();
  });

  it('should initialize _hydrateMode flag', () => {
    const app = new Reflex({});
    app.use(withHydration);

    expect(app._hydrateMode).toBe(false);
  });
});

describe('Hydration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Basic Hydration', () => {
    it('should hydrate text interpolation (legacy path with literal templates)', async () => {
      // Legacy path: server renders literal template syntax
      document.body.innerHTML = '<div id="app"><span>{{ count }}</span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ count: 0 });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('0');

      app.s.count = 5;
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('5');
    });

    it('should hydrate text interpolation with comment markers (correct SSR)', async () => {
      // CRITICAL FIX: Server renders the actual value with a comment marker
      // This is how real SSR works - the server evaluates {{ count }} to "0"
      // and adds a marker <!--txt:{{ count }}--> so hydration can make it reactive
      document.body.innerHTML = '<div id="app"><span><!--txt:{{ count }}-->0</span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ count: 0 });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('0');

      app.s.count = 5;
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('5');
    });

    it('should hydrate complex text interpolation with comment markers', async () => {
      // Server renders: "Hello World" with template "Hello {{ name }}"
      document.body.innerHTML = '<div id="app"><span><!--txt:Hello {{ name }}-->Hello World</span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ name: 'World' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('Hello World');

      app.s.name = 'Reflex';
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('Hello Reflex');
    });

    it('should hydrate attribute bindings', async () => {
      document.body.innerHTML = '<div id="app"><span :class="cls">Hello</span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ cls: 'active' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').className).toBe('active');

      app.s.cls = 'inactive';
      await app.nextTick();

      expect(el.querySelector('span').className).toBe('inactive');
    });

    it('should hydrate m-text directive', async () => {
      document.body.innerHTML = '<div id="app"><span m-text="message"></span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ message: 'Hello' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('Hello');

      app.s.message = 'World';
      await app.nextTick();

      expect(el.querySelector('span').textContent).toBe('World');
    });

    it('should hydrate m-show directive', async () => {
      document.body.innerHTML = '<div id="app"><span m-show="visible">Visible</span></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ visible: true });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(el.querySelector('span').style.display).not.toBe('none');

      app.s.visible = false;
      await app.nextTick();

      expect(el.querySelector('span').style.display).toBe('none');
    });

    it('should hydrate m-ref directive', async () => {
      document.body.innerHTML = '<div id="app"><input m-ref="myInput" type="text"></div>';
      const el = document.getElementById('app');

      const app = new Reflex({});
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      expect(app._refs.myInput).toBeDefined();
      expect(app._refs.myInput.tagName).toBe('INPUT');
    });
  });

  describe('Event Hydration', () => {
    it('should hydrate click event listeners', async () => {
      document.body.innerHTML = '<div id="app"><button @click="count++">Click</button></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ count: 0 });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      const button = el.querySelector('button');
      button.click();
      await app.nextTick();

      expect(app.s.count).toBe(1);
    });

    it('should hydrate input event listeners', async () => {
      document.body.innerHTML = '<div id="app"><input m-model="value" type="text"></div>';
      const el = document.getElementById('app');

      const app = new Reflex({ value: '' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      const input = el.querySelector('input');
      input.value = 'test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await app.nextTick();

      expect(app.s.value).toBe('test');
    });
  });

  describe('Nested Hydration', () => {
    it('should hydrate nested elements', async () => {
      document.body.innerHTML = `
        <div id="app">
          <div class="parent">
            <span :class="parentClass">
              <span :class="childClass">Nested</span>
            </span>
          </div>
        </div>
      `;
      const el = document.getElementById('app');

      const app = new Reflex({ parentClass: 'p1', childClass: 'c1' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      const spans = el.querySelectorAll('span');
      expect(spans[0].className).toBe('p1');
      expect(spans[1].className).toBe('c1');

      app.s.parentClass = 'p2';
      app.s.childClass = 'c2';
      await app.nextTick();

      expect(spans[0].className).toBe('p2');
      expect(spans[1].className).toBe('c2');
    });
  });

  describe('m-ignore in Hydration', () => {
    it('should skip elements with m-ignore', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span :class="cls">Reactive</span>
          <span m-ignore :class="ignoredCls">Ignored</span>
        </div>
      `;
      const el = document.getElementById('app');

      const app = new Reflex({ cls: 'active', ignoredCls: 'ignored' });
      app.use(withHydration);
      app.hydrate(el);
      await app.nextTick();

      const spans = el.querySelectorAll('span');
      expect(spans[0].className).toBe('active');
      // m-ignore element should not have reactive bindings
      expect(spans[1].className).toBe('');
    });
  });

  describe('Hydrate with default element', () => {
    it('should hydrate document.body by default (legacy)', async () => {
      document.body.innerHTML = '<span>{{ message }}</span>';

      const app = new Reflex({ message: 'Hello' });
      app.use(withHydration);
      app.hydrate();
      await app.nextTick();

      expect(document.body.querySelector('span').textContent).toBe('Hello');
    });

    it('should hydrate document.body by default with comment markers', async () => {
      document.body.innerHTML = '<span><!--txt:{{ message }}-->Hello</span>';

      const app = new Reflex({ message: 'Hello' });
      app.use(withHydration);
      app.hydrate();
      await app.nextTick();

      expect(document.body.querySelector('span').textContent).toBe('Hello');

      app.s.message = 'World';
      await app.nextTick();

      expect(document.body.querySelector('span').textContent).toBe('World');
    });
  });

  describe('Hydration chaining', () => {
    it('should return this for chaining', () => {
      document.body.innerHTML = '<div id="app"></div>';
      const el = document.getElementById('app');

      const app = new Reflex({});
      app.use(withHydration);
      const result = app.hydrate(el);

      expect(result).toBe(app);
    });
  });
});

describe('Tree-shaking verification', () => {
  it('should not have hydration methods without plugin', () => {
    const app = new Reflex({});

    // Without withHydration plugin, hydrate method should not exist
    expect(app.hydrate).toBeUndefined();
    expect(app._hydrateWalk).toBeUndefined();
  });
});
