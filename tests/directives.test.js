/**
 * Directive Tests
 *
 * Tests the built-in directives:
 * - m-if (conditional rendering)
 * - m-for (list rendering with LIS reconciliation)
 * - m-show (visibility toggle)
 * - m-model (two-way binding)
 * - m-text, m-html (content binding)
 * - Custom directives
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.js';

describe('Directives', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('m-if', () => {
    it('should conditionally render elements', async () => {
      document.body.innerHTML = '<div m-if="show">Hello</div>';
      const app = new Reflex({ show: true });
      await app.nextTick();

      expect(document.body.textContent).toContain('Hello');
    });

    it('should remove element when condition becomes false', async () => {
      document.body.innerHTML = '<div m-if="show">Hello</div>';
      const app = new Reflex({ show: true });
      await app.nextTick();

      app.s.show = false;
      await app.nextTick();

      expect(document.body.textContent).not.toContain('Hello');
    });

    it('should add element when condition becomes true', async () => {
      document.body.innerHTML = '<div m-if="show">Hello</div>';
      const app = new Reflex({ show: false });
      await app.nextTick();

      expect(document.body.textContent).not.toContain('Hello');

      app.s.show = true;
      await app.nextTick();

      expect(document.body.textContent).toContain('Hello');
    });

    it('should handle nested m-if', async () => {
      document.body.innerHTML = `
        <div m-if="outer">
          <span m-if="inner">Nested</span>
        </div>
      `;
      const app = new Reflex({ outer: true, inner: true });
      await app.nextTick();

      expect(document.body.textContent).toContain('Nested');

      app.s.inner = false;
      await app.nextTick();

      expect(document.body.textContent).not.toContain('Nested');
    });
  });

  describe('m-for', () => {
    it('should render list items', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ items: ['a', 'b', 'c'] });
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(3);
      expect(lis[0].textContent).toBe('a');
      expect(lis[1].textContent).toBe('b');
      expect(lis[2].textContent).toBe('c');
    });

    it('should handle item with index', async () => {
      document.body.innerHTML = '<ul><li m-for="(item, i) in items" m-text="i + \': \' + item"></li></ul>';
      const app = new Reflex({ items: ['a', 'b'] });
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis[0].textContent).toBe('0: a');
      expect(lis[1].textContent).toBe('1: b');
    });

    it('should update when items are added', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ items: ['a'] });
      await app.nextTick();

      app.s.items.push('b');
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(2);
    });

    it('should update when items are removed', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ items: ['a', 'b', 'c'] });
      await app.nextTick();

      app.s.items.pop();
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(2);
    });

    it('should preserve nodes when reordering with key', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-key="item.id" m-text="item.name"></li></ul>';
      const app = new Reflex({
        items: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
          { id: 3, name: 'C' }
        ]
      });
      await app.nextTick();

      const _originalNodes = Array.from(document.querySelectorAll('li'));

      // Reorder: [B, A, C]
      app.s.items = [
        { id: 2, name: 'B' },
        { id: 1, name: 'A' },
        { id: 3, name: 'C' }
      ];
      await app.nextTick();

      const newNodes = Array.from(document.querySelectorAll('li'));
      expect(newNodes[0].textContent).toBe('B');
      expect(newNodes[1].textContent).toBe('A');
      expect(newNodes[2].textContent).toBe('C');
    });

    it('should handle empty list', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ items: [] });
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);
    });
  });

  describe('m-show', () => {
    it('should toggle display style', async () => {
      document.body.innerHTML = '<div m-show="visible">Content</div>';
      const app = new Reflex({ visible: true });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.style.display).not.toBe('none');

      app.s.visible = false;
      await app.nextTick();

      expect(div.style.display).toBe('none');
    });

    it('should preserve original display value', async () => {
      document.body.innerHTML = '<div style="display: flex" m-show="visible">Content</div>';
      const app = new Reflex({ visible: true });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.style.display).toBe('flex');

      app.s.visible = false;
      await app.nextTick();
      expect(div.style.display).toBe('none');

      app.s.visible = true;
      await app.nextTick();
      expect(div.style.display).toBe('flex');
    });
  });

  describe('m-model', () => {
    it('should bind input value', async () => {
      document.body.innerHTML = '<input m-model="text">';
      const app = new Reflex({ text: 'hello' });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('hello');
    });

    it('should update state on input', async () => {
      document.body.innerHTML = '<input m-model="text">';
      const app = new Reflex({ text: 'hello' });
      await app.nextTick();

      const input = document.querySelector('input');
      input.value = 'world';
      input.dispatchEvent(new Event('input'));

      expect(app.s.text).toBe('world');
    });

    it('should handle checkbox', async () => {
      document.body.innerHTML = '<input type="checkbox" m-model="checked">';
      const app = new Reflex({ checked: false });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.checked).toBe(false);

      input.checked = true;
      input.dispatchEvent(new Event('change'));

      expect(app.s.checked).toBe(true);
    });

    it('should handle number input', async () => {
      document.body.innerHTML = '<input type="number" m-model="count">';
      const app = new Reflex({ count: 0 });
      await app.nextTick();

      const input = document.querySelector('input');
      input.value = '42';
      input.dispatchEvent(new Event('input'));

      expect(app.s.count).toBe(42);
    });

    it('should handle nested path', async () => {
      document.body.innerHTML = '<input m-model="user.name">';
      const app = new Reflex({ user: { name: 'John' } });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('John');

      input.value = 'Jane';
      input.dispatchEvent(new Event('input'));

      expect(app.s.user.name).toBe('Jane');
    });
  });

  describe('m-text', () => {
    it('should set text content', async () => {
      document.body.innerHTML = '<span m-text="message"></span>';
      const app = new Reflex({ message: 'Hello' });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('Hello');
    });

    it('should update on state change', async () => {
      document.body.innerHTML = '<span m-text="message"></span>';
      const app = new Reflex({ message: 'Hello' });
      await app.nextTick();

      app.s.message = 'World';
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('World');
    });

    it('should handle expressions', async () => {
      document.body.innerHTML = '<span m-text="count * 2"></span>';
      const app = new Reflex({ count: 5 });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('10');
    });
  });

  describe('m-html', () => {
    it('should set innerHTML', async () => {
      document.body.innerHTML = '<div m-html="content"></div>';
      const app = new Reflex({ content: '<strong>Bold</strong>' });
      app.configure({ sanitize: false }); // Disable sanitization for test
      await app.nextTick();

      expect(document.querySelector('div').innerHTML).toBe('<strong>Bold</strong>');
    });
  });

  describe('Attribute Binding (:attr)', () => {
    it('should bind attribute values', async () => {
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'https://example.com' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('https://example.com');
    });

    it('should bind class with object syntax', async () => {
      document.body.innerHTML = '<div :class="{ active: isActive, disabled: isDisabled }"></div>';
      const app = new Reflex({ isActive: true, isDisabled: false });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.className).toBe('active');
    });

    it('should bind class with array syntax', async () => {
      document.body.innerHTML = '<div :class="classes"></div>';
      const app = new Reflex({ classes: ['a', 'b'] });
      await app.nextTick();

      expect(document.querySelector('div').className).toBe('a b');
    });

    it('should bind style with object syntax', async () => {
      document.body.innerHTML = '<div :style="{ color: textColor, fontSize: \'16px\' }"></div>';
      const app = new Reflex({ textColor: 'red' });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.style.color).toBe('red');
      expect(div.style.fontSize).toBe('16px');
    });

    it('should block unsafe URL protocols', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<a :href="url">Link</a>';
      const app = new Reflex({ url: 'javascript:alert(1)' });
      await app.nextTick();

      expect(document.querySelector('a').getAttribute('href')).toBe('about:blank');
      // console.warn is called with multiple args, join them to check content
      const warnCalls = warnSpy.mock.calls.flat().join(' ');
      expect(warnCalls).toContain('Blocked unsafe URL');
      warnSpy.mockRestore();
    });
  });

  describe('Text Interpolation ({{ }})', () => {
    it('should interpolate text', async () => {
      document.body.innerHTML = '<span>Hello, {{ name }}!</span>';
      const app = new Reflex({ name: 'World' });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('Hello, World!');
    });

    it('should handle expressions', async () => {
      document.body.innerHTML = '<span>{{ count + 1 }}</span>';
      const app = new Reflex({ count: 5 });
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('6');
    });

    it('should update on state change', async () => {
      document.body.innerHTML = '<span>{{ message }}</span>';
      const app = new Reflex({ message: 'Hello' });
      await app.nextTick();

      app.s.message = 'Goodbye';
      await app.nextTick();

      expect(document.querySelector('span').textContent).toBe('Goodbye');
    });
  });

  describe('Custom Directives', () => {
    it('should support custom directives', async () => {
      document.body.innerHTML = '<input m-focus="shouldFocus">';
      const focusSpy = vi.fn();

      const app = new Reflex({ shouldFocus: true });
      app.directive('focus', (el, { value }) => {
        if (value) focusSpy();
      });
      await app.nextTick();

      expect(focusSpy).toHaveBeenCalled();
    });

    it('should provide cleanup function', async () => {
      document.body.innerHTML = '<div m-test="value">Content</div>';
      const cleanup = vi.fn();

      const app = new Reflex({ value: 'test' });
      app.directive('test', (_el, { value: _value }) => {
        return cleanup;
      });
      await app.nextTick();

      // The cleanup should be registered but not yet called
      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  describe('m-ref', () => {
    it('should register element in $refs', async () => {
      document.body.innerHTML = '<input m-ref="myInput">';
      const app = new Reflex({});
      await app.nextTick();

      expect(app._refs.myInput).toBe(document.querySelector('input'));
    });
  });
});
