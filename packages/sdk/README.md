# @shogo/sdk

Shogo Platform SDK - Zero-boilerplate auth and database for Shogo apps.

## Installation

```bash
npm install @shogo/sdk
# or
bun add @shogo/sdk
```

## Quick Start

```typescript
import { createClient } from '@shogo/sdk'

const client = createClient({
  apiUrl: 'http://localhost:3000',
})

// Authentication
await client.auth.signUp({ email: 'user@example.com', password: 'secret' })
await client.auth.signIn({ email: 'user@example.com', password: 'secret' })
const user = client.auth.currentUser()

// Database operations
const todos = await client.db.todos.list({ where: { completed: false } })
const todo = await client.db.todos.create({ title: 'Buy milk' })
await client.db.todos.update(todo.id, { completed: true })
await client.db.todos.delete(todo.id)
```

## Features

- **Authentication** - Email/password auth with Better Auth integration
- **Database** - Zero-config CRUD operations with MongoDB-style filtering
- **TypeScript** - Full type safety with generics
- **Cross-Platform** - Works in browsers, Node.js, and React Native

## API Reference

### Client Setup

```typescript
import { createClient } from '@shogo/sdk'

const client = createClient({
  apiUrl: 'http://localhost:3000',  // Your app backend URL
  auth: {
    mode: 'headless',                // 'managed' or 'headless'
    authPath: '/api/auth',           // Auth endpoint path (default)
  },
})
```

### Authentication

```typescript
// Sign up
const user = await client.auth.signUp({
  email: 'user@example.com',
  password: 'secret',
  name: 'Jane Doe',  // optional
})

// Sign in
const user = await client.auth.signIn({
  email: 'user@example.com',
  password: 'secret',
})

// Get current user (sync)
const user = client.auth.currentUser()

// Get session (async)
const session = await client.auth.getSession()

// Sign out
await client.auth.signOut()

// Listen to auth state changes
const unsubscribe = client.auth.onAuthStateChanged((state) => {
  console.log('Auth state:', state.isAuthenticated, state.user)
})
```

### Database Operations

```typescript
// List with filtering
const todos = await client.db.todos.list({
  where: { status: 'active' },
  orderBy: { createdAt: 'desc' },
  take: 20,
  skip: 0,
})

// Get by ID
const todo = await client.db.todos.get('todo-123')

// Create
const newTodo = await client.db.todos.create({
  title: 'Buy milk',
  completed: false,
})

// Update
await client.db.todos.update('todo-123', {
  completed: true,
})

// Delete
await client.db.todos.delete('todo-123')

// Count
const count = await client.db.todos.count({
  where: { completed: true },
})
```

### Query Operators

```typescript
// Comparison operators
{ priority: { $gt: 5 } }     // Greater than
{ priority: { $gte: 5 } }    // Greater than or equal
{ priority: { $lt: 5 } }     // Less than
{ priority: { $lte: 5 } }    // Less than or equal
{ status: { $eq: 'active' } } // Equal
{ status: { $ne: 'done' } }   // Not equal

// Array operators
{ tags: { $in: ['urgent', 'important'] } }    // In array
{ tags: { $nin: ['archived'] } }              // Not in array

// Logical operators
{
  $and: [
    { status: 'active' },
    { priority: { $gte: 5 } },
  ]
}

{
  $or: [
    { priority: 10 },
    { status: 'urgent' },
  ]
}
```

### React Integration

```typescript
import { useState, useEffect } from 'react'
import { createClient, type AuthState } from '@shogo/sdk'

const client = createClient({ apiUrl: 'http://localhost:3000' })

function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    isAuthenticated: false,
    isLoading: true,
  })

  useEffect(() => {
    return client.auth.onAuthStateChanged(setState)
  }, [])

  return {
    ...state,
    signIn: client.auth.signIn.bind(client.auth),
    signUp: client.auth.signUp.bind(client.auth),
    signOut: client.auth.signOut.bind(client.auth),
  }
}
```

### React Native

```typescript
import { createClient, AsyncStorageAdapter } from '@shogo/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'

const client = createClient({
  apiUrl: 'https://my-app.example.com',
  storage: new AsyncStorageAdapter(AsyncStorage),
})
```

## Type Safety

Use `createTypedClient` for full type inference:

```typescript
import { createTypedClient } from '@shogo/sdk'

interface Todo {
  id: string
  title: string
  completed: boolean
}

interface User {
  id: string
  email: string
  name: string
}

const client = createTypedClient<{
  todos: Todo
  users: User
}>({
  apiUrl: 'http://localhost:3000',
})

// Now fully typed!
const todos: Todo[] = await client.db.todos.list()
const user: User | null = await client.db.users.get('123')
```

## Examples

See the [examples](./examples) directory for complete working examples:

- [todo-app](./examples/todo-app) - Full-featured todo application with auth and CRUD

## License

MIT
