/**
 * Reflex Core - Text and HTML Rendering
 *
 * Handles text interpolation ({{ expr }}) and m-html directive.
 */

import { SafeHTML } from '../safe-html.js';

/**
 * TextHtmlMixin for Reflex class.
 * Provides text interpolation and HTML rendering methods.
 */
export const TextHtmlMixin = {
  /**
   * Text interpolation: {{ expr }}
   */
  _txt(this: any, n: Text, o: any): void {
    const raw = n.nodeValue;
    if (!raw) return;

    if (raw.startsWith('{{') && raw.endsWith('}}') && raw.indexOf('{{', 2) < 0) {
      const fn = this._fn(raw.slice(2, -2));
      let prev: string | undefined;
      const e = this.createEffect(() => {
        try {
          const v = fn(this.s, o);
          const next = v == null ? '' : String(v);
          if (next !== prev) { prev = next; n.nodeValue = next; }
        } catch (err) {
          this._handleError(err, o);
        }
      });
      e.o = o;
      this._reg(n, e.kill);
      return;
    }
    const pts = raw.split(/(\{\{.*?\}\})/g).map((x: string) =>
      x.startsWith('{{') ? this._fn(x.slice(2, -2)) : x
    );
    let prev: string | undefined;
    const e = this.createEffect(() => {
      try {
        let out = '';
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          out += typeof p === 'function' ? (p(this.s, o) ?? '') : p;
        }
        if (out !== prev) { prev = out; n.nodeValue = out; }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(n, e.kill);
  },

  /**
   * HTML binding: m-html="expr"
   *
   * BREAKING CHANGE: Expression MUST evaluate to a SafeHTML instance.
   * Raw strings will throw TypeError.
   *
   * @example
   * // In your state/computed:
   * computed: {
   *   htmlContent() {
   *     return SafeHTML.sanitize(this.userInput);
   *   }
   * }
   *
   * // In template:
   * <div m-html="htmlContent"></div>
   */
  _html(this: any, el: Element, exp: string, o: any): void {
    const fn = this._fn(exp);
    let prev: SafeHTML | null = null;
    const self = this;

    const e = this.createEffect(() => {
      try {
        const rawValue = fn(self.s, o);

        // BREAKING CHANGE: Value MUST be SafeHTML
        if (!SafeHTML.isSafeHTML(rawValue)) {
          throw new TypeError(
            `Reflex Security: m-html expression must evaluate to SafeHTML.\n` +
            `Expression: ${exp}\n` +
            `Received: ${typeof rawValue}\n\n` +
            `BREAKING CHANGE: Raw strings are no longer accepted.\n\n` +
            `Migration:\n` +
            `  1. Install DOMPurify: npm install dompurify @types/dompurify\n` +
            `  2. Configure at app startup: SafeHTML.configureSanitizer(DOMPurify);\n` +
            `  3. In your state/computed, wrap with SafeHTML:\n` +
            `     computed: {\n` +
            `       htmlContent() {\n` +
            `         return SafeHTML.sanitize(this.userInput);\n` +
            `       }\n` +
            `     }\n` +
            `  4. Then use: <div m-html="htmlContent"></div>`
          );
        }

        const safeHtml = rawValue as SafeHTML;
        const htmlString = safeHtml.toString();

        // TASK 12.9: "Loose" Hydration - optimized comparison to avoid expensive DOM parsing
        // During hydration, compare current innerHTML with new value
        // Only update if they differ to prevent destroying iframe state, focus, etc.
        if (self._hydrateMode) {
          const currentHTML = el.innerHTML;

          // Fast path: if strings match exactly, skip update
          if (currentHTML === htmlString) {
            prev = safeHtml;
            return;
          }

          // TASK 12.9: Text Comparison for text-only content
          // If the element only contains text (no child elements), compare directly
          // This avoids expensive DOM parsing for simple text content
          if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) {
            // Single text node - compare text content directly
            if (el.textContent === htmlString.replace(/<[^>]*>/g, '')) {
              prev = safeHtml;
              return;
            }
          }

          // TASK 13.7: Fast Path - Length Comparison First
          // Compare string lengths before doing expensive string comparison
          // If lengths differ, content is definitely different - skip the comparison
          // This is O(1) and catches most cases where content has changed
          if (currentHTML.length !== htmlString.length) {
            // Lengths differ - content is definitely different, proceed to update
          } else if (currentHTML === htmlString) {
            // Lengths match AND content matches - skip the update
            prev = safeHtml;
            return;
          }

          // Lengths match but content differs - fall back to normalized comparison
          // Only now do we incur the cost of DOM parsing
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = htmlString;
          const normalizedNew = tempDiv.innerHTML;

          if (currentHTML === normalizedNew) {
            // Content matches after normalization - skip the destructive innerHTML write
            prev = safeHtml;
            return;
          }
        }

        // Only update if content changed
        if (prev === null || prev.toString() !== htmlString) {
          prev = safeHtml;

          // Clean up child resources before innerHTML replacement
          // innerHTML blindly replaces DOM content without cleanup, leaking:
          // - Reactive effects attached to child elements
          // - Event listeners registered via _reg
          // - Component instances and their resources
          let child = el.firstChild;
          while (child) {
            const next = child.nextSibling;
            if (child.nodeType === 1) {
              // Kill all Reflex resources attached to this element tree
              this._kill(child);
            }
            child = next;
          }

          // Use renderer's setInnerHTML which also enforces SafeHTML
          this._ren.setInnerHTML(el, safeHtml);
        }
      } catch (err) {
        self._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);
  }
};
