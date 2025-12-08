# Pattern 3: Enhancement Hooks

> Add domain-specific views and actions to auto-generated MST models.

## Concept

The schematic pipeline auto-generates MST models from schema definitions. Enhancement hooks let you add domain-specific behaviors without modifying the generated code:

1. **enhanceModels**: Add views/actions to individual entity models
2. **enhanceCollections**: Add query methods or mixins to collection models
3. **enhanceRootStore**: Add store-level views and actions

Each hook supports the **full MST composition API**: views, actions, volatile state, and `types.compose()` for mixin composition.

---

## When to Apply

Apply this pattern when:

- [ ] Generated models need computed properties (derived from fields)
- [ ] Collections need custom query methods
- [ ] Root store needs domain actions that orchestrate multiple collections
- [ ] Business logic spans entities or requires service access
- [ ] Service integration requires initialization and cleanup lifecycle
- [ ] Provider data needs to sync into MST state

Do NOT apply when:

- Simple CRUD with no business logic
- All needed functionality is auto-generated

---

## Full MST Composition at Each Level

Each enhancement hook supports the complete MST composition API:

### enhanceModels (Entity Level)

| Composition | Purpose | Example |
|-------------|---------|---------|
| `.views(self => ({}))` | Computed properties | `displayPrice`, `isInStock`, `stockStatus` |
| `.actions(self => ({}))` | Entity mutations | `adjustInventory()`, `updateStatus()` |
| `.volatile(self => ({}))` | Non-persisted state | `isExpanded`, `localDraft` |
| `types.compose(Model, Mixin)` | Mixin composition | Add validation or audit behaviors |

### enhanceCollections (Collection Level)

| Composition | Purpose | Example |
|-------------|---------|---------|
| `.views(self => ({}))` | Query methods, aggregations | `findBySku()`, `inStock`, `totalValue` |
| `.actions(self => ({}))` | Batch operations | `importBatch()`, `clearAll()` |
| `types.compose(Collection, CollectionPersistable)` | Add persistence | File-based persistence mixin |
| `types.compose(Collection, CustomMixin)` | Add behaviors | Auditing, caching mixins |

### enhanceRootStore (Store Level)

| Composition | Purpose | Example |
|-------------|---------|---------|
| `.views(self => ({}))` | Cross-collection queries | `activeOrderCount`, `totalInventoryValue` |
| `.actions(self => ({}))` | Domain operations | `createOrder()`, `processPayment()` |
| Internal sync | Provider synchronization | `_syncFromProvider()`, `initialize()` |
| Subscriptions | Realtime updates | `setup{Domain}Subscription()` returning cleanup |

---

## Structure

### Hook Execution Order

```
Schema Definition (ArkType Scope)
        ↓
createStoreFromScope(scope, options)
        ↓
┌───────────────────────────────────┐
│ 1. enhanceModels(models)          │  ← Add views to entities
│    Returns: modified models dict  │
└───────────────────────────────────┘
        ↓
┌───────────────────────────────────┐
│ 2. enhanceCollections(collections)│  ← Add methods, compose mixins
│    Returns: modified collections  │
└───────────────────────────────────┘
        ↓
┌───────────────────────────────────┐
│ 3. enhanceRootStore(RootModel)    │  ← Add domain actions, top views
│    Returns: enhanced root model   │
└───────────────────────────────────┘
        ↓
{ models, collectionModels, RootStoreModel, createStore }
```

### Component Breakdown

#### 1. enhanceModels

**Purpose**: Add computed views to entity models.

**Receives**: Dictionary of entity models `{ EntityName: IAnyModelType }`

**Returns**: Modified dictionary (same keys, enhanced models)

```typescript
enhanceModels: (baseModels) => ({
  Product: baseModels.Product.views(self => ({
    // Computed from existing fields
    get displayPrice() {
      return `$${(self.priceInCents / 100).toFixed(2)}`
    },

    get isOnSale() {
      return self.salePrice !== null && self.salePrice < self.price
    },

    get stockStatus() {
      if (self.inventory === 0) return 'out-of-stock'
      if (self.inventory < 10) return 'low-stock'
      return 'in-stock'
    }
  })),

  // Pass through unchanged models
  Category: baseModels.Category,
  Variant: baseModels.Variant
})
```

#### 2. enhanceCollections

**Purpose**: Add query methods or compose with mixins.

**Receives**: Dictionary of collection models `{ EntityCollection: IAnyModelType }`

**Returns**: Modified dictionary

```typescript
enhanceCollections: (baseCollections) => ({
  ProductCollection: baseCollections.ProductCollection.views(self => ({
    // Query helpers
    findByCategory(categoryId: string) {
      return self.all().filter(p => p.category === categoryId)
    },

    get inStock() {
      return self.all().filter(p => p.inventory > 0)
    },

    get onSale() {
      return self.all().filter(p => p.isOnSale)
    },

    searchByName(query: string) {
      const lower = query.toLowerCase()
      return self.all().filter(p =>
        p.name.toLowerCase().includes(lower)
      )
    }
  })),

  // Compose with persistence mixin
  OrderCollection: types.compose(
    baseCollections.OrderCollection,
    CollectionPersistable
  ).named('OrderCollection')
})
```

#### 3. enhanceRootStore

**Purpose**: Add store-level views and domain actions.

**Receives**: Root store model

**Returns**: Enhanced root store model

```typescript
enhanceRootStore: (RootModel) => RootModel
  .views(self => ({
    // Aggregate views across collections
    get totalInventoryValue() {
      return self.productCollection.all().reduce(
        (sum, p) => sum + (p.price * p.inventory), 0
      )
    },

    get activeOrderCount() {
      return self.orderCollection.all()
        .filter(o => o.status !== 'completed').length
    }
  }))
  .actions(self => ({
    // Domain actions that coordinate
    async createOrder(items: OrderItem[]) {
      // 1. Validate inventory
      for (const item of items) {
        const product = self.productCollection.get(item.productId)
        if (!product || product.inventory < item.quantity) {
          throw new Error(`Insufficient inventory: ${item.productId}`)
        }
      }

      // 2. Create order
      const order = self.orderCollection.add({
        id: generateId(),
        items,
        status: 'pending',
        createdAt: Date.now()
      })

      // 3. Reserve inventory
      for (const item of items) {
        const product = self.productCollection.get(item.productId)
        product.setInventory(product.inventory - item.quantity)
      }

      return order
    },

    // Action using environment service
    async processPayment(orderId: string, paymentDetails: PaymentDetails) {
      const env = getEnv<IPaymentEnvironment>(self)
      const order = self.orderCollection.get(orderId)

      const result = await env.services.payment.charge({
        amount: order.total,
        ...paymentDetails
      })

      if (result.error) {
        order.setStatus('payment-failed')
        return { success: false, error: result.error }
      }

      order.setStatus('paid')
      order.setPaymentId(result.transactionId)
      return { success: true }
    }
  }))
```

---

## Anti-Patterns

### ❌ Modifying Models Instead of Returning New

```typescript
// BAD: Mutating input
enhanceModels: (baseModels) => {
  baseModels.Product = baseModels.Product.views(...)  // Mutation!
  return baseModels
}

// GOOD: Return new object
enhanceModels: (baseModels) => ({
  ...baseModels,
  Product: baseModels.Product.views(...)
})
```

### ❌ Forgetting to Return All Models

```typescript
// BAD: Lost other models
enhanceModels: (baseModels) => ({
  Product: baseModels.Product.views(...)
  // Category, Variant are now undefined!
})

// GOOD: Include all models
enhanceModels: (baseModels) => ({
  Product: baseModels.Product.views(...),
  Category: baseModels.Category,
  Variant: baseModels.Variant
})
```

### ❌ Side Effects in Views

```typescript
// BAD: View with side effect
.views(self => ({
  get currentPrice() {
    self.lastAccessed = Date.now()  // Side effect!
    return self.price
  }
}))
```

### ❌ Direct Service Import in Actions

```typescript
// BAD: Direct import instead of environment
import { stripeClient } from '@stripe/stripe-js'

.actions(self => ({
  async charge() {
    await stripeClient.charges.create(...)  // Not using DI
  }
}))
```

---

## CollectionPersistable Mixin

For collections that need file-based persistence, compose with `CollectionPersistable`:

```typescript
import { types } from 'mobx-state-tree'
import { CollectionPersistable } from '@shogo/state-api'

enhanceCollections: (baseCollections) => ({
  ProductCollection: types.compose(
    baseCollections.ProductCollection,
    CollectionPersistable
  ).named('ProductCollection'),

  // Non-persistable collections pass through unchanged
  TempItemCollection: baseCollections.TempItemCollection
})
```

**What CollectionPersistable provides:**

| Member | Type | Description |
|--------|------|-------------|
| `loadAll()` | action | Load entire collection from persistence service |
| `loadById(id)` | action | Load single entity by ID and add to collection |
| `saveAll()` | action | Save entire collection to persistence |
| `saveOne(id)` | action | Save single entity by ID |
| `persistenceContext` | view | Derives `{ schemaName, modelName, location }` from environment |

**Requirements for collections to use CollectionPersistable:**
- Must have `items` map property
- Must have `modelName` view (auto-generated collections have this)
- Must have `add(item)` action
- Environment must provide `persistence` service and `schemaName` context

---

## Environment Access Pattern

Actions that need services use `getEnv<T>(self)` for dependency injection:

```typescript
import { getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '@shogo/state-api'

enhanceRootStore: (RootModel) => RootModel
  .actions(self => ({
    async initialize() {
      const env = getEnv<IEnvironment>(self)
      // Access persistence service
      await self.productCollection.loadAll()
      return { success: true }
    }
  }))
```

**Environment interface (from state-api):**
```typescript
export interface IEnvironment {
  services: {
    persistence: IPersistenceService
    // Domain-specific services added via extension
  }
  context: {
    schemaName: string    // Stable string reference to schema
    location?: string     // Optional workspace/location for isolation
  }
}
```

**Extending environment for domain services:**
```typescript
// types.ts
import type { IEnvironment } from '@shogo/state-api'

export interface IInventoryEnvironment extends IEnvironment {
  services: IEnvironment['services'] & {
    inventory: IInventoryService
  }
}
```

---

## Initialization Pattern

Store initialization using CollectionPersistable:

```typescript
enhanceRootStore: (RootModel) => RootModel
  .actions(self => ({
    async initialize(): Promise<{ success: boolean; error?: { message: string } }> {
      try {
        // Load all persistable collections
        await self.productCollection.loadAll()
        await self.warehouseCollection.loadAll()
        return { success: true }
      } catch (err) {
        return { success: false, error: { message: String(err) } }
      }
    }
  }))
```

---

## Worked Example: Inventory Domain

Complete example showing entity collections with all enhancement hooks.

### Schema (Entity Collections)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "Product": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "sku": { "type": "string" },
        "name": { "type": "string" },
        "priceInCents": { "type": "integer" },
        "quantity": { "type": "integer" },
        "warehouseId": { "type": "string", "x-mst-type": "reference" }
      },
      "required": ["id", "sku", "name", "priceInCents", "quantity"]
    },
    "Warehouse": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "name": { "type": "string" },
        "location": { "type": "string" }
      },
      "required": ["id", "name", "location"]
    },
    "StockMovement": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "productId": { "type": "string", "x-mst-type": "reference" },
        "type": { "type": "string", "enum": ["in", "out", "adjustment"] },
        "quantity": { "type": "integer" },
        "timestamp": { "type": "number" }
      },
      "required": ["id", "productId", "type", "quantity", "timestamp"]
    }
  }
}
```

### Enhancement Hooks Specification

```yaml
enhanceModels:
  Product:
    views:
      - displayPrice      # Formats priceInCents as "$X.XX"
      - isInStock         # quantity > 0
      - stockStatus       # "in-stock" | "low-stock" | "out-of-stock"
    actions:
      - adjustQuantity(delta: number)
    volatile:
      - isSelected        # UI state, not persisted

  StockMovement:
    views:
      - isInbound         # type === "in"
      - displayType       # Human-readable type

enhanceCollections:
  ProductCollection:
    views:
      - findBySku(sku: string)
      - inStock           # All products with quantity > 0
      - lowStock          # Products with quantity < threshold
      - byWarehouse(warehouseId: string)
    compose:
      - CollectionPersistable

  StockMovementCollection:
    views:
      - forProduct(productId: string)
      - recent(hours: number)
    compose:
      - CollectionPersistable

enhanceRootStore:
  views:
    - totalInventoryValue   # Sum of all product values
    - lowStockCount         # Count of low-stock products
  actions:
    - initialize()          # Load all collections
    - recordMovement(productId, type, quantity)
```

### Implementation

```typescript
// packages/state-api/src/inventory/domain.ts

import { types, getEnv } from 'mobx-state-tree'
import { enhancedJsonSchemaToMST, CollectionPersistable } from '@shogo/state-api'
import type { IEnvironment } from '@shogo/state-api'

export function createInventoryStore(schema: any) {
  return enhancedJsonSchemaToMST(schema, {
    enhanceModels: (baseModels) => ({
      Product: baseModels.Product
        .views(self => ({
          get displayPrice() {
            return `$${(self.priceInCents / 100).toFixed(2)}`
          },
          get isInStock() {
            return self.quantity > 0
          },
          get stockStatus() {
            if (self.quantity === 0) return 'out-of-stock'
            if (self.quantity < 10) return 'low-stock'
            return 'in-stock'
          }
        }))
        .actions(self => ({
          adjustQuantity(delta: number) {
            self.quantity = Math.max(0, self.quantity + delta)
          }
        }))
        .volatile(() => ({
          isSelected: false
        })),

      Warehouse: baseModels.Warehouse,

      StockMovement: baseModels.StockMovement.views(self => ({
        get isInbound() { return self.type === 'in' },
        get displayType() {
          const labels = { in: 'Stock In', out: 'Stock Out', adjustment: 'Adjustment' }
          return labels[self.type]
        }
      }))
    }),

    enhanceCollections: (baseCollections) => ({
      ProductCollection: types.compose(
        baseCollections.ProductCollection.views(self => ({
          findBySku(sku: string) {
            return self.all().find(p => p.sku === sku)
          },
          get inStock() {
            return self.all().filter(p => p.isInStock)
          },
          get lowStock() {
            return self.all().filter(p => p.stockStatus === 'low-stock')
          },
          byWarehouse(warehouseId: string) {
            return self.all().filter(p => p.warehouseId === warehouseId)
          }
        })),
        CollectionPersistable
      ).named('ProductCollection'),

      WarehouseCollection: types.compose(
        baseCollections.WarehouseCollection,
        CollectionPersistable
      ).named('WarehouseCollection'),

      StockMovementCollection: types.compose(
        baseCollections.StockMovementCollection.views(self => ({
          forProduct(productId: string) {
            return self.all().filter(m => m.productId === productId)
          },
          recent(hours: number) {
            const cutoff = Date.now() - hours * 60 * 60 * 1000
            return self.all().filter(m => m.timestamp >= cutoff)
          }
        })),
        CollectionPersistable
      ).named('StockMovementCollection')
    }),

    enhanceRootStore: (RootModel) => RootModel
      .views(self => ({
        get totalInventoryValue() {
          return self.productCollection.all().reduce(
            (sum, p) => sum + (p.priceInCents * p.quantity), 0
          )
        },
        get lowStockCount() {
          return self.productCollection.lowStock.length
        }
      }))
      .actions(self => ({
        async initialize() {
          try {
            await self.productCollection.loadAll()
            await self.warehouseCollection.loadAll()
            await self.stockMovementCollection.loadAll()
            return { success: true }
          } catch (err) {
            return { success: false, error: { message: String(err) } }
          }
        },

        recordMovement(productId: string, type: 'in' | 'out' | 'adjustment', quantity: number) {
          const product = self.productCollection.get(productId)
          if (!product) throw new Error(`Product not found: ${productId}`)

          // Record movement
          self.stockMovementCollection.add({
            id: crypto.randomUUID(),
            productId,
            type,
            quantity,
            timestamp: Date.now()
          })

          // Adjust inventory
          const delta = type === 'in' ? quantity : -quantity
          product.adjustQuantity(delta)
        }
      }))
  })
}
```

---

## Checklist

Before considering this pattern complete:

- [ ] enhanceModels returns all models (enhanced or pass-through)
- [ ] Views are pure (no side effects)
- [ ] Actions use `getEnv<T>()` for service access
- [ ] Complex views are layered for clarity
- [ ] Internal actions are prefixed with underscore
- [ ] createDomainStore exports the factory function
- [ ] Collections needing persistence use `CollectionPersistable` mixin
- [ ] `initialize()` returns `{ success, error? }` structure
- [ ] Persistable collections call `loadAll()` in initialize
