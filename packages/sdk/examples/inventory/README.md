# Inventory Management - Shogo SDK Example

A stock management system demonstrating the **@shogo-ai/sdk** with Prisma pass-through.

## Key Concept: Prisma Pass-Through

The SDK's `db` property is your Prisma client:

```typescript
import { createClient } from '@shogo-ai/sdk'
import { prisma } from './db'

const shogo = createClient({
  apiUrl: 'http://localhost:3004',
  db: prisma,
})

// shogo.db IS your Prisma client - same API, zero overhead
const products = await shogo.db.product.findMany({
  where: { userId, quantity: { lt: minQuantity } },
  include: { category: true, supplier: true },
  orderBy: { quantity: 'asc' }
})
```

## Features

- Product management via `shogo.db.product.*`
- Stock tracking via `shogo.db.stockMovement.*`
- Category organization via `shogo.db.category.*`
- Supplier management via `shogo.db.supplier.*`
- Aggregations via `shogo.db.product.groupBy()`
- Low stock alerts and inventory value calculations

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

4. Open [http://localhost:3004](http://localhost:3004)

## Project Structure

```
inventory/
├── prisma/
│   └── schema.prisma      # User, Product, Category, Supplier, StockMovement models
├── src/
│   ├── lib/
│   │   └── shogo.ts       # SDK client setup
│   ├── routes/
│   │   ├── __root.tsx     # Root layout
│   │   └── index.tsx      # Main inventory dashboard
│   └── utils/
│       ├── db.ts          # Prisma client
│       ├── user.ts        # User operations via shogo.db
│       ├── categories.ts  # Category operations via shogo.db
│       ├── suppliers.ts   # Supplier operations via shogo.db
│       ├── products.ts    # Product operations via shogo.db
│       ├── stock.ts       # Stock movement operations via shogo.db
│       └── summary.ts     # Aggregations via shogo.db
├── package.json
└── vite.config.ts
```

## SDK Usage Examples

### Products

```typescript
// List products with relations
const products = await shogo.db.product.findMany({
  where: { userId, categoryId },
  include: { category: true, supplier: true },
  orderBy: { name: 'asc' }
})

// Create product
const product = await shogo.db.product.create({
  data: { 
    name: 'Widget', 
    sku: 'WDG-001',
    price: 29.99,
    cost: 15.00,
    quantity: 100,
    minQuantity: 10,
    categoryId, 
    userId 
  }
})

// Find low stock products
const lowStock = await shogo.db.product.findMany({
  where: {
    userId,
    quantity: { lt: shogo.db.raw('min_quantity') }
  }
})
```

### Stock Movements

```typescript
// Add stock
const movement = await shogo.db.stockMovement.create({
  data: {
    type: 'in',
    quantity: 50,
    reason: 'Restocked from supplier',
    productId,
    userId
  }
})

// Update product quantity
await shogo.db.product.update({
  where: { id: productId },
  data: { quantity: { increment: 50 } }
})

// Get movement history
const history = await shogo.db.stockMovement.findMany({
  where: { productId },
  orderBy: { createdAt: 'desc' },
  take: 20
})
```

### Aggregations

```typescript
// Products by category
const byCategory = await shogo.db.product.groupBy({
  by: ['categoryId'],
  where: { userId },
  _count: { id: true },
  _sum: { quantity: true }
})

// Calculate inventory value
const products = await shogo.db.product.findMany({
  where: { userId }
})
const totalValue = products.reduce(
  (sum, p) => sum + p.price * p.quantity, 
  0
)
```

### Categories

```typescript
// List categories with product counts
const categories = await shogo.db.category.findMany({
  where: { userId },
  include: {
    _count: { select: { products: true } }
  },
  orderBy: { name: 'asc' }
})

// Create category
const cat = await shogo.db.category.create({
  data: { 
    name: 'Electronics', 
    icon: '💻', 
    color: '#3B82F6', 
    userId 
  }
})
```

### Suppliers

```typescript
// List suppliers
const suppliers = await shogo.db.supplier.findMany({
  where: { userId },
  include: {
    _count: { select: { products: true } }
  }
})

// Create supplier
const supplier = await shogo.db.supplier.create({
  data: {
    name: 'Acme Corp',
    email: 'orders@acme.com',
    phone: '555-0100',
    userId
  }
})
```

## Complements Expense Tracker

This inventory example complements the [expense-tracker](../expense-tracker/) example:

| Expense Tracker | Inventory |
|----------------|-----------|
| Tracks money flow | Tracks product flow |
| Income/Expense transactions | Stock in/out movements |
| Financial categories | Product categories |
| Budget tracking | Min stock levels |
| Spending summaries | Inventory value summaries |

Both examples demonstrate the same SDK patterns:
- Prisma pass-through for full database access
- Server functions with Hono
- Relations and aggregations
- User-scoped data

## Why Prisma Pass-Through?

1. **Full Prisma power** - Relations, aggregations, transactions all work
2. **Type safety** - Complete TypeScript support from Prisma
3. **No abstraction overhead** - Direct access to Prisma client
4. **Unified SDK** - One client for auth, db, and more
