/**
 * Scoped CSS Tests
 *
 * Tests the zero-runtime scoped CSS build plugin:
 * - CSS selector scoping
 * - Template transformation
 * - Component transformation
 * - Edge cases and complex selectors
 */

import { describe, it, expect } from 'vitest';
import {
  generateScopeId,
  scopeSelector,
  transformCSS,
  tokenizeCSS
} from '../src/scoped-css/css-transform.js';
import {
  transformTemplate,
  injectScopeAttribute
} from '../src/scoped-css/template-transform.js';
import {
  transformComponent,
  extractStyles,
  extractTemplate
} from '../src/scoped-css/component-transform.js';

describe('Scoped CSS', () => {
  describe('generateScopeId', () => {
    it('should generate consistent IDs for same input', () => {
      const id1 = generateScopeId('test content', 'component');
      const id2 = generateScopeId('test content', 'component');
      expect(id1).toBe(id2);
    });

    it('should generate different IDs for different input', () => {
      const id1 = generateScopeId('content A', 'comp1');
      const id2 = generateScopeId('content B', 'comp2');
      expect(id1).not.toBe(id2);
    });

    it('should return ID in v-xxxxxx format', () => {
      const id = generateScopeId('test', 'name');
      expect(id).toMatch(/^v-[a-f0-9]{6}$/);
    });
  });

  describe('scopeSelector', () => {
    const scopeId = 'v-abc123';

    it('should scope simple class selectors', () => {
      expect(scopeSelector('.btn', scopeId)).toBe('.btn[data-v-abc123]');
    });

    it('should scope element selectors', () => {
      expect(scopeSelector('div', scopeId)).toBe('div[data-v-abc123]');
    });

    it('should scope ID selectors', () => {
      expect(scopeSelector('#main', scopeId)).toBe('#main[data-v-abc123]');
    });

    it('should scope compound selectors', () => {
      expect(scopeSelector('.btn.active', scopeId)).toBe('.btn.active[data-v-abc123]');
    });

    it('should scope descendant selectors', () => {
      expect(scopeSelector('.parent .child', scopeId))
        .toBe('.parent[data-v-abc123] .child[data-v-abc123]');
    });

    it('should scope child selectors', () => {
      expect(scopeSelector('.parent > .child', scopeId))
        .toBe('.parent[data-v-abc123] > .child[data-v-abc123]');
    });

    it('should scope adjacent sibling selectors', () => {
      expect(scopeSelector('.first + .second', scopeId))
        .toBe('.first[data-v-abc123] + .second[data-v-abc123]');
    });

    it('should scope general sibling selectors', () => {
      expect(scopeSelector('.first ~ .rest', scopeId))
        .toBe('.first[data-v-abc123] ~ .rest[data-v-abc123]');
    });

    it('should handle pseudo-classes', () => {
      expect(scopeSelector('.btn:hover', scopeId)).toBe('.btn:hover[data-v-abc123]');
      expect(scopeSelector('.item:first-child', scopeId)).toBe('.item:first-child[data-v-abc123]');
    });

    it('should place scope before pseudo-elements', () => {
      expect(scopeSelector('.btn::before', scopeId)).toBe('.btn[data-v-abc123]::before');
      expect(scopeSelector('.btn::after', scopeId)).toBe('.btn[data-v-abc123]::after');
    });

    it('should handle universal selector', () => {
      expect(scopeSelector('*', scopeId)).toBe('*[data-v-abc123]');
    });

    it('should handle :deep() modifier', () => {
      expect(scopeSelector('.parent :deep(.child)', scopeId))
        .toBe('.parent[data-v-abc123] .child');
    });

    it('should handle :global() modifier', () => {
      expect(scopeSelector(':global(.external)', scopeId)).toBe('.external');
    });

    it('should handle :slotted() modifier', () => {
      expect(scopeSelector(':slotted(.slot-content)', scopeId))
        .toBe('.slot-content[data-v-abc123]');
    });

    it('should not scope :root selector', () => {
      const result = scopeSelector(':root', scopeId);
      expect(result).toBe(':root');
    });

    it('should handle complex multi-part selectors', () => {
      expect(scopeSelector('.nav > .item:first-child > a:hover', scopeId))
        .toBe('.nav[data-v-abc123] > .item:first-child[data-v-abc123] > a:hover[data-v-abc123]');
    });

    it('should handle attribute selectors', () => {
      expect(scopeSelector('[data-type="button"]', scopeId))
        .toBe('[data-type="button"][data-v-abc123]');
    });
  });

  describe('tokenizeCSS', () => {
    it('should tokenize simple CSS', () => {
      const css = '.btn { color: red; }';
      const tokens = tokenizeCSS(css);

      expect(tokens).toContainEqual(expect.objectContaining({
        type: 'selector',
        value: '.btn'
      }));
      expect(tokens).toContainEqual(expect.objectContaining({
        type: '{'
      }));
      expect(tokens).toContainEqual(expect.objectContaining({
        type: 'declaration',
        value: 'color: red'
      }));
    });

    it('should tokenize @media rules', () => {
      const css = '@media (min-width: 768px) { .btn { color: blue; } }';
      const tokens = tokenizeCSS(css);

      expect(tokens).toContainEqual(expect.objectContaining({
        type: 'at-rule',
        value: '@media (min-width: 768px)'
      }));
    });

    it('should tokenize @keyframes', () => {
      const css = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }';
      const tokens = tokenizeCSS(css);

      expect(tokens).toContainEqual(expect.objectContaining({
        type: 'at-rule',
        value: '@keyframes fade'
      }));
    });

    it('should preserve comments', () => {
      const css = '/* comment */ .btn { color: red; }';
      const tokens = tokenizeCSS(css);

      expect(tokens).toContainEqual(expect.objectContaining({
        type: 'comment',
        value: '/* comment */'
      }));
    });
  });

  describe('transformCSS', () => {
    const scopeId = 'v-test12';

    it('should transform simple CSS rules', () => {
      const input = '.btn { color: red; }';
      const output = transformCSS(input, scopeId);

      expect(output).toContain('.btn[data-v-test12]');
      expect(output).toContain('color: red');
    });

    it('should transform multiple selectors', () => {
      const input = '.btn, .link { color: blue; }';
      const output = transformCSS(input, scopeId);

      expect(output).toContain('.btn[data-v-test12]');
      expect(output).toContain('.link[data-v-test12]');
    });

    it('should handle @media queries', () => {
      const input = '@media (min-width: 768px) { .btn { color: blue; } }';
      const output = transformCSS(input, scopeId);

      expect(output).toContain('@media (min-width: 768px)');
      expect(output).toContain('.btn[data-v-test12]');
    });

    it('should NOT scope @keyframes selectors', () => {
      const input = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } }';
      const output = transformCSS(input, scopeId);

      expect(output).toContain('from');
      expect(output).toContain('to');
      expect(output).not.toContain('[data-v-test12]from');
    });

    it('should handle nested at-rules', () => {
      const input = `
        @supports (display: grid) {
          @media (min-width: 768px) {
            .grid { display: grid; }
          }
        }
      `;
      const output = transformCSS(input, scopeId);

      expect(output).toContain('@supports (display: grid)');
      expect(output).toContain('@media (min-width: 768px)');
      expect(output).toContain('.grid[data-v-test12]');
    });
  });

  describe('transformTemplate', () => {
    const scopeId = 'v-abc123';

    it('should add scope attribute to simple elements', () => {
      const input = '<div>Hello</div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toBe('<div data-v-abc123>Hello</div>');
    });

    it('should add scope to multiple elements', () => {
      const input = '<div><span>Text</span></div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toBe('<div data-v-abc123><span data-v-abc123>Text</span></div>');
    });

    it('should preserve existing attributes', () => {
      const input = '<div class="container" id="main">Content</div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('class="container"');
      expect(output).toContain('id="main"');
      expect(output).toContain('data-v-abc123');
    });

    it('should handle self-closing elements', () => {
      const input = '<img src="image.png" />';
      const output = transformTemplate(input, scopeId);

      expect(output).toBe('<img src="image.png" data-v-abc123 />');
    });

    it('should handle void elements', () => {
      const input = '<input type="text"><br><hr>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('<input type="text" data-v-abc123>');
      expect(output).toContain('<br data-v-abc123>');
      expect(output).toContain('<hr data-v-abc123>');
    });

    it('should skip script tags', () => {
      const input = '<div><script>alert(1)</script></div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('<script>');
      expect(output).not.toContain('<script data-v-abc123>');
    });

    it('should skip style tags', () => {
      const input = '<div><style>.btn{}</style></div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('<style>');
      expect(output).not.toContain('<style data-v-abc123>');
    });

    it('should handle comments', () => {
      const input = '<!-- comment --><div>Content</div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toBe('<!-- comment --><div data-v-abc123>Content</div>');
    });

    it('should handle SVG elements', () => {
      const input = '<svg><circle cx="50" cy="50" r="40"/></svg>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('<svg data-v-abc123>');
      expect(output).toContain('<circle');
      expect(output).toContain('data-v-abc123');
    });

    it('should not duplicate scope attribute', () => {
      const input = '<div data-v-abc123>Already scoped</div>';
      const output = transformTemplate(input, scopeId);

      // Should not add a second data-v-abc123
      const matches = output.match(/data-v-abc123/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('injectScopeAttribute', () => {
    it('should add to empty attributes', () => {
      const result = injectScopeAttribute('', 'data-v-test');
      expect(result).toBe(' data-v-test');
    });

    it('should add to existing attributes', () => {
      const result = injectScopeAttribute(' class="btn"', 'data-v-test');
      expect(result).toBe(' class="btn" data-v-test');
    });

    it('should not duplicate existing scope', () => {
      const result = injectScopeAttribute(' data-v-test class="btn"', 'data-v-test');
      expect(result).toBe(' data-v-test class="btn"');
    });
  });

  describe('extractStyles', () => {
    it('should extract scoped style blocks', () => {
      const source = '<style scoped>.btn { color: red; }</style>';
      const styles = extractStyles(source);

      expect(styles).toHaveLength(1);
      expect(styles[0].scoped).toBe(true);
      expect(styles[0].content).toBe('.btn { color: red; }');
    });

    it('should extract unscoped style blocks', () => {
      const source = '<style>.global { color: blue; }</style>';
      const styles = extractStyles(source);

      expect(styles).toHaveLength(1);
      expect(styles[0].scoped).toBe(false);
    });

    it('should extract multiple style blocks', () => {
      const source = `
        <style scoped>.local { color: red; }</style>
        <style>.global { color: blue; }</style>
      `;
      const styles = extractStyles(source);

      expect(styles).toHaveLength(2);
      expect(styles[0].scoped).toBe(true);
      expect(styles[1].scoped).toBe(false);
    });

    it('should detect lang attribute', () => {
      const source = '<style scoped lang="scss">.btn { color: red; }</style>';
      const styles = extractStyles(source);

      expect(styles[0].lang).toBe('scss');
    });
  });

  describe('extractTemplate', () => {
    it('should extract template tag content', () => {
      const source = '<template><div>Content</div></template>';
      const template = extractTemplate(source);

      expect(template).not.toBeNull();
      expect(template.content).toBe('<div>Content</div>');
      expect(template.type).toBe('tag');
    });

    it('should extract template property with backticks', () => {
      const source = "const comp = { template: `<div>Content</div>` };";
      const template = extractTemplate(source);

      expect(template).not.toBeNull();
      expect(template.content).toBe('<div>Content</div>');
      expect(template.type).toBe('property');
      expect(template.quote).toBe('`');
    });

    it('should extract template property with single quotes', () => {
      const source = "const comp = { template: '<div>Content</div>' };";
      const template = extractTemplate(source);

      expect(template).not.toBeNull();
      expect(template.content).toBe('<div>Content</div>');
      expect(template.quote).toBe("'");
    });

    it('should return null when no template found', () => {
      const source = 'const comp = { name: "test" };';
      const template = extractTemplate(source);

      expect(template).toBeNull();
    });
  });

  describe('transformComponent', () => {
    it('should transform component with scoped styles', () => {
      const source = `
        <template>
          <div class="container">
            <button class="btn">Click</button>
          </div>
        </template>
        <style scoped>
          .container { padding: 10px; }
          .btn { color: red; }
        </style>
      `;

      const result = transformComponent(source, 'test-component');

      expect(result.scopeId).toMatch(/^v-[a-f0-9]{6}$/);
      expect(result.css).toContain('.container[data-');
      expect(result.css).toContain('.btn[data-');
      expect(result.code).toContain('data-' + result.scopeId);
    });

    it('should return unchanged source when no scoped styles', () => {
      const source = `
        <template><div>No styles</div></template>
        <style>.global { color: blue; }</style>
      `;

      const result = transformComponent(source, 'no-scope');

      expect(result.scopeId).toBeNull();
      expect(result.css).toBe('');
      expect(result.code).toBe(source);
    });

    it('should handle JS component definitions', () => {
      const source = `
        app.component('my-button', {
          template: '<button class="btn">{{ label }}</button>',
          props: ['label']
        });
        <style scoped>
          .btn { background: blue; }
        </style>
      `;

      const result = transformComponent(source, 'my-button');

      expect(result.scopeId).not.toBeNull();
      expect(result.css).toContain('.btn[data-');
      expect(result.code).toContain('data-' + result.scopeId);
    });

    it('should collect CSS when removeStyles is true', () => {
      const source = `
        <template><div class="box">Box</div></template>
        <style scoped>.box { border: 1px solid; }</style>
      `;

      const result = transformComponent(source, 'box', { removeStyles: true });

      expect(result.css).toContain('.box[data-');
      expect(result.code).not.toContain('<style');
    });

    it('should preserve unscoped styles', () => {
      const source = `
        <template><div>Content</div></template>
        <style>.global { color: red; }</style>
        <style scoped>.local { color: blue; }</style>
      `;

      const result = transformComponent(source, 'mixed');

      expect(result.css).toContain('.local[data-');
      expect(result.css).not.toContain('.global[data-');
      expect(result.code).toContain('<style>.global { color: red; }</style>');
    });
  });

  describe('Edge Cases', () => {
    const scopeId = 'v-edge12';

    it('should handle empty CSS', () => {
      const output = transformCSS('', scopeId);
      expect(output).toBe('');
    });

    it('should handle empty template', () => {
      const output = transformTemplate('', scopeId);
      expect(output).toBe('');
    });

    it('should handle CSS with only comments', () => {
      const input = '/* Just a comment */';
      const output = transformCSS(input, scopeId);
      expect(output).toContain('/* Just a comment */');
    });

    it('should handle deeply nested selectors', () => {
      const input = '.a .b .c .d .e { color: red; }';
      const output = transformCSS(input, scopeId);

      expect(output).toContain('.a[data-v-edge12]');
      expect(output).toContain('.b[data-v-edge12]');
      expect(output).toContain('.c[data-v-edge12]');
      expect(output).toContain('.d[data-v-edge12]');
      expect(output).toContain('.e[data-v-edge12]');
    });

    it('should handle attribute selectors with quotes', () => {
      const selector = 'input[type="text"]';
      const result = scopeSelector(selector, scopeId);
      expect(result).toBe('input[type="text"][data-v-edge12]');
    });

    it('should handle selectors with escaped characters', () => {
      const selector = '.class\\:name';
      const result = scopeSelector(selector, scopeId);
      expect(result).toBe('.class\\:name[data-v-edge12]');
    });

    it('should handle multiline templates', () => {
      const input = `
        <div>
          <span>Line 1</span>
          <span>Line 2</span>
        </div>
      `;
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('<div data-v-edge12>');
      expect(output).toContain('<span data-v-edge12>Line 1</span>');
      expect(output).toContain('<span data-v-edge12>Line 2</span>');
    });

    it('should handle templates with Reflex directives', () => {
      const input = '<div m-if="show" :class="className" @click="handleClick">Content</div>';
      const output = transformTemplate(input, scopeId);

      expect(output).toContain('m-if="show"');
      expect(output).toContain(':class="className"');
      expect(output).toContain('@click="handleClick"');
      expect(output).toContain('data-v-edge12');
    });
  });

  describe('Performance Characteristics', () => {
    it('should handle large CSS files efficiently', () => {
      const rules = [];
      for (let i = 0; i < 1000; i++) {
        rules.push(`.class-${i} { color: #${i.toString(16).padStart(6, '0')}; }`);
      }
      const largeCSS = rules.join('\n');

      const start = performance.now();
      const output = transformCSS(largeCSS, 'v-perf01');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500); // Should complete within 500ms
      expect(output).toContain('.class-0[data-v-perf01]');
      expect(output).toContain('.class-999[data-v-perf01]');
    });

    it('should handle large templates efficiently', () => {
      const elements = [];
      for (let i = 0; i < 1000; i++) {
        elements.push(`<div class="item-${i}">Item ${i}</div>`);
      }
      const largeTemplate = `<div>${elements.join('')}</div>`;

      const start = performance.now();
      const output = transformTemplate(largeTemplate, 'v-perf02');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500);
      expect(output.match(/data-v-perf02/g).length).toBe(1001); // 1000 items + 1 wrapper
    });
  });
});
