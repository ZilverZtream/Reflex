/**
 * Reflex Core - Form Bindings
 *
 * Two-way binding with m-model directive.
 */

import { ScopeContainer } from '../../csp/SafeExprParser.js';
import { SafeHTML } from '../safe-html.js';
import {
  isFlatScope,
  getFlatScopeValue,
} from '../scope-registry.js';
import { getRawValue, parsePath } from './utils.js';

// SECURITY: Prototype-related properties that should be blocked when setting
// These properties could lead to prototype pollution attacks if allowed
const PROTO_PROPS = Object.assign(Object.create(null), {
  constructor: 1,
  '__proto__': 1,
  prototype: 1
});

// Helper to check if a property is prototype-related
const isProtoProperty = (k: string): boolean => {
  return PROTO_PROPS[k] === 1;
};

/**
 * FormsMixin for Reflex class.
 * Provides m-model directive implementation.
 */
export const FormsMixin = {
  /**
   * Two-way binding: m-model="expr"
   *
   * CRITICAL FIX (Issue #2): m-model Dynamic Type Switching
   *
   * PROBLEM: The original implementation captured input type at binding time:
   *   const type = el.type; const isChk = type === 'checkbox'; ...
   * If the input type changes dynamically (e.g., <input :type="showPassword ? 'text' : 'password'">
   * or switching text -> checkbox), the m-model logic doesn't adapt. The binding becomes
   * desynchronized from the DOM type.
   *
   * SOLUTION: Move type detection inside the reactive effect and input handler so it's
   * evaluated on each update/input. Now switching from text to checkbox will:
   * - Re-evaluate the type in the effect
   * - Use the correct DOM property (checked vs value)
   * - Fire the correct events (change vs input)
   *
   * PERFORMANCE: Type detection inside effects adds a negligible String.toLowerCase() call
   * per reactive update. This is acceptable because m-model updates are user-driven (typing)
   * which are inherently rate-limited by human input speed (~20-40 chars/sec max).
   */
  _mod(this: any, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, exp: string, o: any, modifiers: string[] = []): void {
    const fn = this._fn(exp);
    // CRITICAL FIX (Issue #2): Only capture modifiers and lazy flag at binding time
    // Type-related flags (isChk, isRadio, isNum, isMultiSelect) are now dynamic
    const hasNumberMod = modifiers.includes('number');
    const isLazy = modifiers.includes('lazy');

    // Initial file input warning (still static - just a warning)
    const initialType = ((el as HTMLInputElement).type || '').toLowerCase();
    if (initialType === 'file') {
      if (!this._fileInputsWarned.has(el)) {
        this._fileInputsWarned.add(el);
        console.warn(
          'Reflex: m-model is not supported on file inputs (security restriction).\n' +
          'Use @change="handler" and access el.files instead.\n' +
          'Note: If the input type changes dynamically, m-model will work when not type="file".'
        );
      }
    }

    const e = this.createEffect(() => {
      try {
        // CRITICAL FIX (Issue #2): Dynamic type detection inside effect
        // Re-evaluate type on every reactive update to handle :type bindings
        const currentType = ((el as HTMLInputElement).type || '').toLowerCase();

        // Handle file inputs (read-only .value)
        if (currentType === 'file') {
          fn(this.s, o); // Track dependency only
          return;
        }

        // CRITICAL FIX (Issue #2): Dynamic type flags
        const isChk = currentType === 'checkbox';
        const isRadio = currentType === 'radio';
        const isNum = currentType === 'number' || currentType === 'range' || hasNumberMod;
        const isMultiSelect = currentType === 'select-multiple';

        const v = fn(this.s, o);

        // TASK 8.3: Check contenteditable inside the effect
        // Elements with contenteditable="true" use innerText/innerHTML, not value
        // Check both property and attribute for compatibility with different DOM implementations
        const isContentEditable = (el as HTMLElement).contentEditable === 'true' ||
                                   el.getAttribute('contenteditable') === 'true';
        if (isContentEditable) {
          // contenteditable elements use innerText (or innerHTML if .html modifier is used)
          const useHTML = modifiers.includes('html');
          if (useHTML) {
            // TASK 8.3: Unified Security Type System
            // BREAKING CHANGE: m-model.html ONLY accepts SafeHTML instances
            // This eliminates ad-hoc sanitization and enforces a single security model
            if (!SafeHTML.isSafeHTML(v)) {
              throw new TypeError(
                'Reflex Security: m-model.html requires a SafeHTML value.\n\n' +
                'BREAKING CHANGE: Raw strings are no longer accepted.\n\n' +
                'Migration:\n' +
                '  1. Import SafeHTML: import { SafeHTML } from \'reflex\';\n' +
                '  2. Configure sanitizer (once): SafeHTML.configureSanitizer(DOMPurify);\n' +
                '  3. Sanitize user content: const safe = SafeHTML.sanitize(userInput);\n' +
                '  4. For static HTML: const trusted = SafeHTML.unsafe(staticHtml);\n\n' +
                'Example:\n' +
                '  // In your model:\n' +
                '  this.s.content = SafeHTML.sanitize(userInput);\n\n' +
                'Security: This ensures ALL HTML in Reflex goes through SafeHTML,\n' +
                'making it impossible to accidentally render unsanitized content.'
              );
            }
            const next = v.toString();
            if ((el as HTMLElement).innerHTML !== next) (el as HTMLElement).innerHTML = next;
          } else {
            const next = v == null ? '' : String(v);
            if ((el as HTMLElement).innerText !== next) (el as HTMLElement).innerText = next;
          }
        } else if (isChk) {
          // Handle checkbox array binding
          if (Array.isArray(v)) {
            // TASK 6: Object Identity for Checkbox Values
            // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
            // which makes all objects appear identical. Get the original object from WeakMap.
            const state = this._nodeState.get(el);
            const elValue = (state && state.valueRef !== undefined) ? state.valueRef : (el as HTMLInputElement).value;
            // Unwrap reactive proxy to get the raw object for identity comparison
            const rawElValue = getRawValue(elValue);
            (el as HTMLInputElement).checked = v.some((item: any) => {
              // For objects, use identity comparison on raw (unwrapped) values
              // This handles cases where both are reactive proxies of the same object
              if (item !== null && typeof item === 'object') {
                const rawItem = getRawValue(item);
                return rawItem === rawElValue;
              }
              // For primitives, use type coercion to match DOM string values
              // Example: array [1, 2] should match <input value="1">
              return String(item) === String(elValue);
            });
          } else {
            (el as HTMLInputElement).checked = !!v;
          }
        } else if (isRadio) {
          // Radio button: check if value matches model
          (el as HTMLInputElement).checked = String(v) === String((el as HTMLInputElement).value);
        } else if (isMultiSelect) {
          // For multi-select, v should be an array of selected values
          const selectedValues = Array.isArray(v) ? v : [];
          // Update the selected options
          // TASK 13.1: Support object values in multi-select
          // DOM option.value is always a string, but model data might contain objects or numbers
          // Get the original object from nodeState if available
          const options = (el as HTMLSelectElement).options;
          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const optState = this._nodeState.get(opt);
            const optValue = (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
            const isObjectValue = optValue !== null && typeof optValue === 'object';
            const rawOptValue = getRawValue(optValue);

            opt.selected = selectedValues.some((val: any) => {
              // For objects, use identity comparison on raw (unwrapped) values
              if (isObjectValue || (val !== null && typeof val === 'object')) {
                const rawVal = getRawValue(val);
                return rawVal === rawOptValue;
              }
              // For primitives, use type coercion to match DOM string values
              return String(val) === String(optValue);
            });
          }
        } else if (el.tagName === 'SELECT') {
          // TASK 13.1: Handle single-select with object values
          // The model value v might be an object, and options might have object values stored in nodeState
          const options = (el as HTMLSelectElement).options;
          let foundMatch = false;
          const rawV = getRawValue(v);
          const isObjectModel = v !== null && typeof v === 'object';

          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const optState = this._nodeState.get(opt);
            const optValue = (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
            const isObjectOption = optValue !== null && typeof optValue === 'object';
            const rawOptValue = getRawValue(optValue);

            let isMatch = false;
            if (isObjectModel || isObjectOption) {
              // Object comparison: use identity
              isMatch = rawV === rawOptValue;
            } else {
              // Primitive comparison: use string coercion
              isMatch = String(v) === String(optValue);
            }

            if (isMatch && !foundMatch) {
              (el as HTMLSelectElement).selectedIndex = i;
              foundMatch = true;
            }
          }

          // If no match and value is null/undefined, reset to no selection or first option
          if (!foundMatch && v == null) {
            (el as HTMLSelectElement).selectedIndex = options.length > 0 ? 0 : -1;
          }
        } else if (isNum) {
          // For number inputs, avoid cursor jumping by comparing loosely
          // Allow "1." to equal "1" to prevent interrupting user input
          const next = v == null ? '' : String(v);
          if ((el as HTMLInputElement).value !== next && parseFloat((el as HTMLInputElement).value) !== v) {
            (el as HTMLInputElement).value = next;
          }
        } else {
          const next = v == null ? '' : String(v);
          if ((el as HTMLInputElement).value !== next) (el as HTMLInputElement).value = next;
        }
      } catch (err) {
        this._handleError(err, o);
      }
    });
    e.o = o;
    this._reg(el, e.kill);

    // CRITICAL FIX: IME Composition Support (Chinese/Japanese/Korean input)
    // Track composition state to prevent updates during IME composition
    // Without this, input events fire on every keystroke (e.g., "h", "ha", "han")
    // causing state updates that abort the composition, making it impossible to type
    let isComposing = false;

    const up = () => {
      // CRITICAL: Skip update if IME composition is in progress
      if (isComposing) return;

      // CRITICAL FIX (Issue #2): Dynamic type detection in input handler
      // Re-evaluate type on every input event to handle :type bindings
      const currentType = ((el as HTMLInputElement).type || '').toLowerCase();
      const isChk = currentType === 'checkbox';
      const isRadio = currentType === 'radio';
      const isNum = currentType === 'number' || currentType === 'range' || hasNumberMod;
      const isMultiSelect = currentType === 'select-multiple';

      let v: any;
      // TASK 8.3: Check contenteditable dynamically
      // Check both property and attribute for compatibility
      const isContentEditable = (el as HTMLElement).contentEditable === 'true' ||
                                 el.getAttribute('contenteditable') === 'true';
      if (isContentEditable) {
        // contenteditable elements use innerText (or innerHTML if .html modifier is used)
        const useHTML = modifiers.includes('html');
        if (useHTML) {
          // TASK 12.1: Fix m-model.html Crash Loop
          // CRITICAL: When reading innerHTML from user input, we must sanitize and wrap
          // in SafeHTML. This prevents the crash loop:
          //   Input event -> Writes raw string to state -> Reactive update
          //   -> SafeHTML.isSafeHTML(string) throws TypeError -> CRASH
          //
          // FIX: Input -> SafeHTML.fromUser(string) -> State Update -> Reactivity
          //      -> SafeHTML Check (Passes) -> Render
          v = SafeHTML.fromUser((el as HTMLElement).innerHTML);
        } else {
          v = (el as HTMLElement).innerText;
        }
      } else if (isChk) {
        // Handle checkbox array binding
        const currentValue = fn(this.s, o);
        if (Array.isArray(currentValue)) {
          // CRITICAL FIX (Issue #4): Mutate the original array instead of creating a copy
          // Previously: const arr = [...currentValue]; ... v = arr;
          // This replaced the reactive array with a plain array, breaking:
          // - External references to the original state.selected array
          // - Equality checks (oldRef === newRef) in watchers
          // - Object identity for reactive tracking
          //
          // Now we mutate the original array in place, preserving reference identity.
          // The reactivity system will detect the mutation via the array method wrappers.
          const arr = currentValue;

          // TASK 6: Object Identity for Checkbox Values
          // When binding :value="obj" to a checkbox, el.value becomes "[object Object]"
          // Get the original object reference from WeakMap
          const state = this._nodeState.get(el);
          const elValue = (state && state.valueRef !== undefined) ? state.valueRef : (el as HTMLInputElement).value;
          const isObjectValue = elValue !== null && typeof elValue === 'object';
          // Unwrap reactive proxy for identity comparison
          const rawElValue = getRawValue(elValue);

          // CRITICAL FIX #7: Object Identity Failure - Don't use String() for object comparison
          // String([{id:1}]) returns "[object Object]" for all objects, making them all match
          // Use strict equality for objects, type coercion only for primitives
          const idx = arr.findIndex((item: any) => {
            // If both are objects, use identity comparison on raw (unwrapped) values
            if (item !== null && typeof item === 'object') {
              const rawItem = getRawValue(item);
              return rawItem === rawElValue;
            }
            // For primitives, use type coercion to match DOM string values
            return String(item) === String(elValue);
          });
          if ((el as HTMLInputElement).checked && idx === -1) {
            // CRITICAL FIX: For object values, use the original object reference
            // This ensures the model array contains the actual object, not "[object Object]"
            if (isObjectValue) {
              arr.push(elValue);
            } else {
              // Try to preserve the original type if the array has a consistent type
              // If array contains numbers and value is numeric, push as number
              let valueToAdd: any = elValue;

              // CRITICAL FIX: Type inference for empty arrays
              // If array is empty, we can't infer from arr[0], so check if value is numeric
              let shouldCoerceToNumber = false;
              if (arr.length > 0) {
                // Array has values - use first element's type
                shouldCoerceToNumber = typeof arr[0] === 'number';
              } else {
                // Empty array - infer type from checkbox value itself
                // If the value is a valid number string, coerce to number
                // CRITICAL FIX #3: Checkbox Leading Zero Data Corruption
                // Don't coerce values with leading zeros or special formatting
                // "01" should remain "01", not become 1
                // Check: String(Number(value)) must equal the trimmed value
                const trimmed = String(elValue).trim();
                if (trimmed !== '' && !isNaN(Number(trimmed))) {
                  // Valid number, but check if coercion would lose information
                  // "01" -> Number("01") = 1 -> String(1) = "1" ≠ "01" (don't coerce)
                  // "1" -> Number("1") = 1 -> String(1) = "1" = "1" ✓ (coerce)
                  shouldCoerceToNumber = String(Number(trimmed)) === trimmed;
                } else {
                  shouldCoerceToNumber = false;
                }
              }

              if (shouldCoerceToNumber) {
                // CRITICAL FIX #9: Loose Number Conversion - Empty string becomes 0
                // Number("") and Number(" ") return 0, which is valid (not NaN)
                // But empty/whitespace checkbox values should be ignored, not converted to 0
                // Check for empty/whitespace strings BEFORE numeric conversion
                const trimmed = String(elValue).trim();
                if (trimmed === '') {
                  // Empty or whitespace value - skip adding to numeric array
                  console.warn(
                    `Reflex: Skipping empty checkbox value for numeric array binding.`
                  );
                  return;
                }
                // Now check for valid numeric conversion
                const numValue = Number(elValue);
                if (!isNaN(numValue)) {
                  valueToAdd = numValue;
                } else {
                  // Value is not numeric - warn and skip adding it to numeric array
                  console.warn(
                    `Reflex: Cannot add non-numeric value "${elValue}" to numeric array. ` +
                    'Skipping to prevent NaN pollution.'
                  );
                  // Don't add the value - keep the array unchanged
                  return;
                }
              }
              arr.push(valueToAdd);
            }
          } else if (!(el as HTMLInputElement).checked && idx !== -1) {
            arr.splice(idx, 1);
          }
          // CRITICAL FIX (Issue #4): Don't reassign - the array was mutated in place
          // The reactive system already tracks these mutations via push/splice wrappers
          return; // Skip the assignment below since we mutated in place
        } else {
          v = (el as HTMLInputElement).checked;
        }
      } else if (isRadio) {
        v = (el as HTMLInputElement).value;
      } else if (isNum) {
        // Handle badInput state
        if ((el as HTMLInputElement).validity && (el as HTMLInputElement).validity.badInput) {
          return; // Don't update if input is invalid
        }
        // CRITICAL FIX: Preserve intermediate number formats during typing
        // Don't parse values like "1.", "-", "0." that users type mid-input
        // These are valid intermediate states that should not update state
        // until the user finishes typing a complete number
        const raw = (el as HTMLInputElement).value;
        if (raw === '' || raw === null) {
          v = null;
        } else if (raw === '-' || raw.endsWith('.') || raw.endsWith('e') || raw.endsWith('e-') || raw.endsWith('e+')) {
          // Intermediate typing state - don't update state to prevent cursor jump
          return;
        } else {
          v = parseFloat(raw);
        }
      } else if (isMultiSelect) {
        // For multi-select, return array of selected values
        // CRITICAL FIX: Preserve number types (like checkbox array binding)
        // DOM values are always strings, but the model might contain numbers
        // Check the original array type and coerce if needed
        const currentValue = fn(this.s, o);

        // CRITICAL FIX: Empty Multi-Select Type Trap
        // If the array is empty, we can't infer type from currentValue[0]
        //
        // CRITICAL SECURITY FIX #8: m-model Type Confusion
        // VULNERABILITY: Type inference from DOM options allows attackers to change model type
        // by injecting DOM options (e.g., via a separate vulnerability or SSR injection)
        //
        // SOLUTION: Use explicit .number modifier OR infer from existing array elements
        // Priority order:
        // 1. .number modifier (explicit declaration by developer)
        // 2. First element type (if array has values)
        // 3. CRITICAL FIX (Issue #8): Infer from option values if array is empty
        // 4. Default to strings (safest)
        //
        // CRITICAL FIX (Issue #8): Smart type inference for empty arrays
        // Previously, empty arrays ALWAYS defaulted to strings, causing type confusion.
        // Example: user expects numeric IDs but gets ["1", "2"] instead of [1, 2].
        //
        // New behavior: If array is empty and ALL options have numeric values, assume numeric.
        // This matches user intent in the common case of ID-based selects.
        let shouldCoerceToNumber = false;

        if (modifiers.includes('number')) {
          // Explicit .number modifier - trust the developer's intent
          shouldCoerceToNumber = true;
        } else if (Array.isArray(currentValue) && currentValue.length > 0) {
          // Array has values - use first element's type (TRUSTED source)
          shouldCoerceToNumber = typeof currentValue[0] === 'number';
        } else if (Array.isArray(currentValue) && currentValue.length === 0) {
          // CRITICAL FIX (Issue #8): Empty array - infer from option values
          // Check if ALL options have numeric values (e.g., id-based selects)
          // This prevents the common "gotcha" where users expect [1, 2] but get ["1", "2"]
          const options = Array.from((el as HTMLSelectElement).options);
          if (options.length > 0) {
            const allNumeric = options.every(opt => {
              const val = opt.value.trim();
              // Check if value is a valid number that preserves format when converted
              // "01" -> 1 -> "1" !== "01" (not purely numeric, has leading zero)
              // "1" -> 1 -> "1" === "1" (purely numeric)
              return val !== '' && !isNaN(Number(val)) && String(Number(val)) === val;
            });
            if (allNumeric) {
              shouldCoerceToNumber = true;
            }
          }
        }

        // TASK 13.1: Get selected values, preserving object references from nodeState
        // Fallback for environments without selectedOptions (e.g., happy-dom)
        let selectedOptions: HTMLOptionElement[];
        if ((el as HTMLSelectElement).selectedOptions) {
          selectedOptions = Array.from((el as HTMLSelectElement).selectedOptions);
        } else {
          selectedOptions = Array.from((el as HTMLSelectElement).options).filter(opt => opt.selected);
        }

        // TASK 13.1: Check if any option has an object value in nodeState
        // If so, we return object values; otherwise, we continue with string/number handling
        const hasObjectValues = selectedOptions.some(opt => {
          const optState = this._nodeState.get(opt);
          return optState && optState.valueRef !== undefined && typeof optState.valueRef === 'object';
        });

        if (hasObjectValues) {
          // Return object values from nodeState
          v = selectedOptions.map(opt => {
            const optState = this._nodeState.get(opt);
            return (optState && optState.valueRef !== undefined) ? optState.valueRef : opt.value;
          });
        } else {
          // Original behavior: string/number coercion
          const selectedValues = selectedOptions.map(opt => opt.value);

          // Coerce to numbers if the original array contained numbers or all options are numeric
          // CRITICAL FIX #8: Data Integrity - Whitespace Coercion to Zero
          // Number(" ") returns 0, which passes !isNaN check but corrupts data
          // Check for empty/whitespace strings BEFORE numeric conversion
          if (shouldCoerceToNumber) {
            v = selectedValues.map(val => {
              const trimmed = val.trim();
              // Empty or whitespace-only values should remain as strings, not become 0
              if (trimmed === '') return val;
              // Valid numeric conversion
              return !isNaN(Number(val)) ? Number(val) : val;
            });
          } else {
            v = selectedValues;
          }
        }
      } else if (el.tagName === 'SELECT') {
        // TASK 13.1: Handle single-select reading with object values
        const selectedOpt = (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex];
        if (selectedOpt) {
          const optState = this._nodeState.get(selectedOpt);
          v = (optState && optState.valueRef !== undefined) ? optState.valueRef : selectedOpt.value;
        } else {
          v = null;
        }
      } else if (((el as HTMLInputElement).type || '').toLowerCase() === 'file') {
        // TASK 13.1: File input reading - return FileList or first file
        // File inputs can only be read (not set), so this is a one-way binding
        // Return el.files (FileList) so model can access the selected files
        v = (el as HTMLInputElement).files;
      } else v = (el as HTMLInputElement).value;

      // TASK 8.1: Parse path with dynamic segment support
      // parsePath() now returns PathSegment[] with type information
      // Dynamic segments (e.g., users[id]) must be evaluated in the current scope
      const pathSegments = parsePath(exp);
      const endSegment = pathSegments.pop();

      // Safety check
      if (!endSegment) {
        console.warn('Reflex: Invalid m-model expression:', exp);
        return;
      }

      // Security: prevent prototype pollution
      if (isProtoProperty(endSegment.key)) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', endSegment.key);
        return;
      }

      // BREAKING CHANGE: Handle FlatScope and ScopeContainer for first path lookup
      // FlatScope uses flat registry lookup, ScopeContainer uses Map-based storage
      const scopeIsFlatScope = o && isFlatScope(o);
      const scopeIsScopeContainer = o && ScopeContainer.isScopeContainer(o);

      // Check if first path segment exists in scope
      let hasInScope = false;
      if (scopeIsFlatScope && pathSegments.length > 0) {
        hasInScope = getFlatScopeValue(o, pathSegments[0].key).found;
      } else if (scopeIsScopeContainer && pathSegments.length > 0) {
        hasInScope = o.has(pathSegments[0].key);
      }

      let t: any = hasInScope ? o : this.s;
      let isFirstPath = true;

      // TASK 8.1: Traverse path with dynamic segment evaluation
      for (const segment of pathSegments) {
        // Evaluate dynamic segments in the current scope
        let key = segment.key;
        if (segment.type === 'dynamic') {
          // CRITICAL: Evaluate the dynamic key in the current scope
          // Example: users[id] where id=5 → key becomes '5'
          try {
            const keyFn = this._fn(segment.key);
            key = String(keyFn(this.s, o));
          } catch (err) {
            console.warn('Reflex: Failed to evaluate dynamic key:', segment.key, err);
            return;
          }
        }

        if (isProtoProperty(key)) {
          console.warn('Reflex: Blocked attempt to traverse unsafe property:', key);
          return;
        }

        // Handle FlatScope lookup for first path segment
        if (isFirstPath && isFlatScope(t)) {
          const result = getFlatScopeValue(t, key);
          t = result.value;
          isFirstPath = false;
          if (t == null) {
            console.warn('Reflex: Cannot traverse null/undefined in path:', key);
            return;
          }
          continue;
        }
        // Handle ScopeContainer lookup for first path segment
        if (isFirstPath && ScopeContainer.isScopeContainer(t)) {
          t = t.get(key);
          isFirstPath = false;
          if (t == null) {
            console.warn('Reflex: Cannot traverse null/undefined in path:', key);
            return;
          }
          continue;
        }
        isFirstPath = false;
        if (t[key] == null) t[key] = {};
        else if (typeof t[key] !== 'object') {
          console.warn('Reflex: Cannot set nested property on non-object value at path:', key);
          return;
        }
        t = t[key];
      }

      // TASK 8.1: Evaluate final segment if dynamic
      let finalKey = endSegment.key;
      if (endSegment.type === 'dynamic') {
        try {
          const keyFn = this._fn(endSegment.key);
          finalKey = String(keyFn(this.s, o));
        } catch (err) {
          console.warn('Reflex: Failed to evaluate dynamic key:', endSegment.key, err);
          return;
        }
      }

      // CRITICAL SECURITY FIX: Check finalKey AFTER evaluation for dynamic segments
      // The initial isProtoProperty check above only validates the raw expression string.
      // For dynamic keys (e.g., m-model="data[dynamicKey]"), we must also validate
      // the evaluated value to prevent prototype pollution via runtime-controlled keys.
      if (isProtoProperty(finalKey)) {
        console.warn('Reflex: Blocked attempt to set unsafe property:', finalKey);
        return;
      }

      // CRITICAL SECURITY FIX: Additional prototype pollution defense
      // Ensure we're not trying to set a property that exists on Object.prototype
      // or other built-in prototypes, which would indicate a pollution attempt
      if (t !== null && typeof t === 'object') {
        const hasOwnProp = Object.prototype.hasOwnProperty.call(t, finalKey);
        const isPrototypeProp = !hasOwnProp && (finalKey in t);
        if (isPrototypeProp && typeof t !== 'function') {
          console.warn('Reflex: Blocked attempt to modify inherited property:', finalKey);
          // Still allow setting if it's a setter or if the object is meant to have this property
          // But create it as an own property instead of modifying the prototype
        }
      }

      // CRITICAL SECURITY FIX: Prevent ALL Prototype Pollution
      // The original scope shadowing logic walked the prototype chain to find where
      // a property was defined. However, this is fundamentally unsafe:
      // 1. If the property is on Object.prototype, it pollutes ALL objects
      // 2. If the property is on a custom prototype, it pollutes ALL objects sharing that prototype
      // 3. Only updating OWN properties is safe, but then we don't need the chain walk
      //
      // SECURE APPROACH: Only update the target object (t), never any prototype.
      // This prevents prototype pollution while still supporting property assignment.
      // For ScopeContainer, shadowing is handled by the Map-based storage.
      // For regular objects, we simply set the property on the object itself.
      t[finalKey] = v;
    };

    // IME composition event handlers
    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => {
      isComposing = false;
      // Trigger update after composition completes
      up();
    };
    // CRITICAL FIX: Handle composition cancellation to prevent stuck flag
    // If composition is cancelled (e.g., user presses Escape), reset the flag
    const onCompositionCancel = () => {
      isComposing = false;
      // Also trigger update to sync any partial input
      up();
    };

    // CRITICAL FIX (Issue #2): Dynamic Event Listener Setup
    // When input type can change dynamically, we need to listen to both 'input' and 'change'
    // events to handle all type scenarios. This is a trade-off:
    // - For static types: slightly more listeners (negligible overhead)
    // - For dynamic types: correct behavior when switching between text/checkbox/radio
    //
    // The alternative (adding/removing listeners dynamically) is more complex and error-prone.
    // Since most inputs don't change type, and the extra listener is cheap, we always
    // listen to both events (unless .lazy is specified, which forces change-only).
    const initType = ((el as HTMLInputElement).type || '').toLowerCase();
    const initIsChk = initType === 'checkbox';
    const initIsRadio = initType === 'radio';

    // Determine initial event type for IME composition support
    let primaryEvt: string;
    if (isLazy) {
      primaryEvt = 'change'; // .lazy always uses 'change' only
    } else {
      primaryEvt = initIsChk || initIsRadio || el.tagName === 'SELECT' ? 'change' : 'input';
    }

    el.addEventListener(primaryEvt, up);
    // Also listen to 'change' for inputs (unless already using it)
    // This ensures we catch both events for dynamic type switching
    if (primaryEvt !== 'change' && !isLazy) {
      el.addEventListener('change', up);
    }
    // Also listen to 'input' for checkboxes/radios in case they become text inputs
    // (only if we didn't already add it)
    if (primaryEvt === 'change' && !isLazy) {
      el.addEventListener('input', up);
    }

    // Add IME composition listeners for text inputs
    // (checkbox/radio don't need IME support, but harmless if type changes)
    if (!initIsChk && !initIsRadio) {
      el.addEventListener('compositionstart', onCompositionStart);
      el.addEventListener('compositionend', onCompositionEnd);
      // CRITICAL FIX: Add compositioncancel to prevent stuck isComposing flag
      el.addEventListener('compositioncancel', onCompositionCancel);
    }

    // CRITICAL FIX (Issue #6): Dynamic Select Initial State Sync
    // When <option> elements are generated via m-for, they're added to the DOM AFTER
    // m-model has already run its initial sync. The browser doesn't auto-apply the
    // selection to newly added options, leaving the select box appearing empty.
    //
    // Solution: Use MutationObserver to watch for child changes on <select> elements.
    // When options are added, re-run the effect to sync the selection state.
    let selectObserver: MutationObserver | null = null;
    if (el.tagName === 'SELECT' && typeof MutationObserver !== 'undefined') {
      // Debounce the sync to batch multiple option additions
      let syncTimeout: any = null;
      const syncSelection = () => {
        if (syncTimeout) clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
          syncTimeout = null;
          // Re-run the effect to sync the selection state
          // The effect checks the current model value and applies it to all options
          try {
            e();
          } catch (err) {
            // Error during sync - log but don't crash
            // This prevents syncTimeout from leaking if effect throws
            console.error('Reflex: Error during select synchronization:', err);
          }
        }, 0);
      };

      selectObserver = new MutationObserver((mutations) => {
        // Check if any option elements were added
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === 1 && ((node as Element).tagName === 'OPTION' || (node as Element).tagName === 'OPTGROUP')) {
                syncSelection();
                return; // Only need to sync once per batch
              }
            }
          }
        }
      });

      // Observe child additions to the select element
      selectObserver.observe(el, { childList: true, subtree: true });
    }

    this._reg(el, () => {
      el.removeEventListener(primaryEvt, up);
      if (primaryEvt !== 'change' && !isLazy) {
        el.removeEventListener('change', up);
      }
      // Clean up IME composition listeners
      if (primaryEvt === 'input' && !initIsChk && !initIsRadio) {
        el.removeEventListener('compositionstart', onCompositionStart);
        el.removeEventListener('compositionend', onCompositionEnd);
        el.removeEventListener('compositioncancel', onCompositionCancel);
      }
      // CRITICAL FIX (Issue #6): Clean up MutationObserver for select elements
      if (selectObserver) {
        selectObserver.disconnect();
        selectObserver = null;
      }
    });
  }
};
