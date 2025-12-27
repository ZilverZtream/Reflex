/**
 * Reflex Auto-Cleanup Observer Module
 *
 * Provides automatic cleanup of Reflex elements when they are removed
 * from the DOM by external scripts (jQuery, HTMX, vanilla el.remove()).
 *
 * This is a tree-shakable module - if not imported, the MutationObserver
 * logic won't be included in the final bundle (zero-cost abstraction).
 *
 * @example
 * import { Reflex } from 'reflex';
 * import { withAutoCleanup } from 'reflex/observer';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withAutoCleanup);
 *
 * // Now external DOM removals trigger automatic cleanup:
 * document.querySelector('#my-component').remove();
 * // ^ Window/document listeners are automatically cleaned up!
 *
 * @module reflex/observer
 */

export { withAutoCleanup, autoCleanup, RX_MARKER, default } from './withAutoCleanup.js';
