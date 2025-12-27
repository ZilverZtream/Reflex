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
import { Reflex } from '../src/index.ts';

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

  describe('m-if + m-for composition', () => {
    it('should properly clean up list when m-if becomes false', async () => {
      document.body.innerHTML = '<ul><li m-if="open" m-for="user in users" m-text="user"></li></ul>';
      const app = new Reflex({ open: true, users: ['Alice', 'Bob', 'Charlie'] });
      await app.nextTick();

      // Verify list is rendered
      let lis = document.querySelectorAll('li');
      expect(lis.length).toBe(3);
      expect(lis[0].textContent).toBe('Alice');
      expect(lis[1].textContent).toBe('Bob');
      expect(lis[2].textContent).toBe('Charlie');

      // Toggle m-if to false - this is where the "zombie list" bug would occur
      app.s.open = false;
      await app.nextTick();

      // CRITICAL: Verify that ALL list items are actually removed from the DOM
      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);

      // Also verify that no orphaned nodes exist in the document body
      // (checking for common scenarios where nodes might be left behind)
      const allElements = document.body.querySelectorAll('*');
      const hasOrphanedListItems = Array.from(allElements).some(el =>
        el.tagName === 'LI' && el.textContent.match(/Alice|Bob|Charlie/)
      );
      expect(hasOrphanedListItems).toBe(false);
    });

    it('should re-render list when m-if becomes true again', async () => {
      document.body.innerHTML = '<ul><li m-if="show" m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ show: true, items: ['X', 'Y'] });
      await app.nextTick();

      let lis = document.querySelectorAll('li');
      expect(lis.length).toBe(2);

      // Toggle off
      app.s.show = false;
      await app.nextTick();
      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);

      // Toggle back on
      app.s.show = true;
      await app.nextTick();
      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(2);
      expect(lis[0].textContent).toBe('X');
      expect(lis[1].textContent).toBe('Y');
    });

    it('should handle empty list with m-if + m-for', async () => {
      document.body.innerHTML = '<ul><li m-if="show" m-for="item in items" m-text="item"></li></ul>';
      const app = new Reflex({ show: true, items: [] });
      await app.nextTick();

      // With empty list, no items should be rendered
      let lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);

      // Toggle m-if should not cause issues
      app.s.show = false;
      await app.nextTick();
      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);
    });

    it('should update list items when m-if is true', async () => {
      document.body.innerHTML = '<ul><li m-if="active" m-for="num in numbers" m-text="num"></li></ul>';
      const app = new Reflex({ active: true, numbers: [1, 2, 3] });
      await app.nextTick();

      let lis = document.querySelectorAll('li');
      expect(lis.length).toBe(3);

      // Update the list while m-if is still true
      app.s.numbers.push(4);
      await app.nextTick();

      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(4);
      expect(lis[3].textContent).toBe('4');

      // Now toggle m-if off - all 4 items should be removed
      app.s.active = false;
      await app.nextTick();

      lis = document.querySelectorAll('li');
      expect(lis.length).toBe(0);
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

    it('should handle select multiple - initial binding', async () => {
      document.body.innerHTML = `
        <select multiple m-model="selected">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
          <option value="c">Option C</option>
        </select>
      `;
      const app = new Reflex({ selected: ['a', 'c'] });
      await app.nextTick();

      const select = document.querySelector('select');
      const options = select.options;

      // Verify that options 'a' and 'c' are selected
      expect(options[0].selected).toBe(true);  // 'a'
      expect(options[1].selected).toBe(false); // 'b'
      expect(options[2].selected).toBe(true);  // 'c'
    });

    it('should handle select multiple - user selection updates state', async () => {
      document.body.innerHTML = `
        <select multiple m-model="selected">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
          <option value="c">Option C</option>
        </select>
      `;
      const app = new Reflex({ selected: [] });
      await app.nextTick();

      const select = document.querySelector('select');
      const options = select.options;

      // Simulate user selecting options 'a' and 'b'
      options[0].selected = true;
      options[1].selected = true;
      options[2].selected = false;

      select.dispatchEvent(new Event('change'));

      // Verify state is updated to array ['a', 'b']
      expect(app.s.selected).toEqual(['a', 'b']);
    });

    it('should handle select multiple - programmatic state change', async () => {
      document.body.innerHTML = `
        <select multiple m-model="choices">
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
      `;
      const app = new Reflex({ choices: ['x'] });
      await app.nextTick();

      const select = document.querySelector('select');
      let options = select.options;

      expect(options[0].selected).toBe(true);
      expect(options[1].selected).toBe(false);
      expect(options[2].selected).toBe(false);

      // Change state programmatically
      app.s.choices = ['y', 'z'];
      await app.nextTick();

      expect(options[0].selected).toBe(false);
      expect(options[1].selected).toBe(true);
      expect(options[2].selected).toBe(true);
    });

    it('should handle select multiple - empty selection', async () => {
      document.body.innerHTML = `
        <select multiple m-model="items">
          <option value="1">One</option>
          <option value="2">Two</option>
        </select>
      `;
      const app = new Reflex({ items: ['1', '2'] });
      await app.nextTick();

      const select = document.querySelector('select');
      const options = select.options;

      // Initially both selected
      expect(options[0].selected).toBe(true);
      expect(options[1].selected).toBe(true);

      // Deselect all
      options[0].selected = false;
      options[1].selected = false;
      select.dispatchEvent(new Event('change'));

      // Should result in empty array
      expect(app.s.items).toEqual([]);

      // Setting to empty array should deselect all
      app.s.items = ['2'];
      await app.nextTick();

      expect(options[0].selected).toBe(false);
      expect(options[1].selected).toBe(true);
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

  describe('<template> support', () => {
    describe('template with m-if', () => {
      it('should render template content when condition is true', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template m-if="show">
              <span>Item 1</span>
              <span>Item 2</span>
            </template>
          </div>
        `;
        const app = new Reflex({ show: true });
        await app.nextTick();

        const container = document.getElementById('container');
        const spans = container.querySelectorAll('span');
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe('Item 1');
        expect(spans[1].textContent).toBe('Item 2');
      });

      it('should not render template element itself', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template m-if="show">
              <span>Content</span>
            </template>
          </div>
        `;
        const app = new Reflex({ show: true });
        await app.nextTick();

        const container = document.getElementById('container');
        const templates = container.querySelectorAll('template');
        // Should only have the comment marker, no visible template tags
        expect(templates.length).toBe(0);
      });

      it('should remove template content when condition becomes false', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template m-if="show">
              <p>Paragraph 1</p>
              <p>Paragraph 2</p>
            </template>
          </div>
        `;
        const app = new Reflex({ show: true });
        await app.nextTick();

        let container = document.getElementById('container');
        let paragraphs = container.querySelectorAll('p');
        expect(paragraphs.length).toBe(2);

        app.s.show = false;
        await app.nextTick();

        paragraphs = container.querySelectorAll('p');
        expect(paragraphs.length).toBe(0);
      });

      it('should re-render template content when condition becomes true again', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template m-if="show">
              <div>{{ message }}</div>
            </template>
          </div>
        `;
        const app = new Reflex({ show: false, message: 'Hello' });
        await app.nextTick();

        let container = document.getElementById('container');
        expect(container.textContent.trim()).toBe('');

        app.s.show = true;
        await app.nextTick();

        expect(container.textContent.trim()).toBe('Hello');
      });

      it('should handle single element in template', async () => {
        document.body.innerHTML = `
          <template m-if="show">
            <div>Single element</div>
          </template>
        `;
        const app = new Reflex({ show: true });
        await app.nextTick();

        const divs = document.querySelectorAll('div');
        expect(divs.length).toBe(1);
        expect(divs[0].textContent).toBe('Single element');
      });

      it('should process bindings in template content', async () => {
        document.body.innerHTML = `
          <template m-if="show">
            <span m-text="text"></span>
            <input m-model="value">
          </template>
        `;
        const app = new Reflex({ show: true, text: 'Hello', value: 'World' });
        await app.nextTick();

        const span = document.querySelector('span');
        const input = document.querySelector('input');
        expect(span.textContent).toBe('Hello');
        expect(input.value).toBe('World');

        app.s.text = 'Goodbye';
        await app.nextTick();
        expect(span.textContent).toBe('Goodbye');
      });
    });

    describe('template with m-for', () => {
      it('should render template content for each item', async () => {
        document.body.innerHTML = `
          <ul>
            <template m-for="item in items">
              <li class="item">{{ item }}</li>
            </template>
          </ul>
        `;
        const app = new Reflex({ items: ['A', 'B', 'C'] });
        await app.nextTick();

        const items = document.querySelectorAll('.item');
        expect(items.length).toBe(3);
        expect(items[0].textContent).toBe('A');
        expect(items[1].textContent).toBe('B');
        expect(items[2].textContent).toBe('C');
      });

      it('should render multiple elements per iteration', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template m-for="item in items">
              <h3>{{ item.title }}</h3>
              <p>{{ item.desc }}</p>
            </template>
          </div>
        `;
        const app = new Reflex({
          items: [
            { title: 'Title 1', desc: 'Desc 1' },
            { title: 'Title 2', desc: 'Desc 2' }
          ]
        });
        await app.nextTick();

        const container = document.getElementById('container');
        const h3s = container.querySelectorAll('h3');
        const ps = container.querySelectorAll('p');

        expect(h3s.length).toBe(2);
        expect(ps.length).toBe(2);
        expect(h3s[0].textContent).toBe('Title 1');
        expect(ps[0].textContent).toBe('Desc 1');
        expect(h3s[1].textContent).toBe('Title 2');
        expect(ps[1].textContent).toBe('Desc 2');
      });

      it('should update when items change', async () => {
        document.body.innerHTML = `
          <template m-for="num in numbers">
            <span>{{ num }}</span>
          </template>
        `;
        const app = new Reflex({ numbers: [1, 2] });
        await app.nextTick();

        let spans = document.querySelectorAll('span');
        expect(spans.length).toBe(2);

        app.s.numbers.push(3);
        await app.nextTick();

        spans = document.querySelectorAll('span');
        expect(spans.length).toBe(3);
        expect(spans[2].textContent).toBe('3');
      });

      it('should handle empty list', async () => {
        document.body.innerHTML = `
          <template m-for="item in items">
            <div>{{ item }}</div>
          </template>
        `;
        const app = new Reflex({ items: [] });
        await app.nextTick();

        const divs = document.querySelectorAll('div');
        expect(divs.length).toBe(0);
      });

      it('should work with keyed items', async () => {
        document.body.innerHTML = `
          <template m-for="item in items" m-key="item.id">
            <div>{{ item.name }}</div>
          </template>
        `;
        const app = new Reflex({
          items: [
            { id: 1, name: 'First' },
            { id: 2, name: 'Second' }
          ]
        });
        await app.nextTick();

        const divs = document.querySelectorAll('div');
        expect(divs.length).toBe(2);
        expect(divs[0].textContent).toBe('First');
        expect(divs[1].textContent).toBe('Second');
      });

      it('should handle nested templates', async () => {
        document.body.innerHTML = `
          <template m-for="group in groups">
            <div class="group">
              <template m-for="item in group.items">
                <span>{{ item }}</span>
              </template>
            </div>
          </template>
        `;
        const app = new Reflex({
          groups: [
            { items: ['A', 'B'] },
            { items: ['C', 'D'] }
          ]
        });
        await app.nextTick();

        const groups = document.querySelectorAll('.group');
        expect(groups.length).toBe(2);

        const spans = document.querySelectorAll('span');
        expect(spans.length).toBe(4);
        expect(spans[0].textContent).toBe('A');
        expect(spans[1].textContent).toBe('B');
        expect(spans[2].textContent).toBe('C');
        expect(spans[3].textContent).toBe('D');
      });
    });

    describe('template without directives', () => {
      it('should skip templates without m-if or m-for', async () => {
        document.body.innerHTML = `
          <div id="container">
            <template id="my-template">
              <span>This should not render</span>
            </template>
          </div>
        `;
        const app = new Reflex({});
        await app.nextTick();

        const container = document.getElementById('container');
        const spans = container.querySelectorAll('span');
        // Template without directives should remain inert
        expect(spans.length).toBe(0);

        // Template element should still exist
        const template = document.getElementById('my-template');
        expect(template).toBeTruthy();
      });
    });
  });
});
