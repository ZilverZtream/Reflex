/**
 * Browser Reality & DOM Quirks Suite
 *
 * Tests the messy reality of HTML inputs, SVGs, and legacy browser behaviors
 * that Alpine.js handles but Reflex must also support.
 *
 * POLICY: Fix the Code, Not the Test.
 * These tests are correct specifications. If a test fails, fix src/ code.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Browser Quirks', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('The "Input Type" Chaos', () => {
    it('should handle input[type="number"] with BadInput state', async () => {
      document.body.innerHTML = '<input type="number" m-model="num">';
      const app = new Reflex({ num: 0 });
      await app.nextTick();

      const input = document.querySelector('input');

      // Valid number input
      input.value = '42';
      input.dispatchEvent(new Event('input'));
      expect(app.s.num).toBe(42);

      // Invalid number input (e.g., "12e-" is in BadInput state)
      // The input validity API will report validity.badInput = true
      Object.defineProperty(input, 'validity', {
        value: { badInput: true },
        configurable: true
      });
      input.value = '12e-';
      input.dispatchEvent(new Event('input'));

      // When badInput is true, the framework should keep the previous valid value
      // or handle it gracefully (not crash, not set to NaN)
      expect(app.s.num).toBe(42); // Should not change from last valid value
    });

    it('should handle m-model on radio inputs with dynamic :value binding', async () => {
      document.body.innerHTML = `
        <div>
          <input type="radio" name="choice" m-model="selected" :value="items[0].id">
          <input type="radio" name="choice" m-model="selected" :value="items[1].id">
          <input type="radio" name="choice" m-model="selected" :value="items[2].id">
        </div>
      `;
      const app = new Reflex({
        selected: 'b',
        items: [
          { id: 'a', label: 'First' },
          { id: 'b', label: 'Second' },
          { id: 'c', label: 'Third' }
        ]
      });
      await app.nextTick();

      const radios = document.querySelectorAll('input[type="radio"]');

      // Verify the correct radio is checked based on model
      expect(radios[0].checked).toBe(false);
      expect(radios[1].checked).toBe(true); // selected = 'b'
      expect(radios[2].checked).toBe(false);

      // User selects a different radio
      radios[2].checked = true;
      radios[2].dispatchEvent(new Event('change', { bubbles: true }));

      // Model should update to the new value
      expect(app.s.selected).toBe('c');

      // Now change the dynamic value binding
      app.s.items[2].id = 'newC';
      await app.nextTick();

      // The radio should still be checked, but with new value
      expect(radios[2].getAttribute('value')).toBe('newC');
    });

    it('should handle select[multiple] - adding/removing single items', async () => {
      document.body.innerHTML = `
        <select multiple m-model="selected">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
          <option value="c">Option C</option>
          <option value="d">Option D</option>
        </select>
      `;
      const app = new Reflex({ selected: ['a', 'c'] });
      await app.nextTick();

      const select = document.querySelector('select');
      const options = select.options;

      // Verify initial selection
      expect(options[0].selected).toBe(true);  // 'a'
      expect(options[1].selected).toBe(false); // 'b'
      expect(options[2].selected).toBe(true);  // 'c'
      expect(options[3].selected).toBe(false); // 'd'

      // Add single item 'b' to selection
      app.s.selected.push('b');
      await app.nextTick();

      expect(options[1].selected).toBe(true);
      expect(app.s.selected).toEqual(['a', 'c', 'b']);

      // Remove single item 'c' from selection
      app.s.selected.splice(app.s.selected.indexOf('c'), 1);
      await app.nextTick();

      expect(options[2].selected).toBe(false);
      expect(app.s.selected).toEqual(['a', 'b']);
    });

    it('should handle m-model.lazy (update on change vs input)', async () => {
      document.body.innerHTML = `
        <div>
          <input m-model="normal" placeholder="normal">
          <input m-model.lazy="lazy" placeholder="lazy">
        </div>
      `;
      const app = new Reflex({ normal: '', lazy: '' });
      await app.nextTick();

      const [normalInput, lazyInput] = document.querySelectorAll('input');

      // Normal m-model updates on 'input' event
      normalInput.value = 'a';
      normalInput.dispatchEvent(new Event('input'));
      expect(app.s.normal).toBe('a');

      // Lazy m-model should NOT update on 'input' event
      lazyInput.value = 'b';
      lazyInput.dispatchEvent(new Event('input'));
      expect(app.s.lazy).toBe(''); // Still empty

      // Lazy m-model SHOULD update on 'change' event
      lazyInput.dispatchEvent(new Event('change'));
      expect(app.s.lazy).toBe('b'); // Now updated

      // Continue typing in normal input
      normalInput.value = 'abc';
      normalInput.dispatchEvent(new Event('input'));
      expect(app.s.normal).toBe('abc');

      // Lazy still doesn't update until change
      lazyInput.value = 'xyz';
      lazyInput.dispatchEvent(new Event('input'));
      expect(app.s.lazy).toBe('b'); // Still old value

      lazyInput.dispatchEvent(new Event('change'));
      expect(app.s.lazy).toBe('xyz'); // Now updated
    });
  });

  describe('SVG & Namespace Handling', () => {
    it('should handle dynamic classes on SVG elements', async () => {
      document.body.innerHTML = `
        <svg>
          <path :class="pathClass" d="M 10 10"></path>
        </svg>
      `;
      const app = new Reflex({ pathClass: 'active' });
      await app.nextTick();

      const path = document.querySelector('path');

      // SVG elements use className differently (SVGAnimatedString)
      // Reflex should handle this correctly
      expect(path.getAttribute('class')).toBe('active');

      app.s.pathClass = 'inactive';
      await app.nextTick();

      expect(path.getAttribute('class')).toBe('inactive');
    });

    it('should handle dynamic classes with object syntax on SVG', async () => {
      document.body.innerHTML = `
        <svg>
          <circle :class="{ highlighted: isActive, dimmed: !isActive }" r="5"></circle>
        </svg>
      `;
      const app = new Reflex({ isActive: true });
      await app.nextTick();

      const circle = document.querySelector('circle');
      expect(circle.getAttribute('class')).toBe('highlighted');

      app.s.isActive = false;
      await app.nextTick();

      expect(circle.getAttribute('class')).toBe('dimmed');
    });

    it('should handle camelCase vs kebab-case attribute binding on SVG (viewBox)', async () => {
      document.body.innerHTML = `
        <svg :viewBox="box">
          <rect></rect>
        </svg>
      `;
      const app = new Reflex({ box: '0 0 100 100' });
      await app.nextTick();

      const svg = document.querySelector('svg');

      // SVG attributes are case-sensitive: 'viewBox' not 'viewbox'
      expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');

      app.s.box = '0 0 200 200';
      await app.nextTick();

      expect(svg.getAttribute('viewBox')).toBe('0 0 200 200');
    });

    it('should handle kebab-case version :view-box binding', async () => {
      document.body.innerHTML = `
        <svg :view-box="viewport">
          <rect></rect>
        </svg>
      `;
      const app = new Reflex({ viewport: '0 0 50 50' });
      await app.nextTick();

      const svg = document.querySelector('svg');

      // When using kebab-case :view-box, it should be converted to viewBox
      expect(svg.getAttribute('viewBox')).toBe('0 0 50 50');
    });
  });

  describe('The "ContentEditable" Trap', () => {
    it('should handle m-text on contenteditable without cursor jump', async () => {
      document.body.innerHTML = '<div contenteditable="true" m-text="content"></div>';
      const app = new Reflex({ content: 'Hello' });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.textContent).toBe('Hello');

      // Simulate user typing - in real contenteditable, this is complex
      // but for testing, we verify that programmatic updates don't break
      app.s.content = 'Hello World';
      await app.nextTick();

      expect(div.textContent).toBe('Hello World');

      // Ensure the element is still editable
      expect(div.getAttribute('contenteditable')).toBe('true');
    });

    it('should update contenteditable reactively without destroying selection', async () => {
      // This test verifies that updates to contenteditable don't reset cursor
      document.body.innerHTML = '<div contenteditable="true">{{ message }}</div>';
      const app = new Reflex({ message: 'Type here' });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.textContent).toBe('Type here');

      // Update the message - in a real scenario, this should preserve cursor
      // For this test, we just verify it doesn't throw and updates correctly
      app.s.message = 'Updated text';
      await app.nextTick();

      expect(div.textContent).toBe('Updated text');
      // Check attribute is preserved (isContentEditable is not reliable in happy-dom)
      expect(div.getAttribute('contenteditable')).toBe('true');
    });

    it('should handle contenteditable with nested elements', async () => {
      document.body.innerHTML = `
        <div contenteditable="true">
          <span m-text="part1"></span> -
          <span m-text="part2"></span>
        </div>
      `;
      const app = new Reflex({ part1: 'First', part2: 'Second' });
      await app.nextTick();

      const spans = document.querySelectorAll('span');
      expect(spans[0].textContent).toBe('First');
      expect(spans[1].textContent).toBe('Second');

      // Update one part
      app.s.part1 = 'Updated';
      await app.nextTick();

      expect(spans[0].textContent).toBe('Updated');
      expect(spans[1].textContent).toBe('Second'); // Should not change
    });

    it('should handle manual input in contenteditable (if two-way binding supported)', async () => {
      // Note: Standard m-model doesn't typically work on contenteditable
      // This test documents the expected behavior
      document.body.innerHTML = '<div contenteditable="true">{{ text }}</div>';
      const app = new Reflex({ text: 'Initial' });
      await app.nextTick();

      const div = document.querySelector('div');
      expect(div.textContent).toBe('Initial');

      // Programmatic update should work
      app.s.text = 'Changed';
      await app.nextTick();

      expect(div.textContent).toBe('Changed');
    });
  });

  describe('Radio button edge cases', () => {
    it('should handle radio groups with same name across different models', async () => {
      document.body.innerHTML = `
        <div>
          <input type="radio" name="color" m-model="choice1" value="red">
          <input type="radio" name="color" m-model="choice1" value="blue">
          <input type="radio" name="size" m-model="choice2" value="small">
          <input type="radio" name="size" m-model="choice2" value="large">
        </div>
      `;
      const app = new Reflex({ choice1: 'blue', choice2: 'small' });
      await app.nextTick();

      const radios = document.querySelectorAll('input[type="radio"]');

      // Verify correct radios are checked
      expect(radios[0].checked).toBe(false); // red
      expect(radios[1].checked).toBe(true);  // blue
      expect(radios[2].checked).toBe(true);  // small
      expect(radios[3].checked).toBe(false); // large

      // Change first group
      radios[0].checked = true;
      radios[0].dispatchEvent(new Event('change', { bubbles: true }));
      expect(app.s.choice1).toBe('red');
      expect(app.s.choice2).toBe('small'); // Should not change

      // Change second group
      radios[3].checked = true;
      radios[3].dispatchEvent(new Event('change', { bubbles: true }));
      expect(app.s.choice1).toBe('red'); // Should not change
      expect(app.s.choice2).toBe('large');
    });
  });

  describe('Checkbox arrays', () => {
    it('should handle m-model on checkboxes with array binding', async () => {
      document.body.innerHTML = `
        <div>
          <input type="checkbox" m-model="selected" value="a">
          <input type="checkbox" m-model="selected" value="b">
          <input type="checkbox" m-model="selected" value="c">
        </div>
      `;
      const app = new Reflex({ selected: ['b'] });
      await app.nextTick();

      const checkboxes = document.querySelectorAll('input[type="checkbox"]');

      // Verify initial state
      expect(checkboxes[0].checked).toBe(false);
      expect(checkboxes[1].checked).toBe(true);
      expect(checkboxes[2].checked).toBe(false);

      // Check another box
      checkboxes[0].checked = true;
      checkboxes[0].dispatchEvent(new Event('change'));

      // Should add to array
      expect(app.s.selected).toContain('a');
      expect(app.s.selected).toContain('b');

      // Uncheck a box
      checkboxes[1].checked = false;
      checkboxes[1].dispatchEvent(new Event('change'));

      // Should remove from array
      expect(app.s.selected).not.toContain('b');
      expect(app.s.selected).toContain('a');
    });
  });

  describe('Input range and other special types', () => {
    it('should handle input[type="range"] with m-model', async () => {
      document.body.innerHTML = '<input type="range" min="0" max="100" m-model="volume">';
      const app = new Reflex({ volume: 50 });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('50');

      // User moves slider
      input.value = '75';
      input.dispatchEvent(new Event('input'));

      expect(app.s.volume).toBe(75);

      // Programmatic update
      app.s.volume = 25;
      await app.nextTick();

      expect(input.value).toBe('25');
    });

    it('should handle input[type="date"] with m-model', async () => {
      document.body.innerHTML = '<input type="date" m-model="birthday">';
      const app = new Reflex({ birthday: '2000-01-01' });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('2000-01-01');

      // User changes date
      input.value = '1995-06-15';
      input.dispatchEvent(new Event('input'));

      expect(app.s.birthday).toBe('1995-06-15');
    });

    it('should handle input[type="color"] with m-model', async () => {
      document.body.innerHTML = '<input type="color" m-model="favoriteColor">';
      const app = new Reflex({ favoriteColor: '#ff0000' });
      await app.nextTick();

      const input = document.querySelector('input');
      expect(input.value).toBe('#ff0000');

      // User picks a color
      input.value = '#00ff00';
      input.dispatchEvent(new Event('input'));

      expect(app.s.favoriteColor).toBe('#00ff00');
    });
  });

  describe('Textarea edge cases', () => {
    it('should handle m-model on textarea preserving newlines', async () => {
      document.body.innerHTML = '<textarea m-model="text"></textarea>';
      const app = new Reflex({ text: 'Line 1\nLine 2\nLine 3' });
      await app.nextTick();

      const textarea = document.querySelector('textarea');
      expect(textarea.value).toBe('Line 1\nLine 2\nLine 3');

      // User edits
      textarea.value = 'Updated\nText';
      textarea.dispatchEvent(new Event('input'));

      expect(app.s.text).toBe('Updated\nText');
    });

    it('should handle textarea with m-model.lazy', async () => {
      document.body.innerHTML = '<textarea m-model.lazy="description"></textarea>';
      const app = new Reflex({ description: 'Initial' });
      await app.nextTick();

      const textarea = document.querySelector('textarea');

      // Type without blur
      textarea.value = 'Typing...';
      textarea.dispatchEvent(new Event('input'));
      expect(app.s.description).toBe('Initial'); // No change yet

      // Trigger change
      textarea.dispatchEvent(new Event('change'));
      expect(app.s.description).toBe('Typing...'); // Now updated
    });
  });
});
