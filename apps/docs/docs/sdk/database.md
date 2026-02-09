---
sidebar_position: 3
title: Database
slug: /sdk/database
---

# SDK Database

The Shogo SDK gives you a zero-configuration database with MongoDB-style operations. Create, read, update, and delete records without writing SQL or setting up a database server.

## How it works

When your Shogo project has data models (schemas), the SDK automatically generates typed database methods for each model. You access them through `client.db.<collection>`.

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({ projectId: 'my-app' });

// Access the "todos" collection
const todos = client.db.todos;
```

## Create

Add a new record to a collection:

```typescript
const todo = await client.db.todos.create({
  title: 'Buy groceries',
  description: 'Milk, eggs, bread',
  completed: false,
  dueDate: '2026-02-15',
});

console.log(todo.id); // Auto-generated unique ID
```

## Read

### Get a single record by ID

```typescript
const todo = await client.db.todos.get('todo-id-123');
console.log(todo.title); // "Buy groceries"
```

### List records

Retrieve multiple records, optionally with filters:

```typescript
// Get all todos
const allTodos = await client.db.todos.list();

// Get only incomplete todos
const pending = await client.db.todos.list({
  where: { completed: false },
});

// Get todos due today
const dueToday = await client.db.todos.list({
  where: { dueDate: '2026-02-08' },
});
```

### Filtering

Use MongoDB-style operators for advanced filtering:

```typescript
// Equals
const results = await client.db.products.list({
  where: { category: 'electronics' },
});

// Greater than
const expensive = await client.db.products.list({
  where: { price: { $gt: 100 } },
});

// Less than or equal
const affordable = await client.db.products.list({
  where: { price: { $lte: 50 } },
});

// Contains (text search)
const matches = await client.db.products.list({
  where: { name: { $contains: 'phone' } },
});

// Multiple conditions (AND)
const filtered = await client.db.products.list({
  where: {
    category: 'electronics',
    price: { $lte: 500 },
    inStock: true,
  },
});
```

## Update

Modify an existing record:

```typescript
await client.db.todos.update('todo-id-123', {
  completed: true,
});
```

You only need to pass the fields you want to change. Other fields remain untouched.

```typescript
// Only update the title and due date
await client.db.todos.update('todo-id-123', {
  title: 'Buy groceries and snacks',
  dueDate: '2026-02-16',
});
```

## Delete

Remove a record by ID:

```typescript
await client.db.todos.delete('todo-id-123');
```

## Working with relationships

If your data models have relationships (like "each Project has many Tasks"), you can access related data:

```typescript
// Create a project
const project = await client.db.projects.create({
  name: 'Website Redesign',
});

// Create tasks linked to the project
await client.db.tasks.create({
  title: 'Design homepage',
  projectId: project.id,
});

// List tasks for a specific project
const projectTasks = await client.db.tasks.list({
  where: { projectId: project.id },
});
```

## Error handling

```typescript
try {
  const todo = await client.db.todos.get('nonexistent-id');
} catch (error) {
  console.error(error.message); // "Record not found"
}
```

## Full example: Todo app

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({ projectId: 'my-todo-app' });

// Create a new todo
async function addTodo(title: string) {
  return await client.db.todos.create({
    title,
    completed: false,
    createdAt: new Date().toISOString(),
  });
}

// Toggle completion
async function toggleTodo(id: string, completed: boolean) {
  return await client.db.todos.update(id, { completed });
}

// Get all incomplete todos
async function getPendingTodos() {
  return await client.db.todos.list({
    where: { completed: false },
  });
}

// Delete a todo
async function removeTodo(id: string) {
  return await client.db.todos.delete(id);
}

// Search todos by title
async function searchTodos(query: string) {
  return await client.db.todos.list({
    where: { title: { $contains: query } },
  });
}
```
