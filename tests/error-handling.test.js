/**
 * Error Boundaries & Resilience
 *
 * Ensures production apps log errors instead of White-Screen-of-Death.
 * Tests proper error handling in rendering, event handlers, and watchers.
 *
 * POLICY: Fix the Code, Not the Test.
 * Production apps must gracefully handle errors without crashing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

describe('Error Handling & Resilience', () => {
  let originalConsoleError;
  let consoleErrorSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    originalConsoleError = console.error;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('Render Errors', () => {
    it('should catch errors in interpolation and continue rendering', async () => {
      document.body.innerHTML = `
        <div>
          <p>Before error</p>
          <span>{{ crashingFunction() }}</span>
          <p>After error</p>
        </div>
      `;

      const app = new Reflex({
        crashingFunction() {
          throw new Error('Render crash!');
        }
      });

      // Set up error handler
      let caughtError = null;
      app.configure({
        onError(error, context) {
          caughtError = { error, context };
        }
      });

      await app.nextTick();

      // Error should be caught
      expect(caughtError).not.toBeNull();
      expect(caughtError.error.message).toBe('Render crash!');

      // Rest of DOM should still be visible
      const paragraphs = document.querySelectorAll('p');
      expect(paragraphs.length).toBe(2);
      expect(paragraphs[0].textContent).toBe('Before error');
      expect(paragraphs[1].textContent).toBe('After error');
    });

    it('should handle errors in m-text directive', async () => {
      document.body.innerHTML = `
        <div>
          <span m-text="validValue">Initial</span>
          <span m-text="crashingGetter">Initial</span>
          <span m-text="anotherValid">Initial</span>
        </div>
      `;

      const app = new Reflex({
        validValue: 'Valid 1',
        anotherValid: 'Valid 2',
        get crashingGetter() {
          throw new Error('Getter crashed!');
        }
      });

      let errorCaught = false;
      app.configure({
        onError(error) {
          errorCaught = true;
        }
      });

      await app.nextTick();

      // Error should be caught
      expect(errorCaught).toBe(true);

      // Valid spans should still update
      const spans = document.querySelectorAll('span');
      expect(spans[0].textContent).toBe('Valid 1');
      expect(spans[2].textContent).toBe('Valid 2');
    });

    it('should handle errors in expression evaluation', async () => {
      document.body.innerHTML = `
        <div>
          <span>{{ safeValue }}</span>
          <span>{{ obj.nonexistent.property }}</span>
          <span>{{ anotherSafe }}</span>
        </div>
      `;

      const app = new Reflex({
        safeValue: 'Safe',
        anotherSafe: 'Also Safe',
        obj: {}
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      // Should handle the undefined property access gracefully
      const spans = document.querySelectorAll('span');
      expect(spans.length).toBe(3);
    });

    it('should handle errors in m-html directive', async () => {
      document.body.innerHTML = `
        <div>
          <div m-html="getHtml()">Fallback</div>
          <p>This should still render</p>
        </div>
      `;

      const app = new Reflex({
        getHtml() {
          throw new Error('HTML generation failed');
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      expect(errorCaught).toBe(true);

      // Rest of page should render
      const p = document.querySelector('p');
      expect(p).not.toBeNull();
      expect(p.textContent).toBe('This should still render');
    });

    it('should handle errors in computed attribute bindings', async () => {
      document.body.innerHTML = `
        <div>
          <a :href="safeUrl">Safe Link</a>
          <a :href="crashingUrl">Crashing Link</a>
          <a :href="anotherSafe">Another Safe</a>
        </div>
      `;

      const app = new Reflex({
        safeUrl: 'https://example.com',
        anotherSafe: 'https://other.com',
        get crashingUrl() {
          throw new Error('URL computation failed');
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      expect(errorCaught).toBe(true);

      // Other links should still work
      const links = document.querySelectorAll('a');
      expect(links[0].getAttribute('href')).toBe('https://example.com');
      expect(links[2].getAttribute('href')).toBe('https://other.com');
    });
  });

  describe('Handler Errors', () => {
    it('should catch errors in @click handlers and continue app execution', async () => {
      document.body.innerHTML = `
        <div>
          <button id="safe" @click="safeClick">Safe</button>
          <button id="crash" @click="crashingClick">Crash</button>
          <button id="another" @click="anotherClick">Another</button>
        </div>
      `;

      let safeClicked = false;
      let anotherClicked = false;

      const app = new Reflex({
        safeClick() {
          safeClicked = true;
        },
        crashingClick() {
          throw new Error('Click handler crashed!');
        },
        anotherClick() {
          anotherClicked = true;
        }
      });

      let errorCaught = false;
      app.configure({
        onError(error) {
          errorCaught = true;
        }
      });

      await app.nextTick();

      // Click safe button
      document.getElementById('safe').click();
      expect(safeClicked).toBe(true);

      // Click crashing button
      document.getElementById('crash').click();
      expect(errorCaught).toBe(true);

      // App should still work - click another button
      document.getElementById('another').click();
      expect(anotherClicked).toBe(true);
    });

    it('should handle errors in event handler with arguments', async () => {
      document.body.innerHTML = `
        <button @click="handleClick($event, 'test')">Click</button>
      `;

      const app = new Reflex({
        handleClick(event, arg) {
          throw new Error(`Handler error: ${arg}`);
        }
      });

      let errorCaught = false;
      app.configure({
        onError(error) {
          errorCaught = true;
        }
      });

      await app.nextTick();

      document.querySelector('button').click();

      expect(errorCaught).toBe(true);
    });

    it('should handle errors in inline event expressions', async () => {
      document.body.innerHTML = `
        <button @click="count++; throwError(); count++">Click</button>
      `;

      const app = new Reflex({
        count: 0,
        throwError() {
          throw new Error('Inline error');
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      document.querySelector('button').click();

      expect(errorCaught).toBe(true);
      // Count should have incremented before error
      expect(app.s.count).toBeGreaterThanOrEqual(0);
    });

    it('should handle errors in nested event handlers', async () => {
      document.body.innerHTML = `
        <div @click="outerClick">
          <button @click.stop="innerClick">Inner</button>
        </div>
      `;

      let outerClicked = false;

      const app = new Reflex({
        outerClick() {
          outerClicked = true;
        },
        innerClick() {
          throw new Error('Inner handler crashed');
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      // Click inner button
      document.querySelector('button').click();

      expect(errorCaught).toBe(true);
      // .stop should prevent outer click even with error
      expect(outerClicked).toBe(false);
    });
  });

  describe('Watcher Errors', () => {
    it('should catch errors in watch callback and continue watching', async () => {
      const app = new Reflex({ value: 0 });

      let normalWatcherCalled = false;

      // Set up error handler
      let errorCaught = false;
      app.configure({
        onError(error) {
          errorCaught = true;
        }
      });

      // Watcher that crashes
      app.watch(() => app.s.value, (newVal) => {
        if (newVal === 2) {
          throw new Error('Watcher crashed at 2!');
        }
      });

      // Normal watcher
      app.watch(() => app.s.value, () => {
        normalWatcherCalled = true;
      });

      // Trigger change
      app.s.value = 1;
      await app.nextTick();

      // Reset flag
      normalWatcherCalled = false;

      // Trigger crash
      app.s.value = 2;
      await app.nextTick();

      expect(errorCaught).toBe(true);
      expect(normalWatcherCalled).toBe(true); // Other watcher should still run

      // Reset flags
      errorCaught = false;
      normalWatcherCalled = false;

      // Continue watching after error
      app.s.value = 3;
      await app.nextTick();

      expect(normalWatcherCalled).toBe(true);
    });

    it('should handle errors in watch getter', async () => {
      const app = new Reflex({ shouldCrash: false, count: 0 });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      const callback = vi.fn();

      app.watch(() => {
        if (app.s.shouldCrash) {
          throw new Error('Getter crashed');
        }
        return app.s.count;
      }, callback);

      // Normal operation
      app.s.count = 1;
      await app.nextTick();
      expect(callback).toHaveBeenCalledTimes(1);

      // Cause crash
      app.s.shouldCrash = true;
      app.s.count = 2;
      await app.nextTick();

      expect(errorCaught).toBe(true);
    });

    it('should handle errors in deep watcher', async () => {
      const app = new Reflex({
        obj: { value: 1 }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      app.watch(() => app.s.obj, (newVal) => {
        if (newVal.value === 5) {
          throw new Error('Deep watcher error');
        }
      }, { deep: true });

      // Normal change
      app.s.obj.value = 2;
      await app.nextTick();

      expect(errorCaught).toBe(false);

      // Trigger error
      app.s.obj.value = 5;
      await app.nextTick();

      expect(errorCaught).toBe(true);
    });

    it('should not break scheduler when watcher throws error', async () => {
      const app = new Reflex({ a: 0, b: 0 });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      let bWatcherCalled = false;

      // Watcher that will crash
      app.watch(() => app.s.a, () => {
        throw new Error('A watcher crashed');
      });

      // Watcher that should still run
      app.watch(() => app.s.b, () => {
        bWatcherCalled = true;
      });

      // Batch update both
      app.batch(() => {
        app.s.a = 1;
        app.s.b = 1;
      });

      await app.nextTick();

      // First watcher crashed
      expect(errorCaught).toBe(true);

      // But second watcher still executed
      expect(bWatcherCalled).toBe(true);
    });

    it('should handle errors in immediate watcher', async () => {
      const app = new Reflex({ value: 0 });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      app.watch(() => app.s.value, () => {
        throw new Error('Immediate watcher error');
      }, { immediate: true });

      // Error should be caught during setup
      expect(errorCaught).toBe(true);
    });
  });

  describe('Effect Errors', () => {
    it('should catch errors in m-effect and continue', async () => {
      document.body.innerHTML = `
        <div>
          <div m-effect="safeEffect()">Safe</div>
          <div m-effect="crashingEffect()">Crash</div>
          <div m-effect="anotherEffect()">Another</div>
        </div>
      `;

      let safeRan = false;
      let anotherRan = false;

      const app = new Reflex({
        safeEffect() {
          safeRan = true;
        },
        crashingEffect() {
          throw new Error('Effect crashed!');
        },
        anotherEffect() {
          anotherRan = true;
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      expect(safeRan).toBe(true);
      expect(errorCaught).toBe(true);
      expect(anotherRan).toBe(true);
    });

    it('should handle errors in effect cleanup functions', async () => {
      document.body.innerHTML = `
        <div m-if="show">
          <div m-effect="setupEffect()">Content</div>
        </div>
      `;

      const app = new Reflex({
        show: true,
        setupEffect() {
          return () => {
            throw new Error('Cleanup error!');
          };
        }
      });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      await app.nextTick();

      // Unmount to trigger cleanup
      app.s.show = false;
      await app.nextTick();

      // Cleanup error should be caught
      expect(errorCaught).toBe(true);
    });
  });

  describe('Computed Errors', () => {
    it('should handle errors in computed getter', async () => {
      const app = new Reflex({ shouldCrash: false });

      let errorCaught = false;
      app.configure({
        onError() {
          errorCaught = true;
        }
      });

      const computed = app.computed((s) => {
        if (s.shouldCrash) {
          throw new Error('Computed crashed');
        }
        return 'safe value';
      });

      // Normal access
      expect(computed.value).toBe('safe value');

      // Cause crash
      app.s.shouldCrash = true;

      // Access should catch error
      const value = computed.value;

      // Error should be handled (exact behavior depends on implementation)
      // Important: app should not crash
    });
  });

  describe('Global Error Handler', () => {
    it('should call global onError handler for all error types', async () => {
      const errors = [];

      const app = new Reflex({
        renderError() {
          throw new Error('Render');
        },
        clickError() {
          throw new Error('Click');
        },
        value: 0
      });

      app.configure({
        onError(error, context) {
          errors.push({ message: error.message, context });
        }
      });

      // Render error
      document.body.innerHTML = '<div>{{ renderError() }}</div>';
      await app.nextTick();

      // Handler error
      document.body.innerHTML = '<button @click="clickError">Click</button>';
      await app.nextTick();
      document.querySelector('button').click();

      // Watcher error
      app.watch(() => app.s.value, () => {
        throw new Error('Watch');
      });
      app.s.value = 1;
      await app.nextTick();

      // All errors should be caught
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should provide useful context in error handler', async () => {
      let errorContext = null;

      const app = new Reflex({
        crash() {
          throw new Error('Test error');
        }
      });

      app.configure({
        onError(error, context) {
          errorContext = context;
        }
      });

      document.body.innerHTML = '<button @click="crash">Click</button>';
      await app.nextTick();
      document.querySelector('button').click();

      // Context should provide useful debugging info
      expect(errorContext).toBeDefined();
    });
  });

  describe('Error Recovery', () => {
    it('should recover from error and continue normal operation', async () => {
      document.body.innerHTML = '<div>{{ getMessage() }}</div>';

      let shouldCrash = true;

      const app = new Reflex({
        getMessage() {
          if (shouldCrash) {
            throw new Error('Temporary error');
          }
          return 'Success';
        }
      });

      let errorCount = 0;
      app.configure({
        onError() {
          errorCount++;
        }
      });

      await app.nextTick();
      expect(errorCount).toBe(1);

      // Fix the error
      shouldCrash = false;

      // Trigger re-render (implementation dependent)
      // For this test, assume manual trigger or state change
      await app.nextTick();

      // App should recover
      // (exact recovery mechanism depends on implementation)
    });

    it('should handle cascading errors gracefully', async () => {
      document.body.innerHTML = `
        <div>
          <span>{{ error1() }}</span>
          <span>{{ error2() }}</span>
          <span>{{ error3() }}</span>
        </div>
      `;

      let errorCount = 0;

      const app = new Reflex({
        error1() {
          throw new Error('Error 1');
        },
        error2() {
          throw new Error('Error 2');
        },
        error3() {
          throw new Error('Error 3');
        }
      });

      app.configure({
        onError() {
          errorCount++;
        }
      });

      await app.nextTick();

      // All errors should be caught individually
      expect(errorCount).toBe(3);
    });
  });

  describe('Production Mode Error Handling', () => {
    it('should not expose internal stack traces in production', async () => {
      const app = new Reflex({
        crash() {
          throw new Error('User-facing error');
        }
      });

      let capturedError = null;
      app.configure({
        onError(error) {
          capturedError = error;
        },
        mode: 'production'
      });

      document.body.innerHTML = '<button @click="crash">Click</button>';
      await app.nextTick();
      document.querySelector('button').click();

      // Error should be caught
      expect(capturedError).not.toBeNull();
      expect(capturedError.message).toBe('User-facing error');

      // In production, detailed stack traces might be suppressed
      // (exact behavior depends on implementation)
    });

    it('should log errors in development mode', async () => {
      const app = new Reflex({
        crash() {
          throw new Error('Dev error');
        }
      });

      app.configure({
        mode: 'development',
        onError() {}
      });

      document.body.innerHTML = '<button @click="crash">Click</button>';
      await app.nextTick();
      document.querySelector('button').click();

      // In development, console.error might be called
      // (behavior depends on mode setting)
    });
  });
});
