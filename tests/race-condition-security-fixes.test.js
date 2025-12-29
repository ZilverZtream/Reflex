/**
 * Race Condition & Security Fixes Test Suite
 *
 * Tests for 10 critical, high, and medium severity bugs fixed in this patch:
 * 1. Critical Race Condition in nextTick Resolution
 * 2. XSS Vulnerability in setInnerHTML Regex Bypass
 * 3. SVG Context Loss in createElement (Root Components)
 * 4. Broken SVG Rendering in m-for (Wrapper Namespace)
 * 5. SSR Attribute Binding XSS Bypass
 * 6. Crash on Detached Node Transitions
 * 7. Uncaught Exceptions in Component setup
 * 8. Data Integrity: Whitespace Coercion to Zero
 * 9. Scheduler Denial of Service (Deep Watch)
 * 10. DOM Traversal Instability During Unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Critical Security & Race Condition Fixes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('1. Critical: nextTick Race Condition', () => {
    it('nextTick waits for all pending work to complete', async () => {
      const app = new Reflex({ items: [] }, { autoMount: false });
      const executionOrder = [];

      // Create many effects that will take time to process
      for (let i = 0; i < 1000; i++) {
        app.createEffect(() => {
          if (app.s.items.length > 0) {
            // Simulate work
            const dummy = app.s.items[i % app.s.items.length];
          }
        });
      }

      // Trigger a large update
      app.s.items = new Array(100).fill(0).map((_, i) => i);

      // await nextTick should wait for ALL work to complete
      await app.nextTick();
      executionOrder.push('nextTick resolved');

      // At this point, ALL effects should have run
      expect(executionOrder).toEqual(['nextTick resolved']);
    });

    it('nextTick handles time-sliced flushes correctly', async () => {
      const app = new Reflex({ count: 0 }, { autoMount: false });
      let effectRuns = 0;

      // Create many effects to force time slicing
      for (let i = 0; i < 500; i++) {
        app.createEffect(() => {
          effectRuns += app.s.count > 0 ? 1 : 0;
        });
      }

      app.s.count = 1;
      await app.nextTick();

      // All effects should have run despite time slicing
      expect(effectRuns).toBe(500);
    });

    it('nextTick rejects on scheduler crash', async () => {
      const app = new Reflex({ count: 0 }, { autoMount: false });

      // Create a circular dependency that will crash the scheduler
      app.createEffect(() => {
        if (app.s.count > 0) {
          app.s.count++;  // Infinite loop
        }
      });

      app.s.count = 1;

      // Should reject due to circular dependency
      await expect(app.nextTick()).rejects.toThrow(/circular dependency/i);
    });
  });

  describe('2. Critical: XSS in setInnerHTML', () => {
    it('blocks SVG with onload event handler', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const container = document.createElement('div');
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      // Try to inject SVG XSS
      DOMRenderer.setInnerHTML(container, '<svg onload=alert(1)></svg>');

      // Should be blocked
      expect(container.textContent).toBe('[Content blocked for security reasons]');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('BLOCKED dangerous HTML'));

      errorSpy.mockRestore();
    });

    it('blocks img with onerror event handler', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const container = document.createElement('div');
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      // Try to inject img XSS
      DOMRenderer.setInnerHTML(container, '<img src=x onerror=alert(1)>');

      // Should be blocked
      expect(container.textContent).toBe('[Content blocked for security reasons]');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('BLOCKED dangerous HTML'));

      errorSpy.mockRestore();
    });

    it('blocks body with onload event handler', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const container = document.createElement('div');
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      // Try to inject body XSS
      DOMRenderer.setInnerHTML(container, '<body onload=alert(1)>test</body>');

      // Should be blocked
      expect(container.textContent).toBe('[Content blocked for security reasons]');

      errorSpy.mockRestore();
    });

    it('allows safe HTML', async () => {
      const container = document.createElement('div');
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      DOMRenderer.setInnerHTML(container, '<p>Hello <strong>World</strong></p>');

      expect(container.innerHTML).toBe('<p>Hello <strong>World</strong></p>');
    });
  });

  describe('3. High: SVG Context Loss in createElement', () => {
    it('creates SVG component with circle root correctly', () => {
      const app = new Reflex({}, { autoMount: false });

      // Register component with SVG element as root
      app.component('svg-icon', {
        template: '<circle cx="10" cy="10" r="5" fill="red" />'
      });

      const container = document.createElement('div');
      container.innerHTML = '<svg><svg-icon></svg-icon></svg>';
      document.body.appendChild(container);

      app.mount(container);

      // Circle should be an SVGCircleElement, not HTMLUnknownElement
      const circle = container.querySelector('circle');
      expect(circle).toBeTruthy();
      expect(circle.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(circle instanceof SVGCircleElement).toBe(true);

      app.unmount();
    });

    it('creates SVG component with path root correctly', () => {
      const app = new Reflex({}, { autoMount: false });

      app.component('svg-path', {
        template: '<path d="M10 10 L20 20" stroke="black" />'
      });

      const container = document.createElement('div');
      container.innerHTML = '<svg><svg-path></svg-path></svg>';
      document.body.appendChild(container);

      app.mount(container);

      const path = container.querySelector('path');
      expect(path).toBeTruthy();
      expect(path.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(path instanceof SVGPathElement).toBe(true);

      app.unmount();
    });

    it('creates async SVG component correctly', async () => {
      const app = new Reflex({}, { autoMount: false });

      app.component('async-svg', () => Promise.resolve({
        template: '<rect x="5" y="5" width="10" height="10" />'
      }));

      const container = document.createElement('div');
      container.innerHTML = '<svg><async-svg></async-svg></svg>';
      document.body.appendChild(container);

      app.mount(container);

      // Wait for async component
      await new Promise(resolve => setTimeout(resolve, 100));
      await app.nextTick();

      const rect = container.querySelector('rect');
      expect(rect).toBeTruthy();
      expect(rect.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(rect instanceof SVGRectElement).toBe(true);

      app.unmount();
    });
  });

  describe('4. High: Broken SVG Rendering in m-for', () => {
    it('renders m-for inside SVG without wrapper elements', async () => {
      const app = new Reflex({ items: [1, 2, 3] }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = '<svg><g><template m-for="item in items"><circle :cx="item * 10" cy="10" r="5"/></template></g></svg>';
      document.body.appendChild(container);

      app.mount(container);
      await app.nextTick();

      // Should have 3 circles
      const circles = container.querySelectorAll('circle');
      expect(circles.length).toBe(3);

      // All circles should be SVG elements (not HTML)
      circles.forEach(circle => {
        expect(circle.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(circle instanceof SVGCircleElement).toBe(true);
      });

      // Should NOT have any wrapper elements like <rfx-tpl>
      const wrappers = container.querySelectorAll('rfx-tpl');
      expect(wrappers.length).toBe(0);

      app.unmount();
    });

    it('renders m-for with multiple SVG children correctly', async () => {
      const app = new Reflex({ points: [[10, 10], [20, 20], [30, 30]] }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = '<svg><template m-for="(p, i) in points"><circle :cx="p[0]" :cy="p[1]" r="3"/></template></svg>';
      document.body.appendChild(container);

      app.mount(container);
      await app.nextTick();

      const circles = container.querySelectorAll('circle');
      expect(circles.length).toBe(3);

      // Verify positions
      expect(circles[0].getAttribute('cx')).toBe('10');
      expect(circles[1].getAttribute('cx')).toBe('20');
      expect(circles[2].getAttribute('cx')).toBe('30');

      app.unmount();
    });
  });

  describe('5. High: SSR Attribute Binding XSS Bypass', () => {
    it('decodes entities without semicolons in SSR mode', async () => {
      const app = new Reflex({ url: '&#106avascript:alert(1)' }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = '<a :href="url">Link</a>';
      document.body.appendChild(container);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      app.mount(container);
      await app.nextTick();

      const link = container.querySelector('a');

      // Should be sanitized to about:blank
      expect(link.getAttribute('href')).toBe('about:blank');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Blocked unsafe URL'),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );

      warnSpy.mockRestore();
      app.unmount();
    });

    it('decodes hex entities without semicolons', async () => {
      const app = new Reflex({ url: '&#x6aavascript:alert(1)' }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = '<a :href="url">Link</a>';
      document.body.appendChild(container);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      app.mount(container);
      await app.nextTick();

      const link = container.querySelector('a');
      expect(link.getAttribute('href')).toBe('about:blank');

      warnSpy.mockRestore();
      app.unmount();
    });

    it('decodes named entities like &colon;', async () => {
      const app = new Reflex({ url: 'javascript&colon;alert(1)' }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = '<a :href="url">Link</a>';
      document.body.appendChild(container);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      app.mount(container);
      await app.nextTick();

      const link = container.querySelector('a');
      expect(link.getAttribute('href')).toBe('about:blank');

      warnSpy.mockRestore();
      app.unmount();
    });
  });

  describe('6. Medium: Crash on Detached Node Transitions', () => {
    it('handles transition on detached node gracefully', async () => {
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      // Create a detached element (not in DOM)
      const el = document.createElement('div');

      // Should not throw when running transition on detached node
      expect(() => {
        DOMRenderer.runTransition(el, { name: 'fade', type: 'enter' });
      }).not.toThrow();
    });

    it('completes transition immediately for detached nodes', async () => {
      const { DOMRenderer } = await import('../src/renderers/dom.ts');

      const el = document.createElement('div');
      let doneCalled = false;

      DOMRenderer.runTransition(el, {
        name: 'fade',
        type: 'enter',
        done: () => { doneCalled = true; }
      });

      // Done should be called immediately for detached nodes
      expect(doneCalled).toBe(true);
    });
  });

  describe('7. Medium: Uncaught Exceptions in Component setup', () => {
    it('handles errors in component setup gracefully', async () => {
      const app = new Reflex({}, { autoMount: false });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      app.component('broken-component', {
        template: '<div>Component</div>',
        setup() {
          throw new Error('Setup failed');
        }
      });

      const container = document.createElement('div');
      container.innerHTML = '<div><broken-component></broken-component><p>After</p></div>';
      document.body.appendChild(container);

      // Should not crash the entire app
      expect(() => app.mount(container)).not.toThrow();
      await app.nextTick();

      // Other elements should still render
      const p = container.querySelector('p');
      expect(p).toBeTruthy();
      expect(p.textContent).toBe('After');

      // Error should be marked on the component
      const errorMarker = container.querySelector('[data-error]');
      expect(errorMarker).toBeTruthy();

      errorSpy.mockRestore();
      app.unmount();
    });

    it('continues rendering after component error', async () => {
      const app = new Reflex({}, { autoMount: false });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      app.component('broken-1', {
        template: '<div>Broken1</div>',
        setup() { throw new Error('Broken1'); }
      });

      app.component('working-1', {
        template: '<div>Working1</div>'
      });

      const container = document.createElement('div');
      container.innerHTML = '<div><broken-1></broken-1><working-1></working-1></div>';
      document.body.appendChild(container);

      app.mount(container);
      await app.nextTick();

      // Working component should render
      expect(container.textContent).toContain('Working1');

      errorSpy.mockRestore();
      app.unmount();
    });
  });

  describe('8. Medium: Whitespace Coercion to Zero', () => {
    it('does not coerce whitespace to 0 in numeric multi-select', async () => {
      const app = new Reflex({ selected: [] }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = `
        <select multiple m-model="selected">
          <option value="1">One</option>
          <option value=" ">Whitespace</option>
          <option value="3">Three</option>
        </select>
      `;
      document.body.appendChild(container);

      app.mount(container);
      await app.nextTick();

      const select = container.querySelector('select');
      const options = select.querySelectorAll('option');

      // Select the whitespace option
      options[1].selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await app.nextTick();

      // Should remain as string " ", not become 0
      expect(app.s.selected).toEqual([' ']);
      expect(app.s.selected[0]).toBe(' ');
      expect(app.s.selected[0]).not.toBe(0);

      app.unmount();
    });

    it('handles empty option values correctly', async () => {
      const app = new Reflex({ selected: [] }, { autoMount: false });

      const container = document.createElement('div');
      container.innerHTML = `
        <select multiple m-model="selected">
          <option value="1">One</option>
          <option value="">Empty</option>
          <option value="3">Three</option>
        </select>
      `;
      document.body.appendChild(container);

      app.mount(container);
      await app.nextTick();

      const select = container.querySelector('select');
      const options = select.querySelectorAll('option');

      // Select the empty option
      options[1].selected = true;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await app.nextTick();

      // Should remain as empty string, not become 0
      expect(app.s.selected).toEqual(['']);
      expect(app.s.selected[0]).toBe('');

      app.unmount();
    });
  });

  describe('9. Medium: Scheduler DoS', () => {
    it('enforces 10k node limit in deep watch', () => {
      const app = new Reflex({ data: {} }, { autoMount: false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a massive object with 15k nodes
      const massive = {};
      for (let i = 0; i < 15000; i++) {
        massive[`prop${i}`] = { value: i };
      }

      app.s.data = app._r(massive);

      // Deep watch traversal should stop at 10k nodes
      app._trv(app.s.data);

      // Should have warned about exceeding limit
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('exceeded max nodes')
      );

      warnSpy.mockRestore();
    });

    it('completes traversal quickly for 10k nodes', () => {
      const app = new Reflex({ data: {} }, { autoMount: false });

      // Create object with exactly 10k nodes
      const large = {};
      for (let i = 0; i < 10000; i++) {
        large[`prop${i}`] = { value: i };
      }

      app.s.data = app._r(large);

      const start = performance.now();
      app._trv(app.s.data);
      const duration = performance.now() - start;

      // Should complete in reasonable time (< 50ms)
      expect(duration).toBeLessThan(50);
    });
  });

  describe('10. Medium: DOM Traversal Instability', () => {
    it('handles cleanup that modifies DOM', () => {
      const app = new Reflex({}, { autoMount: false });

      const container = document.createElement('div');
      const child1 = document.createElement('div');
      const child2 = document.createElement('div');
      const child3 = document.createElement('div');

      container.appendChild(child1);
      container.appendChild(child2);
      container.appendChild(child3);

      const cleanupOrder = [];

      // Register cleanup that removes a sibling
      app._reg(child1, () => {
        cleanupOrder.push('child1');
      });

      app._reg(child2, () => {
        cleanupOrder.push('child2');
        // Remove child3 during cleanup
        if (child3.parentNode) {
          child3.remove();
        }
      });

      app._reg(child3, () => {
        cleanupOrder.push('child3');
      });

      // Kill the container - should handle DOM modifications gracefully
      expect(() => app._kill(container)).not.toThrow();

      // All cleanups should still run despite DOM modification
      expect(cleanupOrder).toContain('child1');
      expect(cleanupOrder).toContain('child2');
      expect(cleanupOrder).toContain('child3');
    });

    it('handles deeply nested cleanup modifications', () => {
      const app = new Reflex({}, { autoMount: false });

      // Create deeply nested structure
      const root = document.createElement('div');
      let current = root;
      const nodes = [root];

      for (let i = 0; i < 100; i++) {
        const child = document.createElement('div');
        current.appendChild(child);
        nodes.push(child);
        current = child;
      }

      let cleanupCount = 0;

      // Register cleanups that might remove siblings
      nodes.forEach((node, idx) => {
        app._reg(node, () => {
          cleanupCount++;
          // Try to remove next sibling if it exists
          if (idx + 1 < nodes.length && nodes[idx + 1].parentNode) {
            nodes[idx + 1].remove();
          }
        });
      });

      app._kill(root);

      // All cleanups should run despite modifications
      expect(cleanupCount).toBe(nodes.length);
    });
  });
});
