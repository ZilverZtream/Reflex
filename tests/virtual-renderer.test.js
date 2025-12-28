/**
 * Virtual Renderer Tests
 *
 * Tests the pluggable renderer architecture with the VirtualRenderer.
 * Verifies that Reflex can run without a real DOM using virtual nodes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflex, VirtualRenderer, createVirtualRenderer } from '../src/index.ts';

describe('VirtualRenderer', () => {
  let renderer;
  let root;

  beforeEach(() => {
    renderer = createVirtualRenderer({ debug: false });
    root = renderer.getRoot();
  });

  describe('Basic Virtual DOM Operations', () => {
    it('creates comment nodes', () => {
      const comment = renderer.createComment('test');
      expect(comment.nodeType).toBe(8);
      expect(comment.nodeValue).toBe('test');
    });

    it('creates element nodes', () => {
      const div = renderer.createElement('div');
      expect(div.nodeType).toBe(1);
      expect(div.tagName).toBe('DIV');
    });

    it('creates text nodes', () => {
      const text = renderer.createTextNode('Hello');
      expect(text.nodeType).toBe(3);
      expect(text.nodeValue).toBe('Hello');
    });

    it('handles parent-child relationships', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');

      renderer.appendChild(parent, child);

      expect(parent.firstChild).toBe(child);
      expect(parent.lastChild).toBe(child);
      expect(child.parentNode).toBe(parent);
    });

    it('handles sibling relationships', () => {
      const parent = renderer.createElement('div');
      const first = renderer.createElement('span');
      const second = renderer.createElement('span');

      renderer.appendChild(parent, first);
      renderer.appendChild(parent, second);

      expect(first.nextSibling).toBe(second);
      expect(second.previousSibling).toBe(first);
    });

    it('supports insertBefore', () => {
      const parent = renderer.createElement('div');
      const first = renderer.createElement('span');
      const second = renderer.createElement('span');
      const inserted = renderer.createElement('div');

      renderer.appendChild(parent, first);
      renderer.appendChild(parent, second);
      renderer.insertBefore(parent, inserted, second);

      expect(parent.childNodes.length).toBe(3);
      expect(first.nextSibling).toBe(inserted);
      expect(inserted.nextSibling).toBe(second);
    });

    it('supports insertAfter', () => {
      const parent = renderer.createElement('div');
      const first = renderer.createElement('span');
      const second = renderer.createElement('span');

      renderer.appendChild(parent, first);
      renderer.appendChild(parent, second);

      const inserted = renderer.createElement('div');
      renderer.insertAfter(first, inserted);

      expect(parent.childNodes.length).toBe(3);
      expect(first.nextSibling).toBe(inserted);
      expect(inserted.nextSibling).toBe(second);
    });

    it('supports removeChild', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');

      renderer.appendChild(parent, child);
      renderer.removeChild(child);

      expect(parent.childNodes.length).toBe(0);
      expect(child.parentNode).toBe(null);
    });

    it('supports replaceWith', () => {
      const parent = renderer.createElement('div');
      const old = renderer.createElement('span');
      const replacement = renderer.createElement('div');

      renderer.appendChild(parent, old);
      renderer.replaceWith(old, replacement);

      expect(parent.childNodes.length).toBe(1);
      expect(parent.firstChild).toBe(replacement);
      expect(old.parentNode).toBe(null);
    });
  });

  describe('Attribute Handling', () => {
    it('sets and gets attributes', () => {
      const el = renderer.createElement('div');
      renderer.setAttribute(el, 'id', 'test');

      expect(renderer.getAttribute(el, 'id')).toBe('test');
      expect(el.id).toBe('test');
    });

    it('removes attributes', () => {
      const el = renderer.createElement('div');
      renderer.setAttribute(el, 'class', 'foo');
      renderer.removeAttribute(el, 'class');

      expect(renderer.getAttribute(el, 'class')).toBe(null);
    });
  });

  describe('Class List', () => {
    it('adds classes', () => {
      const el = renderer.createElement('div');
      el.classList.add('foo', 'bar');

      expect(el.classList.contains('foo')).toBe(true);
      expect(el.classList.contains('bar')).toBe(true);
    });

    it('removes classes', () => {
      const el = renderer.createElement('div');
      el.classList.add('foo', 'bar');
      el.classList.remove('foo');

      expect(el.classList.contains('foo')).toBe(false);
      expect(el.classList.contains('bar')).toBe(true);
    });
  });

  describe('Event Handling', () => {
    it('registers and dispatches events', () => {
      const el = renderer.createElement('button');
      const handler = vi.fn();

      renderer.addEventListener(el, 'click', handler);
      renderer.dispatchEvent(el, 'click', { value: 42 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].detail.value).toBe(42);
    });

    it('removes event listeners', () => {
      const el = renderer.createElement('button');
      const handler = vi.fn();

      renderer.addEventListener(el, 'click', handler);
      renderer.removeEventListener(el, 'click', handler);
      renderer.dispatchEvent(el, 'click');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Query Selectors', () => {
    it('finds elements by tag', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');
      renderer.appendChild(parent, child);

      const found = renderer.querySelector(parent, 'span');
      expect(found).toBe(child);
    });

    it('finds elements by id', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');
      child.id = 'test';
      renderer.appendChild(parent, child);

      const found = renderer.querySelector(parent, '#test');
      expect(found).toBe(child);
    });

    it('finds elements by class', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');
      child.classList.add('target');
      renderer.appendChild(parent, child);

      const found = renderer.querySelector(parent, '.target');
      expect(found).toBe(child);
    });

    it('finds all matching elements', () => {
      const parent = renderer.createElement('div');
      const child1 = renderer.createElement('span');
      const child2 = renderer.createElement('span');
      renderer.appendChild(parent, child1);
      renderer.appendChild(parent, child2);

      const found = renderer.querySelectorAll(parent, 'span');
      expect(found.length).toBe(2);
    });
  });

  describe('Serialization', () => {
    it('serializes to HTML', () => {
      const div = renderer.createElement('div');
      renderer.setAttribute(div, 'class', 'container');
      const span = renderer.createElement('span');
      renderer.appendChild(div, span);
      renderer.appendChild(root, div);

      const html = renderer.serialize();
      expect(html).toContain('<div');
      expect(html).toContain('class="container"');
      expect(html).toContain('<span');
    });

    it('converts to JSON', () => {
      const div = renderer.createElement('div');
      div.classList.add('test');
      renderer.appendChild(root, div);

      const json = renderer.toJSON();
      expect(json.type).toBe('element');
      expect(json.tag).toBe('body');
      expect(json.children).toHaveLength(1);
      expect(json.children[0].classes).toContain('test');
    });
  });

  describe('Clone Operations', () => {
    it('deep clones nodes', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');
      renderer.setAttribute(child, 'id', 'child');
      renderer.appendChild(parent, child);

      const clone = renderer.cloneNode(parent, true);

      expect(clone).not.toBe(parent);
      expect(clone.firstChild).not.toBe(child);
      expect(renderer.getAttribute(clone.firstChild, 'id')).toBe('child');
    });

    it('shallow clones nodes', () => {
      const parent = renderer.createElement('div');
      const child = renderer.createElement('span');
      renderer.appendChild(parent, child);

      const clone = renderer.cloneNode(parent, false);

      expect(clone.childNodes.length).toBe(0);
    });
  });
});

describe('Reflex with VirtualRenderer', () => {
  let renderer;
  let app;

  beforeEach(() => {
    renderer = createVirtualRenderer({ debug: false });
  });

  describe('Basic Initialization', () => {
    it('creates Reflex instance with custom renderer', () => {
      app = new Reflex({ count: 0 }, { renderer });
      expect(app).toBeDefined();
      expect(app._ren).toBe(renderer);
    });

    it('does not auto-mount for non-browser targets', () => {
      app = new Reflex({ count: 0 }, { renderer });
      expect(app._m).toBe(false);
    });

    it('mounts to virtual root', () => {
      app = new Reflex({ count: 0 }, { renderer });
      app.mount(renderer.getRoot());
      expect(app._m).toBe(true);
      expect(app._dr).toBe(renderer.getRoot());
    });
  });

  describe('Reactive State', () => {
    it('maintains reactive state', () => {
      app = new Reflex({ count: 0 }, { renderer });
      expect(app.s.count).toBe(0);

      app.s.count = 5;
      expect(app.s.count).toBe(5);
    });

    it('triggers effects on state change', async () => {
      app = new Reflex({ count: 0 }, { renderer });
      let effectValue = 0;

      app.createEffect(() => {
        effectValue = app.s.count;
      });

      expect(effectValue).toBe(0);

      app.s.count = 10;
      await app.nextTick();

      expect(effectValue).toBe(10);
    });
  });

  describe('Computed Properties', () => {
    it('computes derived values', () => {
      app = new Reflex({ count: 5 }, { renderer });

      const doubled = app.computed(() => app.s.count * 2);
      expect(doubled.value).toBe(10);
    });

    it('updates on dependency change', async () => {
      app = new Reflex({ count: 5 }, { renderer });
      const doubled = app.computed(() => app.s.count * 2);

      app.s.count = 10;
      await app.nextTick();

      expect(doubled.value).toBe(20);
    });
  });

  describe('Watch', () => {
    it('watches for changes', async () => {
      app = new Reflex({ name: 'Alice' }, { renderer });
      const changes = [];

      app.watch(
        () => app.s.name,
        (newVal, oldVal) => {
          changes.push({ newVal, oldVal });
        }
      );

      app.s.name = 'Bob';
      await app.nextTick();

      expect(changes.length).toBe(1);
      expect(changes[0]).toEqual({ newVal: 'Bob', oldVal: 'Alice' });
    });
  });

  describe('Batch Updates', () => {
    it('batches multiple state changes', async () => {
      app = new Reflex({ a: 0, b: 0 }, { renderer });
      let updateCount = 0;

      app.createEffect(() => {
        app.s.a;
        app.s.b;
        updateCount++;
      });

      // Initial effect run
      expect(updateCount).toBe(1);

      app.batch(() => {
        app.s.a = 1;
        app.s.b = 2;
      });
      await app.nextTick();

      // Should only trigger once for batched updates
      expect(updateCount).toBe(2);
    });
  });

  describe('Error Handling', () => {
    it('requires renderer for native target', () => {
      expect(() => {
        new Reflex({}, { target: 'native' });
      }).toThrow(/require.*renderer/i);
    });

    it('requires renderer for test target', () => {
      expect(() => {
        new Reflex({}, { target: 'test' });
      }).toThrow(/require.*renderer/i);
    });
  });
});

describe('VirtualRenderer Transitions', () => {
  let renderer;

  beforeEach(() => {
    renderer = createVirtualRenderer();
  });

  it('simulates transitions immediately', async () => {
    const el = renderer.createElement('div');
    let transitionComplete = false;

    renderer.runTransition(el, {
      name: 'fade',
      type: 'enter',
      done: () => { transitionComplete = true; }
    });

    // Wait for microtask (requestAnimationFrame simulation)
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));

    expect(transitionComplete).toBe(true);
  });
});

describe('Platform Detection', () => {
  it('DOMRenderer reports browser target', async () => {
    const { DOMRenderer } = await import('../src/renderers/dom.ts');
    expect(DOMRenderer.isBrowser).toBe(true);
  });

  it('VirtualRenderer reports non-browser target', () => {
    const renderer = createVirtualRenderer();
    expect(renderer.isBrowser).toBe(false);
  });
});
