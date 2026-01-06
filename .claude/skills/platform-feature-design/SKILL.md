---
name: platform-feature-design
description: >
  Domain modeling and schema design for platform features. Use after
  platform-feature-analysis (explore mode) to create Enhanced JSON Schema
  informed by codebase patterns. Takes a FeatureSession with
  requirements and analysis findings, produces a schema via Wavesmith.
  Invoke when ready to "design the schema", "create the domain model",
  or when session status=design.
---

# Platform Feature Design

Transform discovery requirements into Enhanced JSON Schema for Wavesmith, informed by analysis findings.

## Output

- **Schema** via `schema.set`
- **DesignDecision entities** recording key choices
- **Updated session** with schemaName and status="spec"

## Workflow

### Phase 1: Load Context

1. Load `platform-features` schema
2. Find session by name or ID (ask if ambiguous)
3. Load associated Requirements
4. **Check for Analysis Findings**:
   ```javascript
   findings = store.query({
     model: "AnalysisFinding",
     schema: "platform-features",
     filter: { session: session.id }
   })
   ```
5. Present summary:
   ```
   Session: {name}
   Intent: {intent}
   Requirements: {count}
   Affected packages: {list}

   Analysis Findings: {count}
   - Patterns: {pattern findings}
   - Gaps: {gap findings}
   - Risks: {risk findings}

   Ready to design the domain model?
   ```

**If no analysis findings exist:**
```
⚠️ No analysis findings found for this session.

Analysis helps discover existing patterns to follow. Options:
1. Run analysis first (recommended) - invoke platform-feature-analysis
2. Proceed without analysis (may miss existing patterns)

Which approach?
```

### Phase 2: Entity Design

#### Entity Modeling: Always Use Collections

All domain entities use the collection pattern. What might seem like a "singleton" (e.g., app settings, current preferences) is simply a collection with one instance.

**Why collections for everything:**
- Uniform pattern across all entities - no special cases
- Schema-to-MST transformation works identically
- "Singleton" behavior achieved via `collection.get(knownId)` or `first()` helper
- Easier to evolve if requirements change (e.g., multi-tenant settings)

**Example - Settings as Collection:**
```json
"AppSettings": {
  "properties": {
    "id": { "type": "string", "x-mst-type": "identifier", "format": "uuid" },
    "theme": { "type": "string", "enum": ["light", "dark"] },
    "locale": { "type": "string" }
  }
}
```
Access: `store.appSettingsCollection.get("default")` or add a `currentSettings` view in `rootStore` enhancements.

| Feature Type | Entities | Notes |
|--------------|----------|-------|
| Inventory | Product, Warehouse, StockLevel | Multiple instances with relationships |
| CRM | Contact, Company, Deal | Full lifecycle entities |
| Settings | AppSettings | Single instance accessed via known ID |
| Notifications | Notification, NotificationPreference | Per-user preferences as collection |

#### Service Integration: Always Use Interface Pattern

External services (auth providers, databases, APIs, third-party SDKs) always use the service interface pattern. This is not a design choice to offer users - it's the architectural standard.

**Required structure:**
- `I{Service}Service` interface in `types.ts` - defines contract
- Provider implementation (e.g., `supabase.ts`) - real service
- Mock implementation (`mock.ts`) - for testing

**Why this is non-negotiable:**
- **Testability** - Unit tests need mocks; without DI you're stuck with integration tests
- **Consistency** - The codebase uses `IEnvironment` with injected services throughout
- **Flexibility** - Swap providers, run offline, test edge cases
- **Low cost** - Interface + implementations is minimal overhead

**Don't ask:** "Should we make this swappable or use Supabase directly?"
**Do say:** "The auth service will use the interface pattern with Supabase as the initial provider."

See [patterns/02-service-interface.md](references/patterns/02-service-interface.md) for implementation details.

#### Schema Always Required: Local State Pattern

Every feature needs a schema. The question is never "schema or no schema?" but rather "what local state does this feature need?"

**Why schema is always required:**
- Schematic layers transform schema → MST models
- MST provides reactive state for React
- Without schema, no local state management
- Even "pure service wrappers" have local state (loading, error, cached data)

**Service integration local state pattern:**

External services own their data. We don't duplicate it. But we DO need local state to:
- Track operation status (loading, error)
- Cache current data for reactive UI
- Coordinate across components

**Example - Weather service local state:**
```json
"WeatherReading": {
  "properties": {
    "id": { "type": "string", "x-mst-type": "identifier", "format": "uuid" },
    "locationId": { "type": "string", "description": "External weather API location" },
    "temperatureCelsius": { "type": "number" },
    "conditions": { "type": "string" },
    "lastFetched": { "type": "string", "format": "date-time" }
  }
}
```

This doesn't duplicate the weather API's data - it tracks LOCAL cached state that the UI observes reactively.

**The pattern:**
1. Service interface wraps external provider (IWeatherService → OpenWeather API)
2. Schema defines local state (WeatherReading entity)
3. Schematic transforms → MST models
4. Service results sync → local MST state
5. React observes → reactive UI

**Don't ask:** "Do you need a schema for this?"
**Do ask:** "What local state does this feature need to track?"

#### Domain Purity Principle

Domain schemas contain **business state only**. UI concerns belong in React components.

**Belongs in schema:**
- Entity identifiers and relationships
- Business data (name, email, amount, status enums)
- Timestamps for domain events (createdAt, expiresAt)
- Computed relationships (inverse arrays)

**Does NOT belong in schema:**
- Loading states (`isLoading: boolean`)
- Error messages (`error: string | null`)
- UI selection state (`isSelected`, `isExpanded`)
- Form draft state (`draftValue`)
- Pagination cursors (`currentPage`, `hasNextPage`)

**Where UI state goes:**
- React `useState` for component-local UI state
- React `useRef` for values that don't trigger re-render
- Volatile MST state (via `volatile()`) only for cross-component UI coordination

**Schema Audit**: Before finalizing, check each field:
- Is this domain state or UI state?
- Will this be persisted or is it transient?
- Would MCP need to read/write this?

If the answer to all three is "no", it's UI state and belongs in React, not the schema.

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
| Raw value fields | `models` views | Store priceInCents, model provides displayPrice |
| Status enums | `models` views | Store status, model provides isActive, isComplete |
| Collection queries | `collections` views | Index by field, collection provides findBy{Field} |
| Cross-entity actions | `rootStore` actions | Ensure fields needed for coordination exist |

**Key principle**: Don't duplicate in schema what hooks will compute. Ensure raw fields exist for hooks to derive from.

See [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) for hook structure and anti-patterns.

**Review gate**: Present conceptual model for approval:
```
Entities:
- Product (id, sku, name, priceInCents)
- Warehouse (id, name, location)
- StockLevel (id, product→, warehouse→, quantity, lastUpdated)

Relationships:
- StockLevel references Product (N:1)
- StockLevel references Warehouse (N:1)

Does this capture the domain correctly?
```

### Phase 3: Schema Generation + Coverage + Validation

**Autonomous phase** - Generate schema, verify coverage, validate structure.

The schema you create will be used in TWO ways:
1. **Wavesmith** - Stored via `schema.set` for session tracking
2. **Runtime** - Translated to ArkType scope in `domain.ts` during implementation

When designing entities, consider how they'll flow through the schematic pipeline:
- Entity with `x-mst-type: identifier` → ArkType `id: 'string'`
- Reference with `x-reference-type: single` → ArkType `product: 'Product'` (entity name only, no `.id` suffix)
- Reference with `x-reference-type: array` → ArkType `items: 'Item[]'` (entity name with `[]`)
- Computed inverse arrays → Include them - system auto-detects and marks `x-computed: true`
- Computed **views** (derived values) → **NOT in schema** - added via `models` enhancements during implementation

**Steps:**
1. Build Enhanced JSON Schema structure
2. For each requirement, verify schema element supports it
3. If gaps found, extend schema (add fields, entities, or relationships)
4. Add status/error fields to primary entities if processing workflows exist
5. **Validate all reference fields** against checklist (CRITICAL - see [schema-patterns.md](references/schema-patterns.md)):
   - [ ] Every reference has `type: "string"` + `x-arktype` + `x-reference-target` + `x-reference-type` + `x-mst-type`
   - [ ] Every computed array has `items.$ref` + `x-arktype` + `x-computed` + `x-inverse`
   - [ ] NO fields have spurious `enum: []`
6. **Add persistence configuration** to schema root:
   ```json
   "x-persistence": {
     "backend": "postgres"
   }
   ```
   Note: System automatically falls back to SQLite (durable) then memory-only SQLite if PostgreSQL unavailable.
7. Register via `schema.set`

**Coverage check format**:
```
✅ req-001: Track products → Product entity with sku, name, priceInCents
✅ req-002: Multiple warehouses → Warehouse entity with location
✅ req-003: Stock per location → StockLevel references Product, Warehouse
⚠️ req-005: Low stock alerts → Added StockLevel.reorderPoint field
```

**Validation check format**:
```
Reference Field Validation:
✅ Product.category: type + x-arktype + x-reference-target + x-reference-type + x-mst-type
✅ StockLevel.product: type + x-arktype + x-reference-target + x-reference-type + x-mst-type
✅ StockLevel.warehouse: type + x-arktype + x-reference-target + x-reference-type + x-mst-type

Persistence Configuration:
✅ Schema root has x-persistence.backend: "postgres"
```

### Phase 4: Runtime Testing (CRITICAL)

**Validation checklists are NOT testing.** You MUST verify the schema actually works by executing operations.

1. **Register schema** via `schema.set`
2. **Execute DDL** via `ddl.execute` to provision database tables:
   ```javascript
   // After schema.set, create tables in the SQL backend
   ddl.execute({ schemaName: session.name })
   ```
   This generates and runs CREATE TABLE statements based on the schema. Required before store operations will work.
3. **Load and test** via `schema.load` - verify MST generation succeeds
4. **Create test entities** for EACH entity type:
   ```javascript
   // Test each entity type - failures here reveal schema issues
   schema.load(session.name)

   // Test root entity
   store.create("RootEntity", session.name, {
     id: crypto.randomUUID(),
     name: "test-root",
     // ... required fields
   })

   // Test child entities with references
   store.create("ChildEntity", session.name, {
     id: crypto.randomUUID(),
     parentRef: rootEntityId,  // Test reference resolution
     // ... required fields
   })

   // Test query + filter
   store.query({
     model: "ChildEntity",
     schema: session.name,
     filter: { parentRef: rootEntityId }
   })
   ```

5. **Verify operations succeed** - If any fail:
   - Check error message for clues
   - Common issues: missing x-extensions, DDL not executed, missing x-reference-target
   - Fix schema and re-test until ALL operations pass

6. **Clean up test data** or leave for inspection

**Common Runtime Errors and Fixes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `A view member should either be a function or getter` | Schematic layer issue with computed views | Check x-computed arrays have correct structure |
| `relation "tablename" does not exist` | DDL not executed | Run `ddl.execute({ schemaName })` after schema.set |
| `foreign key violation` | Missing x-reference-target | Add `x-reference-target: "EntityName"` to reference fields |
| `Reference target not found` | Missing or incorrect x-arktype | Verify x-arktype matches exact entity name |

### Phase 5: Validate & Handoff

1. Create DesignDecision entities for key choices:
   ```
   store.create("DesignDecision", "platform-features", {
     id: uuid(),
     name: "stock-level-modeling",
     session: session.id,
     question: "How to model stock levels?",
     decision: "Separate StockLevel entity referencing Product and Warehouse",
     rationale: "Supports tracking quantity at multiple locations per product"
   })
   ```
3. **Required: Create Enhancement Hooks DesignDecision** - Document planned hooks for the spec skill to consume:
   ```
   store.create("DesignDecision", "platform-features", {
     id: uuid(),
     name: "enhancement-hooks-plan",
     session: session.id,
     question: "What enhancements will the domain need?",
     decision: "models: {Entity}.{view}; collections: {Collection}.{method}; rootStore: {actions}",
     rationale: "All enhancements composed via domain({ name, from, enhancements }). CollectionPersistable auto-composed. Export named domain result ({domain}Domain) for DomainProvider integration."
   })
   ```

   **Enhancements template:**
   - `models: EntityName.viewOrAction` - computed from entity fields
   - `collections: EntityCollection.method` - query helpers
   - `rootStore: actionOrView` - coordination, CRUD actions

   **Important**: This DesignDecision directly informs the spec skill. The spec skill reads these hooks and creates a single "Domain Store" task with acceptance criteria derived from this decision. See [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md).

4. Update session:
   ```
   store.update(session.id, "FeatureSession", "platform-features", {
     schemaName: session.name,
     status: "spec",
     updatedAt: Date.now()
   })
   ```
5. Present handoff summary with next steps

## Wavesmith Operations

```javascript
// Phase 1: Load context
schema.load("platform-features")

session = store.query({
  model: "FeatureSession",
  schema: "platform-features",
  filter: { name: "auth-layer" },
  terminal: "first"
})

requirements = store.query({
  model: "Requirement",
  schema: "platform-features",
  filter: { session: session.id }
})

findings = store.query({
  model: "AnalysisFinding",
  schema: "platform-features",
  filter: { session: session.id }
})

// Phase 3: Register schema
schema.set({
  name: session.name,
  format: "enhanced-json-schema",
  payload: schemaPayload
})

// Phase 4: Runtime Testing (MUST DO)
// First execute DDL to create tables
ddl.execute({ schemaName: session.name })

// Then load schema for MST generation
schema.load(session.name)  // Should succeed if schema is valid

// Test each entity type - discover issues BEFORE handoff
const testRootId = crypto.randomUUID()
store.create("RootEntity", session.name, {
  id: testRootId,
  name: "test-root",
  createdAt: Date.now()
})

store.create("ChildEntity", session.name, {
  id: crypto.randomUUID(),
  parentRef: testRootId,  // Test reference works
  createdAt: Date.now()
})

// Test query + filter
store.query({
  model: "ChildEntity",
  schema: session.name,
  filter: { parentRef: testRootId }
})

// Phase 5: Update session (only after tests pass)
store.update(session.id, "FeatureSession", "platform-features", {
  schemaName: session.name,
  status: "spec"
})

// Record decisions
store.create("DesignDecision", "platform-features", {...})
```

## References

- [schema-patterns.md](references/schema-patterns.md) - Enhanced JSON Schema conventions
- [example-designs.md](references/example-designs.md) - Auth example walkthrough
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) - Enhancement hook patterns for domain logic
