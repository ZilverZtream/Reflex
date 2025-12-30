/**
 * Event System Tests
 *
 * Tests the event handling system including:
 * - Event binding (@event)
 * - Event modifiers (.prevent, .stop, .once, etc.)
 * - Event delegation
 * - Debounce/throttle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

// Helper to dispatch bubbling events
function dispatchClick(el) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

// Helper to wait for DOM operations
async function tick(app, times = 2) {
  for (let i = 0; i < times; i++) {
    await app.nextTick();
  }
}

describe('Events', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Basic Event Binding', () => {
    it('should handle click events', async () => {
      document.body.innerHTML = '<button @click="count++">Click</button>';
      const app = new Reflex({ count: 0 });
      await tick(app);

      dispatchClick(document.querySelector('button'));
      await tick(app);

      expect(app.s.count).toBe(1);
    });

    it('should pass $event to handler', async () => {
      document.body.innerHTML = '<button @click="handleClick($event)">Click</button>';
      let receivedEvent = null;
      const app = new Reflex({
        handleClick(e) { receivedEvent = e; }
      });
      await tick(app);

      dispatchClick(document.querySelector('button'));
      await tick(app);

      expect(receivedEvent).toBeInstanceOf(Event);
    });

    it('should use event delegation', async () => {
      document.body.innerHTML = '<div><button @click="count++">Click</button></div>';
      const app = new Reflex({ count: 0 });
      await tick(app);

      // Events should be delegated to the root
      expect(app._dh.has('click')).toBe(true);
    });
  });

  describe('Event Modifiers', () => {
    it('should support .prevent modifier', async () => {
      document.body.innerHTML = '<form @submit.prevent="submitted = true"><button type="submit">Submit</button></form>';
      const app = new Reflex({ submitted: false });
      await tick(app);

      const form = document.querySelector('form');
      const event = new Event('submit', { cancelable: true, bubbles: true });
      form.dispatchEvent(event);
      await tick(app);

      expect(event.defaultPrevented).toBe(true);
    });

    it('should support .stop modifier', async () => {
      let parentClicked = false;
      let childClicked = false;

      document.body.innerHTML = `
        <div @click="parentClick()">
          <button @click.stop="childClick()">Click</button>
        </div>
      `;
      const app = new Reflex({
        parentClick() { parentClicked = true; },
        childClick() { childClicked = true; }
      });
      await tick(app);

      dispatchClick(document.querySelector('button'));
      await tick(app);

      expect(childClicked).toBe(true);
      expect(parentClicked).toBe(false);
    });

    it('should support .once modifier', async () => {
      document.body.innerHTML = '<button @click.once="count++">Click</button>';
      const app = new Reflex({ count: 0 });
      await tick(app);

      const button = document.querySelector('button');
      dispatchClick(button);
      await tick(app);
      expect(app.s.count).toBe(1);

      dispatchClick(button);
      await tick(app);
      expect(app.s.count).toBe(1); // Should not increment again
    });

    it('should support .self modifier', async () => {
      document.body.innerHTML = `
        <div @click.self="parentClicked = true">
          <button>Click</button>
        </div>
      `;
      const app = new Reflex({ parentClicked: false });
      await tick(app);

      dispatchClick(document.querySelector('button'));
      await tick(app);
      expect(app.s.parentClicked).toBe(false);

      dispatchClick(document.querySelector('div'));
      await tick(app);
      expect(app.s.parentClicked).toBe(true);
    });
  });

  describe('Window/Document Modifiers', () => {
    it('should support .window modifier', async () => {
      document.body.innerHTML = '<div @keydown.window="keyPressed = true"></div>';
      const app = new Reflex({ keyPressed: false });
      await tick(app);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await tick(app);

      expect(app.s.keyPressed).toBe(true);
    });

    it('should support .document modifier', async () => {
      document.body.innerHTML = '<div @click.document="clicked = true"></div>';
      const app = new Reflex({ clicked: false });
      await tick(app);

      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await tick(app);

      expect(app.s.clicked).toBe(true);
    });
  });

  describe('Outside Modifier', () => {
    it('should trigger when clicking outside element', async () => {
      document.body.innerHTML = `
        <div>
          <div id="modal" @click.outside="closed = true">Modal</div>
          <button id="outside">Outside</button>
        </div>
      `;
      const app = new Reflex({ closed: false });
      await tick(app);

      dispatchClick(document.querySelector('#outside'));
      await tick(app);

      expect(app.s.closed).toBe(true);
    });

    it('should not trigger when clicking inside element', async () => {
      document.body.innerHTML = `
        <div id="modal" @click.outside="closed = true">Modal</div>
      `;
      const app = new Reflex({ closed: false });
      await tick(app);

      dispatchClick(document.querySelector('#modal'));
      await tick(app);

      expect(app.s.closed).toBe(false);
    });
  });

  describe('Debounce Modifier', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should debounce event handler', async () => {
      document.body.innerHTML = '<input @input.debounce.300ms="count++">';
      const app = new Reflex({ count: 0 });

      // Run pending microtasks for mount
      await vi.runAllTimersAsync();

      const input = document.querySelector('input');

      // Fire multiple events rapidly
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));

      expect(app.s.count).toBe(0);

      // Advance timers past debounce delay
      await vi.advanceTimersByTimeAsync(300);

      expect(app.s.count).toBe(1);
    });

    it('should use default 300ms if no delay specified', async () => {
      document.body.innerHTML = '<input @input.debounce="count++">';
      const app = new Reflex({ count: 0 });

      await vi.runAllTimersAsync();

      const input = document.querySelector('input');
      input.dispatchEvent(new Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(200);
      expect(app.s.count).toBe(0);

      await vi.advanceTimersByTimeAsync(100);
      expect(app.s.count).toBe(1);
    });

    it('should cleanup debounce timer when component unmounts', async () => {
      document.body.innerHTML = '<div m-if="show"><button @click.debounce.300ms="count++">Click</button></div>';
      const app = new Reflex({ show: true, count: 0 });

      await vi.runAllTimersAsync();

      const button = document.querySelector('button');
      expect(button).toBeTruthy();

      // Click the button
      dispatchClick(button);
      expect(app.s.count).toBe(0); // Not fired yet due to debounce

      // Immediately unmount the component
      app.s.show = false;
      await vi.runAllTimersAsync();

      // Advance past the debounce delay
      await vi.advanceTimersByTimeAsync(400);

      // The callback should NOT have fired because cleanup cleared the timer
      expect(app.s.count).toBe(0);
    });
  });

  describe('Throttle Modifier', () => {
    it('should throttle event handler', async () => {
      // NOTE: Throttle uses performance.now() which is not affected by fake timers
      // Testing with real timers to verify throttle behavior
      document.body.innerHTML = '<div @scroll.throttle.100ms="count++"></div>';
      const app = new Reflex({ count: 0 });

      // Wait for mount to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      const div = document.querySelector('div');

      // First event should fire immediately
      div.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 5)); // Small delay for reactivity
      expect(app.s.count).toBe(1);

      // Events within throttle window should be ignored
      div.dispatchEvent(new Event('scroll', { bubbles: true }));
      div.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(app.s.count).toBe(1);

      // After throttle window, events should fire again
      await new Promise(resolve => setTimeout(resolve, 105)); // Wait for throttle to reset
      div.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(app.s.count).toBe(2);
    });
  });
});
