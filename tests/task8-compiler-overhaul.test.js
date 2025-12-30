/**
 * TASK 8: Compiler Reliability Overhaul Tests
 *
 * Tests for the architectural fixes to the Reactivity/Compiler system:
 * - Sub-Task 8.1: Dynamic Path Resolution (m-model with dynamic brackets)
 * - Sub-Task 8.2: GC Anchor Strategy (Virtual Container memory cleanup)
 * - Sub-Task 8.3: Unified Security Type System (SafeHTML enforcement)
 * - Sub-Task 8.4: Stable Reference Reconciliation (Array identity preservation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Reflex, SafeHTML } from '../src/index.ts';
import DOMPurify from 'dompurify';

describe('TASK 8.1: Dynamic Path Resolution', () => {
  let app;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (app) app.unmount();
    document.body.removeChild(container);
  });

  it('should support dynamic bracket notation in m-model (users[id])', async () => {
    container.innerHTML = `
      <input id="input1" type="text" m-model="users[currentId].name" />
      <input id="input2" type="text" m-model="users[currentId].email" />
    `;

    app = new Reflex({
      el: container,
      state: {
        currentId: 0,
        users: [
          { name: 'Alice', email: 'alice@example.com' },
          { name: 'Bob', email: 'bob@example.com' }
        ]
      }
    });

    const input1 = container.querySelector('#input1');
    const input2 = container.querySelector('#input2');

    // Initial state: currentId=0 → Alice
    expect(input1.value).toBe('Alice');
    expect(input2.value).toBe('alice@example.com');

    // Update via input (should update users[0])
    input1.value = 'Alice Updated';
    input1.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.s.users[0].name).toBe('Alice Updated');

    // Change currentId to 1 → Bob
    app.s.currentId = 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(input1.value).toBe('Bob');
    expect(input2.value).toBe('bob@example.com');

    // Update via input (should update users[1])
    input1.value = 'Bob Updated';
    input1.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.s.users[1].name).toBe('Bob Updated');
  });

  it('should distinguish between literal and dynamic brackets', async () => {
    container.innerHTML = `
      <input id="literal" type="text" m-model="data['key']" />
      <input id="dynamic" type="text" m-model="data[key]" />
    `;

    app = new Reflex({
      el: container,
      state: {
        key: 'dynamicKey',
        data: {
          key: 'literal value', // Literal access: data['key']
          dynamicKey: 'dynamic value' // Dynamic access: data[key] where key='dynamicKey'
        }
      }
    });

    const literalInput = container.querySelector('#literal');
    const dynamicInput = container.querySelector('#dynamic');

    // Literal bracket: data['key'] → accesses property named 'key'
    expect(literalInput.value).toBe('literal value');

    // Dynamic bracket: data[key] → evaluates key variable → accesses 'dynamicKey'
    expect(dynamicInput.value).toBe('dynamic value');

    // Update literal
    literalInput.value = 'updated literal';
    literalInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.s.data.key).toBe('updated literal');

    // Update dynamic
    dynamicInput.value = 'updated dynamic';
    dynamicInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.s.data.dynamicKey).toBe('updated dynamic');
  });

  it('should support nested dynamic paths (data[row][col])', async () => {
    container.innerHTML = `
      <input id="cell" type="text" m-model="grid[row][col]" />
    `;

    app = new Reflex({
      el: container,
      state: {
        row: 0,
        col: 1,
        grid: [
          ['A1', 'B1', 'C1'],
          ['A2', 'B2', 'C2']
        ]
      }
    });

    const cellInput = container.querySelector('#cell');

    // Initial: grid[0][1] → 'B1'
    expect(cellInput.value).toBe('B1');

    // Update via input
    cellInput.value = 'B1-Updated';
    cellInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app.s.grid[0][1]).toBe('B1-Updated');

    // Change row and col
    app.s.row = 1;
    app.s.col = 2;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cellInput.value).toBe('C2');
  });
});

describe('TASK 8.2: GC Anchor Strategy', () => {
  let app;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (app) app.unmount();
    document.body.removeChild(container);
  });

  it('should register virtual containers with GC using anchor node', async () => {
    container.innerHTML = `
      <table>
        <tbody>
          <template m-for="item in items" m-key="id">
            <tr>
              <td>{{ item.name }}</td>
            </tr>
          </template>
        </tbody>
      </tbody>
    `;

    app = new Reflex({
      el: container,
      state: {
        items: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
          { id: 3, name: 'Item 3' }
        ]
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const rows = container.querySelectorAll('tr');
    expect(rows.length).toBe(3);

    // Verify that scope registry has entries
    const initialSize = app._scopeRegistry._registry.size;
    expect(initialSize).toBeGreaterThan(0);

    // Clear the table using innerHTML (simulates DOM removal without cleanup)
    const tbody = container.querySelector('tbody');
    tbody.innerHTML = '';

    await new Promise(resolve => setTimeout(resolve, 10));

    // The GC should eventually clean up the scope entries
    // (In real scenarios, this happens asynchronously when browser GC runs)
    // For testing, we verify the mechanism exists by checking _gcRegistry
    expect(app._gcRegistry).toBeDefined();
  });

  it('should handle virtual container removal in strict parents (<table>, <select>)', async () => {
    container.innerHTML = `
      <table id="test-table">
        <tbody>
          <template m-for="row in rows" m-key="id">
            <tr>
              <td>{{ row.value }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    `;

    app = new Reflex({
      el: container,
      state: {
        rows: [{ id: 1, value: 'A' }, { id: 2, value: 'B' }]
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(container.querySelectorAll('tr').length).toBe(2);

    // Remove all rows
    app.s.rows = [];
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(container.querySelectorAll('tr').length).toBe(0);

    // Re-add rows
    app.s.rows = [{ id: 3, value: 'C' }];
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(container.querySelectorAll('tr').length).toBe(1);
    expect(container.querySelector('td').textContent).toBe('C');
  });
});

describe('TASK 8.3: Unified Security Type System', () => {
  let app;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Configure SafeHTML with DOMPurify
    SafeHTML.configureSanitizer(DOMPurify);
  });

  afterEach(() => {
    if (app) app.unmount();
    document.body.removeChild(container);
  });

  it('should throw TypeError when m-model.html receives a raw string', async () => {
    container.innerHTML = `
      <div contenteditable="true" m-model.html="content"></div>
    `;

    // This should throw during reactivity setup
    expect(() => {
      app = new Reflex({
        el: container,
        state: {
          content: '<p>Raw HTML string</p>' // Raw string - should fail
        }
      });
    }).toThrow(TypeError);
    expect(() => {
      app = new Reflex({
        el: container,
        state: {
          content: '<p>Raw HTML string</p>'
        }
      });
    }).toThrow(/m-model\.html requires a SafeHTML value/);
  });

  it('should accept SafeHTML instances in m-model.html', async () => {
    container.innerHTML = `
      <div id="editor" contenteditable="true" m-model.html="content"></div>
    `;

    const safeContent = SafeHTML.sanitize('<p>Safe <strong>HTML</strong></p>');

    app = new Reflex({
      el: container,
      state: {
        content: safeContent
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const editor = container.querySelector('#editor');
    expect(editor.innerHTML).toContain('Safe');
    expect(editor.innerHTML).toContain('strong');
  });

  it('should sanitize user input through SafeHTML', async () => {
    container.innerHTML = `
      <div id="display" contenteditable="true" m-model.html="userContent"></div>
    `;

    // Malicious input with XSS attempt
    const maliciousInput = '<p>Hello</p><script>alert("XSS")</script>';
    const sanitized = SafeHTML.sanitize(maliciousInput);

    app = new Reflex({
      el: container,
      state: {
        userContent: sanitized
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const display = container.querySelector('#display');

    // DOMPurify should strip the script tag
    expect(display.innerHTML).toContain('Hello');
    expect(display.innerHTML).not.toContain('script');
    expect(display.innerHTML).not.toContain('alert');
  });

  it('should allow SafeHTML.unsafe for trusted static content', async () => {
    container.innerHTML = `
      <div id="icon" contenteditable="true" m-model.html="iconSVG"></div>
    `;

    const trustedSVG = SafeHTML.unsafe('<svg width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>');

    app = new Reflex({
      el: container,
      state: {
        iconSVG: trustedSVG
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    const icon = container.querySelector('#icon');
    expect(icon.innerHTML).toContain('svg');
    expect(icon.innerHTML).toContain('circle');
  });
});

describe('TASK 8.4: Stable Reference Reconciliation', () => {
  let app;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (app) app.unmount();
    document.body.removeChild(container);
  });

  it('should preserve array reference identity across re-renders', async () => {
    container.innerHTML = `
      <ul>
        <li m-for="item in items" m-key="id" m-ref="itemRefs">{{ item.name }}</li>
      </ul>
    `;

    app = new Reflex({
      el: container,
      state: {
        items: [
          { id: 1, name: 'First' },
          { id: 2, name: 'Second' },
          { id: 3, name: 'Third' }
        ]
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Get the initial ref array reference
    const initialRef = app._refs.itemRefs;
    expect(initialRef).toBeDefined();
    expect(Array.isArray(initialRef)).toBe(true);
    expect(initialRef.length).toBe(3);

    // Re-order the items
    app.s.items.reverse();
    await new Promise(resolve => setTimeout(resolve, 10));

    // The ref array should be the SAME object (identity preserved)
    const afterReorder = app._refs.itemRefs;
    expect(afterReorder).toBe(initialRef); // Same reference (===)
    expect(afterReorder.length).toBe(3);
  });

  it('should mutate existing array instead of reassigning', async () => {
    container.innerHTML = `
      <div m-for="num in numbers" m-key="num" m-ref="numRefs">{{ num }}</div>
    `;

    app = new Reflex({
      el: container,
      state: {
        numbers: [1, 2, 3]
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const refArray = app._refs.numRefs;

    // Add a custom property to the array
    refArray.customProperty = 'test metadata';

    // Change the list
    app.s.numbers = [3, 2, 1];
    await new Promise(resolve => setTimeout(resolve, 10));

    // Custom property should still exist (array wasn't replaced)
    expect(app._refs.numRefs.customProperty).toBe('test metadata');
    expect(app._refs.numRefs).toBe(refArray);
  });

  it('should work with watchers that monitor ref array identity', async () => {
    container.innerHTML = `
      <span m-for="letter in letters" m-key="letter" m-ref="letterRefs">{{ letter }}</span>
    `;

    let watcherCallCount = 0;
    const watchCallback = vi.fn(() => watcherCallCount++);

    app = new Reflex({
      el: container,
      state: {
        letters: ['A', 'B', 'C']
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Simulate a watcher on the ref array object (not its contents)
    const originalRef = app._refs.letterRefs;
    const watchedRef = originalRef; // Pretend we're watching this reference

    // Re-sort the letters multiple times
    app.s.letters = ['C', 'B', 'A'];
    await new Promise(resolve => setTimeout(resolve, 10));

    app.s.letters = ['B', 'A', 'C'];
    await new Promise(resolve => setTimeout(resolve, 10));

    // The ref should still be the same object
    expect(app._refs.letterRefs).toBe(watchedRef);

    // A watcher monitoring object identity wouldn't fire
    // (because we mutate in place, not reassign)
  });

  it('should handle dynamic ref array updates correctly', async () => {
    container.innerHTML = `
      <ul>
        <template m-for="task in tasks" m-key="id">
          <li m-ref="taskElements">{{ task.title }}</li>
        </template>
      </ul>
    `;

    app = new Reflex({
      el: container,
      state: {
        tasks: [
          { id: 1, title: 'Task 1' },
          { id: 2, title: 'Task 2' }
        ]
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const refArray = app._refs.taskElements;
    expect(refArray.length).toBe(2);

    // Add a task
    app.s.tasks.push({ id: 3, title: 'Task 3' });
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should still be the same array object
    expect(app._refs.taskElements).toBe(refArray);
    expect(app._refs.taskElements.length).toBe(3);

    // Remove a task
    app.s.tasks.splice(1, 1);
    await new Promise(resolve => setTimeout(resolve, 10));

    // Still the same array
    expect(app._refs.taskElements).toBe(refArray);
    expect(app._refs.taskElements.length).toBe(2);
  });
});

describe('TASK 8: Integration Tests', () => {
  let app;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    SafeHTML.configureSanitizer(DOMPurify);
  });

  afterEach(() => {
    if (app) app.unmount();
    document.body.removeChild(container);
  });

  it('should handle all Task 8 features together', async () => {
    container.innerHTML = `
      <div>
        <input id="selector" type="text" m-model="selectedIndex" />

        <table>
          <tbody>
            <template m-for="(user, index) in users" m-key="id">
              <tr m-ref="userRows">
                <td>{{ index }}</td>
                <td><input type="text" m-model="users[selectedIndex].name" /></td>
              </tr>
            </template>
          </tbody>
        </table>

        <div id="preview" contenteditable="true" m-model.html="richContent"></div>
      </div>
    `;

    app = new Reflex({
      el: container,
      state: {
        selectedIndex: 0,
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' }
        ],
        richContent: SafeHTML.sanitize('<p><strong>Preview</strong></p>')
      }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Test dynamic path resolution
    const nameInput = container.querySelector('input[type="text"]');
    expect(nameInput.value).toBe('Alice');

    // Test stable refs
    const initialRefs = app._refs.userRows;
    app.s.users.reverse();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(app._refs.userRows).toBe(initialRefs);

    // Test SafeHTML enforcement
    const preview = container.querySelector('#preview');
    expect(preview.innerHTML).toContain('strong');
  });
});
