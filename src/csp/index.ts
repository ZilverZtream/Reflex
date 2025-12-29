/**
 * Reflex CSP-Safe Module
 *
 * Optional module for CSP-compliant expression evaluation.
 * Import this only if you need to run in strict CSP environments
 * that disallow `new Function()` or `eval()`.
 */

export { SafeExprParser, ScopeContainer } from './SafeExprParser.js';
export {
  ScopeRegistry,
  createFlatScope,
  isFlatScope,
  getFlatScopeValue,
  setFlatScopeValue,
  hasFlatScopeValue,
  FLAT_SCOPE_MARKER,
  type FlatScope,
  type FlatScopeIds
} from '../core/scope-registry.js';
