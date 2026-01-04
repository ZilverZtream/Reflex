# AOT Todo App Example

This example demonstrates Reflex's AOT (Ahead-of-Time) compilation capabilities.

## Features Demonstrated

1. **AOT Compilation**: Templates compiled to optimized JavaScript at build time
2. **m-for Directive**: Efficient list rendering with keyed reconciliation
3. **m-if Directive**: Conditional rendering
4. **m-trans Directive**: CSS transitions for enter/leave animations
5. **m-model Directive**: Two-way data binding
6. **Event Handlers**: Click and keyup event handling
7. **Dynamic Classes**: Class binding based on state
8. **Computed Properties**: Reactive computed values

## How AOT Works

### Before (Runtime Mode)

In runtime mode, the template is processed by WalkerMixin and ExprMixin at runtime:

```
DOM Template → WalkerMixin → ExprMixin → Component Registry → Runtime
```

Bundle includes: SafeExprParser, WalkerMixin, ExprMixin (~20KB+)

### After (Compiled Mode)

With AOT compilation, templates are transformed to JavaScript at build time:

```
Template → Vite Plugin → Compiler → Optimized JS
```

Bundle excludes: SafeExprParser, WalkerMixin, ExprMixin
Bundle includes: Only used runtime helpers (~3KB)

## Performance Benefits

- **~50% smaller bundle**: No runtime parser or walker
- **Faster initial render**: No DOM traversal or expression parsing
- **Better tree-shaking**: Unused components excluded automatically
- **Optimized list rendering**: Direct callbacks instead of FlatScope overhead

## Running the Example

```bash
# Install dependencies
npm install

# Development mode (runtime)
npm run dev

# Build (AOT compilation)
npm run build

# Preview production build
npm run preview
```

## Inspecting the Build

After running `npm run build`, check the `dist/` folder:

```bash
# Check that SafeExprParser is NOT in the bundle
grep -r "SafeExprParser" dist/

# Check that WalkerMixin is NOT in the bundle
grep -r "WalkerMixin" dist/

# Check bundle size
ls -lh dist/assets/*.js
```

## Compiled Output Example

### Input Template (from index.html)

```html
<li
  m-for="todo in filteredTodos"
  :key="todo.id"
  :class="{ 'todo-item': true, 'completed': todo.completed }"
  m-trans="fade"
>
  <input
    type="checkbox"
    :checked="todo.completed"
    @click="toggleTodo(todo.id)"
  />
  <span class="todo-text">{{ todo.text }}</span>
  <button class="delete-btn" @click="deleteTodo(todo.id)">
    Delete
  </button>
</li>
```

### Compiled JavaScript Output

```javascript
import { createKeyedList, runTransition } from 'reflex/runtime-helpers';

export function render(ctx, _ren) {
  const fragment = _ren.createComment('fragment');
  const anchor = _ren.createComment('for');

  createKeyedList(
    ctx,
    anchor,
    () => ctx.s.filteredTodos,
    (todo) => todo.id,
    (todo) => {
      const li = _ren.createElement('li');

      // Class binding
      ctx.createEffect(() => {
        li.className = todo.completed ? 'todo-item completed' : 'todo-item';
      });

      // Checkbox
      const checkbox = _ren.createElement('input');
      checkbox.type = 'checkbox';
      ctx.createEffect(() => {
        checkbox.checked = todo.completed;
      });
      checkbox.addEventListener('click', () => ctx.s.toggleTodo(todo.id));

      // Text
      const span = _ren.createElement('span');
      span.className = 'todo-text';
      ctx.createEffect(() => {
        span.textContent = todo.text;
      });

      // Delete button
      const btn = _ren.createElement('button');
      btn.className = 'delete-btn';
      btn.textContent = 'Delete';
      btn.addEventListener('click', () => ctx.s.deleteTodo(todo.id));

      li.appendChild(checkbox);
      li.appendChild(span);
      li.appendChild(btn);

      return li;
    }
  );

  _ren.insertBefore(fragment, anchor);
  return fragment;
}
```

## Key Differences

| Feature | Runtime Mode | Compiled Mode |
|---------|--------------|---------------|
| Template Processing | Runtime (DOM walking) | Build-time (static analysis) |
| Expression Parsing | Runtime (SafeExprParser) | Build-time (direct JS) |
| Component Lookup | String registry | Static imports |
| Bundle Size | ~50KB | ~25KB |
| Initial Render | Slower (parsing overhead) | Faster (no parsing) |
| List Rendering | FlatScope overhead | Direct callbacks |

## Browser Compatibility

- Modern browsers (ES2020+)
- No IE11 support (uses Proxy, etc.)

## License

MIT
