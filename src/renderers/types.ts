/**
 * Reflex Renderer Types
 *
 * Defines the interface for pluggable rendering engines.
 * This enables Reflex to run on different targets:
 * - Web (Direct DOM via DOMRenderer)
 * - Native (Virtual/Abstract DOM via VirtualRenderer)
 * - Test environments (Mock rendering for fast tests)
 */

/**
 * Virtual Node representation for non-DOM targets.
 * Implements a minimal DOM-like interface for compatibility.
 */
export interface VNode {
  /** Node type: 1 = Element, 3 = Text, 8 = Comment */
  nodeType: number;
  /** Tag name for elements (uppercase) */
  tagName?: string;
  /** Node value for text/comment nodes */
  nodeValue?: string | null;
  /** Node attributes (for elements) */
  attributes?: Map<string, string>;
  /** Child nodes */
  childNodes: VNode[];
  /** Parent node reference */
  parentNode: VNode | null;
  /** First child shortcut */
  firstChild: VNode | null;
  /** Last child shortcut */
  lastChild: VNode | null;
  /** Next sibling shortcut */
  nextSibling: VNode | null;
  /** Previous sibling shortcut */
  previousSibling: VNode | null;
  /** Custom properties (for component state, etc.) */
  props?: Record<string, any>;
  /** Event listeners */
  _listeners?: Map<string, Function[]>;
  /** Marker for virtual containers in m-for */
  _isVirtualContainer?: boolean;
  /** Nodes array for virtual containers */
  _nodes?: VNode[];
  /** Style object */
  style?: Record<string, string> & { display?: string; cssText?: string };
  /** Class list */
  classList?: {
    add: (...classes: string[]) => void;
    remove: (...classes: string[]) => void;
    contains: (cls: string) => boolean;
    toggle: (cls: string, force?: boolean) => boolean;
    toString: () => string;
    length: number;
    item: (index: number) => string | null;
    [Symbol.iterator]: () => IterableIterator<string>;
  };
  /** Is element connected to a root */
  isConnected?: boolean;
  /** Element content for templates */
  content?: VNode;
  /** Inner HTML (for m-html) */
  innerHTML?: string;
  /** Element ID */
  id?: string;
  /** Element class name */
  className?: string;
  /** Element value (for form inputs) */
  value?: string;
  /** Checked state (for checkboxes/radios) */
  checked?: boolean;
  /** Selected state (for options) */
  selected?: boolean;
  /** Options (for select elements) */
  options?: VNode[];
  /** Selected options (for select elements) */
  selectedOptions?: VNode[];
  /** Element type (for inputs) */
  type?: string;
  /** Validity state (for form validation) */
  validity?: { badInput?: boolean };
}

/**
 * Transition configuration for animations
 */
export interface TransitionConfig {
  name: string;
  type: 'enter' | 'leave';
  done?: () => void;
}

/**
 * Renderer Adapter Interface
 *
 * This is the contract that any rendering engine must fulfill.
 * The DOMRenderer implements this with zero-cost abstractions (direct DOM calls).
 * The VirtualRenderer implements this for non-web targets.
 */
export interface IRendererAdapter {
  /**
   * Create a comment node (used for structural directive markers)
   * @param text - Comment text content
   */
  createComment(text: string): VNode | Comment;

  /**
   * Create an element node
   * @param tagName - Element tag name
   */
  createElement(tagName: string): VNode | Element;

  /**
   * Create a text node
   * @param text - Text content
   */
  createTextNode(text: string): VNode | Text;

  /**
   * Create a template element for component parsing
   */
  createTemplate(): VNode | HTMLTemplateElement;

  /**
   * Clone a node (deep or shallow)
   * @param node - Node to clone
   * @param deep - Whether to deep clone (default: true)
   */
  cloneNode<T extends VNode | Node>(node: T, deep?: boolean): T;

  /**
   * Replace a node with another node
   * @param oldNode - Node to replace
   * @param newNode - Replacement node
   */
  replaceWith(oldNode: VNode | Node, newNode: VNode | Node): void;

  /**
   * Insert a node before a reference node
   * @param parent - Parent node
   * @param newNode - Node to insert
   * @param refNode - Reference node (insert before this)
   */
  insertBefore(parent: VNode | Node, newNode: VNode | Node, refNode: VNode | Node | null): void;

  /**
   * Insert a node after a reference node
   * @param refNode - Reference node (insert after this)
   * @param newNode - Node to insert
   */
  insertAfter(refNode: VNode | Node, newNode: VNode | Node): void;

  /**
   * Append a child node
   * @param parent - Parent node
   * @param child - Child node to append
   */
  appendChild(parent: VNode | Node, child: VNode | Node): void;

  /**
   * Remove a child node from its parent
   * @param node - Node to remove
   */
  removeChild(node: VNode | Node): void;

  /**
   * Get attribute value from element
   * @param node - Element node
   * @param name - Attribute name
   */
  getAttribute(node: VNode | Element, name: string): string | null;

  /**
   * Set attribute value on element
   * @param node - Element node
   * @param name - Attribute name
   * @param value - Attribute value
   */
  setAttribute(node: VNode | Element, name: string, value: string): void;

  /**
   * Remove attribute from element
   * @param node - Element node
   * @param name - Attribute name
   */
  removeAttribute(node: VNode | Element, name: string): void;

  /**
   * Add event listener to element
   * @param node - Element node
   * @param event - Event name
   * @param handler - Event handler function
   * @param options - Event listener options
   */
  addEventListener(
    node: VNode | Element,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void;

  /**
   * Remove event listener from element
   * @param node - Element node
   * @param event - Event name
   * @param handler - Event handler function
   * @param options - Event listener options
   */
  removeEventListener(
    node: VNode | Element,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void;

  /**
   * Dispatch a custom event
   * @param node - Element node
   * @param event - Event name
   * @param detail - Event detail payload
   */
  dispatchEvent(node: VNode | Element, event: string, detail?: any): void;

  /**
   * Set text content of a text node
   * @param node - Text node
   * @param text - New text content
   */
  setTextContent(node: VNode | Text, text: string): void;

  /**
   * Set inner HTML of an element (use with caution - XSS risk)
   * @param node - Element node
   * @param html - HTML content
   */
  setInnerHTML(node: VNode | Element, html: string): void;

  /**
   * Get all attributes of an element
   * @param node - Element node
   */
  getAttributes(node: VNode | Element): NamedNodeMap | Map<string, string>;

  /**
   * Query selector (for component slot projection)
   * @param node - Root element
   * @param selector - CSS selector
   */
  querySelector(node: VNode | Element, selector: string): VNode | Element | null;

  /**
   * Query selector all (for component slot projection)
   * @param node - Root element
   * @param selector - CSS selector
   */
  querySelectorAll(node: VNode | Element, selector: string): NodeListOf<Element> | VNode[];

  /**
   * Check if a node contains another node
   * @param parent - Potential parent node
   * @param child - Potential child node
   */
  contains(parent: VNode | Node, child: VNode | Node): boolean;

  /**
   * Run a transition animation
   * @param node - Element to animate
   * @param config - Transition configuration
   * @param reflex - Reflex instance (for cleanup registration)
   */
  runTransition?(node: VNode | Element, config: TransitionConfig, reflex?: any): void;

  /**
   * Request animation frame (for transitions)
   * @param callback - Callback function
   */
  requestAnimationFrame?(callback: FrameRequestCallback): number;

  /**
   * Cancel animation frame
   * @param handle - Animation frame handle
   */
  cancelAnimationFrame?(handle: number): void;

  /**
   * Get computed style of an element (for transitions)
   * @param node - Element node
   */
  getComputedStyle?(node: VNode | Element): CSSStyleDeclaration | Record<string, string>;

  /**
   * Schedule an update to be processed (for non-DOM targets)
   * Used by VirtualRenderer to batch updates
   * @param node - Node that was updated
   */
  scheduleUpdate?(node: VNode): void;

  /**
   * Flush pending updates (for non-DOM targets)
   * Used to synchronously apply all pending changes
   */
  flushUpdates?(): void;

  /**
   * Serialize the virtual DOM tree (for non-DOM targets)
   * Useful for testing and SSR
   * @param node - Root node to serialize
   */
  serialize?(node: VNode): string;

  /**
   * Get the root document/container (for event delegation)
   */
  getRoot?(): VNode | Document;

  /**
   * Check if running in a browser environment
   */
  isBrowser: boolean;
}

/**
 * Renderer Mixin Interface
 *
 * The interface that defines what methods the CompilerMixin provides.
 * Any custom renderer mixin must implement these methods.
 */
export interface IRendererMixin {
  /** Walk DOM tree and process nodes */
  _w(node: VNode | Node, scope: any): void;

  /** Process bindings on an element */
  _bnd(node: VNode | Element, scope: any): void;

  /** Text interpolation */
  _txt(node: VNode | Text, scope: any): void;

  /** Attribute binding */
  _at(node: VNode | Element, attr: string, expr: string, scope: any): void;

  /** Event binding */
  _ev(node: VNode | Element, event: string, expr: string, scope: any): void;

  /** m-if directive */
  _dir_if(node: VNode | Element, scope: any): void;

  /** m-for directive */
  _dir_for(node: VNode | Element, scope: any): void;

  /** m-model directive */
  _mod(node: VNode | Element, expr: string, scope: any, modifiers?: string[]): void;

  /** m-html directive */
  _html(node: VNode | Element, expr: string, scope: any): void;

  /** m-show directive */
  _show(node: VNode | Element, expr: string, scope: any, trans?: string | null): void;

  /** m-effect directive */
  _effect(node: VNode | Element, expr: string, scope: any): void;

  /** Apply custom directive */
  _applyDir(node: VNode | Element, name: string, value: string, mods: string[], scope: any): boolean;

  /** Convert class binding to string */
  _cls(value: any): string;

  /** Convert style binding to string */
  _sty(value: any): string;

  /** Delegated event handler */
  _hdl(event: Event, eventName: string): void;
}

/**
 * Renderer configuration options
 */
export interface RendererOptions {
  /** Target platform: 'web' | 'native' | 'test' */
  target?: 'web' | 'native' | 'test';

  /** Custom renderer adapter (overrides target) */
  renderer?: IRendererAdapter;

  /** Enable debug mode for virtual renderer */
  debug?: boolean;

  /** Custom event dispatcher for native targets */
  eventDispatcher?: (node: VNode, event: string, detail: any) => void;

  /** Custom update scheduler for native targets */
  scheduler?: {
    scheduleUpdate: (node: VNode) => void;
    flushUpdates: () => void;
  };
}
