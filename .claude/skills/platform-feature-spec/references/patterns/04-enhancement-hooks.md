# Pattern 4: Enhancement Hooks (Domain Store)

> Add domain-specific views and actions to auto-generated MST models via the `domain()` compositional API.

## Concept

The schematic pipeline auto-generates MST models from schema definitions. The `domain()` function provides enhancement hooks to add domain-specific behaviors without modifying generated code:

1. **enhancements.models**: Add views/actions to individual entity models
2. **enhancements.collections**: Add query methods to collection models
3. **enhancements.rootStore**: Add store-level views and actions

Each hook supports the **full MST composition API**: views, actions, volatile state, and `types.compose()` for mixin composition.

**CRITICAL**: All hooks are defined inline in a single `domain()` call in `domain.ts`. Never create separate `mixin.ts` or `hooks.ts` files.

**Key Benefits**:
- CollectionPersistable is **auto-composed** on all collections (unless `persistence: false`)
- Named domain export (`{domain}Domain`) integrates directly with `DomainProvider`
- No factory function boilerplate required

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

## Task Structure for Spec Skill

When creating tasks for domain stores, use a **single task** that covers all enhancement hooks:

```javascript
store.create("ImplementationTask", "platform-features", {
  id: "task-domain-store",
  name: "domain-store",
  session: session.id,
  description: "Create {domain} domain store with domain() API",
  acceptanceCriteria: [
    // Schema Definition
    "domain.ts exports {Domain}Domain ArkType scope with all entity definitions",
    "All identifier fields use 'string.uuid' type",
    "Entity references use entity name directly (e.g., teamId: 'Team')",

    // Domain Result
    "domain.ts exports const {domain}Domain = domain({ name, from, enhancements })",
    "domain.name MUST match the schema name from design skill exactly",

    // Enhancement Hooks
    "enhancements.models adds computed views: {list from DesignDecision}",
    "enhancements.collections adds query methods: {list}",
    "enhancements.rootStore adds domain actions and views",

    // Persistence (auto-composed)
    "CollectionPersistable auto-composed (default behavior)"
  ],
  dependencies: [],  // Domain archetype has no service dependencies
  status: "planned",
  createdAt: Date.now()
})
```

**Never create separate tasks for**:
- ❌ "Create {Domain}Mixin" → would create mixin.ts
- ❌ "Create enhancement hooks" → would create hooks.ts
- ❌ "Create {Domain}Context" → DomainProvider handles this
- ❌ Multiple tasks for views/actions/initialization

---

## Full MST Composition at Each Level

Each enhancement hook supports the complete MST composition API:

### enhancements.models (Entity Level)

| Composition | Purpose | Example |
|-------------|---------|---------|
| `.views(self => ({}))` | Computed properties | `displayPrice`, `isInStock`, `stockStatus` |
| `.actions(self => ({}))` | Entity mutations | `adjustInventory()`, `updateStatus()` |
| `.volatile(self => ({}))` | Non-persisted state | `isExpanded`, `localDraft` |
| `types.compose(Model, Mixin)` | Mixin composition | Add validation or audit behaviors |

### enhancements.collections (Collection Level)

| Composition | Purpose | Example |
|-------------|---------|---------|
| `.views(self => ({}))` | Query methods, aggregations | `findBySku()`, `inStock`, `totalValue` |
| `.actions(self => ({}))` | Batch operations | `importBatch()`, `clearAll()` |

**Note**: CollectionPersistable is **auto-composed** by `domain()` — you don't need to manually compose it.

### enhancements.rootStore (Store Level)

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
domain({ name, from, enhancements })
        ↓
┌───────────────────────────────────┐
│ 1. enhancements.models(models)    │  ← Add views to entities
│    Returns: modified models dict  │
└───────────────────────────────────┘
        ↓
┌───────────────────────────────────┐
│ 2. Auto: CollectionPersistable    │  ← Persistence auto-composed
└───────────────────────────────────┘
        ↓
┌───────────────────────────────────┐
│ 3. enhancements.collections(cols) │  ← Add query methods
│    Returns: modified collections  │
└───────────────────────────────────┘
        ↓
┌───────────────────────────────────┐
│ 4. enhancements.rootStore(Root)   │  ← Add domain actions, views
│    Returns: enhanced root model   │
└───────────────────────────────────┘
        ↓
DomainResult { name, enhancedSchema, RootStoreModel, models, createStore, register }
```

### File Structure (Domain Archetype)

```
packages/state-api/src/{domain}/
├── domain.ts     # ArkType scope + domain() definition ← ALL ENHANCEMENTS HERE
├── index.ts      # Barrel exports
└── __tests__/
    └── domain.test.ts  # Domain logic tests
```

**Note**: No `types.ts`, `mock.ts`, or `{provider}.ts` — these are for Service archetype only.

---

## Component Breakdown

### 1. enhancements.models

**Purpose**: Add computed views to entity models.

**Receives**: Dictionary of entity models `{ EntityName: IAnyModelType }`

**Returns**: Modified dictionary (same keys, enhanced models)

```typescript
enhancements: {
  models: (models) => ({
    ...models,
    Product: models.Product.views((self: any) => ({
      get displayPrice() {
        return `$${(self.priceInCents / 100).toFixed(2)}`
      },
      get stockStatus() {
        if (self.quantity === 0) return 'out-of-stock'
        if (self.quantity < 10) return 'low-stock'
        return 'in-stock'
      }
    })),
  }),
}
```

### 2. enhancements.collections

**Purpose**: Add query methods (persistence is auto-composed).

**Receives**: Dictionary of collection models `{ EntityCollection: IAnyModelType }`

**Returns**: Modified dictionary

```typescript
enhancements: {
  collections: (collections) => ({
    ...collections,
    ProductCollection: collections.ProductCollection.views((self: any) => ({
      findBySku(sku: string) {
        return self.all().find((p: any) => p.sku === sku)
      },
      get inStock() {
        return self.all().filter((p: any) => p.quantity > 0)
      },
    })),
  }),
}
```

### 3. enhancements.rootStore

**Purpose**: Add store-level views and domain actions.

**Receives**: Root store model

**Returns**: Enhanced root store model

```typescript
enhancements: {
  rootStore: (RootModel) => RootModel
    .views((self: any) => ({
      get totalInventoryValue() {
        return self.productCollection.all().reduce(
          (sum: number, p: any) => sum + (p.priceInCents * p.quantity), 0
        )
      },
    }))
    .actions((self: any) => ({
      async createProduct(data: { name: string; sku: string; priceInCents: number }) {
        const product = self.productCollection.create({
          id: crypto.randomUUID(),
          ...data,
        })
        await self.productCollection.saveOne(product.id)
        return product
      },
    })),
}
```

---

## Complete domain.ts Example

```typescript
import { scope } from "arktype"
import { domain } from "@shogo/state-api"

// 1. ArkType Scope
export const InventoryDomain = scope({
  Product: {
    id: "string.uuid",
    name: "string",
    sku: "string",
    priceInCents: "number",
    quantity: "number",
    category: "Category",  // Reference uses entity name
  },
  Category: {
    id: "string.uuid",
    name: "string",
    "parentId?": "Category",  // Optional self-reference
    "products?": "Product[]", // Computed inverse (auto-detected)
  },
})

// 2. Domain Result
// CRITICAL: name MUST match schema name from design skill (.schemas/{name}/schema.json)
export const inventoryDomain = domain({
  name: "inventory",  // Must match schema name exactly
  from: InventoryDomain,
  enhancements: {
    models: (models) => ({
      ...models,
      Product: models.Product.views((self: any) => ({
        get displayPrice() {
          return `$${(self.priceInCents / 100).toFixed(2)}`
        },
        get stockStatus() {
          if (self.quantity === 0) return 'out-of-stock'
          if (self.quantity < 10) return 'low-stock'
          return 'in-stock'
        },
      })),
    }),
    collections: (collections) => ({
      ...collections,
      ProductCollection: collections.ProductCollection.views((self: any) => ({
        findBySku(sku: string) {
          return self.all().find((p: any) => p.sku === sku)
        },
        findByCategory(categoryId: string) {
          return self.all().filter((p: any) => p.category?.id === categoryId)
        },
        get inStock() {
          return self.all().filter((p: any) => p.quantity > 0)
        },
      })),
    }),
    rootStore: (RootModel) => RootModel
      .views((self: any) => ({
        get totalInventoryValue() {
          return self.productCollection.all().reduce(
            (sum: number, p: any) => sum + (p.priceInCents * p.quantity), 0
          )
        },
      }))
      .actions((self: any) => ({
        async createProduct(data: { name: string; sku: string; priceInCents: number; quantity: number; categoryId?: string }) {
          const product = self.productCollection.create({
            id: crypto.randomUUID(),
            ...data,
            category: data.categoryId,
          })
          await self.productCollection.saveOne(product.id)
          return product
        },
        async deleteProduct(id: string) {
          self.productCollection.remove(id)
          await self.productCollection.saveAll()
        },
      })),
  },
  // CollectionPersistable auto-composed by default
})
```

---

## Anti-Patterns

### ❌ Creating Separate Files

```
# BAD: Splits domain logic across files
mixin.ts      # Hand-coded MST models
hooks.ts      # Standalone enhancement hooks

# GOOD: Single domain() call
domain.ts     # ArkType scope + domain() with inline enhancements
```

### ❌ Forgetting to Spread Other Models

```typescript
// BAD: Lost other models
models: (models) => ({
  Product: models.Product.views(...)
  // Category is now undefined!
})

// GOOD: Include all models
models: (models) => ({
  ...models,
  Product: models.Product.views(...),
})
```

### ❌ Manual CollectionPersistable Composition

```typescript
// BAD: Manual persistence composition
collections: (collections) => ({
  ...collections,
  ProductCollection: types.compose(
    collections.ProductCollection,
    CollectionPersistable  // Unnecessary - auto-composed!
  )
})

// GOOD: Just add query methods - persistence is automatic
collections: (collections) => ({
  ...collections,
  ProductCollection: collections.ProductCollection.views((self: any) => ({
    findBySku(sku: string) { ... }
  })),
})
```

### ❌ Using Old createStoreFromScope Pattern

```typescript
// BAD: Old pattern
export function createInventoryStore() {
  return createStoreFromScope(InventoryDomain, { ... })
}

// GOOD: New domain() pattern
export const inventoryDomain = domain({
  name: "inventory",
  from: InventoryDomain,
  enhancements: { ... }
})
```

### ❌ Creating Custom Context/Provider

```typescript
// BAD: Custom context per domain
export const InventoryContext = createContext<Store | null>(null)
export function InventoryProvider({ children }) { ... }
export function useInventory() { ... }

// GOOD: Use DomainProvider + useDomains()
// In App.tsx:
<DomainProvider domains={{ inventory: inventoryDomain }}>
// In components:
const { inventory } = useDomains()
```

---

## Environment Access Pattern

For Service/Hybrid archetypes that need external services, use `getEnv<T>(self)`:

```typescript
import { getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'

enhancements: {
  rootStore: (RootModel) => RootModel
    .actions((self: any) => ({
      async initialize() {
        const env = getEnv<IEnvironment>(self)
        const service = env.services.inventory
        if (!service) return { success: true }

        const products = await service.fetchProducts()
        for (const p of products) {
          self.productCollection.add(p)
        }
        return { success: true }
      },
    })),
}
```

**Environment structure**: `{ services: { persistence, inventory, ... }, context: { schemaName, ... } }`

---

## Checklist

Before considering this pattern complete:

- [ ] Single domain.ts file with ArkType scope and domain() call
- [ ] domain.name matches schema name from design skill exactly
- [ ] enhancements.models returns all models (spread + enhanced)
- [ ] Views are pure (no side effects)
- [ ] CollectionPersistable is auto-composed (don't manually add)
- [ ] Named domain export (`{domain}Domain`) for DomainProvider integration
- [ ] No separate mixin.ts, hooks.ts, or context files

---

## Domain Archetype (No Service Layer)

For **internal domain features** where all data is local, the file structure is simpler:

### File Structure

```
packages/state-api/src/{domain}/
├── domain.ts     # ArkType scope + domain() definition
├── index.ts      # Barrel exports
└── __tests__/
    └── domain.test.ts  # Domain logic tests
```

**No `types.ts`, `mock.ts`, or `{provider}.ts`** — these are for Service archetype only.

### Actions Use Collection Persistence Directly

For internal features, root store actions use `CollectionPersistable` methods (auto-composed):

```typescript
rootStore: (RootModel) => RootModel
  .actions((self: any) => ({
    async createWorkspace(name: string) {
      const workspace = self.workspaceCollection.create({
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now()
      })
      // Persist via auto-composed CollectionPersistable
      await self.workspaceCollection.saveOne(workspace.id)
      return workspace
    },

    async loadAllWorkspaces() {
      await self.workspaceCollection.loadAll()
    },

    async deleteWorkspace(id: string) {
      self.workspaceCollection.remove(id)
      await self.workspaceCollection.saveAll()
    }
  }))
```

### Task Structure for Domain Archetype

```javascript
store.create("ImplementationTask", "platform-features", {
  id: "task-domain-store",
  name: "domain-store",
  session: session.id,
  description: "Create {domain} domain store with domain() API",
  acceptanceCriteria: [
    "domain.ts exports {Domain}Domain ArkType scope",
    "domain.ts exports const {domain}Domain = domain({ name, from, enhancements })",
    "domain.name MUST match schema name from design skill",
    "enhancements.models adds computed views: {list}",
    "enhancements.collections adds query methods (persistence auto-composed)",
    "enhancements.rootStore adds CRUD actions using collection persistence methods",
    "NO IService interface - pure domain store"
  ],
  dependencies: [],  // No service-interface or environment dependencies
  status: "planned",
  createdAt: Date.now()
})
```
