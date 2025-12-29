# SSR Text Interpolation Hydration Guide

## The Problem

Previously, Reflex hydration had a critical flaw where server-rendered text interpolations would not become reactive on the client. This occurred because:

1. **Server renders the result**: During SSR, templates like `{{ user.name }}` are evaluated to their actual values (e.g., "John Doe")
2. **Client expects the template**: The hydration code checked if text nodes contained `{{` to determine if they should be reactive
3. **Mismatch causes static content**: Since the server-rendered HTML contained "John Doe" instead of `{{ user.name }}`, the hydration logic skipped these nodes, making them permanently static

## The Solution

We've implemented a **comment marker** system that allows the server to preserve template information while rendering the evaluated result:

### Server-Side Rendering

When rendering text interpolations during SSR, add a comment marker **before** the text node:

```html
<!-- Template: {{ user.name }} -->
<span><!--txt:{{ user.name }}-->John Doe</span>
```

The marker format is: `<!--txt:TEMPLATE_EXPRESSION-->`

### Client-Side Hydration

During hydration, Reflex now:

1. Detects comment nodes starting with `txt:`
2. Extracts the template expression from the comment
3. Applies the template to the following text node to make it reactive
4. Removes the marker comment to keep the DOM clean

## Implementation Examples

### Single Interpolation

**SSR Output:**
```html
<div id="app">
  <h1><!--txt:{{ title }}-->Welcome to Reflex</h1>
  <p><!--txt:{{ message }}-->Hello World</p>
</div>
```

**Client Hydration:**
```javascript
import { Reflex } from 'reflex';
import { withHydration } from 'reflex/hydration';

const app = new Reflex({
  title: 'Welcome to Reflex',
  message: 'Hello World'
});

app.use(withHydration);
app.hydrate(document.getElementById('app'));

// Now the text is reactive!
app.s.title = 'Updated Title'; // Updates the h1
app.s.message = 'Updated Message'; // Updates the p
```

### Complex Interpolation

**SSR Output:**
```html
<div id="user-card">
  <p><!--txt:Hello {{ user.name }}, you have {{ count }} notifications-->Hello John, you have 5 notifications</p>
</div>
```

**Client Hydration:**
```javascript
const app = new Reflex({
  user: { name: 'John' },
  count: 5
});

app.use(withHydration);
app.hydrate(document.getElementById('user-card'));

// Both values are now reactive
app.s.user.name = 'Jane';
app.s.count = 10;
// Updates to: "Hello Jane, you have 10 notifications"
```

## Backward Compatibility

The hydration system maintains backward compatibility with the legacy approach where servers render literal template syntax:

**Legacy SSR Output (still supported):**
```html
<span>{{ count }}</span>
```

This will continue to work, but is not recommended for production SSR as it exposes template syntax to the client and doesn't provide a proper server-rendered first paint.

## Integration with SSR Frameworks

### Node.js SSR Example

```javascript
function renderToString(template, state) {
  // Replace interpolations with their values and add markers
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, expr) => {
    const value = evaluateExpression(expr, state);
    return `<!--txt:{{ ${expr.trim()} }}-->${value}`;
  });
}

// Usage
const html = renderToString('<h1>{{ title }}</h1>', { title: 'Hello' });
// Result: <h1><!--txt:{{ title }}-->Hello</h1>
```

## Benefits

1. **Proper SSR**: Server renders actual content for SEO and first paint
2. **Full Reactivity**: Client-side hydration makes all interpolations reactive
3. **No Template Exposure**: Template syntax is hidden in comments (removed after hydration)
4. **Performance**: No unnecessary re-renders during hydration
5. **Backward Compatible**: Legacy approach still works

## Migration Guide

If you're using Reflex with SSR:

1. Update your SSR renderer to add `<!--txt:TEMPLATE-->` comment markers before text interpolations
2. Ensure the comment appears immediately before the text node (whitespace is handled automatically)
3. Test that hydration makes the content reactive
4. Remove any workarounds for static text content

## Technical Details

- **Marker Format**: `<!--txt:{{ expression }}-->`
- **Marker Removal**: Comments are automatically removed after hydration
- **Whitespace Handling**: The hydration walker skips whitespace-only text nodes when finding the target
- **Error Handling**: If template application fails, the original server-rendered value is preserved
- **Multiple Interpolations**: Each interpolation needs its own marker

## File Changes

- `src/hydration/withHydration.ts`: Added comment marker detection and `_hydrateTextWithTemplate` method
- `tests/hydration.test.js`: Added tests for the new comment marker approach

## Related Issues

This fix resolves the critical issue where all server-rendered text content was static and would not update when state changes.
