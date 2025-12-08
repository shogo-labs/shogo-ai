# State-API Architectural Pattern Inventory

> Comprehensive catalog of patterns for teaching platform-feature skills to generate idiomatic Shogo/Wavesmith code.

## Context

This inventory was developed by analyzing:
1. Golden path Supabase auth implementation (branch: `feat/platform-feature-skills-supbase-eval-case-testing-golden-path-reference`)
2. Existing platform-feature skill tree structure
3. State-api schematic pipeline and enhancement hooks
4. Non-auth feature examples (CMS, discovery sessions, implementation specs)
5. Gap analysis across all 5 skill phases

---

## Pattern Tiers

### Tier 1: Core Patterns (Essential for any feature)

| # | Pattern | Problem Solved | When to Apply |
|---|---------|----------------|---------------|
| 1 | **Service Interface** | Abstract external providers for testability | Feature touches external systems (DB, API, auth provider) |
| 2 | **Environment Extension** | Inject services into MST stores | Feature needs pluggable backends |
| 3 | **Enhancement Hooks** | Add domain logic to auto-generated models | Feature has business rules beyond CRUD |
| 4 | **Mock Service Testing** | TDD without network dependencies | Always (every service needs a mock) |

### Tier 2: Relationship Patterns (Schema modeling)

| # | Pattern | Problem Solved | When to Apply |
|---|---------|----------------|---------------|
| 5 | **Computed/Inverse Relationships** | Bi-directional navigation without duplication | 1:N or N:M where you need to traverse both directions |
| 6 | **Many-to-Many with Junction** | Rich M2M relationships with metadata | M2M needs timestamps, ordering, or extra fields |
| 7 | **Hierarchical/Self-Reference** | Tree structures (categories, org charts) | Parent-child with unlimited depth |
| 8 | **Cross-Schema References** | Link entities across schema boundaries | Multi-domain systems with bounded contexts |
| 9 | **Embedded Value Objects** | Complex fields without separate identity | Address, Money, PhoneNumber - no independent lifecycle |

### Tier 3: Behavioral Patterns (Runtime concerns)

| # | Pattern | Problem Solved | When to Apply |
|---|---------|----------------|---------------|
| 10 | **Provider Synchronization** | Sync external state into MST reactively | Auth, real-time data, external events |
| 11 | **Async Workflow State** | Track status, errors, retries for long operations | Import jobs, sync operations, background tasks |
| 12 | **Collection Persistence** | Lazy loading, selective saving | Large datasets, pagination, performance |
| 13 | **Multi-Domain Composition** | Namespace isolation for bounded contexts | E-commerce (auth + inventory + orders), SaaS |

### Tier 4: Integration Patterns (Wiring it together)

| # | Pattern | Problem Solved | When to Apply |
|---|---------|----------------|---------------|
| 14 | **React Context Integration** | Lifecycle management for MST in React | Any feature with UI |
| 15 | **Mixin Composition** | Add reusable behaviors to collections | Persistence, caching, auditing across collections |
| 16 | **View System (Query + Template)** | Expose filtered data for reports/exports | Business intelligence, code generation, projections |

### Tier 5: Advanced Patterns (Complex domains)

| # | Pattern | Problem Solved | When to Apply |
|---|---------|----------------|---------------|
| 17 | **Discriminated Unions** | Polymorphic entities with type-specific fields | Payment methods, content blocks, activity types |
| 18 | **Constraint Validation** | Field/entity-level business rules | Forms, API validation, data integrity |
| 19 | **Meta-Store Introspection** | Runtime schema discovery | Schema builders, dynamic forms, tooling |

---

## Decision Frameworks

### Framework 1: Feature Archetype Classification

```
What kind of feature is this?

┌─ Does it add new domain entities?
│  ├─ Yes → DOMAIN FEATURE (Patterns: 3, 5-9, 11)
│  └─ No  → Does it add infrastructure capability?
│           ├─ Yes → INFRASTRUCTURE FEATURE (Patterns: 1-2, 12, 15)
│           └─ No  → SERVICE FEATURE (Patterns: 1-2, 4, 10)
```

### Framework 2: Service vs Domain Model Decision

| Question | Yes → Service | No → Domain Model |
|----------|---------------|-------------------|
| Multiple implementations? (Supabase vs Firebase) | ✓ | |
| External dependencies? (HTTP, crypto, filesystem) | ✓ | |
| Needs mocking for tests? | ✓ | |
| Shared across entities? | ✓ | |
| Pure data transformation? | | ✓ |

### Framework 3: Relationship Type Selection

| Scenario | Pattern |
|----------|---------|
| Entity A owns Entity B (B has no meaning without A) | One-to-many, B references A |
| A and B are independent but linked | Reference + computed inverse |
| A↔B needs metadata (timestamps, ordering) | Junction entity (Pattern 6) |
| A references B in different schema | String ID, not MST reference (Pattern 8) |
| Complex nested data, no independent lifecycle | Embedded value object (Pattern 9) |

### Framework 4: Async State Modeling

```
Does operation complete synchronously?
├─ Yes → Simple status enum (active/inactive)
└─ No  → Full workflow state:
         - status: pending | processing | completed | failed
         - errorMessage?: string
         - errorLog?: Error[]
         - retryCount?: number
         - progress?: { total, processed }
```

---

## Pattern Details by Tier

### Tier 1 Details

#### Pattern 1: Service Interface

**Components**:
- Interface definition (pure types, no runtime imports)
- Domain types (not provider types)
- Production implementation (wraps real client)
- Mock implementation (in-memory for testing)
- Mapping helpers (provider → domain conversion)

**Key Rule**: Interface file has NO runtime imports. Enables optional dependencies and isomorphic code.

**Reference**: `IPersistenceService` in state-api, `IAuthService` in golden path

#### Pattern 2: Environment Extension

**Components**:
- Extension interface (`IAuthEnvironment extends IEnvironment`)
- Service slot in `services` object
- Access pattern via `getEnv<T>(self)`
- Creation pattern at store instantiation

**Key Rule**: Services can be optional (`auth?: IAuthService`) since not all stores need all services.

#### Pattern 3: Enhancement Hooks

**Three hooks in order**:
1. `enhanceModels` - Add views to entities (isVerified, isExpired)
2. `enhanceCollections` - Add query methods, compose mixins (findByEmail)
3. `enhanceRootStore` - Add domain actions (login, logout, initialize)

**Key Rule**: Hooks receive models AFTER schema transformation, return modified models.

**Reference**: `createMetaStore()` in meta-store.ts, `createAuthStore()` in golden path

#### Pattern 4: Mock Service Testing

**Components**:
- Full interface implementation (not stubs)
- In-memory storage (Map)
- Configurable (pre-seed data, simulate errors)
- Test setup with NullPersistence + mock service

**Key Rule**: Mock implements FULL interface to catch contract violations.

---

### Tier 2 Details

#### Pattern 5: Computed/Inverse Relationships

**Schema markers**:
- `x-computed: true` - Field is derived, not stored
- `x-inverse: "fieldName"` - Which field to traverse

**Example**:
```
User.company (persisted) ←→ Company.employees (computed from User.company)
```

#### Pattern 6: Many-to-Many with Junction

**When needed**: M2M relationship needs metadata (assignedAt, priority, etc.)

**Structure**:
- Junction entity: `UserRole { user, role, assignedAt, assignedBy }`
- Computed arrays on both sides via inverse

#### Pattern 7: Hierarchical/Self-Reference

**Structure**:
- Optional self-reference: `parent?: Category`
- Computed children: `children: Category[]` (inverse of parent)

#### Pattern 8: Cross-Schema References

**Rule**: Store as string ID, not MST reference

**Why**: Avoids coupling between schemas, simpler than cross-schema MST references

#### Pattern 9: Embedded Value Objects

**Criteria**: No ID, no independent lifecycle, always accessed via parent

**Examples**: Address, Money, PhoneNumber

---

### Tier 3 Details

#### Pattern 10: Provider Synchronization

**Components**:
- `_syncFromProvider()` - Internal sync method
- `initialize()` - Restore session on startup
- `setupAuthSubscription()` - Real-time external events

**Key Rule**: Subscription returns unsubscribe function for cleanup.

#### Pattern 11: Async Workflow State

**Fields**:
- `status`: enum (pending, processing, completed, failed)
- `errorMessage?`: string
- `errorLog?`: array of errors
- `retryCount?`: number
- `progress?`: { total, processed }

#### Pattern 12: Collection Persistence

**Methods added by CollectionPersistable mixin**:
- `loadAll()` - Load entire collection
- `loadById(id)` - Load single entity
- `saveAll()` - Save entire collection
- `saveOne(id)` - Save single entity

#### Pattern 13: Multi-Domain Composition

**Input**: `createStoreFromScope({ auth: AuthDomain, inventory: InventoryDomain })`

**Result**: Namespaced collections (`store.auth.userCollection`, `store.inventory.productCollection`)

---

### Tier 4 Details

#### Pattern 14: React Context Integration

**Components**:
- Provider component with useRef (not useState) for store stability
- Initialize on mount, setup subscription with cleanup
- Custom hook (`useAuthStore()`)
- `observer()` wrapper for reactive components

#### Pattern 15: Mixin Composition

**Usage**: `types.compose(BaseCollection, CollectionPersistable).named('MyCollection')`

**Available mixins**: CollectionPersistable (others TBD: cacheable, auditable, versioned)

#### Pattern 16: View System

**Query views**: Filter + project from collections
**Template views**: Render query results through Nunjucks

---

### Tier 5 Details

#### Pattern 17: Discriminated Unions

**Use case**: Polymorphic entities (Payment = CreditCard | BankTransfer | Cash)

**Structure**: Common fields + discriminator + type-specific fields

#### Pattern 18: Constraint Validation

**Types**: minLength, maxLength, pattern, minimum, maximum, enum, const

**Preserved through**: JSON Schema → Enhanced JSON Schema → MST

#### Pattern 19: Meta-Store Introspection

**Use case**: Runtime schema discovery for tooling

**Structure**: Schema → Model → Property hierarchy with computed views
