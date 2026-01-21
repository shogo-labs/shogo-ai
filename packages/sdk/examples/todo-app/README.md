# Todo App - Shogo SDK Example

A todo application demonstrating the **@shogo-ai/sdk** with Prisma pass-through.

## Key Concept: Prisma Pass-Through

The SDK's `db` property is a direct reference to your Prisma client:

```typescript
import { createClient } from '@shogo-ai/sdk'
import { prisma } from './db'

const shogo = createClient({
  apiUrl: 'http://localhost:3000',
  db: prisma,  // Your Prisma client becomes shogo.db
})

// shogo.db IS your Prisma client - same API, zero overhead
const user = await shogo.db.user.create({
  data: { email: 'user@example.com', name: 'Alice' }
})

const todos = await shogo.db.todo.findMany({
  where: { userId: user.id },
  orderBy: { createdAt: 'desc' }
})
```

## Features

- User creation via `shogo.db.user.create()`
- Todo CRUD via `shogo.db.todo.*`
- Full Prisma API available through SDK

## Getting Started

1. Install dependencies:
   ```bash
   bun install
   ```

2. Set up the database:
   ```bash
   bun run db:push
   ```

3. Start the development server:
   ```bash
   bun run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
todo-app/
├── prisma/
│   └── schema.prisma    # User & Todo models
├── src/
│   ├── lib/
│   │   ├── db.ts        # Prisma client
│   │   └── shogo.ts     # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx   # Root layout
│   │   └── index.tsx    # Todo app
│   └── utils/
│       ├── user.ts      # User operations via shogo.db
│       └── todos.ts     # Todo operations via shogo.db
├── package.json
└── vite.config.ts
```

## SDK Usage Examples

### User Operations

```typescript
// Create user
const user = await shogo.db.user.create({
  data: { email, name }
})

// Find user
const user = await shogo.db.user.findFirst({
  orderBy: { createdAt: 'asc' }
})
```

### Todo Operations

```typescript
// List todos
const todos = await shogo.db.todo.findMany({
  where: { userId },
  orderBy: { createdAt: 'desc' }
})

// Create todo
const todo = await shogo.db.todo.create({
  data: { title, userId }
})

// Update todo
await shogo.db.todo.update({
  where: { id },
  data: { completed: true }
})

// Delete todo
await shogo.db.todo.delete({
  where: { id }
})
```

## Why Prisma Pass-Through?

1. **Zero learning curve** - If you know Prisma, you know `shogo.db`
2. **Full type safety** - All Prisma types work automatically
3. **No abstraction overhead** - It's literally your Prisma client
4. **Unified SDK** - Access auth, db, and other features from one client
