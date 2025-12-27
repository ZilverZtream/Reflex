#!/usr/bin/env node
/**
 * Example: Building Components with Scoped CSS
 *
 * This example demonstrates how to use the Reflex scoped CSS plugin
 * with esbuild to transform component styles at build time.
 *
 * Run: node build.js
 */

import * as esbuild from 'esbuild';
import { scopedCSSPlugin } from '../../dist/scoped-css/index.esm.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function build() {
  console.log('Building components with scoped CSS...\n');

  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'src/app.js')],
      bundle: true,
      outdir: path.join(__dirname, 'dist'),
      format: 'esm',
      plugins: [
        scopedCSSPlugin({
          // Process .component.html files
          include: /\.component\.html$/,
          // Output collected CSS to a single file
          cssOutput: path.join(__dirname, 'dist/styles.css'),
          // Minify for production
          minify: process.env.NODE_ENV === 'production',
          // Remove style tags from JS (they go to styles.css)
          removeStyles: true
        })
      ]
    });

    console.log('Build complete!');
    console.log('Output files:');
    console.log('  - dist/app.js');
    console.log('  - dist/styles.css');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
