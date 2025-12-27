module.exports = {
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  globals: {
    DOMPurify: 'readonly', // Optional HTML sanitizer
  },
  rules: {
    // Allow unused vars starting with underscore (common pattern for internal methods)
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

    // Allow empty catch blocks (used for cleanup)
    'no-empty': ['error', { allowEmptyCatch: true }],

    // Allow == for null checks
    eqeqeq: ['error', 'always', { null: 'ignore' }],

    // Enforce single quotes
    quotes: ['error', 'single', { avoidEscape: true }],

    // Enforce semicolons
    semi: ['error', 'always'],

    // Consistent spacing
    'comma-spacing': 'error',
    'key-spacing': 'error',
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],

    // No trailing commas
    'comma-dangle': ['error', 'only-multiline'],

    // Consistent brace style
    'brace-style': ['error', '1tbs', { allowSingleLine: true }],

    // No console in production code (warn only)
    'no-console': 'off',

    // Allow short-circuit evaluation for side effects
    'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],

    // Allow while(true) for parser loops
    'no-constant-condition': ['error', { checkLoops: false }],
  },
  overrides: [
    {
      // Test files can use more relaxed rules
      files: ['tests/**/*.js', '**/*.test.js', '**/*.spec.js'],
      rules: {
        'no-unused-expressions': 'off',
        'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
    },
  ],
};
