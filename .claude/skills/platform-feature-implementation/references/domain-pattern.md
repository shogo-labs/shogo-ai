# Domain Pattern Reference

The golden path for implementing domain logic in Shogo. This pattern ensures all domain entities flow through the schematic pipeline (ArkType → MST) rather than being hand-coded.

## Core Principle

**Schema defines structure. Enhancements add behavior.**

- ArkType scope defines entity shapes and relationships
- `domain()` generates MST models, collections, and root store with **auto-included persistence methods**
- Enhancement hooks add computed views, queries, and domain actions

## File Structure

### Domain Archetype (Internal Feature)

For features where all data is local — no external API calls:

```
packages/state-api/src/{feature}/
├── domain.ts     # ArkType scope + domain() definition ← THE KEY FILE
├── index.ts      # Barrel exports
└── __tests__/
    └── domain.test.ts  # Domain logic tests
```

**No `types.ts`, `mock.ts`, or `{provider}.ts`** — these are for Service archetype only.

### Service/Hybrid Archetype (External API)

For features that integrate with external services:

```
packages/state-api/src/{feature}/
├── types.ts      # IService interface + domain types
├── mock.ts       # Mock service for TDD
├── {provider}.ts # Real service implementation (e.g., supabase.ts)
├── domain.ts     # ArkType scope + domain() definition ← THE KEY FILE
├── index.ts      # Barrel exports
└── __tests__/
    ├── mock.test.ts   # Service interface tests
    └── domain.test.ts # Domain logic tests
```

---

## domain.ts Template

```typescript
import { scope } from 'arktype'
import { domain } from '@shogo/state-api'

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================
// Define entities declaratively. References use the entity name directly.
// The system detects references by checking if the type name exists in the scope.
// MST handles ID↔instance translation automatically.

export const InventoryDomain = scope({
  Product: {
    id: 'string.uuid',        // Use string.uuid for identifiers
    sku: 'string',
    name: 'string',
    priceInCents: 'number',
    category: 'Category',      // Reference - just the entity name
    'isActive?': 'boolean',    // Optional with property syntax
    createdAt: 'number',
  },

  Category: {
    id: 'string.uuid',
    name: 'string',
    'parentId?': 'Category',   // Optional self-reference
    'products?': 'Product[]',  // Computed inverse (auto-detected)
  },

  StockLevel: {
    id: 'string.uuid',
    product: 'Product',        // Required reference
    warehouse: 'Warehouse',    // Required reference
    quantity: 'number',
    reorderPoint: 'number',
    lastUpdated: 'number',
  },

  Warehouse: {
    id: 'string.uuid',
    name: 'string',
    location: 'string',
    'stockLevels?': 'StockLevel[]',  // Computed inverse
  },
})

// ============================================================
// 2. DOMAIN RESULT
// ============================================================
// CRITICAL: name MUST match the schema name from design skill
// This ensures persistence loads from correct schema tables in the SQL backend

export const inventoryDomain = domain({
  name: 'inventory',  // Must match schema name exactly
  from: InventoryDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,
      Product: models.Product.views((self: any) => ({
        get displayPrice(): string {
          return `$${(self.priceInCents / 100).toFixed(2)}`
        },
        get isInStock(): boolean {
          // Access inverse relationship
          return (self.stockLevels || []).some((s: any) => s.quantity > 0)
        },
      })),
      StockLevel: models.StockLevel.views((self: any) => ({
        get needsReorder(): boolean {
          return self.quantity <= self.reorderPoint
        },
        get status(): 'ok' | 'low' | 'out' {
          if (self.quantity === 0) return 'out'
          if (self.quantity <= self.reorderPoint) return 'low'
          return 'ok'
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods
    // NOTE: Persistence methods (insertOne, updateOne, deleteOne, query) are auto-included
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,
      ProductCollection: collections.ProductCollection.views((self: any) => ({
        get active() {
          return self.all().filter((p: any) => p.isActive !== false)
        },
        findBySku(sku: string) {
          return self.all().find((p: any) => p.sku === sku)
        },
        findByCategory(categoryId: string) {
          return self.all().filter((p: any) => p.category?.id === categoryId)
        },
      })),
      StockLevelCollection: collections.StockLevelCollection.views((self: any) => ({
        findByProduct(productId: string) {
          return self.all().filter((s: any) => s.product?.id === productId)
        },
        findByWarehouse(warehouseId: string) {
          return self.all().filter((s: any) => s.warehouse?.id === warehouseId)
        },
        get lowStock() {
          return self.all().filter((s: any) => s.needsReorder)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions and coordination
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel
        .views((self: any) => ({
          get totalInventoryValue(): number {
            let total = 0
            for (const product of self.productCollection.all()) {
              const levels = self.stockLevelCollection.findByProduct(product.id)
              const totalQty = levels.reduce((sum: number, l: any) => sum + l.quantity, 0)
              total += product.priceInCents * totalQty
            }
            return total
          },
        }))
        .actions((self: any) => ({
          // CRUD using auto-included persistence methods
          async createProduct(data: { sku: string; name: string; priceInCents: number; categoryId?: string }) {
            // insertOne creates and persists to SQL backend
            const product = await self.productCollection.insertOne({
              id: crypto.randomUUID(),
              ...data,
              category: data.categoryId,
              createdAt: Date.now(),
            })
            return product
          },

          async updateProduct(id: string, changes: Partial<{ name: string; priceInCents: number }>) {
            await self.productCollection.updateOne(id, changes)
            return self.productCollection.get(id)
          },

          async deleteProduct(id: string) {
            await self.productCollection.deleteOne(id)
          },
        })),
  },
  // Persistence methods (insertOne, updateOne, deleteOne, query) auto-included by default
})

// ============================================================
// 3. EXPORTS (index.ts)
// ============================================================
// Export from index.ts:
// export { InventoryDomain, inventoryDomain } from './domain'
```

---

## Enhancement Hook Levels

| Hook | Purpose | What to Add | Examples |
|------|---------|-------------|----------|
| `models` | Entity-level computed properties | Views that derive from entity fields | `displayPrice`, `isExpired`, `fullName`, `status` |
| `collections` | Collection-level queries | Views for querying entities | `findBySku()`, `active`, `findByCategory()`, `lowStock` |
| `rootStore` | Domain-level coordination | Actions that span collections | `createProduct()`, `adjustStock()`, aggregate views |

---

## Translating Design Schema to ArkType

The design phase creates Enhanced JSON Schema. Translate to ArkType:

| Enhanced JSON Schema | ArkType |
|---------------------|---------|
| `"type": "string"` | `'string'` |
| `"type": "number"` | `'number'` |
| `"type": "boolean"` | `'boolean'` |
| `"x-mst-type": "identifier"` | `id: 'string.uuid'` (first field, validates UUID) |
| `"x-reference-type": "single"` | `product: 'Product'` (entity name only) |
| `"x-reference-type": "array"` | `tags: 'Tag[]'` (entity name with `[]`) |
| `"x-reference-target": "EntityName"` | Not used in ArkType (DDL generation only) |
| `"default": value` | `'type = value'` (e.g., `'boolean = true'`) |
| `"x-computed": true` | Include the array - system auto-detects computed inverses |

**Reference syntax key insight**: The system detects references by checking if the type name exists as another entity in the scope. You don't use `.id` suffix - just the entity name. MST handles ID↔instance translation automatically at runtime.

**DDL Note**: The `x-reference-target` extension in Enhanced JSON Schema is used by `ddl.execute` to generate foreign key constraints. It's not needed in ArkType since ArkType handles MST reference resolution, not SQL schema generation.

### Identifier Format

Use `string.uuid` for entity identifiers:

```typescript
// ✅ CORRECT: Use string.uuid for identifiers
export const MyDomain = scope({
  User: {
    id: 'string.uuid',  // Validates UUID format
    name: 'string',
  },
  Order: {
    id: 'string.uuid',
    customer: 'User',  // Reference resolves correctly
  }
})
```

### Optional Field Syntax

ArkType uses property-level optionality — the `?` goes on the property name, NOT the type:

```typescript
// ✅ CORRECT: Question mark on property name (quoted)
export const UserDomain = scope({
  User: {
    id: 'string.uuid',
    email: 'string',
    "displayName?": 'string',   // Optional property
    "manager?": 'User',         // Optional reference
  }
})

// ❌ INCORRECT: This will FAIL validation
export const UserDomain = scope({
  User: {
    displayName: 'string?',     // WRONG - not valid ArkType syntax
  }
})
```

---

## Anti-Patterns

| ❌ Wrong | ✅ Right |
|----------|----------|
| `types.model('Product', { id: types.identifier, ... })` | `scope({ Product: { id: 'string.uuid', ... } })` |
| `createStoreFromScope(Scope, { ... })` | `domain({ name, from: Scope, enhancements: { ... } })` |
| Creating `mixin.ts` or `hooks.ts` files | Put all enhancements in single `domain()` call |
| Manual persistence composition | Rely on auto-included persistence methods |
| `saveOne()`, `saveAll()`, `loadAll()` | Use `insertOne()`, `updateOne()`, `deleteOne()`, `query()` |
| `export function createXStore()` | `export const xDomain = domain({ ... })` |
| Custom context per domain | Use shared `DomainProvider` + `useDomains()` |

---

## Testing the Domain

Unit tests use in-memory backend for fast, isolated testing. The backend registry resolves to `MemoryQueryExecutor` when configured with `backend: "memory"`.

```typescript
// __tests__/domain.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { inventoryDomain } from '../domain'
import { NullPersistence, createBackendRegistry, resetMetaStore, clearRuntimeStores } from '@shogo/state-api'

describe('InventoryDomain', () => {
  let store: any

  beforeEach(() => {
    // Reset state between tests
    resetMetaStore()
    clearRuntimeStores()

    const env = {
      services: {
        persistence: new NullPersistence(),
        backendRegistry: createBackendRegistry({ default: 'memory' }),
      },
      context: {
        schemaName: 'test-inventory',
      },
    }
    store = inventoryDomain.createStore(env)
  })

  test('createProduct adds to collection and returns product', async () => {
    const product = await store.createProduct({
      sku: 'SKU-001',
      name: 'Widget',
      priceInCents: 999,
    })

    expect(product.id).toBeDefined()
    expect(product.sku).toBe('SKU-001')
    expect(store.productCollection.findBySku('SKU-001')).toBe(product)
  })

  test('displayPrice formats cents to dollars', async () => {
    const product = await store.createProduct({
      sku: 'SKU-001',
      name: 'Widget',
      priceInCents: 1999,
    })

    expect(product.displayPrice).toBe('$19.99')
  })

  test('reference resolution works', async () => {
    // Use insertOne for creating entities with persistence
    const category = await store.categoryCollection.insertOne({
      id: crypto.randomUUID(),
      name: 'Electronics',
    })

    const product = await store.productCollection.insertOne({
      id: crypto.randomUUID(),
      sku: 'SKU-001',
      name: 'Widget',
      priceInCents: 999,
      category: category.id,  // Pass ID
      createdAt: Date.now(),
    })

    // CRITICAL: Instance equality proves MST reference works
    expect(product.category).toBe(category)
    expect(product.category?.name).toBe('Electronics')
  })
})
```

---

## React Integration

Use the shared `DomainProvider` — **do not create custom context per domain**.

### 1. Add domain to DomainProvider

```tsx
// App.tsx
import { DomainProvider } from './contexts/DomainProvider'
import { inventoryDomain } from '@shogo/state-api'

const domains = {
  inventory: inventoryDomain,  // Add here
} as const

<EnvironmentProvider env={env}>
  <DomainProvider domains={domains}>
    <Routes>...</Routes>
  </DomainProvider>
</EnvironmentProvider>
```

### 2. Use in components

```tsx
// pages/InventoryDemoPage.tsx
import { observer } from 'mobx-react-lite'
import { useDomains } from '../contexts/DomainProvider'

export const InventoryDemoPage = observer(function InventoryDemoPage() {
  const { inventory } = useDomains()

  // Collections already loaded by DomainProvider
  const products = inventory.productCollection.active
  const lowStock = inventory.stockLevelCollection.lowStock

  const handleCreate = async () => {
    await inventory.createProduct({ sku: 'NEW-001', name: 'New Product', priceInCents: 1000 })
  }

  return (
    <div>
      <h1>Products ({products.length})</h1>
      <ul>
        {products.map(p => (
          <li key={p.id}>{p.name} - {p.displayPrice}</li>
        ))}
      </ul>
      <button onClick={handleCreate}>Add Product</button>

      <h2>Low Stock ({lowStock.length})</h2>
      <ul>
        {lowStock.map(s => (
          <li key={s.id}>{s.product?.name}: {s.quantity}</li>
        ))}
      </ul>
    </div>
  )
})
```

### Key Points

- **No custom context** — just add to DomainProvider domains map
- **No manual loading** — DomainProvider initializes stores on mount
- **SQL backend for demos** — proves full persistence pipeline works (postgres/sqlite)
- **observer() required** — for MobX reactivity

---

## Service/Hybrid Archetype (External API Integration)

For features that call external APIs, add service access via environment:

```typescript
import { getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'

export const paymentDomain = domain({
  name: 'payment',
  from: PaymentDomain,
  enhancements: {
    rootStore: (RootModel) => RootModel
      .actions((self: any) => ({
        async initialize() {
          const env = getEnv<IEnvironment>(self)
          const service = env.services.payment
          if (!service) return { success: true }

          const transactions = await service.fetchTransactions()
          for (const t of transactions) {
            self.transactionCollection.add(t)
          }
          return { success: true }
        },

        async processPayment(amount: number, method: string) {
          const env = getEnv<IEnvironment>(self)
          const result = await env.services.payment.charge({ amount, method })

          // Sync result to local state via insertOne
          const transaction = await self.transactionCollection.insertOne({
            id: result.id,
            amount: result.amount,
            status: result.status,
            processedAt: Date.now(),
          })

          return transaction
        },
      })),
  },
})
```

**Key principle**: External service is source of truth. MST is reactive cache for UI.
