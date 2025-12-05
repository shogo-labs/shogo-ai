---
name: platform-feature-design
description: >
  Domain modeling and schema design for platform features. Use after
  platform-feature-discovery to create Enhanced JSON Schema for features
  that need persistent entities. Takes a PlatformFeatureSession with
  requirements and produces a schema in .schemas/{feature}/. Invoke when
  ready to "design the schema", "create the domain model", "continue to
  design phase", or after discovery handoff.
---

# Platform Feature Design

Transform discovery requirements into Enhanced JSON Schema for Wavesmith.

## Output

- **Schema** in `.schemas/{session.name}/` via `schema.set`
- **DesignDecision entities** recording key choices
- **Updated session** with schemaName and status="integration"

## Workflow

### Phase 1: Load Context

1. Load `platform-features` schema
2. Find session by name or ID (ask if ambiguous)
3. Load associated Requirements
4. Present summary:
   ```
   Session: {name}
   Intent: {intent}
   Requirements: {count}
   Affected packages: {list}

   Ready to design the domain model?
   ```

### Phase 2: Entity Design

#### Entity Modeling Decision

Before designing schema structure, determine the modeling approach:

**Use Entity Collections when:**
- Multiple instances of same type exist (products, orders, contacts)
- Need to query/filter across instances (findBySku, getActive)
- Entities have create/update/delete lifecycle
- Relationships exist between entity types

**Use Singleton State when:**
- Only one instance ever exists (currentTheme, appConfig)
- No need to query across instances
- State is derived/computed from other sources

**For Service/Hybrid features:** Almost always use entity collections. Even if the app only shows "current item", the domain typically has multiple instances with lifecycle.

| Feature Type | Likely Model | Example |
|--------------|--------------|---------|
| Inventory | Collections | Product, Warehouse, StockLevel entities |
| CRM | Collections | Contact, Company, Deal entities |
| Settings | Singleton | AppSettings with theme, locale |
| Notifications | Collections | Notification, Subscription entities |

#### Extract Entities from Requirements

**Extract entities from requirements** - Look for nouns with independent lifecycle:

| Concept Type | Criteria | Schema Pattern |
|--------------|----------|----------------|
| **Entity** | Has ID, independent lifecycle, can be queried | Top-level in `$defs` with `x-mst-type: "identifier"` |
| **Value Object** | Embedded, no ID, belongs to parent | Nested `type: "object"` |
| **Enum** | Fixed set of values | `type: "string", enum: [...]` |

**Determine relationships**:
- 1:1 or N:1 → `x-reference-type: "single"`
- 1:N or N:M → `x-reference-type: "array"`

**Design for Enhancement Hooks** - Consider what hooks will add:

| Schema Element | Enhancement Hook | Design Implication |
|----------------|------------------|-------------------|
| Raw value fields | `enhanceModels` views | Store priceInCents, hook provides displayPrice |
| Status enums | `enhanceModels` views | Store status, hook provides isActive, isComplete |
| Collection queries | `enhanceCollections` views | Index by field, hook provides findBy{Field} |
| Cross-entity actions | `enhanceRootStore` actions | Ensure fields needed for coordination exist |

**Key principle**: Don't duplicate in schema what hooks will compute. Ensure raw fields exist for hooks to derive from.

See [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) for hook structure and anti-patterns.

**Review gate**: Present conceptual model for approval:
```
Entities:
- User (id, email, passwordHash, createdAt)
- ApiKey (id, user→, key, expiresAt, revokedAt)
- AuditLog (id, user→, action, timestamp)

Relationships:
- ApiKey references User (N:1)
- AuditLog references User (N:1)

Does this capture the domain correctly?
```

### Phase 3: Schema Generation + Coverage

**Autonomous phase** - Generate schema and verify coverage:

1. Build Enhanced JSON Schema structure
2. For each requirement, verify schema element supports it
3. If gaps found, extend schema (add fields, entities, or relationships)
4. Add status/error fields to primary entities if processing workflows exist
5. Register via `schema.set`

**Coverage check format**:
```
✅ req-001: User registration → User entity
✅ req-002: Login → User.passwordHash, ApiKey creation
✅ req-003: Token refresh → ApiKey.expiresAt
⚠️ req-005: Rate limiting → Added User.requestCount field
```

### Phase 4: Validate & Handoff

1. Load schema via `schema.load` to verify MST generation
2. Create DesignDecision entities for key choices:
   ```
   store.create("DesignDecision", "platform-features", {
     id: uuid(),
     session: sessionId,
     question: "How to store API keys?",
     decision: "Separate ApiKey entity with user reference",
     rationale: "Supports multiple keys per user and revocation"
   })
   ```
3. Update session:
   ```
   store.update(sessionId, "PlatformFeatureSession", "platform-features", {
     schemaName: session.name,
     status: "integration",
     updatedAt: Date.now()
   })
   ```
4. Present handoff summary with next steps

## Wavesmith Operations

```javascript
// Phase 1: Load context
schema.load("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "auth-layer" })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })

// Phase 3: Register schema
schema.set({
  name: session.name,
  format: "enhanced-json-schema",
  payload: schemaPayload
})

// Phase 4: Validate
schema.load(session.name)  // Should succeed if schema is valid

// Update session
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  schemaName: session.name,
  status: "integration"
})

// Record decisions
store.create("DesignDecision", "platform-features", {...})
```

## References

- [schema-patterns.md](references/schema-patterns.md) - Enhanced JSON Schema conventions
- [example-designs.md](references/example-designs.md) - Auth example walkthrough
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) - Enhancement hook patterns for domain logic
