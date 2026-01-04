/**
 * @reflex/compiler - Main Entry Point
 * AOT compiler for Reflex framework
 */

export { parse, isComponent, toPascalCase } from './parser.js';
export { generate } from './codegen.js';
export * from './types.js';
export * from './runtime-helpers.js';

import { parse } from './parser.js';
import { generate } from './codegen.js';
import type { CompilerOptions, CompilationResult } from './types.js';

/**
 * Compile a Reflex template to JavaScript
 *
 * @param template - HTML template string
 * @param options - Compiler options
 * @returns Compilation result with code, imports, and metadata
 *
 * @example
 * ```ts
 * const result = compile(`
 *   <div>
 *     <h1>{{ title }}</h1>
 *     <ul>
 *       <li m-for="item in items" :key="item.id">{{ item.name }}</li>
 *     </ul>
 *   </div>
 * `, { hoistStatic: true });
 *
 * console.log(result.code);
 * ```
 */
export function compile(
  template: string,
  options: CompilerOptions = {}
): CompilationResult {
  const warnings: any[] = [];

  try {
    // Parse template to AST
    const ast = parse(template, options);

    // Generate code from AST
    const { code, imports, hoisted } = generate(ast, options);

    return {
      code,
      imports,
      hoistedNodes: hoisted,
      warnings,
    };
  } catch (error) {
    warnings.push({
      message: error instanceof Error ? error.message : String(error),
      code: 'COMPILATION_ERROR',
    });

    return {
      code: 'export function render() { throw new Error("Compilation failed"); }',
      imports: [],
      hoistedNodes: [],
      warnings,
    };
  }
}

/**
 * Compile a single-file component (.rfx file)
 *
 * @param source - Full .rfx file content
 * @param filename - File path (for error messages)
 * @param options - Compiler options
 * @returns Compilation result
 *
 * @example
 * ```ts
 * const source = `
 * <template>
 *   <div>{{ message }}</div>
 * </template>
 *
 * <script>
 * export default {
 *   setup() {
 *     return { message: 'Hello' };
 *   }
 * }
 * </script>
 * `;
 *
 * const result = compileSFC(source, 'App.rfx');
 * ```
 */
export function compileSFC(
  source: string,
  filename: string,
  options: CompilerOptions = {}
): CompilationResult & { script?: string; style?: string } {
  const warnings: any[] = [];

  try {
    // Extract template, script, and style blocks
    const templateMatch = source.match(/<template>([\s\S]*?)<\/template>/);
    const scriptMatch = source.match(/<script(?:\s+[^>]*)?>(\s[\s\S]*?)<\/script>/);
    const styleMatch = source.match(/<style(?:\s+[^>]*)?>(\s[\s\S]*?)<\/style>/);

    if (!templateMatch) {
      warnings.push({
        message: 'No <template> block found in SFC',
        code: 'MISSING_TEMPLATE',
      });

      return {
        code: 'export function render() { return null; }',
        imports: [],
        hoistedNodes: [],
        warnings,
      };
    }

    const template = templateMatch[1].trim();
    const script = scriptMatch?.[1]?.trim();
    const style = styleMatch?.[1]?.trim();

    // Compile template
    const result = compile(template, options);

    // Combine with script if present
    let finalCode = result.code;

    if (script) {
      // Extract exports from script
      const setupMatch = script.match(/export\s+default\s+\{([^}]+)\}/);
      if (setupMatch) {
        // Append setup logic
        finalCode += '\n\n// Component setup\n' + script;
      } else {
        finalCode += '\n\n' + script;
      }
    }

    return {
      ...result,
      code: finalCode,
      script,
      style,
    };
  } catch (error) {
    warnings.push({
      message: error instanceof Error ? error.message : String(error),
      code: 'SFC_COMPILATION_ERROR',
    });

    return {
      code: 'export function render() { throw new Error("SFC compilation failed"); }',
      imports: [],
      hoistedNodes: [],
      warnings,
    };
  }
}
