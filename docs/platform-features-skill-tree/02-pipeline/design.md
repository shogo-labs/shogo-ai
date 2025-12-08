# Design: Schema Creation

The **Design** skill transforms discovery requirements into Enhanced JSON Schema, creating the structural foundation that drives code generation. This is where domain concepts become concrete data structures.

## Role in the Pipeline

```
Discovery → Analysis → [DESIGN] → Spec → Tests → Implementation
                         │
                         ▼
              Enhanced JSON Schema
              + DesignDecision entities
```

**Previous**: Analysis findings inform existing patterns to follow  
**Next**: Spec skill uses schema to create implementation tasks

## When to Invoke

| Trigger | Session Status | Situation |
|---------|---------------|-----------|
| `/platform-feature-design` | `design` | After analysis explores codebase patterns |
| "design the schema" | `design` | Ready to model domain entities |
| "create the domain model" | `design` | Requirements are clear and patterns understood |

## Inputs

From **platform-features** schema:
- `PlatformFeatureSession` - Active session with requirements
- `Requirement` entities - What the feature must accomplish

From **platform-feature-spec** schema (via analysis):
- `AnalysisFinding` entities - Patterns, gaps, risks discovered

## What Design Produces

| Output | Location | Purpose |
|--------|----------|---------|
| Enhanced JSON Schema | `.schemas/{feature}/schema.json` | Domain structure definition |
| DesignDecision entities | platform-features schema | Key design choices documented |
| Updated session | platform-features schema | Status → `integration` |

---

## Design Principles

### 1. Collection Pattern for All Entities

**Every entity uses the collection pattern**—no singletons. What seems like a single instance (app settings, user preferences) is a collection with one item.

```json
{
  "AppSettings": {
    "properties": {
      "id": { "type": "string", "x-mst-type": "identifier" },
      "theme": { "type": "string", "enum": ["light", "dark"] },
      "locale": { "type": "string" }
    }
  }
}
```

Access via: `store.appSettingsCollection.get("default")`

**Why**: Uniform patterns, identical transformation logic, easy evolution if requirements change.

### 2. Service Interface Pattern (Non-Negotiable)

External services always use the interface pattern:

| File | Purpose |
|------|---------|
| `types.ts` | `I{Service}Service` interface |
| `{provider}.ts` | Real implementation (e.g., `supabase.ts`) |
| `mock.ts` | Test implementation |

This is not a design choice—it's architectural standard. Don't ask users whether to make services "swappable."

### 3. Schema Always Required

Every feature needs a schema. Even "pure service wrappers" have local state:
- Loading status
- Error messages  
- Cached data for reactive UI

**The question isn't**: "Do we need a schema?"  
**The question is**: "What local state does this feature track?"

### 4. Domain Purity

Schemas contain **business state only**. UI concerns belong elsewhere.

| In Schema | NOT in Schema |
|-----------|---------------|
| Entity IDs and relationships | `isLoading`, `isSelected` |
| Business data (name, email, status) | `error`, `draftValue` |
| Domain timestamps (createdAt, expiresAt) | `currentPage`, `hasNextPage` |

**UI state goes to**: React `useState`, `useRef`, or MST `volatile()` for cross-component coordination.

---

## Design Workflow

### Phase 1: Load Context

The skill loads session, requirements, and analysis findings:

```
Session: auth-layer
Intent: Add authentication with Supabase
Requirements: 4

Analysis Findings: 6
- Patterns: 3 (service interface, environment injection, enhancement hooks)
- Gaps: 1 (no auth service in IEnvironment)
- Risks: 1 (token storage security)

Ready to design the domain model?
```

If no analysis findings exist, the skill warns:
```
⚠️ No analysis findings found for this session.

Analysis helps discover existing patterns to follow. Options:
1. Run analysis first (recommended)
2. Proceed without analysis (may miss existing patterns)
```

### Phase 2: Entity Extraction

The skill identifies entities from requirements:

| Concept | Criteria | Schema Pattern |
|---------|----------|----------------|
| **Entity** | Has ID, independent lifecycle | Top-level in `$defs` with identifier |
| **Value Object** | Embedded, no ID | Nested `type: "object"` |
| **Enum** | Fixed set of values | `type: "string", enum: [...]` |

**Relationship types**:
- 1:1 or N:1 → `x-reference-type: "single"`
- 1:N or N:M → `x-reference-type: "array"`

**Review gate** - Conceptual model presented for approval:
```
Entities:
- AuthUser (id, email, emailVerified, createdAt)
- AuthSession (id, userId→, accessToken, refreshToken, expiresAt)

Relationships:
- AuthSession references AuthUser (N:1)

Does this capture the domain correctly?
```

### Phase 3: Schema Generation

The skill generates Enhanced JSON Schema with MST-specific extensions:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "auth-layer",
  "$defs": {
    "AuthUser": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "email": { "type": "string" },
        "emailVerified": { "type": "boolean" },
        "createdAt": { "type": "string" }
      },
      "required": ["id", "email"]
    },
    "AuthSession": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "x-mst-type": "identifier" },
        "userId": { 
          "type": "string",
          "x-reference-type": "single",
          "x-mst-type": "reference"
        },
        "accessToken": { "type": "string" },
        "refreshToken": { "type": "string" },
        "expiresAt": { "type": "string" }
      },
      "required": ["id", "userId", "accessToken", "expiresAt"]
    }
  }
}
```

**Coverage verification**:
```
✅ req-001: User registration → AuthUser entity with email
✅ req-002: Login sessions → AuthSession with tokens
✅ req-003: Session expiry → AuthSession.expiresAt field
✅ req-004: Token refresh → AuthSession.refreshToken field
```

### Phase 4: Design Decisions

Key choices are captured as `DesignDecision` entities for traceability:

```javascript
store.create("DesignDecision", "platform-features", {
  id: "dd-001",
  session: sessionId,
  question: "How to model auth sessions?",
  decision: "Separate AuthSession entity referencing AuthUser",
  rationale: "Supports multiple sessions per user and session lifecycle"
})
```

**Critical**: Enhancement hooks decision informs spec task creation:

```javascript
store.create("DesignDecision", "platform-features", {
  id: "dd-hooks",
  session: sessionId,
  question: "What enhancement hooks will the domain need?",
  decision: "enhanceModels: AuthSession.isExpired; enhanceRootStore: signIn, signOut, initialize, isAuthenticated, currentUser",
  rationale: "All hooks implemented in single domain.ts using createStoreFromScope()"
})
```

---

## Schema to ArkType Translation

The Enhanced JSON Schema created here will be translated to ArkType scope during implementation:

| JSON Schema | ArkType Scope |
|-------------|---------------|
| `"x-mst-type": "identifier"` | `id: "string.uuid"` |
| `"x-reference-type": "single"` | `userId: "AuthUser"` |
| `"x-reference-type": "array"` | `items: "Item[]"` |
| `"x-computed": true` | Auto-generated inverse arrays |

The implementation skill uses this schema as blueprint for `domain.ts`.

---

## Auth Example Output

For the auth feature, design produced:

**Schema** (`.schemas/auth-layer/schema.json`):
- `AuthUser` - User identity (id, email, emailVerified, createdAt)
- `AuthSession` - Active session (id, userId, accessToken, refreshToken, expiresAt)

**DesignDecision entities**:
1. Collection pattern for auth entities (not singletons)
2. Session references User (N:1 relationship)
3. Enhancement hooks: `isExpired` view, `signIn/signOut/initialize` actions

**Session update**:
- `schemaName`: "auth-layer"
- `status`: "integration"

---

## Design Decisions You'll Encounter

The skill makes decisions transparent. Common choices for review:

| Decision Area | Options Considered | Typical Choice |
|---------------|-------------------|----------------|
| Entity granularity | Single vs. separate entities | Separate for independent lifecycle |
| Relationship direction | Which entity owns the reference | Entity with foreign key semantics |
| Optional fields | Required vs. optional | Optional with defaults in hooks |
| Status tracking | Enum vs. boolean | Enum for multi-state, boolean for binary |

---

## What to Look For

**Good design outputs**:
- Every requirement maps to schema elements
- Entities have clear identity (UUID identifiers)
- Relationships match domain semantics
- Enhancement hooks decision exists
- No UI state in schema (loading, error, selected)

**Warning signs**:
- Schema elements not traced to requirements
- Missing enhancement hooks decision (spec will lack guidance)
- UI state fields in schema (isLoading, isSelected)
- Duplicate data that hooks could compute

---

## Next Step

With schema created and design decisions recorded:

→ **Proceed to [Spec](spec.md)** to transform integration points into implementation tasks

The spec skill reads the schema and enhancement hooks decision to create the task breakdown.
