import { defineConfig } from 'vite';
import reflex from '@reflex/compiler/vite';

export default defineConfig({
  plugins: [
    reflex({
      hoistStatic: true,
      whitespace: 'condense',
      compile: true,
    }),
  ],
  build: {
    target: 'es2020',
    minify: 'terser',
  },
});
