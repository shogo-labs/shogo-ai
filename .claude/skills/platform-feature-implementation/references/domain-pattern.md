# Domain Pattern Reference

The golden path for implementing domain logic in Shogo. This pattern ensures all domain entities flow through the schematic pipeline (ArkType → MST) rather than being hand-coded.

## Core Principle

**Schema defines structure. Hooks add behavior.**

- ArkType scope defines entity shapes and relationships
- `createStoreFromScope()` generates MST models, collections, and root store
- Enhancement hooks add computed views, queries, and domain actions

## File Structure

```
packages/state-api/src/{feature}/
├── types.ts      # IService interface + domain types (for service layer)
├── mock.ts       # Mock service for TDD
├── {provider}.ts # Real service implementation (e.g., supabase.ts)
├── domain.ts     # ArkType scope + createStore factory ← THE KEY FILE
├── index.ts      # Barrel exports
└── __tests__/
    ├── mock.test.ts   # Service interface tests
    └── store.test.ts  # Domain logic tests (uses mock service)
```

## domain.ts Template

```typescript
import { scope } from 'arktype'
import { getEnv } from 'mobx-state-tree'
import { createStoreFromScope } from '../schematic'
import type { IEnvironment } from '../environment/types'

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================
// Define entities declaratively. References use the entity name directly.
// The system detects references by checking if the type name exists in the scope.
// MST handles ID↔instance translation automatically.

export const InventoryDomain = scope({
  Product: {
    id: 'string',
    sku: 'string',
    name: 'string',
    priceInCents: 'number',
    category: 'string',
    isActive: 'boolean = true',
    createdAt: 'number',
    stockLevels: 'StockLevel[]',   // Computed inverse (auto-detected)
  },

  StockLevel: {
    id: 'string',
    product: 'Product',            // Reference - just the entity name
    warehouse: 'Warehouse',        // Reference - just the entity name
    quantity: 'number',
    reorderPoint: 'number = 10',
    lastUpdated: 'number',
  },

  Warehouse: {
    id: 'string',
    name: 'string',
    location: 'string',
    stockLevels: 'StockLevel[]',   // Computed inverse (auto-detected)
  },
})

// ============================================================
// 2. STORE FACTORY OPTIONS
// ============================================================

export interface CreateInventoryStoreOptions {
  /** Environment with injected services */
  environment?: Partial<IEnvironment>
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

// ============================================================
// 3. STORE FACTORY WITH ENHANCEMENT HOOKS
// ============================================================

export function createInventoryStore(options: CreateInventoryStoreOptions = {}) {
  return createStoreFromScope(InventoryDomain, {
    validateReferences: options.validateReferences,

    // --------------------------------------------------------
    // enhanceModels: Add computed views to individual entities
    // Receives: Record<string, IAnyModelType> - all generated models
    // Returns: Same record with enhanced models
    // --------------------------------------------------------
    enhanceModels: (models) => ({
      ...models,
      Product: models.Product.views((self: any) => ({
        get displayPrice(): string {
          return `$${(self.priceInCents / 100).toFixed(2)}`
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
    // enhanceCollections: Add query methods to collections
    // Receives: Record<string, IAnyModelType> - all collection models
    // Returns: Same record with enhanced collections
    // --------------------------------------------------------
    enhanceCollections: (collections) => ({
      ...collections,
      ProductCollection: collections.ProductCollection.views((self: any) => ({
        get active() {
          return self.all().filter((p: any) => p.isActive)
        },
        findBySku(sku: string) {
          return self.all().find((p: any) => p.sku === sku)
        },
        forCategory(category: string) {
          return self.all().filter((p: any) => p.category === category)
        },
      })),
      StockLevelCollection: collections.StockLevelCollection.views((self: any) => ({
        forProduct(productId: string) {
          // s.product is the resolved entity instance, s.product.id gets the ID
          return self.all().filter((s: any) => s.product?.id === productId)
        },
        forWarehouse(warehouseId: string) {
          return self.all().filter((s: any) => s.warehouse?.id === warehouseId)
        },
        get lowStock() {
          return self.all().filter((s: any) => s.needsReorder)
        },
      })),
    }),

    // --------------------------------------------------------
    // enhanceRootStore: Add domain actions and coordination
    // Receives: IAnyModelType - the root store model
    // Returns: Enhanced model with views and actions
    // --------------------------------------------------------
    enhanceRootStore: (RootModel) =>
      RootModel
        .views((self: any) => ({
          // Aggregate views across collections
          get totalInventoryValue(): number {
            let total = 0
            for (const product of self.productCollection.all()) {
              const levels = self.stockLevelCollection.forProduct(product.id)
              const totalQty = levels.reduce((sum: number, l: any) => sum + l.quantity, 0)
              total += product.priceInCents * totalQty
            }
            return total
          },
        }))
        .actions((self: any) => ({
          // Initialize from external service
          async initialize() {
            const env = getEnv<IEnvironment>(self)
            const service = env.services.inventory
            if (!service) return

            const products = await service.fetchProducts()
            for (const p of products) {
              self.productCollection.add(p)
            }

            const levels = await service.fetchStockLevels()
            for (const l of levels) {
              self.stockLevelCollection.add(l)
            }
          },

          // Domain action: adjust stock with service call
          async adjustStock(productId: string, warehouseId: string, delta: number) {
            const env = getEnv<IEnvironment>(self)
            const result = await env.services.inventory.adjustStock(productId, warehouseId, delta)

            // Sync result to local state
            const existing = self.stockLevelCollection.forProduct(productId)
              .find((s: any) => s.warehouse?.id === warehouseId)

            if (existing) {
              existing.update({ quantity: result.newQuantity, lastUpdated: Date.now() })
            }
          },

          // Domain action: add new product
          async addProduct(data: { sku: string; name: string; priceInCents: number; category: string }) {
            const env = getEnv<IEnvironment>(self)
            const product = await env.services.inventory.createProduct(data)
            self.productCollection.add(product)
            return product
          },
        })),
  })
}
```

## Enhancement Hook Levels

| Hook | Purpose | What to Add | Examples |
|------|---------|-------------|----------|
| `enhanceModels` | Entity-level computed properties | Views that derive from entity fields | `displayPrice`, `isExpired`, `fullName`, `status` |
| `enhanceCollections` | Collection-level queries | Views/actions for querying entities | `findBySku()`, `active`, `forCategory()`, `lowStock` |
| `enhanceRootStore` | Domain-level coordination | Actions that span collections, initialize from services | `initialize()`, `adjustStock()`, aggregate views |

## Translating Design Schema to ArkType

The design phase creates Enhanced JSON Schema. Translate to ArkType:

| Enhanced JSON Schema | ArkType |
|---------------------|---------|
| `"type": "string"` | `'string'` |
| `"type": "number"` | `'number'` |
| `"type": "boolean"` | `'boolean'` |
| `"x-mst-type": "identifier"` | `id: 'string'` (first field) |
| `"x-reference-type": "single"` | `product: 'Product'` (entity name only) |
| `"x-reference-type": "array"` | `tags: 'Tag[]'` (entity name with `[]`) |
| `"default": value` | `'type = value'` (e.g., `'boolean = true'`) |
| `"x-computed": true` | Include the array - system auto-detects computed inverses |

**Reference syntax key insight**: The system detects references by checking if the type name exists as another entity in the scope. You don't use `.id` suffix - just the entity name. MST handles ID↔instance translation automatically at runtime.

### Identifier Format

Use `string.uuid` for entity identifiers to ensure proper MST reference resolution:

```typescript
// ✅ CORRECT: Use string.uuid for identifiers
export const MyDomain = scope({
  User: {
    id: 'string.uuid',  // Validates UUID format, works reliably with references
    name: 'string',
  },
  Order: {
    id: 'string.uuid',
    customer: 'User',  // Reference resolves correctly
  }
})

// ❌ AVOID: Plain string identifiers may cause reference issues
export const MyDomain = scope({
  User: {
    id: 'string',  // May cause reference resolution issues
    name: 'string',
  }
})
```

### Optional Field Syntax

ArkType uses property-level optionality—the `?` goes on the property name, NOT the type:

```typescript
// ✅ CORRECT: Question mark on property name
export const UserDomain = scope({
  User: {
    id: 'string.uuid',
    email: 'string',
    "displayName?": 'string',   // Optional property
    "avatarUrl?": 'string',     // Optional property
    "manager?": 'User',         // Optional reference
  }
})

// ❌ INCORRECT: This will FAIL validation
export const UserDomain = scope({
  User: {
    id: 'string.uuid',
    displayName: 'string?',     // WRONG - not valid ArkType syntax
  }
})
```

### Reference Field Naming

Both naming styles work—the reference detection matches the type value, not the field name:

```typescript
export const BusinessDomain = scope({
  User: { id: 'string.uuid', name: 'string' },
  Order: {
    id: 'string.uuid',
    customer: 'User',     // ✅ Field matches entity (recommended for clarity)
    createdBy: 'User',    // ✅ Field differs from entity (also works)
  },
  Company: { id: 'string.uuid', name: 'string' }
})
```

**CamelCase entities**: Multi-word entity names are handled correctly:
- `AuthUser` → collection: `authUserCollection`
- `ProductCategory` → collection: `productCategoryCollection`
- `OrderLineItem` → collection: `orderLineItemCollection`

## Service Integration Pattern

The domain store coordinates with external services via environment injection:

```typescript
// In domain actions, access service via getEnv
async initialize() {
  const env = getEnv<IEnvironment>(self)
  const service = env.services.inventory  // Nested under services
  if (!service) return  // Handle optional service gracefully

  const data = await service.fetchAll()
  // Sync to local MST state
  for (const item of data) {
    self.collection.add(item)
  }
}
```

**Environment structure**: `{ services: { inventory, persistence, ... }, context: { schemaName, ... } }`

**Key principle**: External service is source of truth. MST is reactive cache for UI.

## Anti-Patterns

| ❌ Wrong | ✅ Right |
|----------|----------|
| `types.model('Product', { id: types.identifier, ... })` | `scope({ Product: { id: 'string', ... } })` |
| Creating `mixin.ts` with hand-coded MST actions | Put actions in `enhanceRootStore` |
| Standalone `hooks.ts` applied to manual models | Pass hooks to `createStoreFromScope()` |
| Inline MST model definitions in React contexts | Import store factory from domain.ts |
| Defining computed views in schema | Add them via `enhanceModels` hook |

## Testing the Domain

```typescript
// __tests__/store.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { createInventoryStore } from '../domain'
import { MockInventoryService } from '../mock'
import { NullPersistence } from '../../persistence/null'
import type { IEnvironment } from '../../environment/types'

describe('InventoryStore', () => {
  let mockService: MockInventoryService
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    mockService = new MockInventoryService()

    env = {
      services: {
        persistence: new NullPersistence(),
        inventory: mockService,
      },
      context: {
        schemaName: 'test-inventory',
      },
    }

    const { createStore } = createInventoryStore()
    store = createStore(env)
  })

  test('initialize loads products from service', async () => {
    mockService.addProduct({ id: 'p1', sku: 'SKU-001', name: 'Widget', priceInCents: 999 })

    await store.initialize()

    expect(store.productCollection.findBySku('SKU-001')).toBeDefined()
  })

  test('displayPrice formats cents to dollars', async () => {
    mockService.addProduct({ id: 'p1', sku: 'SKU-001', name: 'Widget', priceInCents: 1999 })
    await store.initialize()

    const product = store.productCollection.findBySku('SKU-001')
    expect(product?.displayPrice).toBe('$19.99')
  })
})
```

## React Integration

```typescript
// contexts/InventoryContext.tsx
import { createContext, useContext, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { createInventoryStore } from '@shogo/state-api/inventory'
import { SupabaseInventoryService } from '@shogo/state-api/inventory/supabase'
import { NullPersistence } from '@shogo/state-api/persistence/null'

const InventoryContext = createContext<any>(null)

export const InventoryProvider = observer(({ children }: { children: React.ReactNode }) => {
  const storeRef = useRef<any>(null)

  if (!storeRef.current) {
    const env = {
      services: {
        persistence: new NullPersistence(),
        inventory: new SupabaseInventoryService(/* config */),
      },
      context: {
        schemaName: 'inventory',
      },
    }
    const { createStore } = createInventoryStore()
    storeRef.current = createStore(env)
  }

  useEffect(() => {
    storeRef.current?.initialize()
  }, [])

  return (
    <InventoryContext.Provider value={storeRef.current}>
      {children}
    </InventoryContext.Provider>
  )
})

export function useInventory() {
  const store = useContext(InventoryContext)
  if (!store) throw new Error('useInventory must be used within InventoryProvider')
  return store
}
```
