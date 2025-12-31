/**
 * Reflex Core - Attribute Bindings
 *
 * Handles attribute bindings (:attr="expr") and processes element bindings.
 */

import { SAFE_URL_RE, RELATIVE_URL_RE } from '../symbols.js';
import { queueMicrotaskSafe } from '../scheduler.js';
import { isFlatScope } from '../scope-registry.js';

/**
 * BindingsMixin for Reflex class.
 * Provides attribute binding methods.
 */
export const BindingsMixin = {
  /**
   * Process bindings on an element.
   */
  _bnd(this: any, n: Element, o: any): void {
    const atts = n.attributes;
    if (!atts) return;
    const trans = n.getAttribute('m-trans'); // For m-show transitions

    // CRITICAL FIX: Pre-set object value reference for checkboxes/radios
    // Attributes are processed in reverse order, so m-model runs before :value.
    // TASK 6: Eagerly evaluate and store the object reference in WeakMap BEFORE any effects run.
    // This ensures m-model can find the valueRef when setting initial checked state.
    if (((n as HTMLInputElement).type === 'checkbox' || (n as HTMLInputElement).type === 'radio') && n.hasAttribute(':value')) {
      const valueExp = n.getAttribute(':value');
      if (valueExp) {
        try {
          const fn = this._fn(valueExp);
          const initialValue = fn(this.s, o);
          if (initialValue !== null && typeof initialValue === 'object') {
            // TASK 6: Store in WeakMap instead of DOM property
            const state = this._nodeState.get(n) || {};
            state.valueRef = initialValue;
            this._nodeState.set(n, state);
          }
        } catch (e) {
          // Ignore errors - effect will handle it
        }
      }
    }

    for (let i = atts.length - 1; i >= 0; i--) {
      const a = atts[i], nm = a.name, v = a.value;

      if (nm.startsWith(':')) {
        this._at(n, nm.slice(1), v, o);
      } else if (nm.startsWith('@')) {
        // CRITICAL FIX: Event Modifier Separation
        // Extract modifiers here (like m-model) for consistency and clarity
        // @click.stop.prevent becomes eventName="click", modifiers=["stop", "prevent"]
        const parts = nm.slice(1).split('.');
        const eventName = parts[0];
        const modifiers = parts.slice(1);
        this._ev(n, eventName, v, o, modifiers);
      } else if (nm.startsWith('m-')) {
        if (nm.startsWith('m-model')) {
          // Extract modifiers from m-model (e.g., m-model.lazy)
          const modifiers = nm.split('.').slice(1);
          this._mod(n, v, o, modifiers);
        } else if (nm === 'm-text') this._at(n, 'textContent', v, o);
        else if (nm === 'm-html') this._html(n, v, o);
        else if (nm === 'm-show') this._show(n, v, o, trans);
        else if (nm === 'm-effect') this._effect(n, v, o);
        else if (nm === 'm-ref') {
          // CRITICAL FIX: m-ref in loops (array ref support)
          // If used inside m-for, every row would overwrite the same ref variable.
          // Solution: If the ref is initialized as an array, push to it instead of replacing.
          // Example: <div m-for="item in items" m-ref="itemRefs">
          //   - state.itemRefs = [] (initialized as array)
          //   - Each element gets pushed to the array
          //   - Cleanup removes the element from the array

          // TASK 8.4: Check if this ref should be an array (for m-for usage)
          // Auto-detect array mode by checking:
          // 1. If state[refName] is already an array (user pre-initialized)
          // 2. If _refs[refName] is already an array (second+ item in loop)
          // 3. If scope is a loop scope (has loop variables like item, index)
          // Use property access instead of 'in' operator for proxy compatibility
          const isArrayRef = (this.s[v] && Array.isArray(this.s[v])) ||
                             Array.isArray(this._refs[v]) ||
                             (o && isFlatScope(o) && Object.keys(o._ids).length > 0);

          if (isArrayRef) {
            // Array mode: push element to array
            // TASK 8.4: Initialize arrays if they don't exist
            if (!Array.isArray(this._refs[v])) {
              this._refs[v] = [];
            }
            // TASK 9.2: Ensure state array exists for synchronization
            if (!this.s[v] || !Array.isArray(this.s[v])) {
              this.s[v] = [];
            }
            this.s[v].push(n);
            this._refs[v].push(n);

            // CRITICAL FIX (Issue #1): O(N²) Unmount Performance Fix for m-ref Arrays
            //
            // PROBLEM: When unmounting a list of N items (e.g., navigating away from a page
            // with 5,000 items), _kill runs for every item. Each cleanup callback uses
            // splice() which is O(N) because it shifts all subsequent elements.
            // N calls × O(N) splice = O(N²) complexity.
            //
            // SOLUTION: Use batched removal with Set for O(1) marking + single O(N) filter.
            // Instead of immediately splicing, we mark elements for removal in a Set.
            // On the next microtask, we filter out all marked elements in one pass.
            // This converts O(N²) to O(N) for bulk unmounts.
            //
            // CORRECTNESS: DOM order is still preserved because:
            // 1. filter() preserves relative order of remaining elements
            // 2. The microtask runs synchronously after all unmount callbacks complete
            // 3. Developers accessing refs during unmount will still see correct order
            //    (elements are only removed after all callbacks have run)
            this._reg(n, () => {
              const stateArray = this.s[v];
              const refsArray = this._refs[v];

              // Initialize batch removal sets if they don't exist
              if (!this._refBatchRemoval) {
                this._refBatchRemoval = new Map();
              }

              // Get or create the batch for this ref name
              let batch = this._refBatchRemoval.get(v);
              if (!batch) {
                batch = { stateSet: new Set(), refsSet: new Set(), scheduled: false };
                this._refBatchRemoval.set(v, batch);
              }

              // Mark element for removal (O(1))
              if (Array.isArray(stateArray)) {
                batch.stateSet.add(n);
              }
              if (Array.isArray(refsArray)) {
                batch.refsSet.add(n);
              }

              // Schedule batch removal if not already scheduled
              if (!batch.scheduled) {
                batch.scheduled = true;
                queueMicrotaskSafe(() => {
                  // Apply batch removal (single O(N) filter)
                  if (batch.stateSet.size > 0 && Array.isArray(this.s[v])) {
                    const raw = this.toRaw(this.s[v]);
                    // Filter in place to avoid creating new array
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < raw.length; readIdx++) {
                      if (!batch.stateSet.has(raw[readIdx])) {
                        raw[writeIdx++] = raw[readIdx];
                      }
                    }
                    raw.length = writeIdx;
                  }

                  if (batch.refsSet.size > 0 && Array.isArray(this._refs[v])) {
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < this._refs[v].length; readIdx++) {
                      if (!batch.refsSet.has(this._refs[v][readIdx])) {
                        this._refs[v][writeIdx++] = this._refs[v][readIdx];
                      }
                    }
                    this._refs[v].length = writeIdx;
                  }

                  // Clear the batch
                  this._refBatchRemoval.delete(v);
                });
              }
            });
          } else {
            // Single mode: replace ref (original behavior)
            this._refs[v] = n;
            if (v in this.s) {
              this.s[v] = n;
            }
            this._reg(n, () => {
              // CRITICAL: Set to null before deleting to break references
              // This prevents memory leaks from "Detached DOM Nodes"
              this._refs[v] = null;
              delete this._refs[v];
              if (v in this.s) {
                this.s[v] = null;
              }
            });
          }
        } else {
          // Check for custom directives: m-name.mod1.mod2="value"
          const parts = nm.slice(2).split('.');
          const dirName = parts[0];
          const mods = parts.slice(1);
          this._applyDir(n, dirName, v, mods, o);
        }
      }
    }
  },

  /**
   * Attribute binding: :attr="expr"
   */
  _at(this: any, el: Element, att: string, exp: string, o: any): void {
    // CRITICAL SECURITY FIX #2: XSS via Dynamic Attribute Binding
    // Block event handler attributes (onclick, onload, onmouseover, etc.)
    // Without this check, :onclick="malicious" or :[userAttr]="code" bypasses expression security
    // The browser's DOM event system executes the attribute value as JavaScript
    //
    // TASK 12.5: Whitelist safe "on" attributes
    // The naive attr.startsWith('on') blocks valid attributes like 'only', 'once', 'loading="lazy"'
    // Whitelist known-safe attributes that happen to start with "on"
    const SAFE_ON_ATTRS = new Set([
      'only',       // Common boolean/value attribute
      'once',       // Playback attribute for audio/video
      'on',         // Some frameworks use this
      'one',        // Generic attribute
      'online',     // Network status attribute
      // NOTE: Event handlers like 'onerror', 'onclick', 'onload' are NOT whitelisted
    ]);

    const attrLower = att.toLowerCase();
    if (attrLower.startsWith('on') && !SAFE_ON_ATTRS.has(attrLower)) {
      // Additional check: event handlers are specifically "on" + event name
      // Event names are things like "click", "load", "error", "mouseover" etc.
      // If it's a known safe attribute, allow it
      throw new Error(
        `Reflex: SECURITY ERROR - Cannot bind event handler attribute '${att}'.\n` +
        `Event handlers must use @ syntax (e.g., @click="handler") for security.\n` +
        `This prevents XSS attacks via dynamic attribute names.`
      );
    }

    const fn = this._fn(exp);
    let prev: any;
    // CRITICAL SECURITY FIX: Validate URL attributes
    // CRITICAL FIX: Remove srcdoc from URL validation - it contains HTML, not URLs
    // srcdoc requires HTML sanitization (DOMPurify), not URL validation
    // data (object/embed) can point to javascript: URIs or malicious content
    const isUrlAttr = att === 'href' || att === 'src' || att === 'action' ||
                      att === 'formaction' || att === 'xlink:href' || att === 'data';
    // srcdoc requires separate HTML sanitization
    const isSrcdoc = att === 'srcdoc';

    // Handle kebab-case to camelCase conversion for SVG attributes
    // e.g., :view-box -> viewBox
    let attrName = att;
    if (att.includes('-')) {
      attrName = att.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    // SVG attributes that should always use setAttribute (not property access)
    // These are read-only properties that return SVGAnimated* objects
    const isSVGAttr = attrName === 'viewBox' || attrName === 'preserveAspectRatio' ||
                      attrName === 'transform' || attrName === 'gradientTransform' ||
                      attrName === 'patternTransform';

    // Cache initial static class/style to preserve when binding dynamic values
    // This prevents the "class wipeout" bug where :class overwrites static classes
    // TASK 13.3: During hydration, we MUST read the existing className and style.cssText
    // The SSR-rendered values should be preserved, not destroyed. The previous logic was
    // backwards - it skipped capture during hydration, causing static classes to be lost.
    const initialClass = att === 'class' ? (el as HTMLElement).className : null;
    const initialStyle = att === 'style' ? el.getAttribute('style') || '' : null;

    // Track previous style keys for cleanup (fixes "stale style" bug)
    // When style object changes, we need to explicitly remove old properties
    let prevStyleKeys: Set<string> | null = null;

    const e = this.createEffect(() => {
      try {
        let v = fn(this.s, o);

        // SECURITY FIX: Validate URL protocols using allowlist instead of blocklist
        // Only allow known-safe protocols (http, https, mailto, tel, etc.) and relative URLs
        // CRITICAL: Decode HTML entities AND strip control characters BEFORE validation
        // Attack vectors:
        //   1. Entity encoding: :href="'j&#97;vascript:alert(1)'"
        //      - Regex sees: j&#97;vascript: (passes)
        //      - Browser sees: javascript:alert(1) (executes!)
        //   2. Control characters: :href="'java\tscript:alert(1)'"
        //      - Regex sees: java\tscript: (passes if not stripped)
        //      - Browser sees: javascript:alert(1) (executes!)
        if (isUrlAttr && v != null && typeof v === 'string') {
          // CRITICAL FIX: Use centralized sanitization helper
          // This decodes ALL entities (including &Tab;, &NewLine;, etc.)
          // and strips ALL control characters (0x00-0x1F, 0x7F-0x9F)
          const sanitizedUrl = this._decodeAndSanitizeUrl(v);

          // Check the sanitized URL against our allowlist
          const isSafe = RELATIVE_URL_RE.test(sanitizedUrl) || SAFE_URL_RE.test(sanitizedUrl);
          if (!isSafe) {
            console.warn('Reflex: Blocked unsafe URL protocol in', att + ':', v, `(sanitized: ${sanitizedUrl})`);
            v = 'about:blank';
          }
        }

        // CRITICAL FIX: srcdoc validation - requires HTML sanitization, not URL validation
        // srcdoc attribute contains HTML content that can execute scripts
        // Apply DOMPurify sanitization similar to m-html
        //
        // TASK 12.7: Remove srcdoc sanitization opt-out
        // srcdoc MUST always pass through DOMPurify, regardless of the sanitize flag.
        // This is a guaranteed XSS hole if allowed to bypass.
        // Unlike m-html which may have legitimate use cases for opt-out, srcdoc
        // is always rendered in an isolated iframe context where XSS is particularly dangerous.
        if (isSrcdoc && v != null && typeof v === 'string') {
          const purify = this.cfg.domPurify;
          if (purify && typeof purify.sanitize === 'function') {
            v = purify.sanitize(v);
          } else {
            // TASK 12.7: Hard block - srcdoc REQUIRES DOMPurify, no opt-out allowed
            // This is a security-critical change - developers MUST configure DOMPurify
            throw new Error(
              'Reflex SECURITY ERROR: srcdoc attribute requires DOMPurify for safe HTML.\n' +
              'srcdoc accepts HTML content that can execute scripts.\n\n' +
              'Solution:\n' +
              '  1. Install DOMPurify: npm install dompurify\n' +
              '  2. Configure: app.configure({ domPurify: DOMPurify })\n' +
              '  3. Import: import DOMPurify from \'dompurify\'\n\n' +
              'SECURITY NOTE: Unlike m-html, srcdoc does NOT support { sanitize: false }.\n' +
              'The srcdoc attribute is always sanitized to prevent XSS attacks.'
            );
          }
        }

        if (att === 'class') {
          const dynamicClass = this._cls(v);
          // Merge static class with dynamic class to prevent wipeout
          const next = initialClass && dynamicClass
            ? `${initialClass} ${dynamicClass}`
            : (initialClass || dynamicClass);
          if (next !== prev) { prev = next; (el as HTMLElement).className = next; }
        } else if (att === 'style') {
          // CRITICAL FIX: Handle object-style bindings to prevent "stale style" bug
          // When style changes from { color: 'red' } to { background: 'blue' },
          // we must explicitly clear 'color' or it persists forever
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            // CRITICAL FIX: Zombie Styles - Clear ALL styles when transitioning from string to object
            // If prevStyleKeys is null, we were previously using cssText (string mode)
            // We must clear all inline styles before applying the object styles
            if (prevStyleKeys === null) {
              // Clear all inline styles to prevent zombie styles from string mode
              (el as HTMLElement).style.cssText = '';
            }

            // Track current keys to remove stale ones
            const currentKeys = new Set(Object.keys(v));

            // Clear previous keys that aren't in the new object
            if (prevStyleKeys) {
              for (const key of prevStyleKeys) {
                if (!currentKeys.has(key)) {
                  // Handle CSS variables (--custom-props) and regular properties
                  const cssProp = key.startsWith('--')
                    ? key
                    : key.replace(/([A-Z])/g, '-$1').toLowerCase();
                  (el as HTMLElement).style.setProperty(cssProp, '');
                }
              }
            }

            // Apply new styles
            for (const key in v) {
              const val = v[key];
              // CRITICAL FIX: CSS Variables (--custom-props) must use setProperty
              // CSS custom properties cannot be set via property assignment:
              // - el.style['--bg'] = 'red' FAILS (returns undefined, doesn't set)
              // - el.style.setProperty('--bg', 'red') WORKS
              // For regular properties, convert camelCase to kebab-case
              // For CSS variables (already start with --), preserve as-is
              const cssProp = key.startsWith('--')
                ? key
                : key.replace(/([A-Z])/g, '-$1').toLowerCase();

              if (val != null && val !== false) {
                // CRITICAL FIX: !important Style Failure
                // setProperty doesn't parse !important from value string
                // We must detect it and pass as the 3rd argument
                let strVal = String(val);

                // CRITICAL SECURITY FIX: Apply comprehensive CSS sanitization
                // Object-style bindings must use the same sanitization as string-style bindings
                // This blocks:
                // - javascript:, data:, vbscript: protocols
                // - expression() (IE CSS expressions)
                // - -moz-binding (Firefox XBL binding)
                // - behavior: (IE behavior)
                // - @import directives
                // - CSS escape sequence bypasses
                // Previously only validated URLs for specific properties, allowing bypasses via:
                // - :style="{ width: 'expression(alert(1))' }"
                // - :style="{ '--custom': 'url(javascript:alert(1))' }"
                strVal = this._sanitizeStyleString(strVal);

                // If sanitization returned empty string, skip this property
                if (!strVal) {
                  continue;
                }

                const hasImportant = strVal.includes('!important');
                if (hasImportant) {
                  // Remove !important from value and pass as priority argument
                  const cleanVal = strVal.replace(/\s*!important\s*$/, '').trim();
                  (el as HTMLElement).style.setProperty(cssProp, cleanVal, 'important');
                } else {
                  (el as HTMLElement).style.setProperty(cssProp, strVal);
                }
              } else {
                (el as HTMLElement).style.setProperty(cssProp, '');
              }
            }

            // Update tracked keys
            prevStyleKeys = currentKeys;
          } else {
            // String-style binding: use cssText (original behavior)
            const dynamicStyle = this._sty(v);
            // Merge static style with dynamic style to prevent fragmentation
            const next = initialStyle && dynamicStyle
              ? `${initialStyle}${dynamicStyle}`
              : (initialStyle || dynamicStyle);
            if (next !== prev) { prev = next; (el as HTMLElement).style.cssText = next; }
            // Clear tracked keys since we're using cssText
            prevStyleKeys = null;
          }
        } else if (isSVGAttr) {
          // SVG attributes must use setAttribute with proper camelCase
          const next = v === null || v === false ? null : String(v);
          if (next !== prev) {
            prev = next;
            next === null ? el.removeAttribute(attrName) : el.setAttribute(attrName, next);
          }
        } else if (att in el && !isSVGAttr) {
          // CRITICAL SECURITY FIX: Block innerHTML and outerHTML binding to prevent SafeHTML bypass
          // The m-html directive enforces SafeHTML for XSS protection, but :innerHTML="str" bypasses this
          // Attackers or careless developers could inject XSS by binding to innerHTML directly
          // This creates an inconsistent security model where m-html is safe but :innerHTML is not
          const dangerousHtmlProps = ['innerHTML', 'outerHTML'];
          if (dangerousHtmlProps.includes(att)) {
            throw new Error(
              `Reflex: SECURITY ERROR - Cannot bind to '${att}' property.\n` +
              `The '${att}' property accepts raw HTML and bypasses SafeHTML security.\n\n` +
              `Solution:\n` +
              `  1. Use the m-html directive instead: <div m-html="safeContent"></div>\n` +
              `  2. Wrap your HTML with SafeHTML: SafeHTML.sanitize(htmlString)\n` +
              `  3. Configure DOMPurify: SafeHTML.configureSanitizer(DOMPurify)\n\n` +
              `This prevents XSS attacks by enforcing consistent security checks.\n` +
              `For dynamic text content (no HTML), use m-text or :textContent instead.`
            );
          }

          // CRITICAL FIX: Read-Only Property Crash
          // Many DOM properties are read-only (e.g., input.list, video.duration, element.clientTop)
          // In strict mode (ES modules), assigning to read-only properties throws TypeError
          // Use try-catch to gracefully fall back to setAttribute for read-only properties
          try {
            // TASK 6 + 13.1: Object Identity for Checkbox/Radio/Option Values
            // When binding :value="obj" to a checkbox, radio, or option, the DOM stringifies objects to "[object Object]"
            // This makes it impossible to match objects in m-model array/select binding since all objects become identical strings
            // Solution: Store the original object reference in WeakMap for later retrieval by m-model
            if (att === 'value' && v !== null && typeof v === 'object' &&
                ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio' || el.tagName === 'OPTION')) {
              // TASK 6/13.1: Store in WeakMap instead of DOM property
              const state = this._nodeState.get(el) || {};
              state.valueRef = v;
              this._nodeState.set(el, state);
            }
            (el as any)[att] = v ?? '';
          } catch (err) {
            // Property is read-only, fall back to setAttribute
            const next = v === null || v === false ? null : String(v ?? '');
            if (next !== prev) {
              prev = next;
              next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
            }
          }
        } else {
          // ARIA boolean attributes need explicit "true"/"false" string values
          // They should not be removed when value is false
          const isAriaBoolAttr = att.startsWith('aria-') && (
            att === 'aria-expanded' || att === 'aria-pressed' || att === 'aria-checked' ||
            att === 'aria-selected' || att === 'aria-hidden' || att === 'aria-disabled' ||
            att === 'aria-grabbed' || att === 'aria-busy' || att === 'aria-invalid' ||
            att === 'aria-readonly' || att === 'aria-required' || att === 'aria-current' ||
            att === 'aria-haspopup' || att === 'aria-modal'
          );

          let next: string | null;
          if (isAriaBoolAttr && typeof v === 'boolean') {
            next = String(v);  // Convert boolean to "true" or "false" string
          } else {
            next = v === null || v === false ? null : String(v);
          }

          if (next !== prev) {
            prev = next;
            // CRITICAL FIX: Unhandled SVG xlink:href Namespace
            // SVG namespaced attributes like xlink:href require setAttributeNS for strict XML/SVG contexts.
            // Modern browsers handle xlink:href without namespacing, but strict SVG parsers
            // (or older user agents) may fail to render SVG icons or references correctly.
            //
            // Namespace URIs:
            // - xlink: http://www.w3.org/1999/xlink (for xlink:href, xlink:show, etc.)
            // - xml: http://www.w3.org/XML/1998/namespace (for xml:lang, xml:space)
            if (att === 'xlink:href' || att.startsWith('xlink:')) {
              const XLINK_NS = 'http://www.w3.org/1999/xlink';
              const localName = att.split(':')[1]; // 'href' from 'xlink:href'
              if (next === null) {
                el.removeAttributeNS(XLINK_NS, localName);
              } else {
                el.setAttributeNS(XLINK_NS, att, next);
              }
            } else if (att.startsWith('xml:')) {
              // Handle xml: namespace attributes (xml:lang, xml:space, etc.)
              const XML_NS = 'http://www.w3.org/XML/1998/namespace';
              const localName = att.split(':')[1];
              if (next === null) {
                el.removeAttributeNS(XML_NS, localName);
              } else {
                el.setAttributeNS(XML_NS, att, next);
              }
            } else {
              next === null ? el.removeAttribute(att) : el.setAttribute(att, next);
            }
          }
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  }
};
