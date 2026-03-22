# Expense Tracker - Shogo SDK Example

A personal finance tracker demonstrating the **@shogo-ai/sdk** with Prisma pass-through.

## Key Concept: Prisma Pass-Through

The SDK's `db` property is your Prisma client:

```typescript
import { createClient } from '@shogo-ai/sdk'
import { prisma } from './db'

const shogo = createClient({
  apiUrl: 'http://localhost:3001',
  db: prisma,
})

// shogo.db IS your Prisma client - same API, zero overhead
const transactions = await shogo.db.transaction.findMany({
  where: { userId, type: 'expense' },
  include: { category: true },
  orderBy: { date: 'desc' }
})
```

## Features

- User creation via `shogo.db.user.create()`
- Transaction CRUD via `shogo.db.transaction.*`
- Categories via `shogo.db.category.*`
- Aggregations via `shogo.db.transaction.aggregate()` and `groupBy()`
- Monthly trends and spending summaries

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

4. Open [http://localhost:3001](http://localhost:3001)

## Project Structure

```
expense-tracker/
├── prisma/
│   └── schema.prisma      # User, Category, Transaction models
├── src/
│   ├── lib/
│   │   └── shogo.ts       # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx     # Root layout
│   │   └── index.tsx      # Main dashboard
│   └── utils/
│       ├── db.ts          # Prisma client
│       ├── user.ts        # User operations via shogo.db
│       ├── categories.ts  # Category operations via shogo.db
│       ├── transactions.ts # Transaction operations via shogo.db
│       └── summary.ts     # Aggregations via shogo.db
├── package.json
└── vite.config.ts
```

## SDK Usage Examples

### Transactions

```typescript
// List transactions with relations
const transactions = await shogo.db.transaction.findMany({
  where: { userId, type: 'expense' },
  include: { category: true },
  orderBy: { date: 'desc' }
})

// Create transaction
const tx = await shogo.db.transaction.create({
  data: { amount: 50, type: 'expense', categoryId, userId }
})
```

### Aggregations

```typescript
// Total by type
const total = await shogo.db.transaction.aggregate({
  where: { userId, type: 'expense' },
  _sum: { amount: true }
})

// Group by category
const byCategory = await shogo.db.transaction.groupBy({
  by: ['categoryId'],
  where: { userId, type: 'expense' },
  _sum: { amount: true }
})
```

### Categories

```typescript
// List categories
const categories = await shogo.db.category.findMany({
  where: { userId },
  orderBy: { name: 'asc' }
})

// Create category
const cat = await shogo.db.category.create({
  data: { name: 'Groceries', icon: '🛒', color: '#22C55E', type: 'expense', userId }
})
```

## Why Prisma Pass-Through?

1. **Full Prisma power** - Relations, aggregations, transactions all work
2. **Type safety** - Complete TypeScript support from Prisma
3. **No abstraction overhead** - Direct access to Prisma client
4. **Unified SDK** - One client for auth, db, and more
