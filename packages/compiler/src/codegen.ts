/**
 * @reflex/compiler - Code Generator
 * Transforms AST nodes into optimized JavaScript code
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

  // Check if node can be hoisted
  if (node.isStatic && context.options.hoistStatic) {
    const hoistId = `_hoisted_${context.hoisted.length}`;
    node.hoistId = hoistId;

    // Generate hoisted node creation
    const hoistedCode = genStaticElement(node, context);
    context.hoisted.push({ id: hoistId, code: hoistedCode });

    // Use cloned node in render
    lines.push(`  const ${varName} = _ren.cloneNode(${hoistId}, true);`);
  } else {
    // Create element
    lines.push(`  const ${varName} = _ren.createElement('${node.tag}');`);

    // Set static attributes
    for (const prop of node.props) {
      if (!prop.isDynamic && prop.value !== null) {
        const value = prop.value.replace(/'/g, "\\'");
        lines.push(`  _ren.setAttribute(${varName}, '${prop.name}', '${value}');`);
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

    // Add children
    for (const child of node.children) {
      const childCode = genNode(child, context);
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
  const parts: string[] = [`_ren.createElement('${node.tag}')`];

  // Note: For hoisted nodes, we create a template and clone it
  // This is a simplified version - in production, we'd use document.createElement
  return `(() => {
    const el = _ren.createElement('${node.tag}');
    ${node.props.map(p => `_ren.setAttribute(el, '${p.name}', '${p.value}');`).join('\n    ')}
    return el;
  })()`;
}

/**
 * Generate code for a text node
 */
function genText(node: TextNode, context: CodegenContext): string {
  const varName = `text${context.uid++}`;
  return `  const ${varName} = _ren.createTextNode('${node.content.replace(/'/g, "\\'")}');\n  _ren.insertBefore(fragment, ${varName});`;
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
 * Resolve expression to JavaScript code
 * Distinguishes between state (ctx.s.x) and local scope variables
 */
function resolveExpression(
  expr: string,
  context: CodegenContext,
  $event?: string,
  $el?: string
): string {
  // Simple heuristic: if the variable is in scopeVars, use it directly
  // Otherwise, prefix with ctx.s.

  // For now, use a simple approach: wrap in a function that checks scope first
  // In production, we'd use a proper parser to identify identifiers

  // Check if it's a simple identifier
  const identifierMatch = expr.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
  if (identifierMatch) {
    const varName = identifierMatch[0];
    if (context.scopeVars.has(varName)) {
      return varName;
    } else {
      return `ctx.s.${varName}`;
    }
  }

  // For complex expressions, we need to replace identifiers
  // This is a simplified version - in production, use a proper parser
  let result = expr;

  // Replace known scope vars
  for (const scopeVar of context.scopeVars) {
    const regex = new RegExp(`\\b${scopeVar}\\b`, 'g');
    result = result.replace(regex, scopeVar);
  }

  // Prefix other identifiers with ctx.s.
  // This is a naive approach - proper implementation would use AST
  result = result.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (match, identifier) => {
    if (context.scopeVars.has(identifier) ||
        ['true', 'false', 'null', 'undefined', 'this', 'event', 'Math', 'String', 'Number', 'Array', 'Object'].includes(identifier)) {
      return identifier;
    }
    return `ctx.s.${identifier}`;
  });

  if ($event) {
    result = result.replace(/\$event\b/g, $event);
  }
  if ($el) {
    result = result.replace(/\$el\b/g, $el);
  }

  return result;
}

/**
 * Extract variable name from generated code
 */
function extractVarName(code: string): string | null {
  const match = code.match(/const\s+(\w+)\s*=/);
  return match ? match[1] : null;
}
