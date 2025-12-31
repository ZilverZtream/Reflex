/**
 * Reflex Core - Event Binding
 *
 * Handles event binding with modifiers and delegation.
 */

import { weakRefWarningShown, setWeakRefWarningShown } from './utils.js';

/**
 * EventsMixin for Reflex class.
 * Provides event binding methods.
 */
export const EventsMixin = {
  /**
   * Event binding: @event.mod1.mod2="expr"
   * @param el - Element to bind event to
   * @param nm - Event name (e.g., "click")
   * @param exp - Expression to evaluate
   * @param o - Scope object
   * @param mod - Array of modifiers (e.g., ["stop", "prevent"])
   */
  _ev(this: any, el: Element, nm: string, exp: string, o: any, mod: string[] = []): void {
    let fn = this._fn(exp, true);

    // Parse debounce/throttle timing from modifiers
    const getDelay = (prefix: string): number => {
      for (const m of mod) {
        if (m.startsWith(prefix)) return parseInt(m.slice(prefix.length), 10) || 300;
        const match = m.match(/^(\d+)(ms)?$/);
        if (match && mod.includes(prefix.slice(0, -1))) return parseInt(match[1], 10);
      }
      return mod.includes(prefix.slice(0, -1)) ? 300 : 0;
    };

    // Track timer IDs for cleanup to prevent memory leaks
    const timers: { debounce?: number | null; throttle?: number | null } = {};

    // Debounce modifier: @input.debounce.300ms="search"
    const debounceDelay = getDelay('debounce.');
    if (debounceDelay || mod.includes('debounce')) {
      const delay = debounceDelay || 300;
      const origFn = fn;
      timers.debounce = null;
      fn = (s: any, c: any, e: Event) => {
        if (timers.debounce !== null) clearTimeout(timers.debounce);
        timers.debounce = setTimeout(() => {
          timers.debounce = null;
          origFn(s, c, e);
        }, delay) as any;
      };
      // Register cleanup to prevent memory leaks
      this._reg(el, () => {
        if (timers.debounce !== null) {
          clearTimeout(timers.debounce);
          timers.debounce = null;
        }
      });
    }

    // Throttle modifier: @scroll.throttle.100ms="onScroll"
    const throttleDelay = getDelay('throttle.');
    if (throttleDelay || mod.includes('throttle')) {
      const delay = throttleDelay || 300;
      const origFn = fn;
      let last = 0;
      timers.throttle = null;
      fn = (s: any, c: any, e: Event) => {
        // CRITICAL FIX: Use performance.now() for monotonic time (not affected by system clock changes)
        const now = performance.now();
        if (now - last >= delay) {
          last = now;
          origFn(s, c, e);
        }
      };
    }

    // Window/Document modifiers: @keydown.window="handleKey"
    if (mod.includes('window') || mod.includes('document')) {
      // SSR/Node.js compatibility: use renderer to get target
      let target: any;
      if (this._ren.isBrowser) {
        // Browser mode: use actual window/document
        target = mod.includes('window') ? window : document;
      } else {
        // Virtual/SSR mode: bind to the virtual root
        // VirtualRenderer doesn't have a 'window', but 'root' captures events
        target = this._ren.getRoot();
      }
      const self = this;

      // CRITICAL LIFECYCLE FIX #9: Event Listener Leak (Window/Document)
      //
      // VULNERABILITY: If element is removed by external code (jQuery, D3, innerHTML=''),
      // the Reflex cleanup mechanism (_kill) is never triggered, leaking window/document listeners
      //
      // SOLUTION: Use WeakRef + FinalizationRegistry to avoid circular references
      // The handler uses WeakRef to avoid strongly capturing 'el', allowing GC when el is no longer referenced
      const elRef = typeof WeakRef !== 'undefined' ? new WeakRef(el) : null;

      // CRITICAL FIX: Warn if WeakRef is not available (memory leak risk in old browsers)
      if (!elRef && !weakRefWarningShown && typeof console !== 'undefined' && console.warn) {
        setWeakRefWarningShown(true);
        console.warn(
          'Reflex: WeakRef not supported in this environment. ' +
          'Window/document event listeners may not be properly cleaned up, ' +
          'potentially causing memory leaks in long-running applications.'
        );
      }

      const handler = (e: Event) => {
        // Deref the element - if it's been GC'd, cleanup and exit
        const element = elRef ? elRef.deref() : el;
        if (!element) {
          // Element has been garbage collected, remove this listener
          target.removeEventListener(nm, handler, opts);
          return;
        }

        if (mod.includes('prevent')) e.preventDefault();
        if (mod.includes('stop')) e.stopPropagation();
        try {
          fn(self.s, o, e, element);
        } catch (err) {
          self._handleError(err, o);
        }
      };
      const opts: AddEventListenerOptions | undefined = mod.includes('once') ? { once: true } : undefined;
      target.addEventListener(nm, handler, opts);

      // Register cleanup with Reflex lifecycle
      const cleanup = () => target.removeEventListener(nm, handler, opts);
      this._reg(el, cleanup);

      // Modern browsers: Use FinalizationRegistry for automatic cleanup when element is GC'd
      // IMPORTANT: We pass cleanup data (not a closure) to avoid circular references
      // The held value must NOT reference 'el' directly or indirectly
      if (typeof FinalizationRegistry !== 'undefined') {
        if (!this._globalListenerRegistry) {
          this._globalListenerRegistry = new FinalizationRegistry((cleanupData: any) => {
            // cleanupData contains: { target, eventName, handler, options }
            // This callback runs when the element is GC'd
            cleanupData.target.removeEventListener(cleanupData.eventName, cleanupData.handler, cleanupData.options);
          });
        }
        // Register the element for cleanup when it's garbage collected
        // Pass cleanup data (not a function) to avoid capturing 'el' in the held value
        this._globalListenerRegistry.register(el, { target, eventName: nm, handler, options: opts });
      }

      return;
    }

    // Outside modifier: @click.outside="closeModal"
    if (mod.includes('outside')) {
      // SSR/Node.js compatibility: use renderer to get document root
      const docTarget = this._ren.isBrowser ? document : this._ren.getRoot();
      const self = this;
      const handler = (e: Event) => {
        if (!el.contains(e.target as Node) && e.target !== el) {
          if (mod.includes('prevent')) e.preventDefault();
          if (mod.includes('stop')) e.stopPropagation();
          try {
            fn(self.s, o, e, el);
          } catch (err) {
            self._handleError(err, o);
          }
        }
      };
      docTarget.addEventListener(nm, handler);
      this._reg(el, () => docTarget.removeEventListener(nm, handler));
      return;
    }

    // CRITICAL FIX: Non-bubbling events (focus, blur, scroll on some elements)
    // These events don't bubble, so they never reach the root listener
    // Must use direct binding instead of delegation
    const nonBubblingEvents = ['focus', 'blur', 'load', 'unload', 'scroll', 'mouseenter', 'mouseleave'];
    const isNonBubbling = nonBubblingEvents.includes(nm);

    // Use direct binding for .stop, .self, and non-bubbling events (delegation won't work for these)
    if (mod.includes('stop') || mod.includes('self') || isNonBubbling) {
      const self = this;
      const handler = (e: Event) => {
        if (mod.includes('self') && e.target !== el) return;
        if (mod.includes('prevent')) e.preventDefault();
        if (mod.includes('stop')) e.stopPropagation();

        // Check key modifiers
        if ((e as KeyboardEvent).key) {
          if (mod.includes('enter') && (e as KeyboardEvent).key !== 'Enter') return;
          if (mod.includes('esc') && (e as KeyboardEvent).key !== 'Escape') return;
          if (mod.includes('space') && (e as KeyboardEvent).key !== ' ') return;
          if (mod.includes('tab') && (e as KeyboardEvent).key !== 'Tab') return;
        }
        if (mod.includes('ctrl') && !(e as KeyboardEvent).ctrlKey) return;
        if (mod.includes('alt') && !(e as KeyboardEvent).altKey) return;
        if (mod.includes('shift') && !(e as KeyboardEvent).shiftKey) return;
        if (mod.includes('meta') && !(e as KeyboardEvent).metaKey) return;

        try {
          fn(self.s, o, e, el);
        } catch (err) {
          self._handleError(err, o);
        }
      };

      const opts = mod.includes('once') ? { once: true } : undefined;
      el.addEventListener(nm, handler, opts);
      this._reg(el, () => el.removeEventListener(nm, handler, opts));
      return;
    }

    // Default: use event delegation
    if (!this._dh.has(nm)) {
      // CRITICAL FIX: Store handler function reference for removal during unmount
      const handler = (e: Event) => this._hdl(e, nm);
      const eventData = { handlers: new WeakMap(), listener: handler };
      this._dh.set(nm, eventData);
      this._dr.addEventListener(nm, handler);
    }
    this._dh.get(nm).handlers.set(el, { f: fn, o, m: mod });
  },

  /**
   * Delegated event handler
   */
  _hdl(this: any, e: Event, nm: string): void {
    let t = e.target as Node | null;
    while (t && t !== this._dr) {
      const h = this._dh.get(nm)?.handlers?.get(t);
      if (h) {
        const { f, o, m } = h;
        if (m.includes('self') && e.target !== t) { t = (t as Element).parentNode; continue; }

        // Check key modifiers
        // Key-specific modifiers (enter, esc, etc.)
        if ((e as KeyboardEvent).key) {
          if (m.includes('enter') && (e as KeyboardEvent).key !== 'Enter') { t = (t as Element).parentNode; continue; }
          if (m.includes('esc') && (e as KeyboardEvent).key !== 'Escape') { t = (t as Element).parentNode; continue; }
          if (m.includes('space') && (e as KeyboardEvent).key !== ' ') { t = (t as Element).parentNode; continue; }
          if (m.includes('tab') && (e as KeyboardEvent).key !== 'Tab') { t = (t as Element).parentNode; continue; }
        }
        // System key modifiers (ctrl, alt, shift, meta) - work with any event type
        if (m.includes('ctrl') && !(e as KeyboardEvent).ctrlKey) { t = (t as Element).parentNode; continue; }
        if (m.includes('alt') && !(e as KeyboardEvent).altKey) { t = (t as Element).parentNode; continue; }
        if (m.includes('shift') && !(e as KeyboardEvent).shiftKey) { t = (t as Element).parentNode; continue; }
        if (m.includes('meta') && !(e as KeyboardEvent).metaKey) { t = (t as Element).parentNode; continue; }

        if (m.includes('prevent')) e.preventDefault();
        if (m.includes('stop')) e.stopPropagation();

        // Wrap handler in try-catch for error handling
        try {
          f(this.s, o, e, t);
        } catch (err) {
          this._handleError(err, o);
        }

        if (m.includes('once')) this._dh.get(nm).handlers.delete(t);
        if (e.cancelBubble) return;
      }
      t = (t as Element).parentNode;
    }
  }
};
