---
name: platform-feature-design
description: >
  Domain modeling and schema design for platform features. Use after
  platform-feature-analysis (explore mode) to create Enhanced JSON Schema
  informed by codebase patterns. Takes a PlatformFeatureSession with
  requirements and analysis findings, produces schema in .schemas/{feature}/.
  Invoke when ready to "design the schema", "create the domain model",
  or when session status=design.
---

# Platform Feature Design

Transform discovery requirements into Enhanced JSON Schema for Wavesmith, informed by analysis findings.

## Output

- **Schema** in `.schemas/{session.name}/` via `schema.set`
- **DesignDecision entities** recording key choices
- **Updated session** with schemaName and status="integration"

## Workflow

### Phase 1: Load Context

1. Load `platform-features` schema
2. Find session by name or ID (ask if ambiguous)
3. Load associated Requirements
4. **Check for Analysis Findings**:
   ```javascript
   schema.load("platform-feature-spec")
   data.loadAll("platform-feature-spec")
   findings = store.list("AnalysisFinding", "platform-feature-spec", { sessionId: session.id })
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

### Phase 3: Schema Generation + Coverage

**Autonomous phase** - Generate schema and verify coverage.

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
5. Register via `schema.set`

**Coverage check format**:
```
✅ req-001: Track products → Product entity with sku, name, priceInCents
✅ req-002: Multiple warehouses → Warehouse entity with location
✅ req-003: Stock per location → StockLevel references Product, Warehouse
⚠️ req-005: Low stock alerts → Added StockLevel.reorderPoint field
```

### Phase 4: Validate & Handoff

1. Load schema via `schema.load` to verify MST generation
2. Create DesignDecision entities for key choices:
   ```
   store.create("DesignDecision", "platform-features", {
     id: uuid(),
     session: sessionId,
     question: "How to model stock levels?",
     decision: "Separate StockLevel entity referencing Product and Warehouse",
     rationale: "Supports tracking quantity at multiple locations per product"
   })
   ```
3. **Required: Create Enhancement Hooks DesignDecision** - Document planned hooks for the spec skill to consume:
   ```
   store.create("DesignDecision", "platform-features", {
     id: uuid(),
     session: sessionId,
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
   store.update(sessionId, "PlatformFeatureSession", "platform-features", {
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
