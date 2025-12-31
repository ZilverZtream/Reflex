/**
 * Reflex Core - Compiler and Directives
 *
 * This file re-exports the modular compiler components.
 * The compiler has been refactored into separate modules for better maintainability:
 *
 * - compiler/utils.ts: Shared utilities and constants
 * - compiler/transitions.ts: CSS transition handling
 * - compiler/styles.ts: Style/class binding helpers and CSS sanitization
 * - compiler/events.ts: Event binding and delegation
 * - compiler/text-html.ts: Text interpolation and m-html directive
 * - compiler/forms.ts: m-model two-way binding
 * - compiler/bindings.ts: Attribute bindings
 * - compiler/directives.ts: Structural directives (m-if, m-for, m-show, m-effect)
 * - compiler/walker.ts: DOM tree walking
 * - compiler/index.ts: Combined CompilerMixin
 */

// Re-export everything from the modular compiler
export {
  // Utilities
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
  type PathSegment,

  // Transitions
  runTransition,
  TransitionMixin,

  // Styles
  StylesMixin,

  // Events
  EventsMixin,

  // Text/HTML
  TextHtmlMixin,

  // Forms
  FormsMixin,

  // Bindings
  BindingsMixin,

  // Directives
  DirectivesMixin,

  // Walker
  WalkerMixin,

  // Combined Mixin
  CompilerMixin
} from './compiler/index.js';
