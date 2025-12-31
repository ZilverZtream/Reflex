/**
 * Reflex Core - Compiler and Directives
 *
 * Handles DOM walking, template compilation, and directive processing.
 * Includes:
 * - DOM tree walking with m-if/m-for structural directives
 * - Attribute bindings (:attr="expr")
 * - Event handlers (@event="expr")
 * - Two-way binding (m-model)
 * - Text interpolation ({{ expr }})
 * - Transitions (m-trans)
 *
 * RENDERER ABSTRACTION:
 * This module uses a pluggable renderer architecture. All DOM operations
 * go through `this._ren` (the renderer adapter) to support:
 * - Web targets (DOMRenderer - zero-cost browser DOM)
 * - Native targets (VirtualRenderer - abstract VDOM)
 * - Test environments (Mock rendering)
 */

// Re-export utilities
export {
  objectKeyMap,
  objectKeyUid,
  weakRefWarningShown,
  setWeakRefWarningShown,
  MILLISECONDS_PER_SECOND,
  TRANSITION_BUFFER_MS,
  OBJECT_KEY_PREFIX,
  getRawValue,
  getStableKey,
  parsePath,
  cloneNodeWithProps,
  hasStrictParent,
  sortRefsByDOM,
  type PathSegment
} from './utils.js';

// Re-export transitions
export { runTransition, TransitionMixin } from './transitions.js';

// Re-export styles
export { StylesMixin } from './styles.js';

// Re-export events
export { EventsMixin } from './events.js';

// Re-export text-html
export { TextHtmlMixin } from './text-html.js';

// Re-export forms
export { FormsMixin } from './forms.js';

// Re-export bindings
export { BindingsMixin } from './bindings.js';

// Re-export directives
export { DirectivesMixin } from './directives.js';

// Re-export walker
export { WalkerMixin } from './walker.js';

// Import all mixins for the combined CompilerMixin
import { TransitionMixin } from './transitions.js';
import { StylesMixin } from './styles.js';
import { EventsMixin } from './events.js';
import { TextHtmlMixin } from './text-html.js';
import { FormsMixin } from './forms.js';
import { BindingsMixin } from './bindings.js';
import { DirectivesMixin } from './directives.js';
import { WalkerMixin } from './walker.js';

/**
 * CompilerMixin - Combined mixin for Reflex class.
 *
 * This combines all the individual mixins into a single object that can be
 * mixed into the Reflex class. Each mixin provides a specific set of functionality:
 *
 * - WalkerMixin: DOM tree walking and scope registration
 * - BindingsMixin: Attribute bindings (:attr="expr")
 * - DirectivesMixin: Structural directives (m-if, m-for, m-show, m-effect)
 * - FormsMixin: Two-way binding (m-model)
 * - EventsMixin: Event handlers (@event="expr")
 * - TextHtmlMixin: Text interpolation and m-html
 * - StylesMixin: Style/class binding helpers
 * - TransitionMixin: Transition handling
 */
export const CompilerMixin = {
  ...WalkerMixin,
  ...BindingsMixin,
  ...DirectivesMixin,
  ...FormsMixin,
  ...EventsMixin,
  ...TextHtmlMixin,
  ...StylesMixin,
  ...TransitionMixin
};
