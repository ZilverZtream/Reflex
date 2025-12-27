/**
 * Directive Composition Matrix
 *
 * Verifies that directives play nicely together, fixing the m-if + m-for
 * class of bugs and ensuring proper interaction between all directive types.
 *
 * POLICY: Fix the Code, Not the Test.
 * Directive composition bugs indicate architectural issues in the framework.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Directive Composition', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Structural Conflict', () => {
    it('should update m-text only when m-if is visible', async () => {
      document.body.innerHTML = '<div m-if="show" m-text="message"></div>';
      const app = new Reflex({ show: false, message: 'Hello' });
      await app.nextTick();

      // Element should not exist
      expect(document.querySelector('div')).toBeNull();

      // Change message while hidden
      app.s.message = 'Updated';
      await app.nextTick();

      // Still hidden
      expect(document.querySelector('div')).toBeNull();

      // Show element
      app.s.show = true;
      await app.nextTick();

      // Should show updated message
      const div = document.querySelector('div');
      expect(div).not.toBeNull();
      expect(div.textContent).toBe('Updated');

      // Update while visible
      app.s.message = 'Visible Update';
      await app.nextTick();
      expect(div.textContent).toBe('Visible Update');
    });

    it('should handle m-if + m-show combination', async () => {
      document.body.innerHTML = '<div m-if="exists" m-show="visible">Content</div>';
      const app = new Reflex({ exists: true, visible: false });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div).not.toBeNull(); // m-if is true, so element exists
      expect(div.style.display).toBe('none'); // m-show is false, so it's hidden

      // Show it
      app.s.visible = true;
      await app.nextTick();
      expect(div.style.display).not.toBe('none');

      // Remove it
      app.s.exists = false;
      await app.nextTick();
      expect(document.querySelector('div')).toBeNull();
    });

    it('should handle m-for with m-text on same element', async () => {
      document.body.innerHTML = '<ul><li m-for="item in items" m-text="item.name"></li></ul>';
      const app = new Reflex({
        items: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Charlie' }
        ]
      });
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(3);
      expect(lis[0].textContent).toBe('Alice');
      expect(lis[1].textContent).toBe('Bob');
      expect(lis[2].textContent).toBe('Charlie');

      // Update one item
      app.s.items[1].name = 'Robert';
      await app.nextTick();

      expect(lis[1].textContent).toBe('Robert');
    });

    it('should handle m-for with m-model for two-way binding in loop', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="item in items" m-key="item.id">
            <input m-model="item.value">
          </li>
        </ul>
      `;
      const app = new Reflex({
        items: [
          { id: 1, value: 'a' },
          { id: 2, value: 'b' },
          { id: 3, value: 'c' }
        ]
      });
      await app.nextTick();

      const inputs = document.querySelectorAll('input');
      expect(inputs.length).toBe(3);
      expect(inputs[0].value).toBe('a');
      expect(inputs[1].value).toBe('b');
      expect(inputs[2].value).toBe('c');

      // User edits second input
      inputs[1].value = 'modified';
      inputs[1].dispatchEvent(new Event('input'));

      expect(app.s.items[1].value).toBe('modified');

      // Programmatic update
      app.s.items[2].value = 'updated';
      await app.nextTick();

      expect(inputs[2].value).toBe('updated');
    });

    it('should handle m-for + m-if on same element', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="item in items" m-if="item.active" m-text="item.name"></li>
        </ul>
      `;
      const app = new Reflex({
        items: [
          { name: 'Alice', active: true },
          { name: 'Bob', active: false },
          { name: 'Charlie', active: true }
        ]
      });
      await app.nextTick();

      // Only active items should render
      const lis = document.querySelectorAll('li');
      expect(lis.length).toBe(2);
      expect(lis[0].textContent).toBe('Alice');
      expect(lis[1].textContent).toBe('Charlie');

      // Toggle Bob to active
      app.s.items[1].active = true;
      await app.nextTick();

      const updatedLis = document.querySelectorAll('li');
      expect(updatedLis.length).toBe(3);
      expect(updatedLis[1].textContent).toBe('Bob');
    });

    it('should handle nested m-for with inner m-if', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="group in groups">
            <span m-for="item in group.items" m-if="item.show" m-text="item.name"></span>
          </li>
        </ul>
      `;
      const app = new Reflex({
        groups: [
          {
            items: [
              { name: 'A', show: true },
              { name: 'B', show: false }
            ]
          },
          {
            items: [
              { name: 'C', show: true },
              { name: 'D', show: true }
            ]
          }
        ]
      });
      await app.nextTick();

      const spans = document.querySelectorAll('span');
      expect(spans.length).toBe(3); // A, C, D
      expect(spans[0].textContent).toBe('A');
      expect(spans[1].textContent).toBe('C');
      expect(spans[2].textContent).toBe('D');

      // Show B
      app.s.groups[0].items[1].show = true;
      await app.nextTick();

      const updatedSpans = document.querySelectorAll('span');
      expect(updatedSpans.length).toBe(4);
    });

    it('should handle m-html with m-if', async () => {
      document.body.innerHTML = '<div m-if="show" m-html="content"></div>';
      const app = new Reflex({ show: false, content: '<strong>Bold</strong>' });
      app.configure({ sanitize: false });
      await app.nextTick();

      expect(document.querySelector('div')).toBeNull();

      app.s.show = true;
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.innerHTML).toBe('<strong>Bold</strong>');
    });
  });

  describe('Event Modifier Chaining', () => {
    it('should handle @click.stop.prevent.once - all three modifiers', async () => {
      document.body.innerHTML = `
        <div id="parent">
          <button id="child" @click.stop.prevent.once="onClick">Click</button>
        </div>
      `;

      let clickCount = 0;
      let parentClicked = false;

      const app = new Reflex({
        onClick(event) {
          clickCount++;
        }
      });

      // Add listener to parent to test stop propagation
      const parent = document.getElementById('parent');
      parent.addEventListener('click', () => {
        parentClicked = true;
      });

      await app.nextTick();

      const button = document.getElementById('child');

      // First click
      const event1 = new MouseEvent('click', { bubbles: true, cancelable: true });
      button.dispatchEvent(event1);

      // .stop: event should not bubble to parent
      expect(parentClicked).toBe(false);

      // .prevent: default should be prevented
      expect(event1.defaultPrevented).toBe(true);

      // .once: handler should be called
      expect(clickCount).toBe(1);

      // Second click - .once should prevent handler from running again
      const event2 = new MouseEvent('click', { bubbles: true, cancelable: true });
      button.dispatchEvent(event2);

      expect(clickCount).toBe(1); // Still 1, not 2
    });

    it('should handle @click.prevent - prevents default action', async () => {
      document.body.innerHTML = '<a href="#" @click.prevent="onClick">Link</a>';

      const app = new Reflex({
        onClick() {}
      });
      await app.nextTick();

      const link = document.querySelector('a');
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it('should handle @click.stop - stops propagation', async () => {
      document.body.innerHTML = `
        <div id="parent">
          <button @click.stop="onChildClick">Child</button>
        </div>
      `;

      let parentClicked = false;

      const app = new Reflex({
        onChildClick() {}
      });

      const parent = document.getElementById('parent');
      parent.addEventListener('click', () => {
        parentClicked = true;
      });

      await app.nextTick();

      const button = document.querySelector('button');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(parentClicked).toBe(false);
    });

    it('should handle @keydown.enter modifier', async () => {
      document.body.innerHTML = '<input @keydown.enter="onEnter">';

      let enterPressed = false;

      const app = new Reflex({
        onEnter() {
          enterPressed = true;
        }
      });
      await app.nextTick();

      const input = document.querySelector('input');

      // Press Enter
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      input.dispatchEvent(enterEvent);

      expect(enterPressed).toBe(true);

      // Press other key
      enterPressed = false;
      const otherEvent = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
      input.dispatchEvent(otherEvent);

      expect(enterPressed).toBe(false); // Should not trigger
    });

    it('should handle @keydown.ctrl.enter - combined key modifiers', async () => {
      document.body.innerHTML = '<input @keydown.ctrl.enter="onCtrlEnter">';

      let triggered = false;

      const app = new Reflex({
        onCtrlEnter() {
          triggered = true;
        }
      });
      await app.nextTick();

      const input = document.querySelector('input');

      // Ctrl+Enter
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true
      });
      input.dispatchEvent(event);

      expect(triggered).toBe(true);

      // Just Enter without Ctrl
      triggered = false;
      const enterOnly = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: false,
        bubbles: true
      });
      input.dispatchEvent(enterOnly);

      expect(triggered).toBe(false);
    });

    it('should handle @click.self - only trigger when event target is element itself', async () => {
      document.body.innerHTML = `
        <div id="container" @click.self="onSelfClick">
          <button id="child">Child</button>
        </div>
      `;

      let selfClicked = false;

      const app = new Reflex({
        onSelfClick() {
          selfClicked = true;
        }
      });
      await app.nextTick();

      const container = document.getElementById('container');
      const child = document.getElementById('child');

      // Click on child - should not trigger
      child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(selfClicked).toBe(false);

      // Click on container itself - should trigger
      container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(selfClicked).toBe(true);
    });

    it('should handle @mouseover.passive modifier', async () => {
      document.body.innerHTML = '<div @mouseover.passive="onHover">Hover</div>';

      const app = new Reflex({
        onHover() {}
      });
      await app.nextTick();

      // Passive modifier should be applied to event listener
      // This is hard to test directly, but we verify no errors occur
      const div = document.querySelector('div');
      div.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  });

  describe('Transition Interruption', () => {
    it('should gracefully handle interrupting enter transition with leave', async () => {
      document.body.innerHTML = `
        <div m-if="show" m-transition-enter="fade-enter" m-transition-leave="fade-leave">
          Content
        </div>
      `;

      const app = new Reflex({ show: false });
      await app.nextTick();

      // Start enter transition
      app.s.show = true;
      await app.nextTick();

      // Element should be in DOM (or entering)
      let div = document.querySelector('div');
      expect(div).not.toBeNull();

      // Interrupt with leave before enter completes
      app.s.show = false;
      await app.nextTick();

      // Should gracefully handle the interruption
      // Element should either be leaving or already gone
      // No errors should occur
    });

    it('should handle rapid transition toggles', async () => {
      document.body.innerHTML = `
        <div m-if="visible" m-transition-enter="fade-in" m-transition-leave="fade-out">
          Animated
        </div>
      `;

      const app = new Reflex({ visible: false });

      // Rapidly toggle
      for (let i = 0; i < 10; i++) {
        app.s.visible = !app.s.visible;
        await app.nextTick();
      }

      // Should end in consistent state
      if (app.s.visible) {
        expect(document.querySelector('div')).not.toBeNull();
      } else {
        expect(document.querySelector('div')).toBeNull();
      }
    });
  });

  describe('Attribute Binding Composition', () => {
    it('should handle :class with m-for', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="item in items" :class="{ active: item.active }" m-text="item.name"></li>
        </ul>
      `;
      const app = new Reflex({
        items: [
          { name: 'A', active: true },
          { name: 'B', active: false },
          { name: 'C', active: true }
        ]
      });
      await app.nextTick();

      const lis = document.querySelectorAll('li');
      expect(lis[0].className).toBe('active');
      expect(lis[1].className).toBe('');
      expect(lis[2].className).toBe('active');

      // Toggle active state
      app.s.items[1].active = true;
      await app.nextTick();

      expect(lis[1].className).toBe('active');
    });

    it('should handle :style with m-for', async () => {
      document.body.innerHTML = `
        <div m-for="item in items" :style="{ color: item.color }"></div>
      `;
      const app = new Reflex({
        items: [
          { color: 'red' },
          { color: 'blue' },
          { color: 'green' }
        ]
      });
      await app.nextTick();

      const divs = document.querySelectorAll('div');
      expect(divs[0].style.color).toBe('red');
      expect(divs[1].style.color).toBe('blue');
      expect(divs[2].style.color).toBe('green');

      // Update color
      app.s.items[1].color = 'yellow';
      await app.nextTick();

      expect(divs[1].style.color).toBe('yellow');
    });

    it('should handle multiple :attributes with m-if', async () => {
      document.body.innerHTML = `
        <a m-if="show" :href="url" :title="tooltip" :class="linkClass">Link</a>
      `;
      const app = new Reflex({
        show: true,
        url: 'https://example.com',
        tooltip: 'Example Site',
        linkClass: 'external'
      });
      await app.nextTick();

      const link = document.querySelector('a');
      expect(link.getAttribute('href')).toBe('https://example.com');
      expect(link.getAttribute('title')).toBe('Example Site');
      expect(link.className).toBe('external');

      // Update attributes
      app.s.url = 'https://newsite.com';
      app.s.linkClass = 'internal';
      await app.nextTick();

      expect(link.getAttribute('href')).toBe('https://newsite.com');
      expect(link.className).toBe('internal');
    });
  });

  describe('Event Handlers with Structural Directives', () => {
    it('should handle @click with m-for', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="item in items" @click="selectItem(item)" m-text="item.name"></li>
        </ul>
      `;

      let selected = null;

      const app = new Reflex({
        items: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
          { id: 3, name: 'Item 3' }
        ],
        selectItem(item) {
          selected = item;
        }
      });
      await app.nextTick();

      const lis = document.querySelectorAll('li');

      // Click second item
      lis[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(selected).toEqual({ id: 2, name: 'Item 2' });
    });

    it('should handle @click with m-if toggling', async () => {
      document.body.innerHTML = `
        <button m-if="showButton" @click="handleClick">Click Me</button>
      `;

      let clickCount = 0;

      const app = new Reflex({
        showButton: true,
        handleClick() {
          clickCount++;
        }
      });
      await app.nextTick();

      let button = document.querySelector('button');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(clickCount).toBe(1);

      // Hide and show
      app.s.showButton = false;
      await app.nextTick();
      app.s.showButton = true;
      await app.nextTick();

      // Click again
      button = document.querySelector('button');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(clickCount).toBe(2);
    });
  });

  describe('Complex Nested Compositions', () => {
    it('should handle m-for > m-if > m-text with events', async () => {
      document.body.innerHTML = `
        <ul>
          <li m-for="group in groups">
            <div m-if="group.visible">
              <span m-text="group.name" @click="selectGroup(group)"></span>
            </div>
          </li>
        </ul>
      `;

      let selectedGroup = null;

      const app = new Reflex({
        groups: [
          { id: 1, name: 'Group A', visible: true },
          { id: 2, name: 'Group B', visible: false },
          { id: 3, name: 'Group C', visible: true }
        ],
        selectGroup(group) {
          selectedGroup = group;
        }
      });
      await app.nextTick();

      const spans = document.querySelectorAll('span');
      expect(spans.length).toBe(2); // Only visible groups

      // Click first visible group
      spans[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(selectedGroup.id).toBe(1);

      // Make Group B visible
      app.s.groups[1].visible = true;
      await app.nextTick();

      const updatedSpans = document.querySelectorAll('span');
      expect(updatedSpans.length).toBe(3);
      expect(updatedSpans[1].textContent).toBe('Group B');
    });

    it('should handle deeply nested directive combinations', async () => {
      document.body.innerHTML = `
        <div m-if="showContainer">
          <ul m-show="showList">
            <li m-for="item in items" m-key="item.id">
              <input m-model="item.value" :disabled="item.locked" @input="onItemChange(item)">
              <span m-text="item.label" :class="{ highlight: item.important }"></span>
            </li>
          </ul>
        </div>
      `;

      const changes = [];

      const app = new Reflex({
        showContainer: true,
        showList: true,
        items: [
          { id: 1, value: 'a', label: 'First', locked: false, important: true },
          { id: 2, value: 'b', label: 'Second', locked: true, important: false }
        ],
        onItemChange(item) {
          changes.push(item.id);
        }
      });
      await app.nextTick();

      const inputs = document.querySelectorAll('input');
      const spans = document.querySelectorAll('span');

      expect(inputs.length).toBe(2);
      expect(inputs[0].disabled).toBe(false);
      expect(inputs[1].disabled).toBe(true);
      expect(spans[0].className).toBe('highlight');
      expect(spans[1].className).toBe('');

      // Change first item
      inputs[0].value = 'modified';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));

      expect(app.s.items[0].value).toBe('modified');
      expect(changes).toContain(1);

      // Hide list
      app.s.showList = false;
      await app.nextTick();

      expect(document.querySelector('ul').style.display).toBe('none');

      // Hide container
      app.s.showContainer = false;
      await app.nextTick();

      expect(document.querySelector('div')).toBeNull();
    });
  });

  describe('m-ref with other directives', () => {
    it('should handle m-ref with m-for', async () => {
      document.body.innerHTML = `
        <div m-for="item in items" m-ref="item-ref">Item</div>
      `;
      const app = new Reflex({
        items: [1, 2, 3]
      });
      await app.nextTick();

      // m-ref in m-for typically captures the last item
      // or creates an array of refs (implementation dependent)
      // Just verify no errors
      expect(document.querySelectorAll('div').length).toBe(3);
    });

    it('should handle m-ref with m-if', async () => {
      document.body.innerHTML = '<div m-if="show" m-ref="myDiv">Content</div>';
      const app = new Reflex({ show: false });
      await app.nextTick();

      expect(app._refs.myDiv).toBeUndefined();

      app.s.show = true;
      await app.nextTick();

      expect(app._refs.myDiv).toBeDefined();
      expect(app._refs.myDiv.tagName).toBe('DIV');
    });
  });
});
