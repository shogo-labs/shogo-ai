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
- **Updated session** with schemaName and status="integration"

## Workflow

### Phase 1: Load Context

1. Load `platform-features` schema
2. Find session by name or ID (ask if ambiguous)
3. Load associated Requirements
4. **Check for Analysis Findings**:
   ```javascript
   findings = store.list("AnalysisFinding", "platform-features", { session: session.id })
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
    "id": { "type": "string", "x-mst-type": "identifier" },
    "theme": { "type": "string", "enum": ["light", "dark"] },
    "locale": { "type": "string" }
  }
}
```
Access: `store.appSettingsCollection.get("default")` or add a `currentSettings` view in enhanceRootStore.

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
    "id": { "type": "string", "x-mst-type": "identifier" },
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
| Raw value fields | `enhanceModels` views | Store priceInCents, hook provides displayPrice |
| Status enums | `enhanceModels` views | Store status, hook provides isActive, isComplete |
| Collection queries | `enhanceCollections` views | Index by field, hook provides findBy{Field} |
| Cross-entity actions | `enhanceRootStore` actions | Ensure fields needed for coordination exist |

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

### Phase 2a: Persistence Layout Inference

**Automatically apply persistence config based on entity relationships.**

For each entity, apply these rules:

| Condition | `nested` value | Rationale |
|-----------|----------------|-----------|
| Has required single reference | `true` | Child nests under parent |
| All references optional/polymorphic | `false` | Cannot determine parent path |
| No parent references | `false` | Root entity |
| Has optional self-reference | No additional nesting | Logical hierarchy only (e.g., Team→Team) |

**Inference algorithm:**
1. Identify all entities with `x-reference-type: "single"` fields
2. For each entity:
   - If any single ref is REQUIRED (`x-mst-type: "reference"`) → `nested: true`
   - If all single refs are OPTIONAL (`x-mst-type: "maybe-reference"`) → `nested: false`
   - If no single refs → `nested: false` (root entity)
3. Set `displayKey` to first human-readable field (name, title, slug, or id)

**Self-reference handling:**
Optional self-references (e.g., Team.parentId → Team for sub-teams) represent **logical hierarchy**, not physical storage hierarchy. They do NOT add nesting levels.

Example: Team nests under Organization (required ref), but sub-teams stay flat within the Team collection:
```
Organization/
└── acme-corp/
    ├── _index.json
    └── Team/
        ├── engineering.json     (parentId: null)
        ├── platform.json        (parentId: engineering)
        └── qa.json              (parentId: engineering)
```

**Always output explicit config** — every entity gets `nested: true` or `nested: false`, never implicit.

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
- Computed **views** (derived values) → **NOT in schema** - added via `enhanceModels` hook during implementation

**Steps:**
1. Build Enhanced JSON Schema structure
2. For each requirement, verify schema element supports it
3. If gaps found, extend schema (add fields, entities, or relationships)
4. Add status/error fields to primary entities if processing workflows exist
5. **Validate all reference fields** against checklist (CRITICAL - see [schema-patterns.md](references/schema-patterns.md)):
   - [ ] Every reference has `type: "string"` + `x-arktype` + `x-reference-type` + `x-mst-type`
   - [ ] Every computed array has `items.$ref` + `x-arktype` + `x-computed` + `x-inverse`
   - [ ] NO fields have spurious `enum: []`
6. **Validate all entities** have `x-persistence` config:
   - [ ] Root entities: `strategy: "entity-per-file"` + `displayKey`
   - [ ] Child entities: add `nested: true`
   - [ ] Multi-ref entities: add `partitionKey`
7. **Persistence Configuration Audit** (before schema.set):

   | Check | Criteria | Action |
   |-------|----------|--------|
   | Required refs nested | Entity with required single ref has `nested: true` | Flag for review |
   | Polymorphic refs flat | Entity with all-optional refs has `nested: false` | Flag for review |
   | Root entities flat | Entity with no parent ref has `nested: false` | Auto-correct |
   | DisplayKey set | All entities have `displayKey` for human-readable filenames | Flag for review |
   | Explicit nested | Every entity has explicit `nested: true` or `nested: false` | Auto-add via inference |

   **Audit output format:**
   ```
   Persistence Configuration Audit:
   ✅ Product: root entity, nested=false, displayKey=sku
   ✅ Warehouse: root entity, nested=false, displayKey=name
   ✅ StockLevel: required refs (product, warehouse), nested=true, partitionKey=product
   ⚠️ Category: required ref (parent) but nested=false — correcting to nested=true
   ```

8. Register via `schema.set`

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
✅ Product.category: type + x-arktype + x-reference-type + x-mst-type
✅ StockLevel.product: type + x-arktype + x-reference-type + x-mst-type
✅ StockLevel.warehouse: type + x-arktype + x-reference-type + x-mst-type

Persistence Validation:
✅ Product: x-persistence with displayKey="sku"
✅ Warehouse: x-persistence with displayKey="name"
✅ StockLevel: x-persistence with nested=true, partitionKey="product"
```

### Phase 3b: Persistence Layout Review Gate

**Present layout summary for human approval before proceeding to runtime testing.**

```
Persistence Layout Review

Root Entities:
- Product (displayKey: sku)
- Warehouse (displayKey: name)

Nested Under Parent:
- StockLevel → Product (displayKey: id, partitionKey: product)
- Category → Category (displayKey: name, self-referential hierarchy)

Flat (Polymorphic):
- (none in this schema)

Resulting Disk Structure:
.schemas/{name}/data/
├── Product/
│   └── {sku}/
│       ├── _index.json
│       └── StockLevel/
│           └── {id}.json
├── Warehouse/
│   └── {name}.json
└── Category/
    └── {name}.json

Any concerns with this layout? [Proceed] [Adjust]
```

If user chooses "Adjust", capture specific overrides before continuing.

### Phase 4: Runtime Testing (CRITICAL)

**Validation checklists are NOT testing.** You MUST verify the schema actually works by executing operations.

1. **Register schema** via `schema.set`
2. **Load and test** via `schema.load` - verify MST generation succeeds
3. **Create test entities** for EACH entity type:
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

   // Test list + filter
   store.list("ChildEntity", session.name, { parentRef: rootEntityId })
   ```

4. **Verify operations succeed** - If any fail:
   - Check error message for clues
   - Common issues: missing x-extensions, invalid nested persistence config
   - Fix schema and re-test until ALL operations pass

5. **Clean up test data** or leave for inspection

**Common Runtime Errors and Fixes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `A view member should either be a function or getter` | Schematic layer issue with computed views | Check x-computed arrays have correct structure |
| `Cannot determine parent path for nested entity` | Nested persistence with all optional references | Remove `nested: true` from polymorphic entities |
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
     question: "What enhancement hooks will the domain need?",
     decision: "enhanceModels: {Entity}.{view}; enhanceCollections: {Collection}.{method}; enhanceRootStore: {actions}",
     rationale: "All hooks will be implemented in a single domain.ts using createStoreFromScope(). The spec skill will create ONE 'Domain Store' task for this - never separate mixin.ts or hooks.ts files."
   })
   ```

   **Enhancement hooks template:**
   - `enhanceModels: EntityName.viewOrAction` - computed from entity fields
   - `enhanceCollections: EntityCollection.method` - query helpers
   - `enhanceRootStore: actionOrView` - coordination, initialization, cross-entity

   **Important**: This DesignDecision directly informs the spec skill. The spec skill reads these hooks and creates a single "Domain Store" task with acceptance criteria derived from this decision. See [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md).

4. Update session:
   ```
   store.update(session.id, "FeatureSession", "platform-features", {
     schemaName: session.name,
     status: "integration",
     updatedAt: Date.now()
   })
   ```
5. Present handoff summary with next steps

## Wavesmith Operations

```javascript
// Phase 1: Load context
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("FeatureSession", "platform-features", { name: "auth-layer" })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })
findings = store.list("AnalysisFinding", "platform-features", { session: session.id })

// Phase 3: Register schema
schema.set({
  name: session.name,
  format: "enhanced-json-schema",
  payload: schemaPayload
})

// Phase 4: Runtime Testing (MUST DO)
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

// Test list + filter
store.list("ChildEntity", session.name, { parentRef: testRootId })

// Phase 5: Update session (only after tests pass)
store.update(session.id, "FeatureSession", "platform-features", {
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
