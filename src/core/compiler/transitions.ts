/**
 * Reflex Core - Transition System
 *
 * CSS Transition helper for enter/leave animations.
 * Follows Vue/Alpine naming convention:
 * - {name}-enter-from, {name}-enter-active, {name}-enter-to
 * - {name}-leave-from, {name}-leave-active, {name}-leave-to
 */

import type { IRendererAdapter } from '../../renderers/types.js';
import { MILLISECONDS_PER_SECOND, TRANSITION_BUFFER_MS } from './utils.js';

/**
 * CSS Transition helper for enter/leave animations.
 *
 * This function supports both direct DOM usage and the pluggable renderer.
 * When a Reflex instance with a renderer is provided, it uses the renderer's
 * animation frame and computed style methods.
 *
 * @param el - The element to animate
 * @param name - Transition name (e.g., 'fade', 'slide')
 * @param type - 'enter' or 'leave'
 * @param done - Callback when transition completes
 * @param reflex - Optional Reflex instance to register cleanup in lifecycle registry
 */
export function runTransition(el: any, name: string, type: 'enter' | 'leave', done?: () => void, reflex?: any): void {
  // CRITICAL FIX: Transition Race Condition Prevention
  // If a transition is already running on this element, cancel it first
  // Example: m-if toggles from false->true (leave starts) then true->false (enter starts)
  // Without cancellation, the leave's done callback would fire and remove the element!
  if (el._transCb) {
    // Cancel the previous transition's done callback
    el._transCb.cancelled = true;
    // Call cleanup to remove old classes and listeners
    if (el._transCleanup) {
      el._transCleanup();
    }
  }

  const from = `${name}-${type}-from`;
  const active = `${name}-${type}-active`;
  const to = `${name}-${type}-to`;

  // Get renderer from reflex instance if available
  const renderer: IRendererAdapter | undefined = reflex?._ren;

  // Add initial classes
  el.classList.add(from, active);

  // Force reflow to ensure initial state is applied (browser only)
  if (typeof el.offsetHeight !== 'undefined') {
    el.offsetHeight; // eslint-disable-line no-unused-expressions
  }

  // Track cleanup state to prevent double execution
  let cleaned = false;
  let timeoutId: any = null;

  // CRITICAL FIX: Track transition completion to prevent early cutoff
  // transitionend fires for EVERY property (opacity, transform, etc.)
  // We must wait for all properties to finish, not just the first one
  // CRITICAL FIX: Use performance.now() instead of Date.now() for monotonic time
  // Date.now() can jump backwards/forwards due to NTP sync, causing transitions to hang/skip
  // performance.now() is monotonic and unaffected by system time adjustments
  let expectedEndTime = 0;

  // Cleanup function to cancel transition
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    // Clear timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Remove event listeners
    el.removeEventListener('transitionend', onEnd);
    el.removeEventListener('animationend', onEnd);

    // Remove transition classes
    el.classList.remove(from, active, to);

    // Clear stored callbacks
    if (el._transCb === transitionCallback) {
      el._transCb = null;
    }
    if (el._transCleanup === cleanup) {
      el._transCleanup = null;
    }
  };

  // Store cleanup for cancellation
  el._transCleanup = cleanup;

  // Create transition callback wrapper that can be cancelled
  const transitionCallback = {
    cancelled: false,
    done: done
  };
  el._transCb = transitionCallback;

  // Register cleanup in element's lifecycle registry if Reflex instance provided
  if (reflex && typeof reflex._reg === 'function') {
    reflex._reg(el, cleanup);
  }

  // End handler
  const onEnd = (e: Event) => {
    if ((e as any).target !== el || cleaned) return;

    // CRITICAL FIX: Only complete if we've reached the expected end time
    // This prevents early completion when multiple properties are transitioning
    // Example: opacity 0.2s, transform 1s - don't complete at 0.2s!
    // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
    const now = performance.now();
    if (now < expectedEndTime) {
      // Not all properties have finished yet, wait for more events
      return;
    }

    cleanup();
    // Only call done if this transition wasn't cancelled
    if (!transitionCallback.cancelled && done) {
      done();
    }
  };

  // Use renderer's requestAnimationFrame if available, otherwise use global
  const raf = renderer?.requestAnimationFrame ?? requestAnimationFrame;

  // CRITICAL FIX #8: Flaky Transitions - Use Double RAF
  // A single requestAnimationFrame is often insufficient for the browser to apply the initial styles
  // Browsers batch style updates, and a single frame may not guarantee the '-from' class has rendered
  // Using two frames ensures the initial state is fully applied before transitioning
  raf(() => {
    if (cleaned || transitionCallback.cancelled) return; // Transition was cancelled before it started

    // Second frame: Now swap classes to trigger the transition
    raf(() => {
      if (cleaned || transitionCallback.cancelled) return; // Transition was cancelled during first frame

      el.classList.remove(from);
      el.classList.add(to);

      // Listen for transition end
      el.addEventListener('transitionend', onEnd);
      el.addEventListener('animationend', onEnd);

      // Use renderer's getComputedStyle if available, otherwise use global
      const getStyle = renderer?.getComputedStyle ?? getComputedStyle;

      // Fallback timeout (in case transitionend doesn't fire)
      const style = getStyle(el);

      // CRITICAL FIX (Issue #7): Parse all comma-separated duration values and use the maximum
      // Previously: parseFloat("0.5s, 1s") returned 0.5, cutting off the animation early
      // When an element has multiple transitions (e.g., opacity 0.5s, transform 1s),
      // the browser reports "0.5s, 1s" but parseFloat only gets the first value.
      //
      // Solution: Split by comma, parse each value, and use the maximum.
      const parseMaxDuration = (str: string): number => {
        if (!str) return 0;
        return Math.max(...str.split(',').map(s => {
          const val = parseFloat(s.trim());
          return isNaN(val) ? 0 : val;
        }));
      };

      const duration = parseMaxDuration(style.transitionDuration) || parseMaxDuration(style.animationDuration) || 0;
      const delay = parseMaxDuration(style.transitionDelay) || parseMaxDuration(style.animationDelay) || 0;
      const timeout = (duration + delay) * MILLISECONDS_PER_SECOND + TRANSITION_BUFFER_MS;

      // Set expected end time for transition completion check
      // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
      expectedEndTime = performance.now() + (duration + delay) * MILLISECONDS_PER_SECOND;

      if (timeout > TRANSITION_BUFFER_MS) {
        timeoutId = setTimeout(() => {
          if (cleaned || transitionCallback.cancelled) return;
          cleanup();
          if (!transitionCallback.cancelled && done) {
            done();
          }
        }, timeout);
      } else {
        // No transition defined, complete immediately
        cleanup();
        if (!transitionCallback.cancelled && done) {
          done();
        }
      }
    });
  });
}

/**
 * TransitionMixin for Reflex class.
 * Provides the _runTrans method that uses renderer abstraction.
 */
export const TransitionMixin = {
  /**
   * Run transition with renderer abstraction.
   *
   * Checks if the renderer has a runTransition method (e.g., VirtualRenderer).
   * If yes, uses the renderer's implementation (instant for tests/SSR).
   * If no, falls back to the internal runTransition (browser animations).
   *
   * This allows:
   * - VirtualRenderer to "skip" animations instantly (essential for fast unit tests)
   * - DOMRenderer to play animations smoothly in the browser
   * - Custom renderers to implement their own animation systems
   *
   * @param el - The element to animate
   * @param name - Transition name (e.g., 'fade', 'slide')
   * @param type - 'enter' or 'leave'
   * @param done - Callback when transition completes
   */
  _runTrans(this: any, el: any, name: string, type: 'enter' | 'leave', done?: () => void): void {
    if (this._ren.runTransition) {
      // Use renderer's transition implementation (instant for virtual, animated for DOM)
      this._ren.runTransition(el, { name, type, done }, this);
    } else {
      // Fallback to internal runTransition function
      runTransition(el, name, type, done, this);
    }
  }
};
