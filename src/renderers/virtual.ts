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
    style: {
      display: '',
      cssText: ''
    },
    classList: createClassList()
  };

  if (nodeType === ELEMENT_NODE) {
    node.attributes = new Map();
    node.innerHTML = '';
    node.className = '';
    node.id = '';

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
  }

  return node;
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

  // Clone style
  if (node.style) {
    clone.style = { ...node.style };
  }

  // Clone class list
  if (node.classList) {
    for (const cls of node.classList) {
      clone.classList!.add(cls);
    }
  }

  // Clone other element properties
  clone.className = node.className;
  clone.id = node.id;
  clone.value = node.value;
  clone.checked = node.checked;
  clone.type = node.type;
  clone.innerHTML = node.innerHTML;

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
 * Simple CSS selector matcher for virtual nodes.
 * Supports: tag, #id, .class, [attr], [attr="value"]
 */
function matchesSelector(node: VNode, selector: string): boolean {
  if (node.nodeType !== ELEMENT_NODE) return false;

  const selectors = selector.split(',').map(s => s.trim());

  for (const sel of selectors) {
    // Tag selector
    if (/^[a-zA-Z][\w-]*$/.test(sel)) {
      if (node.tagName === sel.toUpperCase()) return true;
      continue;
    }

    // ID selector
    if (sel.startsWith('#')) {
      if (node.id === sel.slice(1)) return true;
      continue;
    }

    // Class selector
    if (sel.startsWith('.')) {
      if (node.classList?.contains(sel.slice(1))) return true;
      continue;
    }

    // Attribute selector
    const attrMatch = sel.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    if (attrMatch) {
      const [, attr, value] = attrMatch;
      if (value !== undefined) {
        if (node.attributes?.get(attr) === value) return true;
      } else {
        if (node.attributes?.has(attr)) return true;
      }
      continue;
    }

    // Compound selector (e.g., "tag.class", "tag#id")
    const parts = sel.match(/^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/);
    if (parts) {
      const [, tag, id, classes] = parts;
      let matches = true;

      if (tag && node.tagName !== tag.toUpperCase()) matches = false;
      if (id && node.id !== id.slice(1)) matches = false;
      if (classes) {
        const classList = classes.split('.').filter(Boolean);
        for (const cls of classList) {
          if (!node.classList?.contains(cls)) {
            matches = false;
            break;
          }
        }
      }

      if (matches) return true;
    }
  }

  return false;
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
 * Serialize a virtual node to HTML string.
 */
function serializeVNode(node: VNode, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (node.nodeType === TEXT_NODE) {
    return node.nodeValue ?? '';
  }

  if (node.nodeType === COMMENT_NODE) {
    return `${pad}<!--${node.nodeValue}-->`;
  }

  if (node.nodeType === ELEMENT_NODE) {
    const tag = node.tagName!.toLowerCase();

    // Build attributes string
    let attrs = '';
    if (node.attributes) {
      for (const [key, value] of node.attributes) {
        attrs += ` ${key}="${value}"`;
      }
    }
    if (node.id) attrs += ` id="${node.id}"`;
    if (node.className) attrs += ` class="${node.className}"`;
    const classList = node.classList?.toString();
    if (classList && !node.className) attrs += ` class="${classList}"`;

    // Self-closing tags
    const selfClosing = ['br', 'hr', 'img', 'input', 'meta', 'link'];
    if (selfClosing.includes(tag) && node.childNodes.length === 0) {
      return `${pad}<${tag}${attrs} />`;
    }

    // Regular elements
    if (node.childNodes.length === 0) {
      return `${pad}<${tag}${attrs}></${tag}>`;
    }

    let children = '';
    const hasElementChildren = node.childNodes.some(c => c.nodeType === ELEMENT_NODE);

    if (hasElementChildren) {
      children = '\n' + node.childNodes.map(c => serializeVNode(c, indent + 1)).join('\n') + '\n' + pad;
    } else {
      children = node.childNodes.map(c => serializeVNode(c, 0)).join('');
    }

    return `${pad}<${tag}${attrs}>${children}</${tag}>`;
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

      // Define innerHTML setter to parse content
      Object.defineProperty(node, 'innerHTML', {
        set(html: string) {
          // Simple HTML parsing for templates
          node.content!.childNodes = [];
          // In a real implementation, you'd parse the HTML
          // For now, store as a text node
          const textNode = createVNode(TEXT_NODE, undefined, html);
          node.content!.childNodes.push(textNode);
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

    // Default: call registered handlers
    const handlers = node._listeners?.get(event);
    if (handlers) {
      const syntheticEvent = {
        type: event,
        target: node,
        currentTarget: node,
        detail,
        preventDefault: () => {},
        stopPropagation: () => {},
        bubbles: true,
        cancelBubble: false
      };

      for (const handler of handlers) {
        handler(syntheticEvent as any);
      }
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
