/**
 * Virtual Renderer - Abstract DOM for Non-Web Targets
 *
 * This renderer provides a virtual node tree implementation that mimics
 * the browser DOM API. It enables Reflex to run in:
 * - Native environments (iOS/Android via bridge)
 * - Terminal UIs
 * - Test environments (fast, deterministic tests)
 * - Server-side rendering
 *
 * The virtual tree can be:
 * - Serialized to JSON for bridge communication
 * - Rendered to strings for SSR
 * - Inspected for testing assertions
 */

import type { IRendererAdapter, TransitionConfig, VNode } from './types.js';

/** Node type constants (matching DOM) */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** Counter for unique node IDs */
let nodeIdCounter = 0;

/** Self-closing HTML tags */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Raw text elements - these elements should NOT have their content parsed as HTML.
 * Their content is treated as raw text until the closing tag is found.
 * See: https://html.spec.whatwg.org/multipage/syntax.html#raw-text-elements
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * Escapable raw text elements - similar to raw text, but certain entities are decoded.
 * See: https://html.spec.whatwg.org/multipage/syntax.html#escapable-raw-text-elements
 */
const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(['title', 'textarea']);

/**
 * Parse an HTML string into a virtual DOM tree.
 * Handles nested elements, attributes, text nodes, and comments.
 */
function parseHTML(html: string): VNode[] {
  const nodes: VNode[] = [];
  let pos = 0;
  const len = html.length;

  // Stack of open elements for nesting
  const stack: { node: VNode; tagName: string }[] = [];

  function currentParent(): VNode[] {
    return stack.length > 0 ? stack[stack.length - 1].node.childNodes : nodes;
  }

  function addNode(node: VNode): void {
    const parent = currentParent();
    parent.push(node);
    if (stack.length > 0) {
      node.parentNode = stack[stack.length - 1].node;
    }
  }

  while (pos < len) {
    // Check for comment
    if (html.slice(pos, pos + 4) === '<!--') {
      const endComment = html.indexOf('-->', pos + 4);
      if (endComment !== -1) {
        const commentText = html.slice(pos + 4, endComment);
        const commentNode = createVNode(COMMENT_NODE, undefined, commentText);
        addNode(commentNode);
        pos = endComment + 3;
        continue;
      }
    }

    // Check for tag
    if (html[pos] === '<') {
      // Closing tag
      if (html[pos + 1] === '/') {
        const closeEnd = html.indexOf('>', pos);
        if (closeEnd !== -1) {
          const closingTag = html.slice(pos + 2, closeEnd).trim().toLowerCase();
          // Pop from stack until we find the matching tag
          while (stack.length > 0) {
            const top = stack.pop()!;
            updateRelationships(top.node);
            if (top.tagName === closingTag) break;
          }
          pos = closeEnd + 1;
          continue;
        }
      }

      // Opening tag
      const tagMatch = html.slice(pos).match(/^<([a-zA-Z][\w-]*)/);
      if (tagMatch) {
        const tagName = tagMatch[1].toLowerCase();
        pos += tagMatch[0].length;

        // Parse attributes
        const attrs: [string, string][] = [];
        let selfClosing = false;

        // Skip whitespace and parse attributes until > or />
        while (pos < len) {
          // Skip whitespace
          while (pos < len && /\s/.test(html[pos])) pos++;

          // Check for end of tag
          if (html[pos] === '>') {
            pos++;
            break;
          }
          if (html.slice(pos, pos + 2) === '/>') {
            selfClosing = true;
            pos += 2;
            break;
          }

          // Parse attribute - handle escaped quotes in values
          // CRITICAL FIX: Use ([^\s/>]+) for unquoted values instead of ([^\s>]+)
          // Previously, unquoted values consumed the trailing slash in self-closing tags
          // e.g., <div val=1/> would capture "1/" as the value, breaking the /> detection
          const attrMatch = html.slice(pos).match(/^([^\s=/>]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s/>]+)))?/);
          if (attrMatch) {
            const attrName = attrMatch[1];
            // Unescape quotes in attribute values
            let attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
            if (attrMatch[2] !== undefined || attrMatch[3] !== undefined) {
              // Unescape common escape sequences in quoted attributes
              attrValue = attrValue.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            }
            attrs.push([attrName, attrValue]);
            pos += attrMatch[0].length;
          } else {
            pos++; // Skip invalid character
          }
        }

        // Create element node
        const elemNode = createVNode(ELEMENT_NODE, tagName);
        for (const [name, value] of attrs) {
          elemNode.attributes!.set(name, value);
          if (name === 'id') elemNode.id = value;
          if (name === 'class') {
            elemNode.className = value;
            value.split(/\s+/).filter(Boolean).forEach(cls => elemNode.classList!.add(cls));
          }
          if (name === 'value') elemNode.value = value;
          if (name === 'type') elemNode.type = value;
          if (name === 'checked') elemNode.checked = true;
        }

        addNode(elemNode);

        // Handle void elements and self-closing tags
        if (!selfClosing && !VOID_ELEMENTS.has(tagName)) {
          // CRITICAL FIX: Handle raw text elements (script, style, title, textarea)
          // Their content should NOT be parsed as HTML - it's treated as raw text
          if (RAW_TEXT_ELEMENTS.has(tagName) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(tagName)) {
            // Find the closing tag for this element (case-insensitive)
            const closingTagPattern = new RegExp(`</${tagName}>`, 'i');
            const closingMatch = html.slice(pos).match(closingTagPattern);

            if (closingMatch && closingMatch.index !== undefined) {
              // Extract raw content between opening and closing tag
              const rawContent = html.slice(pos, pos + closingMatch.index);

              if (rawContent) {
                // For escapable raw text elements, decode basic HTML entities
                let textContent = rawContent;
                if (ESCAPABLE_RAW_TEXT_ELEMENTS.has(tagName)) {
                  textContent = rawContent
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&nbsp;/g, '\u00A0');
                }

                // Add raw content as a single text node
                const textNode = createVNode(TEXT_NODE, undefined, textContent);
                textNode.parentNode = elemNode;
                elemNode.childNodes.push(textNode);
              }

              // Move position past the closing tag
              pos = pos + closingMatch.index + closingMatch[0].length;
              updateRelationships(elemNode);
            } else {
              // No closing tag found - treat rest of content as raw text
              const remainingContent = html.slice(pos);
              if (remainingContent) {
                const textNode = createVNode(TEXT_NODE, undefined, remainingContent);
                textNode.parentNode = elemNode;
                elemNode.childNodes.push(textNode);
              }
              pos = len;
              updateRelationships(elemNode);
            }
          } else {
            // Normal elements - push to stack for recursive parsing
            stack.push({ node: elemNode, tagName });
          }
        } else {
          updateRelationships(elemNode);
        }

        continue;
      }

      // CRITICAL FIX: If '<' is not followed by a valid tag, treat it as text content
      // Previously, this would skip the '<' entirely, losing data (e.g., "1 < 2" became "1  2")
      // Now we find the next potential tag and include the '<' in the text content
      const nextPotentialTag = html.slice(pos + 1).search(/<(?:[a-zA-Z/!]|$)/);
      const textEnd = nextPotentialTag === -1 ? len : pos + 1 + nextPotentialTag;
      const text = html.slice(pos, textEnd);

      if (text) {
        // Decode basic HTML entities
        const decodedText = text
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, '\u00A0');

        const textNode = createVNode(TEXT_NODE, undefined, decodedText);
        addNode(textNode);
      }

      pos = textEnd;
      continue;
    }

    // Text content - find the next tag
    const nextTag = html.indexOf('<', pos);
    const textEnd = nextTag === -1 ? len : nextTag;
    const text = html.slice(pos, textEnd);

    if (text.trim() || (text && stack.length > 0)) {
      // Decode basic HTML entities
      const decodedText = text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, '\u00A0');

      const textNode = createVNode(TEXT_NODE, undefined, decodedText);
      addNode(textNode);
    }

    pos = textEnd;
  }

  // Close any remaining open tags
  while (stack.length > 0) {
    const top = stack.pop()!;
    updateRelationships(top.node);
  }

  // Update relationships for top-level nodes
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].previousSibling = nodes[i - 1] ?? null;
    nodes[i].nextSibling = nodes[i + 1] ?? null;
  }

  return nodes;
}

/**
 * Create a virtual node with the standard DOM-like interface.
 * Includes DOM-like methods for compatibility with CompilerMixin.
 */
function createVNode(
  nodeType: number,
  tagName?: string,
  nodeValue?: string | null
): VNode {
  const node: VNode = {
    nodeType,
    tagName: tagName?.toUpperCase(),
    nodeValue: nodeValue ?? null,
    childNodes: [],
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    isConnected: false,
    props: {},
    _listeners: new Map(),
    style: createStyleObject(),
    classList: createClassList()
  };

  if (nodeType === ELEMENT_NODE) {
    node.attributes = new Map();
    node.id = '';

    // CRITICAL FIX: className and classList must be synced bidirectionally
    // Use a property with getter/setter to ensure they stay in sync
    // The classList is the source of truth; className is derived from it
    let _classNameCache = '';

    Object.defineProperty(node, 'className', {
      get() {
        // Return cached value if classList hasn't changed
        const listStr = node.classList!.toString();
        if (listStr !== _classNameCache) {
          _classNameCache = listStr;
        }
        return _classNameCache;
      },
      set(value: string) {
        // Clear existing classes and add new ones
        const classList = node.classList!;
        // Clear all existing classes
        for (const cls of Array.from(classList)) {
          classList.remove(cls);
        }
        // Add new classes from the string
        if (value) {
          value.split(/\s+/).filter(Boolean).forEach(cls => classList.add(cls));
        }
        _classNameCache = node.classList!.toString();
      },
      enumerable: true,
      configurable: true
    });

    // CRITICAL FIX: textContent must update childNodes like real DOM
    // Previously missing, causing m-text directive to fail silently
    // Setting textContent would just add a plain property, not update children
    Object.defineProperty(node, 'textContent', {
      get() {
        // For element nodes, recursively get text content of all children
        return node.childNodes.map(child => {
          if (child.nodeType === TEXT_NODE) {
            return child.nodeValue ?? '';
          }
          // Recursively get textContent from element children
          return (child as any).textContent ?? '';
        }).join('');
      },
      set(text: string) {
        // Clear existing childNodes and insert a single TEXT_NODE
        node.childNodes = [createVNode(TEXT_NODE, undefined, String(text))];
        updateRelationships(node);
      },
      enumerable: true,
      configurable: true
    });

    // CRITICAL FIX: innerHTML must parse HTML content into childNodes
    // Previously only templates had this behavior, causing "ghost content" bug
    // where m-html would set innerHTML but childNodes remained empty
    Object.defineProperty(node, 'innerHTML', {
      get() {
        // Serialize childNodes back to HTML string
        return node.childNodes.map(child => serializeVNode(child)).join('');
      },
      set(html: string) {
        // Clear existing childNodes
        node.childNodes = [];
        node.firstChild = null;
        node.lastChild = null;

        // Parse HTML string into virtual DOM nodes
        if (html) {
          const parsedNodes = parseHTML(html);
          for (const child of parsedNodes) {
            child.parentNode = node;
            node.childNodes.push(child);
          }
          updateRelationships(node);
        }
      },
      enumerable: true,
      configurable: true
    });

    // Add DOM-like methods for compatibility with CompilerMixin
    (node as any).getAttribute = function(name: string): string | null {
      return this.attributes?.get(name) ?? null;
    };

    (node as any).setAttribute = function(name: string, value: string): void {
      if (!this.attributes) this.attributes = new Map();
      this.attributes.set(name, value);
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name === 'value') this.value = value;
      // CRITICAL FIX: Sync boolean attributes to properties
      // Previously only 'value' was synced, causing el.checked to remain undefined
      // even after setAttribute('checked', 'true') was called
      if (name === 'checked') this.checked = value !== null && value !== 'false';
      if (name === 'disabled') this.disabled = value !== null && value !== 'false';
      if (name === 'readonly') this.readOnly = value !== null && value !== 'false';
      if (name === 'selected') this.selected = value !== null && value !== 'false';
    };

    (node as any).removeAttribute = function(name: string): void {
      this.attributes?.delete(name);
      if (name === 'id') this.id = '';
      if (name === 'class') this.className = '';
    };

    (node as any).hasAttribute = function(name: string): boolean {
      return this.attributes?.has(name) ?? false;
    };

    (node as any).cloneNode = function(deep = true): VNode {
      return cloneVNode(this, deep);
    };

    (node as any).replaceWith = function(...nodes: VNode[]): void {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(this);
      if (index === -1) return;
      parent.childNodes.splice(index, 1, ...nodes);
      this.parentNode = null;
      updateRelationships(parent);
    };

    (node as any).remove = function(): void {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(this);
      if (index !== -1) {
        parent.childNodes.splice(index, 1);
        updateRelationships(parent);
      }
      this.parentNode = null;
      this.nextSibling = null;
      this.previousSibling = null;
      updateConnected(this, false);
    };

    (node as any).after = function(...nodes: VNode[]): void {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.childNodes.indexOf(this);
      if (index === -1) return;
      parent.childNodes.splice(index + 1, 0, ...nodes);
      updateRelationships(parent);
      for (const n of nodes) {
        updateConnected(n, parent.isConnected ?? false);
      }
    };

    (node as any).insertBefore = function(newChild: VNode, refChild: VNode | null): VNode {
      if (!refChild) {
        this.childNodes.push(newChild);
      } else {
        const index = this.childNodes.indexOf(refChild);
        if (index === -1) {
          this.childNodes.push(newChild);
        } else {
          this.childNodes.splice(index, 0, newChild);
        }
      }
      updateRelationships(this);
      updateConnected(newChild, this.isConnected ?? false);
      return newChild;
    };

    (node as any).appendChild = function(child: VNode): VNode {
      this.childNodes.push(child);
      updateRelationships(this);
      updateConnected(child, this.isConnected ?? false);
      return child;
    };

    (node as any).contains = function(other: VNode): boolean {
      let current: VNode | null = other;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    };

    (node as any).querySelector = function(selector: string): VNode | null {
      return querySelector(this, selector);
    };

    (node as any).querySelectorAll = function(selector: string): VNode[] {
      return querySelectorAll(this, selector);
    };

    (node as any).dispatchEvent = function(event: any): boolean {
      const handlers = this._listeners?.get(event.type);
      if (handlers) {
        for (const handler of handlers) {
          handler(event);
        }
      }
      return true;
    };

    (node as any).addEventListener = function(event: string, handler: Function, _options?: any): void {
      if (!this._listeners) this._listeners = new Map();
      let handlers = this._listeners.get(event);
      if (!handlers) {
        handlers = [];
        this._listeners.set(event, handlers);
      }
      handlers.push(handler);
    };

    (node as any).removeEventListener = function(event: string, handler: Function, _options?: any): void {
      const handlers = this._listeners?.get(event);
      if (!handlers) return;
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    };

    // Mock form element properties for SSR/testing compatibility
    // This prevents "Cannot read property 'length' of undefined" errors
    const upperTag = tagName?.toUpperCase();

    if (upperTag === 'SELECT') {
      // Mock 'options' getter - returns OPTION child elements
      Object.defineProperty(node, 'options', {
        get() {
          return this.childNodes.filter((n: VNode) => n.tagName === 'OPTION');
        }
      });
      // Mock 'selectedOptions' getter - returns selected OPTION elements
      Object.defineProperty(node, 'selectedOptions', {
        get() {
          return this.options.filter((n: VNode) => n.attributes?.get('selected') !== undefined);
        }
      });
    }

    if (upperTag === 'INPUT') {
      // Mock ValidityState for inputs (prevents NaN crashes with number inputs)
      (node as any).validity = {
        badInput: false,
        customError: false,
        patternMismatch: false,
        rangeOverflow: false,
        rangeUnderflow: false,
        stepMismatch: false,
        tooLong: false,
        tooShort: false,
        typeMismatch: false,
        valid: true,
        valueMissing: false
      };
    }

    if (upperTag === 'TEXTAREA') {
      // Mock ValidityState for textareas as well
      (node as any).validity = {
        badInput: false,
        customError: false,
        patternMismatch: false,
        rangeOverflow: false,
        rangeUnderflow: false,
        stepMismatch: false,
        tooLong: false,
        tooShort: false,
        typeMismatch: false,
        valid: true,
        valueMissing: false
      };
    }
  }

  return node;
}

/**
 * Parse a CSS string into a map of property-value pairs.
 * Handles both camelCase and kebab-case property names.
 */
function parseCSSText(cssText: string): Map<string, string> {
  const props = new Map<string, string>();
  if (!cssText) return props;

  // CRITICAL FIX: Split by semicolons ONLY if not inside parentheses
  // This prevents breaking data URIs like: background-image: url('data:image/png;base64,ABC')
  // The regex /;(?![^(]*\))/ matches semicolons not followed by a closing paren without an opening paren
  const declarations = cssText.split(/;(?![^(]*\))/g);
  for (const decl of declarations) {
    const trimmed = decl.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const prop = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (prop && value) {
      // Store both kebab-case and camelCase versions
      props.set(prop, value);

      // Convert kebab-case to camelCase for JS access
      const camelCase = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camelCase !== prop) {
        props.set(camelCase, value);
      }
    }
  }
  return props;
}

/**
 * Convert a map of CSS properties back to cssText string.
 */
function serializeCSSText(props: Map<string, string>): string {
  const seen = new Set<string>();
  let result = '';

  for (const [prop, value] of props) {
    // Skip camelCase duplicates (only output kebab-case)
    const kebabCase = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
    if (seen.has(kebabCase)) continue;
    seen.add(kebabCase);

    if (result) result += ' ';
    result += `${kebabCase}: ${value};`;
  }
  return result;
}

/**
 * Create a reactive style object for virtual nodes.
 * Properly parses and tracks CSS properties.
 */
function createStyleObject(): Record<string, any> {
  const props = new Map<string, string>();
  let cachedCssText = '';

  // Create a proxy to handle dynamic property access
  const handler: ProxyHandler<object> = {
    get(target, prop: string) {
      if (prop === 'cssText') {
        return cachedCssText;
      }
      if (prop === 'setProperty') {
        return (name: string, value: string) => {
          if (value === null || value === '') {
            props.delete(name);
            const camelCase = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            props.delete(camelCase);
          } else {
            props.set(name, value);
            const camelCase = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            if (camelCase !== name) props.set(camelCase, value);
          }
          cachedCssText = serializeCSSText(props);
        };
      }
      if (prop === 'getPropertyValue') {
        return (name: string) => props.get(name) ?? '';
      }
      if (prop === 'removeProperty') {
        return (name: string) => {
          const value = props.get(name);
          props.delete(name);
          const camelCase = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          props.delete(camelCase);
          cachedCssText = serializeCSSText(props);
          return value ?? '';
        };
      }
      // Return the property value or empty string
      return props.get(prop) ?? '';
    },
    set(target, prop: string, value: string) {
      if (prop === 'cssText') {
        // Parse the entire cssText and update all properties
        props.clear();
        const parsed = parseCSSText(value);
        for (const [k, v] of parsed) {
          props.set(k, v);
        }
        cachedCssText = value;
        return true;
      }
      // Setting individual property
      if (value === null || value === '' || value === undefined) {
        props.delete(prop);
        const kebabCase = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        props.delete(kebabCase);
      } else {
        props.set(prop, value);
        // Also store kebab-case version
        const kebabCase = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (kebabCase !== prop) props.set(kebabCase, value);
      }
      cachedCssText = serializeCSSText(props);
      return true;
    },
    has(target, prop: string) {
      return prop === 'cssText' || props.has(prop);
    },
    ownKeys(): (string | symbol)[] {
      return ['cssText', ...Array.from(props.keys())];
    },
    getOwnPropertyDescriptor(target, prop: string | symbol) {
      if (typeof prop === 'string' && (prop === 'cssText' || props.has(prop))) {
        return { enumerable: true, configurable: true, writable: true };
      }
      return undefined;
    }
  };

  return new Proxy({}, handler);
}

/**
 * Create a classList-like object for virtual nodes.
 */
function createClassList() {
  const classes = new Set<string>();

  return {
    add(...classNames: string[]) {
      for (const cls of classNames) {
        if (cls) classes.add(cls);
      }
    },
    remove(...classNames: string[]) {
      for (const cls of classNames) {
        classes.delete(cls);
      }
    },
    contains(cls: string): boolean {
      return classes.has(cls);
    },
    toggle(cls: string, force?: boolean): boolean {
      if (force === undefined) {
        if (classes.has(cls)) {
          classes.delete(cls);
          return false;
        } else {
          classes.add(cls);
          return true;
        }
      }
      if (force) {
        classes.add(cls);
        return true;
      } else {
        classes.delete(cls);
        return false;
      }
    },
    toString(): string {
      return Array.from(classes).join(' ');
    },
    get length(): number {
      return classes.size;
    },
    item(index: number): string | null {
      return Array.from(classes)[index] ?? null;
    },
    [Symbol.iterator]() {
      return classes[Symbol.iterator]();
    }
  };
}

/**
 * Update parent-child and sibling relationships after DOM mutation.
 */
function updateRelationships(parent: VNode): void {
  const children = parent.childNodes;
  parent.firstChild = children[0] ?? null;
  parent.lastChild = children[children.length - 1] ?? null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    child.parentNode = parent;
    child.previousSibling = children[i - 1] ?? null;
    child.nextSibling = children[i + 1] ?? null;
    child.isConnected = parent.isConnected;
  }
}

/**
 * Recursively update isConnected state for a subtree.
 */
function updateConnected(node: VNode, connected: boolean): void {
  node.isConnected = connected;
  for (const child of node.childNodes) {
    updateConnected(child, connected);
  }
}

/**
 * Deep clone a virtual node.
 */
function cloneVNode(node: VNode, deep = true): VNode {
  const clone = createVNode(node.nodeType, node.tagName, node.nodeValue);

  // Clone attributes
  if (node.attributes) {
    clone.attributes = new Map(node.attributes);
  }

  // Clone properties
  if (node.props) {
    clone.props = { ...node.props };
  }

  // Clone style - copy cssText to properly initialize the new reactive style object
  if (node.style && node.style.cssText) {
    clone.style.cssText = node.style.cssText;
  }

  // Clone class list
  if (node.classList) {
    for (const cls of node.classList) {
      clone.classList!.add(cls);
    }
  }

  // Clone other element properties
  // NOTE: className setter syncs with classList, so setting it after classList.add
  // will overwrite the classList. Only set className if it differs from classList.
  const classListStr = clone.classList?.toString() || '';
  if (node.className && node.className !== classListStr) {
    clone.className = node.className;
  }
  clone.id = node.id;
  clone.value = node.value;
  clone.checked = node.checked;
  clone.type = node.type;
  // NOTE: Do NOT copy innerHTML here - it now parses content into childNodes
  // For deep clones, children are explicitly cloned below
  // For shallow clones, we intentionally skip children

  // Deep clone children
  if (deep) {
    for (const child of node.childNodes) {
      const clonedChild = cloneVNode(child, true);
      clone.childNodes.push(clonedChild);
    }
    updateRelationships(clone);
  }

  // Special handling for template elements
  if (node.tagName === 'TEMPLATE' && node.content) {
    clone.content = cloneVNode(node.content, true);
  }

  return clone;
}

/**
 * Parse a simple selector (no combinators) into parts.
 * Returns null if invalid.
 */
interface SimpleSelectorParts {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op?: string; value?: string }[];
  pseudos: { name: string; arg?: string }[];
}

function parseSimpleSelector(selector: string): SimpleSelectorParts | null {
  const parts: SimpleSelectorParts = { classes: [], attrs: [], pseudos: [] };
  let pos = 0;
  const len = selector.length;

  while (pos < len) {
    const char = selector[pos];

    // Tag name (must be first if present)
    if (pos === 0 && /[a-zA-Z*]/.test(char)) {
      const match = selector.slice(pos).match(/^([a-zA-Z][\w-]*|\*)/);
      if (match) {
        parts.tag = match[1] === '*' ? '*' : match[1].toUpperCase();
        pos += match[0].length;
        continue;
      }
    }

    // ID selector
    if (char === '#') {
      const match = selector.slice(pos + 1).match(/^[\w-]+/);
      if (match) {
        parts.id = match[0];
        pos += match[0].length + 1;
        continue;
      }
    }

    // Class selector
    if (char === '.') {
      const match = selector.slice(pos + 1).match(/^[\w-]+/);
      if (match) {
        parts.classes.push(match[0]);
        pos += match[0].length + 1;
        continue;
      }
    }

    // Attribute selector
    if (char === '[') {
      const closeIdx = selector.indexOf(']', pos);
      if (closeIdx !== -1) {
        const attrContent = selector.slice(pos + 1, closeIdx);
        const attrMatch = attrContent.match(/^([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]+)["']?)?$/);
        if (attrMatch) {
          parts.attrs.push({
            name: attrMatch[1],
            op: attrMatch[2],
            value: attrMatch[3]
          });
        }
        pos = closeIdx + 1;
        continue;
      }
    }

    // Pseudo-class
    if (char === ':') {
      const match = selector.slice(pos + 1).match(/^([\w-]+)(?:\(([^)]*)\))?/);
      if (match) {
        parts.pseudos.push({
          name: match[1],
          arg: match[2]
        });
        pos += match[0].length + 1;
        continue;
      }
    }

    pos++;
  }

  return parts;
}

/**
 * Check if a node matches a simple selector (no combinators).
 */
function matchesSimpleSelector(node: VNode, parts: SimpleSelectorParts): boolean {
  if (node.nodeType !== ELEMENT_NODE) return false;

  // Check tag
  if (parts.tag && parts.tag !== '*' && node.tagName !== parts.tag) {
    return false;
  }

  // Check ID
  if (parts.id && node.id !== parts.id) {
    return false;
  }

  // Check classes
  for (const cls of parts.classes) {
    if (!node.classList?.contains(cls)) {
      return false;
    }
  }

  // Check attributes
  for (const attr of parts.attrs) {
    const nodeValue = node.attributes?.get(attr.name);
    if (!attr.op) {
      // Presence check
      if (nodeValue === undefined && !node.attributes?.has(attr.name)) {
        return false;
      }
    } else if (attr.op === '=') {
      if (nodeValue !== attr.value) return false;
    } else if (attr.op === '~=') {
      // Contains word
      if (!nodeValue?.split(/\s+/).includes(attr.value!)) return false;
    } else if (attr.op === '|=') {
      // Starts with or equals
      if (nodeValue !== attr.value && !nodeValue?.startsWith(attr.value + '-')) return false;
    } else if (attr.op === '^=') {
      // Starts with
      if (!nodeValue?.startsWith(attr.value!)) return false;
    } else if (attr.op === '$=') {
      // Ends with
      if (!nodeValue?.endsWith(attr.value!)) return false;
    } else if (attr.op === '*=') {
      // Contains
      if (!nodeValue?.includes(attr.value!)) return false;
    }
  }

  // Check pseudo-classes
  for (const pseudo of parts.pseudos) {
    if (!matchesPseudoClass(node, pseudo.name, pseudo.arg)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a node matches a pseudo-class.
 */
function matchesPseudoClass(node: VNode, name: string, arg?: string): boolean {
  const parent = node.parentNode;
  if (!parent) return false;

  const siblings = parent.childNodes.filter(n => n.nodeType === ELEMENT_NODE);
  const index = siblings.indexOf(node);

  switch (name) {
    case 'first-child':
      return index === 0;

    case 'last-child':
      return index === siblings.length - 1;

    case 'only-child':
      return siblings.length === 1;

    case 'nth-child': {
      if (!arg) return false;
      return matchesNth(index + 1, arg);
    }

    case 'nth-last-child': {
      if (!arg) return false;
      return matchesNth(siblings.length - index, arg);
    }

    case 'first-of-type': {
      const sameType = siblings.filter(n => n.tagName === node.tagName);
      return sameType[0] === node;
    }

    case 'last-of-type': {
      const sameType = siblings.filter(n => n.tagName === node.tagName);
      return sameType[sameType.length - 1] === node;
    }

    case 'nth-of-type': {
      if (!arg) return false;
      const sameType = siblings.filter(n => n.tagName === node.tagName);
      const typeIndex = sameType.indexOf(node);
      return matchesNth(typeIndex + 1, arg);
    }

    case 'empty':
      return node.childNodes.length === 0 ||
             node.childNodes.every(c =>
               c.nodeType === TEXT_NODE && !c.nodeValue?.trim()
             );

    case 'not': {
      if (!arg) return true;
      const notParts = parseSimpleSelector(arg);
      return notParts ? !matchesSimpleSelector(node, notParts) : true;
    }

    default:
      return true; // Unknown pseudo-classes pass by default
  }
}

/**
 * Match nth-child formula (e.g., "odd", "even", "3", "2n+1").
 */
function matchesNth(pos: number, formula: string): boolean {
  formula = formula.trim().toLowerCase();

  if (formula === 'odd') return pos % 2 === 1;
  if (formula === 'even') return pos % 2 === 0;

  // Simple number
  const simpleNum = parseInt(formula, 10);
  if (!isNaN(simpleNum) && formula === String(simpleNum)) {
    return pos === simpleNum;
  }

  // an+b formula
  const match = formula.match(/^(-?\d*)?n([+-]\d+)?$/);
  if (match) {
    const a = match[1] === '' || match[1] === undefined ? 1 :
              match[1] === '-' ? -1 : parseInt(match[1], 10);
    const b = match[2] ? parseInt(match[2], 10) : 0;

    if (a === 0) return pos === b;
    return (pos - b) % a === 0 && (pos - b) / a >= 0;
  }

  return false;
}

/**
 * Parse a selector into parts with combinators.
 */
interface SelectorPart {
  selector: SimpleSelectorParts;
  combinator?: ' ' | '>' | '+' | '~';
}

function parseSelectorWithCombinators(selector: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let lastCombinator: ' ' | '>' | '+' | '~' | undefined;

  // Normalize whitespace around combinators
  const normalized = selector
    .replace(/\s*>\s*/g, ' > ')
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s*~\s*/g, ' ~ ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(' ');

  for (const token of tokens) {
    if (token === '>') {
      lastCombinator = '>';
    } else if (token === '+') {
      lastCombinator = '+';
    } else if (token === '~') {
      lastCombinator = '~';
    } else if (token) {
      const parsed = parseSimpleSelector(token);
      if (parsed) {
        parts.push({
          selector: parsed,
          combinator: lastCombinator ?? (parts.length > 0 ? ' ' : undefined)
        });
      }
      lastCombinator = undefined;
    }
  }

  return parts;
}

/**
 * CSS selector matcher for virtual nodes.
 * Supports: tag, #id, .class, [attr], [attr="value"],
 * descendant combinator (space), child combinator (>),
 * adjacent sibling (+), general sibling (~),
 * and pseudo-classes (:first-child, :nth-child, etc.)
 */
function matchesSelector(node: VNode, selector: string): boolean {
  if (node.nodeType !== ELEMENT_NODE) return false;

  // Handle comma-separated selectors (OR)
  const selectors = selector.split(',').map(s => s.trim());

  for (const sel of selectors) {
    const parts = parseSelectorWithCombinators(sel);
    if (parts.length === 0) continue;

    // Match from right to left
    if (matchesSelectorParts(node, parts, parts.length - 1)) {
      return true;
    }
  }

  return false;
}

/**
 * Match selector parts recursively from right to left.
 */
function matchesSelectorParts(node: VNode, parts: SelectorPart[], index: number): boolean {
  if (index < 0) return true;

  const part = parts[index];
  if (!matchesSimpleSelector(node, part.selector)) {
    return false;
  }

  // If this is the first part (leftmost), we're done
  if (index === 0) return true;

  const prevPart = parts[index];
  const combinator = prevPart.combinator;

  if (combinator === '>') {
    // Direct parent
    const parent = node.parentNode;
    return parent !== null && matchesSelectorParts(parent, parts, index - 1);
  } else if (combinator === '+') {
    // Adjacent sibling - find previous element sibling
    let prevElem = node.previousSibling;
    while (prevElem && prevElem.nodeType !== ELEMENT_NODE) {
      prevElem = prevElem.previousSibling;
    }
    return prevElem !== null &&
           matchesSelectorParts(prevElem, parts, index - 1);
  } else if (combinator === '~') {
    // General sibling
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === ELEMENT_NODE &&
          matchesSelectorParts(sibling, parts, index - 1)) {
        return true;
      }
      sibling = sibling.previousSibling;
    }
    return false;
  } else {
    // Descendant (space)
    let ancestor = node.parentNode;
    while (ancestor) {
      if (matchesSelectorParts(ancestor, parts, index - 1)) {
        return true;
      }
      ancestor = ancestor.parentNode;
    }
    return false;
  }
}

/**
 * Find first matching element in subtree.
 */
function querySelector(root: VNode, selector: string): VNode | null {
  for (const child of root.childNodes) {
    if (matchesSelector(child, selector)) return child;
    const found = querySelector(child, selector);
    if (found) return found;
  }
  return null;
}

/**
 * Find all matching elements in subtree.
 */
function querySelectorAll(root: VNode, selector: string): VNode[] {
  const results: VNode[] = [];

  function traverse(node: VNode) {
    for (const child of node.childNodes) {
      if (matchesSelector(child, selector)) results.push(child);
      traverse(child);
    }
  }

  traverse(root);
  return results;
}

/**
 * Escape HTML special characters to prevent XSS in SSR output.
 * CRITICAL SECURITY: Text content must be escaped before insertion into HTML.
 */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize a virtual node to HTML string.
 * Note: Does not add formatting/indentation to preserve exact whitespace for SSR.
 */
function serializeVNode(node: VNode, indent = 0): string {
  if (node.nodeType === TEXT_NODE) {
    // CRITICAL SECURITY FIX: Escape text content to prevent XSS
    // Without escaping, user input like "<script>alert(1)</script>" would execute
    return escapeHTML(node.nodeValue ?? '');
  }

  if (node.nodeType === COMMENT_NODE) {
    return `<!--${node.nodeValue}-->`;
  }

  if (node.nodeType === ELEMENT_NODE) {
    const tag = node.tagName!.toLowerCase();

    // Build attributes string
    let attrs = '';
    if (node.attributes) {
      for (const [key, value] of node.attributes) {
        // CRITICAL SECURITY FIX: Escape all HTML special characters in attribute values
        // Not just quotes - & < > " ' can all break out of attributes
        // Example: value="a&b" must become value="a&amp;b"
        const escapedValue = escapeHTML(String(value));
        attrs += ` ${key}="${escapedValue}"`;
      }
    }
    if (node.id) attrs += ` id="${escapeHTML(String(node.id))}"`;
    if (node.className) attrs += ` class="${escapeHTML(String(node.className))}"`;
    const classList = node.classList?.toString();
    if (classList && !node.className) attrs += ` class="${escapeHTML(classList)}"`;

    // CRITICAL FIX: Use the single source of truth VOID_ELEMENTS Set
    // Previously used incomplete hardcoded array, missing: source, track, wbr, col, embed, etc.
    // This caused invalid HTML output like <source></source> instead of <source />
    if (VOID_ELEMENTS.has(tag)) {
      return `<${tag}${attrs} />`;
    }

    // Regular elements
    if (node.childNodes.length === 0) {
      return `<${tag}${attrs}></${tag}>`;
    }

    // Serialize children without adding formatting to preserve whitespace
    const children = node.childNodes.map(c => serializeVNode(c, 0)).join('');

    return `<${tag}${attrs}>${children}</${tag}>`;
  }

  return '';
}

/**
 * Virtual Renderer implementation.
 *
 * Provides a complete virtual DOM for non-browser environments.
 */
export class VirtualRenderer implements IRendererAdapter {
  isBrowser = false;

  /** Root container for the virtual DOM */
  private root: VNode;

  /** Pending updates queue */
  private pendingUpdates: Set<VNode> = new Set();

  /** Animation frame simulation */
  private animationFrameId = 0;
  private animationFrameCallbacks: Map<number, FrameRequestCallback> = new Map();

  /** Debug mode flag */
  private debug: boolean;

  /** Custom event dispatcher for native targets */
  private eventDispatcher?: (node: VNode, event: string, detail: any) => void;

  constructor(options: { debug?: boolean; eventDispatcher?: (node: VNode, event: string, detail: any) => void } = {}) {
    this.debug = options.debug ?? false;
    this.eventDispatcher = options.eventDispatcher;

    // Create root document-like container
    this.root = createVNode(ELEMENT_NODE, 'body');
    this.root.isConnected = true;
  }

  createComment(text: string): VNode {
    return createVNode(COMMENT_NODE, undefined, text);
  }

  createElement(tagName: string): VNode {
    const node = createVNode(ELEMENT_NODE, tagName);

    // Special handling for template elements
    if (tagName.toLowerCase() === 'template') {
      node.content = createVNode(ELEMENT_NODE, 'fragment');
      node.content.isConnected = false;

      // Define innerHTML setter to parse content using real HTML parser
      Object.defineProperty(node, 'innerHTML', {
        set(html: string) {
          // Parse HTML string into virtual DOM nodes
          node.content!.childNodes = [];
          const parsedNodes = parseHTML(html);
          for (const child of parsedNodes) {
            child.parentNode = node.content!;
            node.content!.childNodes.push(child);
          }
          updateRelationships(node.content!);
        },
        get() {
          return serializeVNode(node.content!);
        }
      });
    }

    return node;
  }

  createTextNode(text: string): VNode {
    return createVNode(TEXT_NODE, undefined, text);
  }

  createTemplate(): VNode {
    return this.createElement('template');
  }

  cloneNode<T extends VNode>(node: T, deep = true): T {
    return cloneVNode(node, deep) as T;
  }

  replaceWith(oldNode: VNode, newNode: VNode): void {
    const parent = oldNode.parentNode;
    if (!parent) return;

    const index = parent.childNodes.indexOf(oldNode);
    if (index === -1) return;

    // Remove old node connections
    oldNode.parentNode = null;
    oldNode.nextSibling = null;
    oldNode.previousSibling = null;
    updateConnected(oldNode, false);

    // Insert new node
    parent.childNodes[index] = newNode;
    updateRelationships(parent);
    updateConnected(newNode, parent.isConnected ?? false);

    if (this.debug) {
      console.log('[VirtualRenderer] replaceWith:', oldNode.tagName || oldNode.nodeValue, '->', newNode.tagName || newNode.nodeValue);
    }
  }

  insertBefore(parent: VNode, newNode: VNode, refNode: VNode | null): void {
    if (!refNode) {
      this.appendChild(parent, newNode);
      return;
    }

    const index = parent.childNodes.indexOf(refNode);
    if (index === -1) {
      this.appendChild(parent, newNode);
      return;
    }

    parent.childNodes.splice(index, 0, newNode);
    updateRelationships(parent);
    updateConnected(newNode, parent.isConnected ?? false);

    if (this.debug) {
      console.log('[VirtualRenderer] insertBefore:', newNode.tagName || newNode.nodeValue);
    }
  }

  insertAfter(refNode: VNode, newNode: VNode): void {
    const parent = refNode.parentNode;
    if (!parent) return;

    const index = parent.childNodes.indexOf(refNode);
    if (index === -1) return;

    parent.childNodes.splice(index + 1, 0, newNode);
    updateRelationships(parent);
    updateConnected(newNode, parent.isConnected ?? false);

    if (this.debug) {
      console.log('[VirtualRenderer] insertAfter:', newNode.tagName || newNode.nodeValue);
    }
  }

  appendChild(parent: VNode, child: VNode): void {
    parent.childNodes.push(child);
    updateRelationships(parent);
    updateConnected(child, parent.isConnected ?? false);

    if (this.debug) {
      console.log('[VirtualRenderer] appendChild:', child.tagName || child.nodeValue);
    }
  }

  removeChild(node: VNode): void {
    const parent = node.parentNode;
    if (!parent) return;

    const index = parent.childNodes.indexOf(node);
    if (index === -1) return;

    parent.childNodes.splice(index, 1);
    node.parentNode = null;
    node.nextSibling = null;
    node.previousSibling = null;
    updateRelationships(parent);
    updateConnected(node, false);

    if (this.debug) {
      console.log('[VirtualRenderer] removeChild:', node.tagName || node.nodeValue);
    }
  }

  getAttribute(node: VNode, name: string): string | null {
    return node.attributes?.get(name) ?? null;
  }

  setAttribute(node: VNode, name: string, value: string): void {
    if (!node.attributes) node.attributes = new Map();
    node.attributes.set(name, value);

    // Sync common properties
    if (name === 'id') node.id = value;
    if (name === 'class') {
      node.className = value;
      // Parse classes into classList
      const classes = value.split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        node.classList?.add(cls);
      }
    }
    if (name === 'value') node.value = value;

    if (this.debug) {
      console.log('[VirtualRenderer] setAttribute:', node.tagName, name, '=', value);
    }
  }

  removeAttribute(node: VNode, name: string): void {
    node.attributes?.delete(name);

    if (name === 'id') node.id = '';
    if (name === 'class') node.className = '';
  }

  addEventListener(
    node: VNode,
    event: string,
    handler: EventListener,
    _options?: AddEventListenerOptions
  ): void {
    if (!node._listeners) node._listeners = new Map();
    let handlers = node._listeners.get(event);
    if (!handlers) {
      handlers = [];
      node._listeners.set(event, handlers);
    }
    handlers.push(handler);
  }

  removeEventListener(
    node: VNode,
    event: string,
    handler: EventListener,
    _options?: AddEventListenerOptions
  ): void {
    const handlers = node._listeners?.get(event);
    if (!handlers) return;

    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  dispatchEvent(node: VNode, event: string, detail?: any): void {
    // Use custom dispatcher if provided
    if (this.eventDispatcher) {
      this.eventDispatcher(node, event, detail);
      return;
    }

    // Create synthetic event with proper bubbling support
    let propagationStopped = false;
    const syntheticEvent = {
      type: event,
      target: node,
      currentTarget: node,
      detail,
      preventDefault: () => {},
      stopPropagation: () => { propagationStopped = true; },
      bubbles: true,
      cancelBubble: false
    };

    // Implement event bubbling - traverse up the parent chain
    let currentNode: VNode | null = node;
    while (currentNode && !propagationStopped) {
      const handlers = currentNode._listeners?.get(event);
      if (handlers) {
        // Update currentTarget to the node being processed
        syntheticEvent.currentTarget = currentNode;

        // Call all handlers registered on this node
        for (const handler of handlers) {
          if (propagationStopped) break;
          handler(syntheticEvent as any);
        }
      }

      // Move to parent for bubbling
      currentNode = currentNode.parentNode;
    }

    if (this.debug) {
      console.log('[VirtualRenderer] dispatchEvent:', node.tagName, event, detail);
    }
  }

  setTextContent(node: VNode, text: string): void {
    node.nodeValue = text;

    if (this.debug) {
      console.log('[VirtualRenderer] setTextContent:', text);
    }
  }

  setInnerHTML(node: VNode, html: string): void {
    node.innerHTML = html;
    // In a real implementation, you'd parse the HTML into child nodes
    // For now, store as raw string

    if (this.debug) {
      console.log('[VirtualRenderer] setInnerHTML:', node.tagName, html.slice(0, 50) + '...');
    }
  }

  getAttributes(node: VNode): Map<string, string> {
    return node.attributes ?? new Map();
  }

  querySelector(node: VNode, selector: string): VNode | null {
    return querySelector(node, selector);
  }

  querySelectorAll(node: VNode, selector: string): VNode[] {
    return querySelectorAll(node, selector);
  }

  contains(parent: VNode, child: VNode): boolean {
    let current: VNode | null = child;
    while (current) {
      if (current === parent) return true;
      current = current.parentNode;
    }
    return false;
  }

  runTransition(node: VNode, config: TransitionConfig, _reflex?: any): void {
    // For virtual renderer, transitions complete immediately
    // Native targets can implement their own animation system
    const from = `${config.name}-${config.type}-from`;
    const active = `${config.name}-${config.type}-active`;
    const to = `${config.name}-${config.type}-to`;

    // Add classes to track state
    node.classList?.add(from, active);

    // Simulate immediate transition
    this.requestAnimationFrame(() => {
      node.classList?.remove(from);
      node.classList?.add(to);

      // Complete immediately
      node.classList?.remove(active, to);
      if (config.done) config.done();
    });
  }

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = ++this.animationFrameId;
    this.animationFrameCallbacks.set(id, callback);

    // Execute on next tick (synchronous for testing, async for production)
    queueMicrotask(() => {
      const cb = this.animationFrameCallbacks.get(id);
      if (cb) {
        this.animationFrameCallbacks.delete(id);
        cb(performance.now());
      }
    });

    return id;
  }

  cancelAnimationFrame(handle: number): void {
    this.animationFrameCallbacks.delete(handle);
  }

  getComputedStyle(_node: VNode): Record<string, string> {
    // Return mock computed style
    return {
      transitionDuration: '0s',
      transitionDelay: '0s',
      animationDuration: '0s',
      animationDelay: '0s',
      display: 'block'
    };
  }

  scheduleUpdate(node: VNode): void {
    this.pendingUpdates.add(node);
  }

  flushUpdates(): void {
    // Process all pending updates
    const updates = Array.from(this.pendingUpdates);
    this.pendingUpdates.clear();

    if (this.debug && updates.length > 0) {
      console.log('[VirtualRenderer] flushUpdates:', updates.length, 'nodes');
    }
  }

  serialize(node?: VNode): string {
    return serializeVNode(node ?? this.root);
  }

  getRoot(): VNode {
    return this.root;
  }

  /**
   * Get a snapshot of the virtual DOM as JSON.
   * Useful for testing assertions and debugging.
   */
  toJSON(node?: VNode): any {
    const n = node ?? this.root;

    if (n.nodeType === TEXT_NODE) {
      return { type: 'text', value: n.nodeValue };
    }

    if (n.nodeType === COMMENT_NODE) {
      return { type: 'comment', value: n.nodeValue };
    }

    return {
      type: 'element',
      tag: n.tagName?.toLowerCase(),
      attributes: n.attributes ? Object.fromEntries(n.attributes) : {},
      classes: n.classList ? Array.from(n.classList) : [],
      style: n.style?.cssText || '',
      children: n.childNodes.map(c => this.toJSON(c))
    };
  }

  /**
   * Reset the virtual DOM to initial state.
   * Useful for testing.
   */
  reset(): void {
    this.root.childNodes = [];
    this.root.firstChild = null;
    this.root.lastChild = null;
    this.pendingUpdates.clear();
    this.animationFrameCallbacks.clear();
  }
}

/**
 * Create a new VirtualRenderer instance.
 * Factory function for convenient instantiation.
 */
export function createVirtualRenderer(options?: { debug?: boolean }): VirtualRenderer {
  return new VirtualRenderer(options);
}

export default VirtualRenderer;
