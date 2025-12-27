/**
 * Shadow DOM & Integration Tests
 *
 * "Reality is the Spec." These tests ensure Reflex survives in hostile environments.
 *
 * Tests:
 * - Shadow DOM boundary handling
 * - Third-party script sabotage (jQuery-style DOM manipulation)
 * - Slot projection with dynamic content
 *
 * If these tests fail, Reflex needs to be more robust.
 * DO NOT modify tests to pass on broken behavior. Fix the framework.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

// Helper to dispatch click events
function dispatchClick(el) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(event);
  return event;
}

// Helper to wait for DOM operations
async function tick(app, times = 2) {
  for (let i = 0; i < times; i++) {
    await app.nextTick();
  }
}

describe('Shadow DOM & Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Shadow DOM Boundary', () => {
    /**
     * CRITICAL REQUIREMENT:
     * Event delegation typically binds to document, which fails in Shadow DOM
     * because events retarget when crossing shadow boundaries.
     *
     * Reflex must bind to the root element or handle shadow DOM correctly.
     */

    it('should handle events inside Shadow DOM', async () => {
      // Create a custom element with shadow DOM
      class ShadowContainer extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      if (!customElements.get('shadow-container')) {
        customElements.define('shadow-container', ShadowContainer);
      }

      // Add the custom element to body
      document.body.innerHTML = '<shadow-container id="host"></shadow-container>';

      const host = document.getElementById('host');
      host.shadowRoot.innerHTML = '<div id="shadow-app"><button @click="count++">Click</button></div>';

      // Mount Reflex inside shadow root
      const shadowApp = host.shadowRoot.getElementById('shadow-app');
      const app = new Reflex({ count: 0 });
      app.mount(shadowApp);
      await tick(app);

      const button = host.shadowRoot.querySelector('button');
      expect(button).toBeTruthy();

      // Click inside shadow DOM
      dispatchClick(button);
      await tick(app);

      expect(app.s.count).toBe(1);
    });

    it('should handle m-text binding inside shadow DOM', async () => {
      // This test verifies that m-text works correctly inside shadow DOM
      class ShadowTextBinding extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      if (!customElements.get('shadow-text-binding')) {
        customElements.define('shadow-text-binding', ShadowTextBinding);
      }

      document.body.innerHTML = '<shadow-text-binding id="host"></shadow-text-binding>';

      const host = document.getElementById('host');
      host.shadowRoot.innerHTML = '<div id="text-app"><span @click="clicked = true" m-text="String(clicked)"></span></div>';

      const textApp = host.shadowRoot.getElementById('text-app');
      const app = new Reflex({ clicked: false });
      app.mount(textApp);

      // Wait for auto-mount microtask to clear, then wait for effects
      await new Promise(r => setTimeout(r, 0));
      await tick(app);

      const span = host.shadowRoot.querySelector('span');
      expect(span.textContent).toBe('false');

      dispatchClick(span);
      await tick(app);

      expect(app.s.clicked).toBe(true);
      expect(span.textContent).toBe('true');
    });

    it('should handle nested shadow DOM', async () => {
      // This test verifies that Reflex works in nested shadow DOM environments
      // Note: Some test environments (happy-dom) may have limitations with deeply nested shadow roots
      class OuterShadow extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      class InnerShadow extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      if (!customElements.get('outer-shadow-v2')) {
        customElements.define('outer-shadow-v2', OuterShadow);
      }
      if (!customElements.get('inner-shadow-v2')) {
        customElements.define('inner-shadow-v2', InnerShadow);
      }

      document.body.innerHTML = '<outer-shadow-v2 id="outer"></outer-shadow-v2>';

      const outer = document.getElementById('outer');
      outer.shadowRoot.innerHTML = '<inner-shadow-v2 id="inner"></inner-shadow-v2>';

      const inner = outer.shadowRoot.getElementById('inner');
      inner.shadowRoot.innerHTML = '<div id="nested-app"><button @click="count++">{{ count }}</button></div>';

      const nestedApp = inner.shadowRoot.getElementById('nested-app');
      const app = new Reflex({ count: 0 });
      app.mount(nestedApp);
      await tick(app);

      const button = inner.shadowRoot.querySelector('button');
      expect(button).toBeTruthy();

      // Click should work in nested shadow DOM
      dispatchClick(button);
      await tick(app);

      expect(app.s.count).toBe(1);
    });

    it('should handle m-for inside shadow DOM', async () => {
      class ShadowList extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      if (!customElements.get('shadow-list')) {
        customElements.define('shadow-list', ShadowList);
      }

      document.body.innerHTML = '<shadow-list id="list-host"></shadow-list>';

      const host = document.getElementById('list-host');
      host.shadowRoot.innerHTML = `
        <div id="list-app">
          <ul>
            <li m-for="item in items" m-text="item"></li>
          </ul>
        </div>
      `;

      const listApp = host.shadowRoot.getElementById('list-app');
      const app = new Reflex({ items: ['A', 'B', 'C'] });
      app.mount(listApp);
      await tick(app);

      let items = host.shadowRoot.querySelectorAll('li');
      expect(items.length).toBe(3);

      // Update list
      app.s.items.push('D');
      await tick(app);

      items = host.shadowRoot.querySelectorAll('li');
      expect(items.length).toBe(4);
      expect(items[3].textContent).toBe('D');
    });

    it('should handle m-if inside shadow DOM', async () => {
      class ShadowConditional extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' });
        }
      }

      if (!customElements.get('shadow-conditional')) {
        customElements.define('shadow-conditional', ShadowConditional);
      }

      document.body.innerHTML = '<shadow-conditional id="cond-host"></shadow-conditional>';

      const host = document.getElementById('cond-host');
      host.shadowRoot.innerHTML = `
        <div id="cond-app">
          <button @click="show = !show">Toggle</button>
          <div m-if="show" id="conditional-content">Visible</div>
        </div>
      `;

      const condApp = host.shadowRoot.getElementById('cond-app');
      const app = new Reflex({ show: false });
      app.mount(condApp);
      await tick(app);

      expect(host.shadowRoot.getElementById('conditional-content')).toBeNull();

      // Toggle visibility
      const button = host.shadowRoot.querySelector('button');
      dispatchClick(button);
      await tick(app);

      expect(host.shadowRoot.getElementById('conditional-content')).toBeTruthy();
    });
  });

  describe('Third-Party DOM Sabotage ("jQuery" Test)', () => {
    /**
     * CRITICAL REQUIREMENT:
     * Third-party scripts (analytics, chat widgets, jQuery plugins) often
     * manipulate the DOM directly. Reflex must handle this gracefully.
     *
     * When a rogue element is added to a container managed by m-for,
     * Reflex should:
     * 1. NOT crash with "Node not found"
     * 2. Either preserve or ignore the rogue node
     * 3. Continue updating its own managed items correctly
     */

    it('should not crash when rogue nodes are added to m-for container', async () => {
      document.body.innerHTML = `
        <ul id="list">
          <li m-for="item in items" m-text="item"></li>
        </ul>
      `;

      const app = new Reflex({ items: ['One', 'Two', 'Three'] });
      await tick(app);

      const list = document.getElementById('list');
      let items = list.querySelectorAll('li');
      expect(items.length).toBe(3);

      // Simulate third-party script adding a rogue element
      const rogueDiv = document.createElement('div');
      rogueDiv.id = 'rogue-element';
      rogueDiv.textContent = 'I am a rogue element!';
      list.appendChild(rogueDiv);

      // Verify rogue element is there
      expect(document.getElementById('rogue-element')).toBeTruthy();

      // Update the m-for list - this should NOT crash
      app.s.items.push('Four');
      await tick(app);

      // Should have 4 list items now
      items = list.querySelectorAll('li');
      expect(items.length).toBe(4);
      expect(items[3].textContent).toBe('Four');
    });

    it('should handle rogue nodes inserted in the middle of m-for list', async () => {
      document.body.innerHTML = `
        <ul id="middle-list">
          <li m-for="item in items" m-text="item" m-key="item"></li>
        </ul>
      `;

      const app = new Reflex({ items: ['A', 'B', 'C'] });
      await tick(app);

      const list = document.getElementById('middle-list');

      // Insert rogue element between B and C
      const bItem = list.querySelectorAll('li')[1];
      const rogueSpan = document.createElement('span');
      rogueSpan.className = 'rogue';
      rogueSpan.textContent = 'ROGUE';
      list.insertBefore(rogueSpan, bItem.nextSibling);

      // Update list data
      app.s.items = ['A', 'B', 'C', 'D'];
      await tick(app);

      // List items should be correct
      const items = list.querySelectorAll('li');
      expect(items.length).toBe(4);
    });

    it('should handle rogue node removal by third party', async () => {
      document.body.innerHTML = `
        <div id="container">
          <span m-if="show" id="managed">Managed Content</span>
          <div id="external">External Content</div>
        </div>
      `;

      const app = new Reflex({ show: true });
      await tick(app);

      // Third party removes the external div
      const external = document.getElementById('external');
      external.parentNode.removeChild(external);

      // Toggle the managed element - should not crash
      app.s.show = false;
      await tick(app);

      expect(document.getElementById('managed')).toBeNull();

      app.s.show = true;
      await tick(app);

      expect(document.getElementById('managed')).toBeTruthy();
    });

    it('should handle complete container replacement by third party', async () => {
      document.body.innerHTML = `
        <div id="app-root">
          <ul id="original-list">
            <li m-for="item in items" m-text="item"></li>
          </ul>
        </div>
      `;

      const app = new Reflex({ items: ['X', 'Y'] });
      await tick(app);

      const originalList = document.getElementById('original-list');
      expect(originalList.querySelectorAll('li').length).toBe(2);

      // Third party replaces the entire list with new content
      // (simulating something like jQuery's .html() or .replaceWith())
      const newContent = document.createElement('div');
      newContent.textContent = 'Replaced by third party';
      originalList.parentNode.replaceChild(newContent, originalList);

      // The original list is gone - updating state should not crash
      // (Though the update won't be visible since the DOM is replaced)
      app.s.items.push('Z');
      await tick(app);

      // Should not throw, framework remains stable
      expect(app.s.items).toEqual(['X', 'Y', 'Z']);
    });

    it('should handle attribute modifications by third party', async () => {
      document.body.innerHTML = `
        <input id="managed-input" :class="inputClass" m-model="value">
      `;

      const app = new Reflex({
        inputClass: 'original-class',
        value: 'initial'
      });
      await tick(app);

      const input = document.getElementById('managed-input');
      expect(input.className).toBe('original-class');

      // Third party modifies the class
      input.classList.add('third-party-class');

      // Update state
      app.s.inputClass = 'updated-class';
      await tick(app);

      // Reflex should update its managed attribute
      // (third-party class may or may not be preserved depending on implementation)
      expect(input.className).toContain('updated-class');
    });

    it('should handle text content modifications by third party', async () => {
      document.body.innerHTML = `
        <span id="managed-span" m-text="message"></span>
      `;

      const app = new Reflex({ message: 'Original' });
      await tick(app);

      const span = document.getElementById('managed-span');
      expect(span.textContent).toBe('Original');

      // Third party modifies text
      span.textContent = 'Modified by third party';

      // Update via Reflex
      app.s.message = 'Updated';
      await tick(app);

      // Reflex should override with its managed content
      expect(span.textContent).toBe('Updated');
    });
  });

  describe('Slot Projection', () => {
    /**
     * REQUIREMENT:
     * Content projected into slots must remain reactive.
     * Dynamic content inside component slots should update correctly.
     */

    it('should handle dynamic content in component slots', async () => {
      document.body.innerHTML = `<div id="app"></div>`;

      const app = new Reflex({ dynamicText: 'Initial' });

      // Register a component with a slot
      app.component('slot-wrapper', {
        template: `
          <div class="wrapper">
            <slot></slot>
          </div>
        `
      });

      // Mount with projected content
      document.getElementById('app').innerHTML = `
        <slot-wrapper>
          <span id="projected" m-text="dynamicText"></span>
        </slot-wrapper>
      `;

      app.mount(document.getElementById('app'));
      await tick(app);

      const projected = document.getElementById('projected');
      expect(projected).toBeTruthy();
      expect(projected.textContent).toBe('Initial');

      // Update the dynamic content
      app.s.dynamicText = 'Updated';
      await tick(app);

      expect(projected.textContent).toBe('Updated');
    });

    it('should handle m-for in projected content', async () => {
      document.body.innerHTML = `<div id="app"></div>`;

      const app = new Reflex({ items: ['A', 'B'] });

      app.component('list-container', {
        template: `
          <div class="container">
            <slot></slot>
          </div>
        `
      });

      document.getElementById('app').innerHTML = `
        <list-container>
          <ul id="projected-list">
            <li m-for="item in items" m-text="item"></li>
          </ul>
        </list-container>
      `;

      app.mount(document.getElementById('app'));
      await tick(app);

      let items = document.querySelectorAll('#projected-list li');
      expect(items.length).toBe(2);

      // Update list
      app.s.items.push('C');
      await tick(app);

      items = document.querySelectorAll('#projected-list li');
      expect(items.length).toBe(3);
    });

    it('should handle m-if in projected content', async () => {
      document.body.innerHTML = `<div id="app"></div>`;

      const app = new Reflex({ visible: false });

      app.component('modal-shell', {
        template: `
          <div class="modal-shell">
            <slot></slot>
          </div>
        `
      });

      document.getElementById('app').innerHTML = `
        <modal-shell>
          <div m-if="visible" id="modal-content">Modal Content</div>
        </modal-shell>
      `;

      app.mount(document.getElementById('app'));
      await tick(app);

      expect(document.getElementById('modal-content')).toBeNull();

      app.s.visible = true;
      await tick(app);

      expect(document.getElementById('modal-content')).toBeTruthy();
    });

    it('should handle events in projected content', async () => {
      document.body.innerHTML = `<div id="app"></div>`;

      const app = new Reflex({ count: 0 });

      app.component('event-wrapper', {
        template: `
          <div class="event-wrapper">
            <slot></slot>
          </div>
        `
      });

      document.getElementById('app').innerHTML = `
        <event-wrapper>
          <button id="slot-button" @click="count++">Increment</button>
        </event-wrapper>
      `;

      app.mount(document.getElementById('app'));
      await tick(app);

      const button = document.getElementById('slot-button');
      dispatchClick(button);
      await tick(app);

      expect(app.s.count).toBe(1);
    });

    it('should handle nested components with slots', async () => {
      document.body.innerHTML = `<div id="app"></div>`;

      const app = new Reflex({ text: 'Deep' });

      app.component('outer-comp', {
        template: `<div class="outer"><slot></slot></div>`
      });

      app.component('inner-comp', {
        template: `<div class="inner"><slot></slot></div>`
      });

      document.getElementById('app').innerHTML = `
        <outer-comp>
          <inner-comp>
            <span id="deep-content" m-text="text"></span>
          </inner-comp>
        </outer-comp>
      `;

      app.mount(document.getElementById('app'));
      await tick(app);

      const content = document.getElementById('deep-content');
      expect(content.textContent).toBe('Deep');

      app.s.text = 'Deeper';
      await tick(app);

      expect(content.textContent).toBe('Deeper');
    });
  });

  describe('Web Component Integration', () => {
    it('should work alongside native custom elements', async () => {
      class NativeCounter extends HTMLElement {
        constructor() {
          super();
          this.count = 0;
        }
        connectedCallback() {
          this.innerHTML = `<span class="native-count">${this.count}</span>`;
        }
        increment() {
          this.count++;
          this.querySelector('.native-count').textContent = this.count;
        }
      }

      if (!customElements.get('native-counter')) {
        customElements.define('native-counter', NativeCounter);
      }

      document.body.innerHTML = `
        <div id="hybrid-app">
          <native-counter id="native"></native-counter>
          <div id="reflex-section">
            <span m-text="reflexCount"></span>
            <button @click="reflexCount++">Increment Reflex</button>
          </div>
        </div>
      `;

      const app = new Reflex({ reflexCount: 0 });
      app.mount(document.getElementById('hybrid-app'));
      await tick(app);

      // Native counter works
      const native = document.getElementById('native');
      native.increment();
      expect(native.querySelector('.native-count').textContent).toBe('1');

      // Reflex counter works
      const button = document.querySelector('button');
      dispatchClick(button);
      await tick(app);

      expect(app.s.reflexCount).toBe(1);
    });

    it('should handle custom elements with observed attributes', async () => {
      class AttrElement extends HTMLElement {
        static get observedAttributes() {
          return ['data-value'];
        }
        attributeChangedCallback(name, oldVal, newVal) {
          if (name === 'data-value') {
            this.textContent = `Value: ${newVal}`;
          }
        }
      }

      if (!customElements.get('attr-element')) {
        customElements.define('attr-element', AttrElement);
      }

      document.body.innerHTML = `
        <div id="app">
          <attr-element :data-value="dynamicValue"></attr-element>
        </div>
      `;

      const app = new Reflex({ dynamicValue: 'initial' });
      app.mount(document.getElementById('app'));
      await tick(app);

      const attrEl = document.querySelector('attr-element');
      expect(attrEl.textContent).toBe('Value: initial');

      app.s.dynamicValue = 'updated';
      await tick(app);

      expect(attrEl.textContent).toBe('Value: updated');
    });
  });

  describe('Cross-Frame Communication', () => {
    it('should handle references to external DOM elements', async () => {
      document.body.innerHTML = `
        <div id="external-target"></div>
        <div id="app">
          <button @click="updateExternal()">Update External</button>
        </div>
      `;

      const externalTarget = document.getElementById('external-target');

      const app = new Reflex({
        updateExternal() {
          // Simulating updating an external DOM element
          externalTarget.textContent = 'Updated by Reflex';
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const button = document.querySelector('button');
      dispatchClick(button);
      await tick(app);

      expect(externalTarget.textContent).toBe('Updated by Reflex');
    });
  });
});
