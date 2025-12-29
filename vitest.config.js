import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plugin to resolve .js imports to .ts source files
function resolveJsToTs() {
  return {
    name: 'resolve-js-to-ts',
    resolveId(source, importer) {
      if (!source.endsWith('.js')) return null;
      if (!importer) return null;

      // Resolve the path relative to the importer
      const resolved = path.resolve(path.dirname(importer), source);

      // Check if a .ts file exists instead of .js
      const tsPath = resolved.replace(/\.js$/, '.ts');
      if (fs.existsSync(tsPath)) {
        return tsPath;
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveJsToTs()],
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.js', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
    setupFiles: ['tests/setup.js'],
  },
});
