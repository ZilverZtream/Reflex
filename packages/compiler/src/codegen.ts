/**
 * @reflex/compiler - Code Generator
 * Transforms AST nodes into optimized JavaScript code
 *
 * TRIFECTA PROTOCOL - Sink-Based Security
 * ========================================
 * This codegen generates simple _ren.setAttribute() and _ren.setProperty() calls.
 * Security validation is handled CENTRALLY by the renderer's setAttribute/setProperty
 * methods via the validateSink() function from '@reflex/core/sinks'.
 *
 * Benefits:
 * - Single source of truth for security (the Renderer)
 * - Smaller bundle size (no sanitization wrappers in generated code)
 * - Consistent behavior across Runtime and Compiled code
 *
 * The renderer automatically blocks:
 * - javascript: URLs in href, src, action, etc.
 * - Direct innerHTML/outerHTML assignments (must use SafeHTML)
 * - CSS injection via expression() or javascript: in url()
 */

import type {
  ASTNode,
  ElementNode,
  TextNode,
  InterpolationNode,
  DirectiveNode,
  CodegenContext,
  CompilerOptions,
  HoistedNode,
  ImportDeclaration,
} from './types.js';
import { RUNTIME_HELPERS } from './types.js';
import { isComponent, toPascalCase } from './parser.js';
import { SafeExprParser } from '../../src/csp/SafeExprParser.js';

/**
 * Generate JavaScript code from AST
 */
export function generate(
  ast: ASTNode[],
  options: CompilerOptions = {}
): { code: string; imports: ImportDeclaration[]; hoisted: HoistedNode[] } {
  const context: CodegenContext = {
    indent: 0,
    code: [],
    helpers: new Set(),
    components: new Map(),
    hoisted: [],
    scopeVars: new Set(),
    options,
    uid: 0,
  };

  // Generate render function body
  const renderCode = genNodes(ast, context);

  // Build final code
  const lines: string[] = [];

  // Add imports
  if (context.helpers.size > 0) {
    const helperList = Array.from(context.helpers).join(', ');
    lines.push(`import { ${helperList} } from '@reflex/core/runtime-helpers';`);
  }

  // Add component imports
  for (const [local, source] of context.components.entries()) {
    lines.push(`import ${local} from '${source}';`);
  }

  // Add hoisted nodes
  if (context.hoisted.length > 0) {
    lines.push('');
    lines.push('// Hoisted static nodes');
    for (const hoisted of context.hoisted) {
      lines.push(`const ${hoisted.id} = ${hoisted.code};`);
    }
  }

  // Add render function
  lines.push('');
  lines.push('export function render(ctx, _ren) {');
  lines.push(`  const fragment = _ren.createComment('fragment');`);
  lines.push('');
  lines.push(renderCode);
  lines.push('');
  lines.push('  return fragment;');
  lines.push('}');

  const code = lines.join('\n');

  // Build imports array
  const imports: ImportDeclaration[] = [];

  if (context.helpers.size > 0) {
    for (const helper of context.helpers) {
      imports.push({
        source: '@reflex/core/runtime-helpers',
        specifier: helper,
        local: helper,
        isDefault: false,
      });
    }
  }

  for (const [local, source] of context.components.entries()) {
    imports.push({
      source,
      specifier: 'default',
      local,
      isDefault: true,
    });
  }

  return { code, imports, hoisted: context.hoisted };
}

/**
 * Generate code for multiple nodes
 */
function genNodes(nodes: ASTNode[], context: CodegenContext): string {
  const fragments: string[] = [];

  for (const node of nodes) {
    fragments.push(genNode(node, context));
  }

  return fragments.filter(f => f).join('\n');
}

/**
 * Generate code for a single node
 */
function genNode(node: ASTNode, context: CodegenContext): string {
  switch (node.type) {
    case 'Element':
      return genElement(node as ElementNode, context);
    case 'Text':
      return genText(node as TextNode, context);
    case 'Interpolation':
      return genInterpolation(node as InterpolationNode, context);
    case 'Comment':
      return ''; // Skip comments in compiled output
    default:
      return '';
  }
}

/**
 * Generate code for an element
 */
function genElement(node: ElementNode, context: CodegenContext): string {
  // Check for structural directives first (m-if, m-for, m-show)
  const structuralDirective = node.directives.find(d =>
    ['if', 'for', 'show', 'effect'].includes(d.name)
  );

  if (structuralDirective) {
    return genDirective(node, structuralDirective, context);
  }

  // Check if it's a component
  if (isComponent(node.tag)) {
    return genComponent(node, context);
  }

  // Regular element
  return genRegularElement(node, context);
}

/**
 * Generate code for a regular DOM element
 */
function genRegularElement(node: ElementNode, context: CodegenContext): string {
  const lines: string[] = [];
  const varName = `el${context.uid++}`;

  // CRITICAL FIX (SEC-2026-003 Issue #5): Proper SVG Namespace Handling
  // SVG elements need createElementNS instead of createElement
  //
  // There are three categories of tags:
  // 1. Unambiguous SVG-only tags (path, circle, etc.) - always SVG
  // 2. Ambiguous tags (a, title, script, style) - depend on parent context
  // 3. HTML-only tags (div, span, etc.) - always HTML
  //
  // The context.isSVG flag is inherited from parent, ensuring ambiguous tags
  // like <a> inside <svg> get the SVG namespace, while <a> in HTML stays HTML.
  const SVG_ONLY_TAGS = ['svg', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline',
    'rect', 'g', 'defs', 'clipPath', 'mask', 'pattern', 'linearGradient',
    'radialGradient', 'stop', 'text', 'tspan', 'use', 'symbol', 'marker', 'animate',
    'animateMotion', 'animateTransform', 'set', 'foreignObject', 'image', 'desc',
    'metadata', 'switch', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer',
    'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
    'feFlood', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
    'feOffset', 'feSpecularLighting', 'feTile', 'feTurbulence', 'textPath'];

  // Ambiguous tags exist in both HTML and SVG - use parent context to decide
  const AMBIGUOUS_TAGS = ['a', 'script', 'style', 'title'];

  // Determine if we're in SVG context:
  // 1. The tag itself is SVG-only (e.g., 'svg', 'path')
  // 2. The tag is ambiguous AND we're already in SVG context
  // 3. We inherited SVG context from parent and tag isn't HTML-only
  const isSvgOnlyTag = SVG_ONLY_TAGS.includes(node.tag);
  const isAmbiguous = AMBIGUOUS_TAGS.includes(node.tag);
  const isSVG = node.tag === 'svg' || isSvgOnlyTag || (context.isSVG && !isHtmlOnlyTag(node.tag));

  // Helper: Check if tag is HTML-only (not valid in SVG)
  function isHtmlOnlyTag(tag: string): boolean {
    // These tags are definitely HTML-only and break SVG context
    const htmlOnlyTags = ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'form', 'input', 'button',
      'select', 'option', 'textarea', 'header', 'footer', 'nav', 'main',
      'section', 'article', 'aside'];
    return htmlOnlyTags.includes(tag);
  }

  // Check if node can be hoisted
  if (node.isStatic && context.options.hoistStatic) {
    const hoistId = `_hoisted_${context.hoisted.length}`;
    node.hoistId = hoistId;

    // Generate hoisted node creation
    const hoistedCode = genStaticElement(node, { ...context, isSVG });
    context.hoisted.push({ id: hoistId, code: hoistedCode });

    // Use cloned node in render
    lines.push(`  const ${varName} = _ren.cloneNode(${hoistId}, true);`);
  } else {
    // Create element with proper namespace
    if (isSVG) {
      lines.push(`  const ${varName} = _ren.createElementNS('http://www.w3.org/2000/svg', '${node.tag}');`);
    } else {
      lines.push(`  const ${varName} = _ren.createElement('${node.tag}');`);
    }

    // Set static attributes
    // CRITICAL SECURITY FIX: Use JSON.stringify for safe string literal generation
    // The previous implementation used manual quote escaping which was vulnerable to
    // code injection attacks like: <div title=" \'); alert('XSS'); // ">
    // JSON.stringify handles backslashes, newlines, quotes, and all special characters
    for (const prop of node.props) {
      if (!prop.isDynamic && prop.value !== null) {
        const safeValue = JSON.stringify(prop.value);
        lines.push(`  _ren.setAttribute(${varName}, ${JSON.stringify(prop.name)}, ${safeValue});`);
      }
    }

    // Set dynamic attributes
    for (const prop of node.props) {
      if (prop.isDynamic) {
        const expr = resolveExpression(prop.value || '', context);
        lines.push(`  ctx.createEffect(() => {`);
        lines.push(`    _ren.setAttribute(${varName}, '${prop.name}', ${expr});`);
        lines.push(`  });`);
      }
    }

    // Add children (propagate SVG context)
    const childContext = { ...context, isSVG };
    for (const child of node.children) {
      const childCode = genNode(child, childContext);
      if (childCode) {
        lines.push(childCode);
        // Append child to parent
        const childVar = extractVarName(childCode);
        if (childVar) {
          lines.push(`  _ren.appendChild(${varName}, ${childVar});`);
        }
      }
    }

    // Handle event listeners
    const eventDirectives = node.directives.filter(d => d.name === 'on');
    for (const directive of eventDirectives) {
      const eventName = directive.arg || 'click';
      const handler = directive.value;
      const modifiers = directive.modifiers;

      lines.push(`  _ren.addEventListener(${varName}, '${eventName}', (event) => {`);

      // Apply modifiers
      if (modifiers.includes('prevent')) {
        lines.push(`    event.preventDefault();`);
      }
      if (modifiers.includes('stop')) {
        lines.push(`    event.stopPropagation();`);
      }

      // Call handler
      lines.push(`    ${resolveExpression(handler, context, 'event', varName)};`);
      lines.push(`  });`);
    }
  }

  lines.push(`  _ren.insertBefore(fragment, ${varName});`);

  return lines.join('\n');
}

/**
 * Generate code for a static element (for hoisting)
 */
function genStaticElement(node: ElementNode, context: CodegenContext): string {
  // CRITICAL FIX: Use createElementNS for SVG elements
  const createCall = context.isSVG
    ? `_ren.createElementNS('http://www.w3.org/2000/svg', '${node.tag}')`
    : `_ren.createElement('${node.tag}')`;

  // CRITICAL SECURITY FIX: Use JSON.stringify for safe string literal generation
  // Prevents code injection via attribute values like: <div title="'); alert('XSS'); //">
  const attrCalls = node.props.map(p =>
    `_ren.setAttribute(el, ${JSON.stringify(p.name)}, ${JSON.stringify(p.value)});`
  ).join('\n    ');

  return `(() => {
    const el = ${createCall};
    ${attrCalls}
    return el;
  })()`;
}

/**
 * Generate code for a text node
 * CRITICAL SECURITY FIX: Use JSON.stringify for safe string literal generation
 * Prevents code injection via text content containing quotes/backslashes
 */
function genText(node: TextNode, context: CodegenContext): string {
  const varName = `text${context.uid++}`;
  const safeContent = JSON.stringify(node.content);
  return `  const ${varName} = _ren.createTextNode(${safeContent});\n  _ren.insertBefore(fragment, ${varName});`;
}

/**
 * Generate code for an interpolation
 */
function genInterpolation(node: InterpolationNode, context: CodegenContext): string {
  const varName = `text${context.uid++}`;
  const expr = resolveExpression(node.expression, context);

  return `  const ${varName} = _ren.createTextNode('');\n  ctx.createEffect(() => {\n    _ren.setTextContent(${varName}, String(${expr}));\n  });\n  _ren.insertBefore(fragment, ${varName});`;
}

/**
 * Generate code for a directive
 */
function genDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  switch (directive.name) {
    case 'if':
      return genIfDirective(node, directive, context);
    case 'for':
      return genForDirective(node, directive, context);
    case 'show':
      return genShowDirective(node, directive, context);
    case 'effect':
      return genEffectDirective(node, directive, context);
    case 'model':
      return genModelDirective(node, directive, context);
    default:
      return '';
  }
}

/**
 * Generate code for m-if directive
 */
function genIfDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  context.helpers.add(RUNTIME_HELPERS.RUN_TRANSITION);

  const anchorName = `anchor${context.uid++}`;
  const condition = resolveExpression(directive.value, context);
  const transDirective = node.directives.find(d => d.name === 'trans');
  const transName = transDirective?.value || null;

  const lines: string[] = [];
  lines.push(`  const ${anchorName} = _ren.createComment('if');`);
  lines.push(`  _ren.insertBefore(fragment, ${anchorName});`);
  lines.push(`  let currentEl${context.uid} = null;`);
  lines.push(`  ctx.createEffect(() => {`);
  lines.push(`    const shouldShow = !!(${condition});`);
  lines.push(`    if (shouldShow && !currentEl${context.uid}) {`);

  // Create element
  const childContext = { ...context, uid: context.uid };
  const elementCode = genRegularElement(
    { ...node, directives: node.directives.filter(d => d.name !== 'if' && d.name !== 'trans') },
    childContext
  );

  lines.push(elementCode.split('\n').map(l => `      ${l}`).join('\n'));
  lines.push(`      currentEl${context.uid} = el${childContext.uid - 1};`);

  if (transName) {
    lines.push(`      runTransition(currentEl${context.uid}, '${transName}', 'enter');`);
  }

  lines.push(`    } else if (!shouldShow && currentEl${context.uid}) {`);
  lines.push(`      const elToRemove = currentEl${context.uid};`);
  lines.push(`      currentEl${context.uid} = null;`);

  if (transName) {
    lines.push(`      runTransition(elToRemove, '${transName}', 'leave', () => {`);
    lines.push(`        _ren.removeChild(elToRemove);`);
    lines.push(`      });`);
  } else {
    lines.push(`      _ren.removeChild(elToRemove);`);
  }

  lines.push(`    }`);
  lines.push(`  });`);

  context.uid = childContext.uid;
  return lines.join('\n');
}

/**
 * Generate code for m-for directive
 */
function genForDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  context.helpers.add(RUNTIME_HELPERS.CREATE_KEYED_LIST);

  const anchorName = `anchor${context.uid++}`;

  // Parse "item in items" or "(item, index) in items"
  const forMatch = directive.value.match(/^(?:\(([^,]+),\s*([^)]+)\)|([^\s]+))\s+in\s+(.+)$/);
  if (!forMatch) {
    throw new Error(`Invalid m-for expression: ${directive.value}`);
  }

  const itemName = forMatch[3] || forMatch[1];
  const indexName = forMatch[2] || 'index';
  const listExpr = forMatch[4];

  // Get key expression
  const keyDirective = node.props.find(p => p.name === 'key');
  const keyExpr = keyDirective?.value || indexName;

  const lines: string[] = [];
  lines.push(`  const ${anchorName} = _ren.createComment('for');`);
  lines.push(`  _ren.insertBefore(fragment, ${anchorName});`);

  // Add item and index to scope
  const prevScope = new Set(context.scopeVars);
  context.scopeVars.add(itemName);
  context.scopeVars.add(indexName);

  lines.push(`  createKeyedList(`);
  lines.push(`    ctx,`);
  lines.push(`    ${anchorName},`);
  lines.push(`    () => ${resolveExpression(listExpr, context)},`);
  lines.push(`    (${itemName}) => ${resolveExpression(keyExpr, context)},`);
  lines.push(`    (${itemName}, ${indexName}) => {`);

  // Generate element creation inside the loop
  const childContext = { ...context, uid: context.uid };
  const elementCode = genRegularElement(
    { ...node, directives: node.directives.filter(d => d.name !== 'for'), props: node.props.filter(p => p.name !== 'key') },
    childContext
  );

  lines.push(elementCode.split('\n').map(l => `      ${l}`).join('\n'));
  lines.push(`      return el${childContext.uid - 1};`);
  lines.push(`    }`);
  lines.push(`  );`);

  context.uid = childContext.uid;
  context.scopeVars = prevScope;

  return lines.join('\n');
}

/**
 * Generate code for m-show directive
 */
function genShowDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  const condition = resolveExpression(directive.value, context);

  const lines: string[] = [];

  // Generate element first
  const childContext = { ...context, uid: context.uid };
  const elementCode = genRegularElement(
    { ...node, directives: node.directives.filter(d => d.name !== 'show') },
    childContext
  );

  lines.push(elementCode);

  const varName = `el${childContext.uid - 1}`;
  lines.push(`  ctx.createEffect(() => {`);
  lines.push(`    _ren.setAttribute(${varName}, 'style', (${condition}) ? '' : 'display: none');`);
  lines.push(`  });`);

  context.uid = childContext.uid;
  return lines.join('\n');
}

/**
 * Generate code for m-effect directive
 */
function genEffectDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  const effect = resolveExpression(directive.value, context);

  return `  ctx.createEffect(() => {\n    ${effect};\n  });`;
}

/**
 * Generate code for m-model directive (two-way binding)
 * CRITICAL FIX: Implements missing m-model support for form inputs
 */
function genModelDirective(node: ElementNode, directive: DirectiveNode, context: CodegenContext): string {
  const lines: string[] = [];

  // Generate element first
  const childContext = { ...context, uid: context.uid };
  const elementCode = genRegularElement(
    { ...node, directives: node.directives.filter(d => d.name !== 'model') },
    childContext
  );

  lines.push(elementCode);

  const varName = `el${childContext.uid - 1}`;
  const modelExpr = directive.value;

  // Determine input type
  const typeAttr = node.props.find(p => p.name === 'type');
  const inputType = typeAttr?.value || 'text';

  // Generate two-way binding based on input type
  if (inputType === 'checkbox') {
    // Checkbox: bind to checked property
    lines.push(`  ctx.createEffect(() => {`);
    lines.push(`    _ren.setProperty(${varName}, 'checked', !!${resolveExpression(modelExpr, context)});`);
    lines.push(`  });`);
    lines.push(`  _ren.addEventListener(${varName}, 'change', (event) => {`);
    lines.push(`    ${resolveExpression(modelExpr, context)} = event.target.checked;`);
    lines.push(`  });`);
  } else if (inputType === 'radio') {
    // Radio: bind to checked property based on value match
    const valueAttr = node.props.find(p => p.name === 'value');
    const radioValue = valueAttr?.value || '';
    lines.push(`  ctx.createEffect(() => {`);
    lines.push(`    _ren.setProperty(${varName}, 'checked', ${resolveExpression(modelExpr, context)} === '${radioValue}');`);
    lines.push(`  });`);
    lines.push(`  _ren.addEventListener(${varName}, 'change', (event) => {`);
    lines.push(`    if (event.target.checked) ${resolveExpression(modelExpr, context)} = '${radioValue}';`);
    lines.push(`  });`);
  } else if (node.tag === 'select') {
    // Select: bind to value property
    lines.push(`  ctx.createEffect(() => {`);
    lines.push(`    _ren.setProperty(${varName}, 'value', ${resolveExpression(modelExpr, context)});`);
    lines.push(`  });`);
    lines.push(`  _ren.addEventListener(${varName}, 'change', (event) => {`);
    lines.push(`    ${resolveExpression(modelExpr, context)} = event.target.value;`);
    lines.push(`  });`);
  } else {
    // Text input / textarea: bind to value property
    lines.push(`  ctx.createEffect(() => {`);
    lines.push(`    _ren.setProperty(${varName}, 'value', ${resolveExpression(modelExpr, context)} ?? '');`);
    lines.push(`  });`);
    lines.push(`  _ren.addEventListener(${varName}, 'input', (event) => {`);
    lines.push(`    ${resolveExpression(modelExpr, context)} = event.target.value;`);
    lines.push(`  });`);
  }

  context.uid = childContext.uid;
  return lines.join('\n');
}

/**
 * Generate code for a component
 */
function genComponent(node: ElementNode, context: CodegenContext): string {
  const componentName = toPascalCase(node.tag);

  // Resolve component path
  let componentPath = node.tag + '.rfx';
  if (context.options.resolveComponent) {
    const resolved = context.options.resolveComponent(node.tag);
    if (resolved) {
      componentPath = resolved;
    }
  }

  // Add to imports
  context.components.set(componentName, componentPath);

  const varName = `comp${context.uid++}`;
  const lines: string[] = [];

  lines.push(`  const ${varName}Anchor = _ren.createComment('component');`);
  lines.push(`  _ren.insertBefore(fragment, ${varName}Anchor);`);

  // Build props object
  const props: string[] = [];
  for (const prop of node.props) {
    if (prop.isDynamic) {
      const expr = resolveExpression(prop.value || '', context);
      props.push(`    ${prop.name}: ${expr}`);
    } else {
      props.push(`    ${prop.name}: '${prop.value}'`);
    }
  }

  lines.push(`  const ${varName} = new ${componentName}({`);
  lines.push(props.join(',\n'));
  lines.push(`  });`);
  lines.push(`  ${varName}.mount(${varName}Anchor);`);

  return lines.join('\n');
}

/**
 * Resolve expression to JavaScript code using AST-based approach
 * FIXED: Now uses SafeExprParser instead of regex to prevent syntax corruption
 * Distinguishes between state (ctx.s.x) and local scope variables
 */
function resolveExpression(
  expr: string,
  context: CodegenContext,
  $event?: string,
  $el?: string
): string {
  // Parse expression into AST using SafeExprParser
  const parser = new SafeExprParser();
  let ast;
  try {
    ast = parser.parse(expr);
  } catch (err) {
    // If parsing fails, fall back to the expression as-is (may be a literal)
    console.warn(`Failed to parse expression: ${expr}`, err);
    return expr;
  }

  // Generate code from AST
  return genExpression(ast, context, $event, $el);
}

/**
 * Generate JavaScript code from expression AST
 * Handles proper context detection for identifiers:
 * - Object keys: NOT prefixed (prevents { active: true } -> { ctx.s.active: true })
 * - Scope vars (m-for variables): NOT prefixed
 * - State variables: Prefixed with ctx.s.
 */
function genExpression(node: any, context: CodegenContext, $event?: string, $el?: string): string {
  if (!node) return 'undefined';

  switch (node.type) {
    case 'literal':
      // String, number, boolean, null, undefined
      if (typeof node.value === 'string') {
        return JSON.stringify(node.value);
      }
      return String(node.value);

    case 'identifier': {
      const name = node.name;

      // Magic variables
      if (name === '$event' && $event) return $event;
      if (name === '$el' && $el) return $el;
      if (name.startsWith('$')) return name; // Other magic vars like $refs, $dispatch

      // Scope variables (m-for item, index)
      if (context.scopeVars.has(name)) {
        return name;
      }

      // Safe globals
      const safeGlobals = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
        'Math', 'Date', 'Array', 'Number', 'String', 'Boolean', 'JSON', 'Object',
        'Promise', 'Symbol', 'BigInt', 'Map', 'Set', 'RegExp', 'Error',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console'];
      if (safeGlobals.includes(name)) {
        return name;
      }

      // State variable - prefix with ctx.s.
      return `ctx.s.${name}`;
    }

    case 'member': {
      const obj = genExpression(node.object, context, $event, $el);
      if (node.computed) {
        // Bracket notation: obj[prop]
        const prop = genExpression(node.property, context, $event, $el);
        return `${obj}[${prop}]`;
      } else {
        // Dot notation: obj.prop
        // CRITICAL: property is NOT an identifier in scope - it's a literal key
        return `${obj}.${node.property}`;
      }
    }

    case 'call': {
      const callee = genExpression(node.callee, context, $event, $el);
      const args = node.arguments.map((arg: any) => genExpression(arg, context, $event, $el));
      return `${callee}(${args.join(', ')})`;
    }

    case 'binary': {
      const left = genExpression(node.left, context, $event, $el);
      const right = genExpression(node.right, context, $event, $el);
      return `(${left} ${node.op} ${right})`;
    }

    case 'unary': {
      const arg = genExpression(node.arg, context, $event, $el);
      if (node.op === 'typeof') {
        return `typeof ${arg}`;
      }
      return `${node.op}${arg}`;
    }

    case 'ternary': {
      const condition = genExpression(node.condition, context, $event, $el);
      const consequent = genExpression(node.consequent, context, $event, $el);
      const alternate = genExpression(node.alternate, context, $event, $el);
      return `(${condition} ? ${consequent} : ${alternate})`;
    }

    case 'array': {
      const elements = node.elements.map((el: any) => genExpression(el, context, $event, $el));
      return `[${elements.join(', ')}]`;
    }

    case 'object': {
      // CRITICAL FIX: Object literal keys are NOT identifiers in scope
      // { active: true } should become { active: ctx.s.true } NOT { ctx.s.active: ctx.s.true }
      const props = node.properties.map((prop: any) => {
        let key;
        if (prop.computed) {
          // Computed property: { [expr]: value }
          key = `[${genExpression(prop.key, context, $event, $el)}]`;
        } else if (typeof prop.key === 'string') {
          // String literal key or identifier key
          // Check if it needs quoting
          if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop.key)) {
            key = prop.key; // Valid identifier - no quotes needed
          } else {
            key = JSON.stringify(prop.key); // Needs quotes
          }
        } else {
          key = String(prop.key);
        }

        if (prop.shorthand) {
          // Shorthand: { count } -> { count: ctx.s.count }
          const value = genExpression(prop.value, context, $event, $el);
          return `${key}: ${value}`;
        } else {
          const value = genExpression(prop.value, context, $event, $el);
          return `${key}: ${value}`;
        }
      });
      return `{ ${props.join(', ')} }`;
    }

    case 'assignment': {
      const left = genExpression(node.left, context, $event, $el);
      const right = genExpression(node.right, context, $event, $el);
      return `${left} ${node.op} ${right}`;
    }

    case 'update': {
      const arg = genExpression(node.arg, context, $event, $el);
      if (node.prefix) {
        return `${node.op}${arg}`;
      } else {
        return `${arg}${node.op}`;
      }
    }

    default:
      console.warn(`Unknown AST node type: ${node.type}`);
      return 'undefined';
  }
}

/**
 * Extract variable name from generated code
 */
function extractVarName(code: string): string | null {
  const match = code.match(/const\s+(\w+)\s*=/);
  return match ? match[1] : null;
}
