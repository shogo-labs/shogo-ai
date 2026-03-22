# @shogo-ai/sdk

Shogo Platform SDK - Zero-boilerplate auth, database, and email for Shogo apps.

## Installation

```bash
npm install @shogo-ai/sdk
# or
bun add @shogo-ai/sdk
```

## Quick Start

```typescript
import { createClient } from '@shogo-ai/sdk'

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
- **Email** - SMTP and AWS SES support with templates
- **TypeScript** - Full type safety with generics
- **Cross-Platform** - Works in browsers, Node.js, and React Native

## API Reference

### Client Setup

```typescript
import { createClient } from '@shogo-ai/sdk'

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

// List with query parameters (sent as URL query params)
// Example: GET /api/v2/projects?workspaceId=abc123&status=active
const projects = await client.db.projects.list({
  where: { workspaceId: 'abc123', status: 'active' },
  limit: 20,
})

// You can also use the params option for additional query parameters
const filtered = await client.db.items.list({
  where: { category: 'electronics' },
  params: { sortBy: 'price', order: 'asc' },
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
import { createClient, type AuthState } from '@shogo-ai/sdk'

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
import { createClient, AsyncStorageAdapter } from '@shogo-ai/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'

const client = createClient({
  apiUrl: 'https://my-app.example.com',
  storage: new AsyncStorageAdapter(AsyncStorage),
})
```

## Type Safety

Use `createTypedClient` for full type inference:

```typescript
import { createTypedClient } from '@shogo-ai/sdk'

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

## Email (Server-Side)

The SDK includes a server-side email module for sending transactional emails via SMTP or AWS SES.

### Setup

```bash
# For SMTP (works with SES SMTP, SendGrid, Mailgun, etc.)
npm install nodemailer

# For AWS SES native API
npm install @aws-sdk/client-ses
```

### Environment Variables

```bash
# SMTP Configuration
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIA...
SMTP_PASSWORD=your-password
EMAIL_FROM=noreply@yourapp.com

# OR AWS SES Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
EMAIL_FROM=noreply@yourapp.com
```

### Usage

```typescript
// In server functions or API routes
import { createEmail } from '@shogo-ai/sdk/email/server'

// Auto-configured from environment variables
const email = createEmail()

// Send a templated email (built-in templates: welcome, password-reset, invitation, notification)
await email.sendTemplate({
  to: 'user@example.com',
  template: 'welcome',
  data: { name: 'Alice', appName: 'MyApp' },
})

// Send a raw email
await email.send({
  to: 'user@example.com',
  subject: 'Hello!',
  html: '<h1>Hello World</h1>',
})

// Register custom templates
email.registerTemplate({
  name: 'order-confirmation',
  subject: 'Order #{{orderId}} Confirmed',
  html: '<h1>Thanks for your order, {{name}}!</h1><p>Order: {{orderId}}</p>',
})

await email.sendTemplate({
  to: 'customer@example.com',
  template: 'order-confirmation',
  data: { name: 'Bob', orderId: '12345' },
})
```

### Built-in Templates

| Template | Variables |
|----------|-----------|
| `welcome` | `name`, `appName`, `loginUrl?` |
| `password-reset` | `name?`, `appName`, `resetUrl`, `expiresIn?` |
| `invitation` | `inviterName`, `resourceName`, `role?`, `acceptUrl`, `appName` |
| `notification` | `title`, `message`, `actionUrl?`, `actionText?`, `appName` |

### Explicit Configuration

```typescript
// SMTP with explicit config
const email = createEmail({
  config: {
    provider: 'smtp',
    defaultFrom: 'noreply@myapp.com',
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      user: 'username',
      password: 'password',
    },
  },
})

// AWS SES with explicit config
const email = createEmail({
  config: {
    provider: 'ses',
    defaultFrom: 'noreply@myapp.com',
    ses: {
      region: 'us-east-1',
      // credentials optional if using IAM role
    },
  },
})
```

### Optional Email (Graceful Degradation)

```typescript
import { createEmailOptional } from '@shogo-ai/sdk/email/server'

const email = createEmailOptional()

if (email) {
  await email.sendTemplate({ ... })
} else {
  console.log('Email not configured, skipping')
}
```

## Examples

See the [examples](./examples) directory for complete working examples:

- [todo-app](./examples/todo-app) - Full-featured todo application with auth and CRUD

## License

Apache-2.0
