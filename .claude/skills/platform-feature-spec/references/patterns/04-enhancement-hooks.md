# Pattern 4: Enhancement Hooks (Domain Store)

> Add domain-specific views and actions to auto-generated MST models via a single domain.ts file.

## Concept

The schematic pipeline auto-generates MST models from schema definitions. Enhancement hooks let you add domain-specific behaviors without modifying the generated code:

1. **enhanceModels**: Add views/actions to individual entity models
2. **enhanceCollections**: Add query methods or mixins to collection models
3. **enhanceRootStore**: Add store-level views and actions

Each hook supports the **full MST composition API**: views, actions, volatile state, and `types.compose()` for mixin composition.

**CRITICAL**: All hooks belong in a single `domain.ts` file using `createStoreFromScope()`. Never create separate `mixin.ts` or `hooks.ts` files.

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
  description: "Create {domain} domain store with enhancement hooks",
  acceptanceCriteria: [
    "domain.ts exports {Domain}Domain ArkType scope",
    "domain.ts exports create{Domain}Store() factory using createStoreFromScope",
    "enhanceModels adds computed views: {list}",
    "enhanceCollections adds query methods: {list}",
    "enhanceRootStore adds initialize() and domain actions",
    "Store integrates with I{Domain}Service via getEnv()"
  ],
  dependencies: ["task-service-interface", "task-environment-extension"],
  status: "planned",
  createdAt: Date.now()
})
```

**Never create separate tasks for**:
- ❌ "Create {Domain}Mixin" → would create mixin.ts
- ❌ "Create enhancement hooks" → would create hooks.ts
- ❌ Multiple tasks for views/actions/initialization

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

### File Structure

```
packages/state-api/src/{domain}/
├── types.ts      # IService interface + domain types
├── mock.ts       # Mock service for TDD
├── {provider}.ts # Real service implementation
├── domain.ts     # ArkType scope + createStore factory ← ALL HOOKS HERE
├── index.ts      # Barrel exports
└── __tests__/
    ├── mock.test.ts   # Service tests
    └── store.test.ts  # Domain logic tests
```

---

## Component Breakdown

### 1. enhanceModels

**Purpose**: Add computed views to entity models.

**Receives**: Dictionary of entity models `{ EntityName: IAnyModelType }`

**Returns**: Modified dictionary (same keys, enhanced models)

```typescript
enhanceModels: (baseModels) => ({
  ...baseModels,
  Product: baseModels.Product.views((self: any) => ({
    get displayPrice() {
      return `$${(self.priceInCents / 100).toFixed(2)}`
    },
    get stockStatus() {
      if (self.quantity === 0) return 'out-of-stock'
      if (self.quantity < 10) return 'low-stock'
      return 'in-stock'
    }
  })),
})
```

### 2. enhanceCollections

**Purpose**: Add query methods or compose with mixins.

**Receives**: Dictionary of collection models `{ EntityCollection: IAnyModelType }`

**Returns**: Modified dictionary

```typescript
enhanceCollections: (baseCollections) => ({
  ...baseCollections,
  ProductCollection: baseCollections.ProductCollection.views((self: any) => ({
    findBySku(sku: string) {
      return self.all().find((p: any) => p.sku === sku)
    },
    get inStock() {
      return self.all().filter((p: any) => p.quantity > 0)
    },
  })),
})
```

### 3. enhanceRootStore

**Purpose**: Add store-level views and domain actions.

**Receives**: Root store model

**Returns**: Enhanced root store model

```typescript
enhanceRootStore: (RootModel) => RootModel
  .views((self: any) => ({
    get totalInventoryValue() {
      return self.productCollection.all().reduce(
        (sum: number, p: any) => sum + (p.priceInCents * p.quantity), 0
      )
    },
  }))
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
  }))
```

---

## Anti-Patterns

### ❌ Creating Separate Files

```
# BAD: Splits domain logic across files
mixin.ts      # Hand-coded MST models
hooks.ts      # Standalone enhancement hooks

# GOOD: Single cohesive file
domain.ts     # ArkType scope + createStoreFromScope with all hooks
```

### ❌ Forgetting to Spread Other Models

```typescript
// BAD: Lost other models
enhanceModels: (baseModels) => ({
  Product: baseModels.Product.views(...)
  // Category, Variant are now undefined!
})

// GOOD: Include all models
enhanceModels: (baseModels) => ({
  ...baseModels,
  Product: baseModels.Product.views(...),
})
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

// GOOD: Use environment injection
.actions((self: any) => ({
  async charge() {
    const env = getEnv<IEnvironment>(self)
    await env.services.payment.charge(...)
  }
}))
```

---

## Environment Access Pattern

Actions that need services use `getEnv<T>(self)` for dependency injection:

```typescript
import { getEnv } from 'mobx-state-tree'
import type { IEnvironment } from '../environment/types'

enhanceRootStore: (RootModel) => RootModel
  .actions((self: any) => ({
    async initialize() {
      const env = getEnv<IEnvironment>(self)
      const service = env.services.inventory
      // Use service...
    }
  }))
```

**Environment structure**: `{ services: { persistence, inventory, ... }, context: { schemaName, ... } }`

---

## Checklist

Before considering this pattern complete:

- [ ] Single domain.ts file with ArkType scope and createStoreFromScope
- [ ] enhanceModels returns all models (spread + enhanced)
- [ ] Views are pure (no side effects)
- [ ] Actions use `getEnv<T>()` for service access
- [ ] create{Domain}Store exports the factory function
- [ ] `initialize()` returns `{ success, error? }` structure
- [ ] No separate mixin.ts or hooks.ts files
