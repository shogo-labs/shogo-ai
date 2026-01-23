# CRM - Shogo SDK Example

A Customer Relationship Management application demonstrating the **@shogo-ai/sdk** with Prisma pass-through for complex data models.

## Key Concept: Prisma Pass-Through

The SDK's `db` property is your Prisma client:

```typescript
import { createClient } from '@shogo-ai/sdk'
import { prisma } from './db'

const shogo = createClient({
  apiUrl: 'http://localhost:3002',
  db: prisma,
})

// shogo.db IS your Prisma client - full power, zero overhead
const contacts = await shogo.db.contact.findMany({
  where: { userId, status: 'lead' },
  include: {
    company: true,
    tags: { include: { tag: true } },
    _count: { select: { notes: true, deals: true } }
  },
  orderBy: { updatedAt: 'desc' }
})
```

## Features

This example showcases advanced Prisma patterns via `shogo.db`:

- **Many-to-many relations**: Contacts with Tags via junction table
- **Complex filtering**: Multi-field search, status filtering, tag filtering
- **Nested includes**: Company, tags, counts in single query
- **Aggregations**: Pipeline summaries via `groupBy()`
- **Activity logging**: Notes with contact updates

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

4. Open [http://localhost:3002](http://localhost:3002)

## Project Structure

```
crm/
├── prisma/
│   └── schema.prisma      # User, Contact, Company, Tag, Note, Deal models
├── src/
│   ├── lib/
│   │   └── shogo.ts       # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx     # Root layout
│   │   └── index.tsx      # CRM dashboard
│   └── utils/
│       ├── db.ts          # Prisma client
│       ├── user.ts        # User operations via shogo.db
│       ├── contacts.ts    # Contact CRUD via shogo.db
│       ├── companies.ts   # Company CRUD via shogo.db
│       ├── tags.ts        # Tag + many-to-many via shogo.db
│       ├── notes.ts       # Activity log via shogo.db
│       └── deals.ts       # Pipeline management via shogo.db
├── package.json
└── vite.config.ts
```

## SDK Usage Examples

### Many-to-Many Relations

```typescript
// Add tag to contact (junction table)
await shogo.db.contactTag.create({
  data: { contactId, tagId }
})

// Get contacts with tags
const contacts = await shogo.db.contact.findMany({
  include: {
    tags: { include: { tag: true } }
  }
})
```

### Complex Filtering

```typescript
// Multi-field search with relations
const contacts = await shogo.db.contact.findMany({
  where: {
    userId,
    OR: [
      { firstName: { contains: search } },
      { email: { contains: search } },
      { company: { name: { contains: search } } }
    ],
    status: 'lead',
    tags: { some: { tagId: hotLeadTagId } }
  }
})
```

### Aggregations

```typescript
// Pipeline summary
const pipeline = await shogo.db.deal.groupBy({
  by: ['stage'],
  where: { userId },
  _count: true,
  _sum: { value: true }
})

// Contact stats by status
const stats = await shogo.db.contact.groupBy({
  by: ['status'],
  where: { userId },
  _count: true
})
```

### Nested Counts

```typescript
// Include related counts
const contacts = await shogo.db.contact.findMany({
  include: {
    _count: {
      select: { notes: true, deals: true }
    }
  }
})
```

## Why Prisma Pass-Through?

1. **Full Prisma power** - Relations, transactions, aggregations all work
2. **Complex queries** - Nested includes, OR conditions, junction tables
3. **Type safety** - Complete TypeScript support from Prisma schema
4. **No abstraction overhead** - Direct Prisma client access
5. **Unified SDK** - One client for auth, db, and more
