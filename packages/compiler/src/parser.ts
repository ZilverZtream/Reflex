/**
 * @reflex/compiler - HTML Template Parser
 * Parses Reflex templates into AST nodes for compilation
 */

import type {
  ASTNode,
  ElementNode,
  TextNode,
  CommentNode,
  InterpolationNode,
  PropNode,
  DirectiveNode,
  CompilerOptions,
} from './types.js';

const INTERPOLATION_REGEX = /\{\{([^}]+)\}\}/g;
const DIRECTIVE_PREFIX = 'm-';
const BIND_PREFIX = ':';
const EVENT_PREFIX = '@';

/**
 * Parse HTML template string into AST
 */
export function parse(template: string, options: CompilerOptions = {}): ASTNode[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<template>${template}</template>`, 'text/html');
  const root = doc.querySelector('template');

  if (!root) {
    throw new Error('Failed to parse template');
  }

  return parseChildren(root, options);
}

/**
 * Parse child nodes recursively
 */
function parseChildren(parent: Element | DocumentFragment, options: CompilerOptions): ASTNode[] {
  const nodes: ASTNode[] = [];
  const childNodes = Array.from(parent.childNodes);

  for (const node of childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      nodes.push(parseElement(node as Element, options));
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      const textNodes = parseText(text, options);
      nodes.push(...textNodes);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      nodes.push(parseComment(node as Comment));
    }
  }

  return nodes;
}

/**
 * Parse an element node
 */
function parseElement(el: Element, options: CompilerOptions): ElementNode {
  const tag = el.tagName.toLowerCase();
  const props: PropNode[] = [];
  const directives: DirectiveNode[] = [];

  // Parse attributes
  for (const attr of Array.from(el.attributes)) {
    const { name, value } = attr;

    if (name.startsWith(DIRECTIVE_PREFIX)) {
      // Directive (m-if, m-for, m-show, etc.)
      directives.push(parseDirective(name, value));
    } else if (name.startsWith(BIND_PREFIX)) {
      // Dynamic binding (:href, :class, etc.)
      const propName = name.slice(1);
      props.push({
        type: 'Prop',
        name: propName,
        value,
        isDynamic: true,
        modifiers: [],
      });
    } else if (name.startsWith(EVENT_PREFIX)) {
      // Event handler (@click, @input, etc.)
      const eventName = name.slice(1);
      const modifiers = eventName.split('.');
      const baseEvent = modifiers.shift()!;

      directives.push({
        type: 'Directive',
        name: 'on',
        value,
        arg: baseEvent,
        modifiers,
      });
    } else {
      // Static attribute
      props.push({
        type: 'Prop',
        name,
        value,
        isDynamic: false,
        modifiers: [],
      });
    }
  }

  // Parse children
  const children = parseChildren(el, options);

  // Determine if node is static
  const isStatic = directives.length === 0 &&
                   props.every(p => !p.isDynamic) &&
                   children.every(c => c.type !== 'Interpolation' &&
                                      (c.type === 'Text' || c.type === 'Element') &&
                                      (c as any).isStatic);

  return {
    type: 'Element',
    tag,
    props,
    children,
    directives,
    isStatic,
  };
}

/**
 * Parse text content, splitting interpolations
 */
function parseText(text: string, options: CompilerOptions): ASTNode[] {
  const nodes: ASTNode[] = [];

  // Handle whitespace
  if (options.whitespace === 'condense') {
    text = text.replace(/\s+/g, ' ');
  }

  // If no interpolations, return simple text node
  if (!INTERPOLATION_REGEX.test(text)) {
    const trimmed = text.trim();
    if (trimmed) {
      nodes.push({
        type: 'Text',
        content: text,
        isStatic: true,
      });
    }
    return nodes;
  }

  // Split by interpolations
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INTERPOLATION_REGEX.lastIndex = 0; // Reset regex state

  while ((match = INTERPOLATION_REGEX.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // Add static text before interpolation
    if (start > lastIndex) {
      const staticText = text.slice(lastIndex, start);
      if (staticText) {
        nodes.push({
          type: 'Text',
          content: staticText,
          isStatic: true,
        });
      }
    }

    // Add interpolation
    nodes.push({
      type: 'Interpolation',
      expression: match[1].trim(),
    });

    lastIndex = end;
  }

  // Add remaining static text
  if (lastIndex < text.length) {
    const staticText = text.slice(lastIndex);
    if (staticText) {
      nodes.push({
        type: 'Text',
        content: staticText,
        isStatic: true,
      });
    }
  }

  return nodes;
}

/**
 * Parse a comment node
 */
function parseComment(node: Comment): CommentNode {
  return {
    type: 'Comment',
    content: node.textContent || '',
  };
}

/**
 * Parse a directive attribute
 */
function parseDirective(name: string, value: string): DirectiveNode {
  // Remove m- prefix
  let directiveName = name.slice(DIRECTIVE_PREFIX.length);

  // Parse argument (m-bind:href -> bind with arg 'href')
  let arg: string | undefined;
  const colonIndex = directiveName.indexOf(':');
  if (colonIndex > -1) {
    arg = directiveName.slice(colonIndex + 1);
    directiveName = directiveName.slice(0, colonIndex);
  }

  // Parse modifiers (m-on:click.stop.prevent)
  const parts = directiveName.split('.');
  directiveName = parts[0];
  const modifiers = parts.slice(1);

  return {
    type: 'Directive',
    name: directiveName,
    value,
    arg,
    modifiers,
  };
}

/**
 * Check if a tag name is a component (PascalCase or kebab-case with hyphen)
 */
export function isComponent(tag: string): boolean {
  // PascalCase (UserProfile)
  if (/^[A-Z]/.test(tag)) {
    return true;
  }

  // kebab-case with hyphen (user-profile)
  if (tag.includes('-')) {
    return true;
  }

  return false;
}

/**
 * Convert kebab-case to PascalCase
 */
export function toPascalCase(str: string): string {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}
