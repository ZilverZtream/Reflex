/**
 * Reflex Hydration Module
 *
 * Provides SSR hydration support for Reflex applications.
 * This is a tree-shakable module - if not imported, the hydration
 * logic won't be included in the final bundle.
 *
 * @example
 * import { Reflex } from 'reflex';
 * import { withHydration } from 'reflex/hydration';
 *
 * const app = new Reflex({ count: 0 });
 * app.use(withHydration);
 * app.hydrate(document.getElementById('app'));
 *
 * @module reflex/hydration
 */

export { withHydration, default } from './withHydration.js';
