# Feature Classification Framework

> Decision framework for identifying feature archetypes and selecting applicable patterns.

## Purpose

Before diving into implementation, skills must classify what *kind* of feature is being requested. This determines which patterns apply and in what order.

---

## Feature Archetypes

### Archetype 1: Service Feature

**Definition**: Feature that integrates with an external system or provider.

**Characteristics**:
- Communicates with external APIs (HTTP, SDK, protocol)
- Needs abstraction for testability (can't hit real service in tests)
- May have multiple provider options (swap implementations)
- Often involves credentials, tokens, or API keys

**Examples**:
- Payment processing (Stripe, PayPal, Square)
- Email delivery (SendGrid, Mailgun, SES)
- Cloud storage (S3, GCS, Azure Blob)
- Analytics tracking (Mixpanel, Amplitude, Segment)
- SMS/notifications (Twilio, SNS)

**Applicable Patterns**:
- Pattern 1: Service Interface (always)
- Pattern 2: Environment Extension (always)
- Pattern 4: Mock Service Testing (always)
- Pattern 5: Provider Synchronization (if real-time state)
- Pattern 6: React Context (if UI integration needed)

---

### Archetype 2: Domain Feature

**Definition**: Feature that adds new business entities and logic to the application.

**Characteristics**:
- Introduces new entity types (Product, Order, Customer)
- Has business rules and validation
- May need computed properties or derived state
- Often involves relationships between entities

**Examples**:
- Product catalog management
- Customer relationship tracking
- Inventory management
- Content management
- Task/project tracking

**Applicable Patterns**:
- Pattern 3: Enhancement Hooks (always)
- Pattern 4: Mock Service Testing (for any services used)
- Pattern 6: React Context (if UI integration needed)
- Relationship patterns from Tier 2 (as needed)

---

### Archetype 3: Infrastructure Feature

**Definition**: Feature that adds cross-cutting capabilities to the platform.

**Characteristics**:
- Affects multiple parts of the system
- Often transparent to business logic
- Provides utilities or optimizations
- May be used by other features

**Examples**:
- Caching layer (Redis, in-memory)
- Logging/observability
- Rate limiting
- Background job processing
- Feature flags

**Applicable Patterns**:
- Pattern 1: Service Interface (always)
- Pattern 2: Environment Extension (always)
- Pattern 4: Mock Service Testing (always)
- Custom collection behaviors via domain() enhancements (if needed)

---

### Archetype 4: Hybrid Feature

**Definition**: Feature that combines service integration with domain modeling.

**Characteristics**:
- External provider + local domain entities
- State synchronized between provider and local store
- Provider is source of truth for some data
- Local store may cache or extend provider data

**Examples**:
- CRM integration (Salesforce data + local extensions)
- E-commerce with external inventory system
- Real-time collaboration (external sync + local state)
- Third-party user directory integration

**Applicable Patterns**:
- All Service Feature patterns (1, 2, 4, 5)
- All Domain Feature patterns (3)
- Pattern 6: React Context (typically needed)

---

## Decision Tree

```
START: What does this feature primarily do?

┌─ Integrates with external system/API?
│  │
│  ├─ Yes ─┬─ Also adds new domain entities?
│  │       │  ├─ Yes → HYBRID FEATURE
│  │       │  └─ No  → SERVICE FEATURE
│  │       │
│  └─ No  ─┬─ Adds cross-cutting capability?
│          │  ├─ Yes → INFRASTRUCTURE FEATURE
│          │  └─ No  → DOMAIN FEATURE
```

---

## Pattern Selection Matrix

| Pattern | Service | Domain | Infrastructure | Hybrid |
|---------|---------|--------|----------------|--------|
| 1. Service Interface | ✅ | ❌ | ✅ | ✅ |
| 2. Environment Extension | ✅ | ❌ | ✅ | ✅ |
| 3. Enhancement Hooks | ❌ | ✅ | ❌ | ✅ |
| 4. Mock Service Testing | ✅ | △ | ✅ | ✅ |
| 5. Provider Synchronization | △ | ❌ | ❌ | ✅ |
| 6. React Context | △ | △ | ❌ | ✅ |

✅ = Always applies | △ = Sometimes applies | ❌ = Rarely applies

---

## Classification Questions

When classifying a feature request, ask:

### External Integration Questions
1. Does this feature need to communicate with an external service?
2. Will credentials or API keys be required?
3. Could there be multiple providers for this capability?
4. Does the external service maintain state we need to track?

### Domain Questions
1. Does this introduce new entity types?
2. Are there business rules or validation requirements?
3. Do entities have relationships to existing entities?
4. Are there computed or derived properties needed?

### Infrastructure Questions
1. Is this a cross-cutting concern (logging, caching, etc.)?
2. Will multiple features use this capability?
3. Is this transparent to business logic?

### Real-time Questions
1. Can the external state change without our action?
2. Do we need to react to external events?
3. Should local state stay synchronized with external source?

---

## Worked Examples (Non-Auth)

### Example 1: "Add Stripe payment processing"

**Classification**: SERVICE FEATURE

**Reasoning**:
- External API integration (Stripe)
- Credentials required (API keys)
- Multiple providers possible (could swap to PayPal)
- No new domain entities (uses existing Order)

**Patterns**: 1, 2, 4, (5 if webhooks)

---

### Example 2: "Add product catalog"

**Classification**: DOMAIN FEATURE

**Reasoning**:
- New entities (Product, Category, Variant)
- Business rules (pricing, inventory thresholds)
- Relationships (Category → Products, Product → Variants)
- No external integration

**Patterns**: 3, 6 (if UI), relationship patterns

---

### Example 3: "Add Redis caching"

**Classification**: INFRASTRUCTURE FEATURE

**Reasoning**:
- Cross-cutting capability
- No new domain entities
- Used by multiple features
- External service (Redis)

**Patterns**: 1, 2, 4

---

### Example 4: "Add Salesforce CRM sync"

**Classification**: HYBRID FEATURE

**Reasoning**:
- External API (Salesforce)
- New domain entities (Contact, Opportunity extensions)
- Real-time sync needed
- Local store extends external data

**Patterns**: 1, 2, 3, 4, 5, 6

---

## Service vs Internal Decision

The most critical distinction is whether a feature calls **external APIs** or operates purely on **local data**.

### External Service Feature (requires IService interface)

- Calls external APIs (Supabase, Stripe, external REST/GraphQL)
- Needs provider abstraction (multiple implementations possible)
- Source of truth is external system
- Examples: auth, payments, email, analytics

**Pattern**: Create `IService` interface + provider implementations + store syncs from service.

### Internal Domain Feature (pure MST, NO service layer)

- All data is local to the application
- Source of truth is MST store + SQL persistence (postgres/sqlite)
- Operations are direct MST mutations
- Persistence is automatic via SQL backends (no manual mixin needed)
- Examples: workspace/team management, project tracking, content management

**Pattern**: Create domain store with `domain()` API and enhancement hooks. NO `IService` interface needed—actions mutate MST directly and persistence happens automatically via configured SQL backend.

### Decision Rule

```
Does this feature's CORE DATA live in an external system?
├── Yes → External Service pattern (IService + provider implementations)
└── No  → Internal Domain pattern (MST store + SQL backend persistence)
```

**Critical distinction**: The question is about where the feature's *own data* lives, NOT whether it references other entities.

| Scenario | Classification | Why |
|----------|----------------|-----|
| Feature data stored externally (Supabase, Stripe) | External Service | Core data lives outside app |
| Feature data local, but *references* external IDs (user IDs from auth) | **Internal Domain** | Core data is local; references are just foreign keys |
| Feature syncs/mirrors external data locally | Hybrid | Both local modeling AND external sync |

**Key insight**: Referencing an external entity (like a user ID from auth) does NOT make a feature "external service." If the feature's own entities are created, stored, and managed locally, it's an Internal Domain feature—even if those entities contain foreign key references to users managed by a separate auth service.

---

## Anti-Patterns

### Over-Classification
Don't create a service interface for purely local functionality. If there's no external provider and no need for multiple implementations, use domain patterns directly.

### Under-Classification
Don't embed provider-specific code directly in domain models. If touching an external system, abstract it behind a service interface.

### Hybrid Confusion
Don't treat a service feature as hybrid just because it returns data. Hybrid requires *domain modeling* of that data, not just passing it through.

### Reference Confusion
Don't classify a feature as "Hybrid" or "Service" just because it *references* entities from another domain (like user IDs from auth). Foreign key references to external entities are normal in Internal Domain features. The question is: where does THIS feature's data live and get managed?

- Records that reference user IDs → Internal Domain (the records are local)
- User sessions managed by Supabase Auth → External Service (sessions live externally)

### Unnecessary Service Layer
Don't create service interfaces (e.g., `I{Domain}Service`) for features that are purely local. If all data lives in MST and persists via SQL backends, a service interface adds complexity without benefit.

---

## Next Steps After Classification

1. **Service Feature** → Start with Pattern 1 (Service Interface)
2. **Domain Feature** → Start with entity schema design, then Pattern 3
3. **Infrastructure Feature** → Start with Pattern 1, focus on cross-cutting integration
4. **Hybrid Feature** → Start with Pattern 1, then Pattern 3, then Pattern 5
