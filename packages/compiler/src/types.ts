/**
 * @reflex/compiler - Type Definitions
 * AOT compilation types for transforming Reflex templates to JavaScript
 */

export interface CompilerOptions {
  /**
   * Whether to generate source maps
   */
  sourceMap?: boolean;

  /**
   * Whether to enable static hoisting optimization
   */
  hoistStatic?: boolean;

  /**
   * Whether to generate code in development mode (with more checks)
   */
  dev?: boolean;

  /**
   * Base path for resolving component imports
   */
  basePath?: string;

  /**
   * Custom component resolution function
   */
  resolveComponent?: (name: string) => string | null;

  /**
   * Whether to preserve whitespace in templates
   */
  whitespace?: 'preserve' | 'condense';

  /**
   * Custom directive handlers for compilation
   */
  customDirectives?: Map<string, DirectiveCompiler>;
}

export interface CompilationResult {
  /**
   * Generated JavaScript code
   */
  code: string;

  /**
   * Source map if enabled
   */
  map?: any;

  /**
   * Component imports needed
   */
  imports: ImportDeclaration[];

  /**
   * Static nodes that can be hoisted
   */
  hoistedNodes: HoistedNode[];

  /**
   * Warnings generated during compilation
   */
  warnings: CompilerWarning[];
}

export interface ImportDeclaration {
  /**
   * Import source (file path)
   */
  source: string;

  /**
   * Import specifier name
   */
  specifier: string;

  /**
   * Local name in the module
   */
  local: string;

  /**
   * Whether this is a default import
   */
  isDefault: boolean;
}

export interface HoistedNode {
  /**
   * Unique identifier for the hoisted node
   */
  id: string;

  /**
   * Code to create the static node
   */
  code: string;
}

export interface CompilerWarning {
  /**
   * Warning message
   */
  message: string;

  /**
   * Source location
   */
  loc?: SourceLocation;

  /**
   * Warning code
   */
  code?: string;
}

export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

/**
 * AST Node Types
 */
export type ASTNode =
  | ElementNode
  | TextNode
  | CommentNode
  | InterpolationNode
  | DirectiveNode;

export interface BaseNode {
  type: string;
  loc?: SourceLocation;
}

export interface ElementNode extends BaseNode {
  type: 'Element';
  tag: string;
  props: PropNode[];
  children: ASTNode[];
  directives: DirectiveNode[];
  /**
   * Whether this node is static (no bindings)
   */
  isStatic: boolean;
  /**
   * Unique ID for hoisting
   */
  hoistId?: string;
}

export interface TextNode extends BaseNode {
  type: 'Text';
  content: string;
  isStatic: boolean;
}

export interface CommentNode extends BaseNode {
  type: 'Comment';
  content: string;
}

export interface InterpolationNode extends BaseNode {
  type: 'Interpolation';
  expression: string;
}

export interface PropNode extends BaseNode {
  type: 'Prop';
  name: string;
  value: string | null;
  isDynamic: boolean;
  modifiers: string[];
}

export interface DirectiveNode extends BaseNode {
  type: 'Directive';
  name: string;
  value: string;
  arg?: string;
  modifiers: string[];
}

/**
 * Code Generation Context
 */
export interface CodegenContext {
  /**
   * Indentation level
   */
  indent: number;

  /**
   * Generated code fragments
   */
  code: string[];

  /**
   * Helper imports needed
   */
  helpers: Set<string>;

  /**
   * Component imports needed
   */
  components: Map<string, string>;

  /**
   * Hoisted static nodes
   */
  hoisted: HoistedNode[];

  /**
   * Current scope variables (for m-for locals)
   */
  scopeVars: Set<string>;

  /**
   * Compiler options
   */
  options: CompilerOptions;

  /**
   * Counter for generating unique IDs
   */
  uid: number;
}

/**
 * Directive Compiler Function
 * Transforms a directive into JavaScript code
 */
export type DirectiveCompiler = (
  node: ElementNode,
  directive: DirectiveNode,
  context: CodegenContext
) => string;

/**
 * Runtime Helper Names
 */
export const RUNTIME_HELPERS = {
  CREATE_KEYED_LIST: 'createKeyedList',
  RUN_TRANSITION: 'runTransition',
  TO_DISPLAY_STRING: 'toDisplayString',
  CREATE_ELEMENT_VNODE: 'createElementVNode',
  CREATE_TEXT_VNODE: 'createTextVNode',
  WITH_DIRECTIVES: 'withDirectives',
} as const;

export type RuntimeHelper = typeof RUNTIME_HELPERS[keyof typeof RUNTIME_HELPERS];
