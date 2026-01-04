import { Reflex } from 'reflex';

let nextId = 1;

const app = new Reflex({
  newTodo: '',
  filter: 'all',
  todos: [],

  // Computed properties
  get filteredTodos() {
    if (this.filter === 'all') return this.todos;
    if (this.filter === 'active') return this.todos.filter(t => !t.completed);
    if (this.filter === 'completed') return this.todos.filter(t => t.completed);
    return this.todos;
  },

  get activeCount() {
    return this.todos.filter(t => !t.completed).length;
  },

  // Methods
  addTodo() {
    const text = this.newTodo.trim();
    if (!text) return;

    this.todos.push({
      id: nextId++,
      text,
      completed: false,
    });

    this.newTodo = '';
  },

  toggleTodo(id) {
    const todo = this.todos.find(t => t.id === id);
    if (todo) {
      todo.completed = !todo.completed;
    }
  },

  deleteTodo(id) {
    const index = this.todos.findIndex(t => t.id === id);
    if (index !== -1) {
      this.todos.splice(index, 1);
    }
  },

  setFilter(filter) {
    this.filter = filter;
  },
});

app.mount(document.getElementById('app'));

// Add some sample todos
app.s.todos.push(
  { id: nextId++, text: 'Learn Reflex AOT compilation', completed: false },
  { id: nextId++, text: 'Build something awesome', completed: false },
  { id: nextId++, text: 'Deploy to production', completed: false }
);
