# Pattern 3: Enhancement Hooks

> Add domain-specific views and actions to auto-generated MST models.

## Concept

The schematic pipeline auto-generates MST models from schema definitions. Enhancement hooks let you add domain-specific behaviors without modifying the generated code:

1. **enhanceModels**: Add views/actions to individual entity models
2. **enhanceCollections**: Add query methods or mixins to collection models
3. **enhanceRootStore**: Add store-level views and actions

---

## When to Apply

Apply this pattern when:

- [ ] Generated models need computed properties (derived from fields)
- [ ] Collections need custom query methods
- [ ] Root store needs domain actions that orchestrate multiple collections
- [ ] Business logic spans entities or requires service access

Do NOT apply when:

- Simple CRUD with no business logic
- All needed functionality is auto-generated

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

## Checklist

Before considering this pattern complete:

- [ ] enhanceModels returns all models (enhanced or pass-through)
- [ ] Views are pure (no side effects)
- [ ] Actions use `getEnv<T>()` for service access
- [ ] Complex views are layered for clarity
- [ ] Internal actions are prefixed with underscore
- [ ] createDomainStore exports the factory function
