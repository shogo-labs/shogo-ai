# Quick Reference

Scannable lookup for common operations, entities, and patterns.

---

## Skill Invocation Cheat Sheet

| Skill | Trigger | Session Status | Purpose |
|-------|---------|----------------|---------|
| Discovery | `/platform-feature-discovery` | — | Create session, capture requirements |
| Analysis | `/platform-feature-analysis` | `discovery` | EXPLORE: Find patterns, integration points |
| Analysis | `/platform-feature-analysis` | `testing` | VERIFY: Check spec still valid |
| Design | `/platform-feature-design` | `design` | Create schema, record decisions |
| Spec | `/platform-feature-spec` | `spec` | Create implementation tasks |
| Tests | `/platform-feature-tests` | `testing` | Create test specifications |
| Implementation | `/platform-feature-implementation` | `testing` | Execute TDD cycle |

---

## Session Status Flow

```
discovery → design → integration → testing → complete
```

| Status | What's Happening | What's Next |
|--------|------------------|-------------|
| `discovery` | Capturing intent, requirements | Analysis or Design |
| `design` | Creating schema, decisions | Analysis (verify) or Spec |
| `integration` | Creating tasks, points | Spec or Tests |
| `testing` | Creating tests or implementing | Tests or Implementation |
| `complete` | Feature done | — |

---

## Entity Quick Reference

### platform-features Schema

| Entity | Key Fields | Purpose |
|--------|------------|---------|
| `PlatformFeatureSession` | id, name, intent, status | Session container |
| `Requirement` | id, session, description, priority | What must be done |
| `DesignDecision` | id, session, question, decision, rationale | Design choices |

### platform-feature-spec Schema

| Entity | Key Fields | Purpose |
|--------|------------|---------|
| `AnalysisFinding` | id, sessionId, type, location, recommendation | Codebase discoveries |
| `IntegrationPoint` | id, sessionId, package, filePath, changeType | Where to change |
| `ImplementationTask` | id, sessionId, integrationPoint, acceptanceCriteria, status | Work units |
| `TestSpecification` | id, task, scenario, given, when, then, testType | Test cases |
| `ImplementationRun` | id, sessionId, status, completedTasks | Execution tracking |
| `TaskExecution` | id, runId, taskId, status, testOutput | Per-task TDD |

---

## Wavesmith Operations

### Load Data

```javascript
schema.load("platform-features")
store.query("platform-features")
```

### CRUD Operations

```javascript
// Create
store.create("Entity", "schema", { ...data })

// Read
store.get("id", "Entity", "schema")
store.query("Entity", "schema", { filter: "value" })

// Update
store.update("id", "Entity", "schema", { field: "newValue" })
```

### Find Session

```javascript
session = store.query("PlatformFeatureSession", "platform-features", { name: "feature-name" })[0]
```

---

## Pattern Quick Reference

| # | Pattern | One-Liner |
|---|---------|-----------|
| 1 | Isomorphism | Domain → state-api, React → apps/web |
| 2 | Service Interface | External APIs behind domain types |
| 3 | Environment Extension | DI via `getEnv()` |
| 4 | Enhancement Hooks | Views/actions in domain.ts |
| 5 | Mock Service | Full interface, in-memory, configurable |
| 6 | Provider Sync | External state → MST |
| 7 | React Context | `useRef` for store, cleanup in `useEffect` |

---

## Package Placement

| Component | Package | Path |
|-----------|---------|------|
| Interface | state-api | `src/{domain}/types.ts` |
| Service | state-api | `src/{domain}/{provider}.ts` |
| Mock | state-api | `src/{domain}/mock.ts` |
| Domain store | state-api | `src/{domain}/domain.ts` |
| React Context | apps/web | `src/contexts/{Domain}Context.tsx` |
| Components | apps/web | `src/components/{Domain}/*.tsx` |

---

## TDD Cycle

```
WRITE test → RUN test → VERIFY RED → IMPLEMENT → RUN test → VERIFY GREEN → COMPLETE
```

**Cannot skip any step.** Per-task, not batched.

---

## Finding Types

| Type | Meaning | Created By |
|------|---------|------------|
| `pattern` | Existing code pattern to follow | Analysis |
| `integration_point` | Where changes are needed | Analysis |
| `risk` | Potential issues to watch | Analysis |
| `gap` | Missing capability | Analysis |
| `existing_test` | Related test to consider | Analysis |
| `verification` | Drift check result | Analysis (VERIFY) |

---

## Task Status

| Status | Meaning |
|--------|---------|
| `planned` | Ready to start |
| `in_progress` | Currently being worked |
| `complete` | Done and tested |
| `blocked` | Failed, needs intervention |

---

## Test Types

| Type | When | Focus |
|------|------|-------|
| `unit` | Single function | Isolated I/O |
| `integration` | Multiple components | Cross-boundary |
| `acceptance` | User-facing | Observable result |

---

## Feature Archetypes

| Archetype | Description | Required Patterns |
|-----------|-------------|-------------------|
| Service | External integration | All 7 |
| Domain | Business logic only | 1, 4 |
| Infrastructure | Internal services | 1, 2, 3, 5 |
| Hybrid | Service + complex domain | All 7 |

---

## Common Commands

### Check Session Progress

```javascript
schema.load("platform-features")
store.query("platform-features")
session = store.query("PlatformFeatureSession", "platform-features", { name: "NAME" })[0]
console.log(session.status)
```

### Count Tasks by Status

```javascript
schema.load("platform-feature-spec")
store.query("platform-feature-spec")
tasks = store.query("ImplementationTask", "platform-feature-spec", { sessionId: "ID" })
console.log({
  planned: tasks.filter(t => t.status === "planned").length,
  complete: tasks.filter(t => t.status === "complete").length,
  blocked: tasks.filter(t => t.status === "blocked").length
})
```

### Resume Implementation

```javascript
existingRun = store.query("ImplementationRun", "platform-feature-spec", {
  sessionId: "ID",
  status: "in_progress"
})[0]
// Then invoke /platform-feature-implementation and select "Resume"
```

### Unblock a Task

```javascript
store.update("task-id", "ImplementationTask", "platform-feature-spec", {
  status: "planned"
})
```

---

## Anti-Patterns Checklist

❌ Domain logic in apps/web  
❌ Multiple domain.ts files (mixin.ts, hooks.ts)  
❌ `useState` for store in React (use `useRef`)  
❌ Missing `observer()` on components  
❌ Batch TDD (all tests then all implementations)  
❌ Provider types in interface (use domain types)  
❌ Direct service import in MST (use `getEnv()`)  
❌ UI state in schema (`isLoading`, `isSelected`)

---

## File Structure Reference

### Generated Auth Feature

```
packages/state-api/src/auth/
├── types.ts              # IAuthService, AuthSession, etc.
├── supabase.ts           # SupabaseAuthService
├── mock.ts               # MockAuthService
├── domain.ts             # AuthDomain + createAuthStore()
├── index.ts              # Barrel exports
└── __tests__/
    └── domain.test.ts    # Domain tests

apps/web/src/
├── contexts/
│   └── AuthContext.tsx   # AuthProvider, useAuth
└── pages/
    └── AuthDemoPage.tsx  # Proof-of-work page
```

### Wavesmith Data

```
.schemas/
├── platform-features/
│   ├── schema.json
│   └── data/
│       ├── PlatformFeatureSession.json
│       ├── Requirement.json
│       └── DesignDecision.json
└── platform-feature-spec/
    ├── schema.json
    └── data/
        ├── AnalysisFinding.json
        ├── IntegrationPoint.json
        ├── ImplementationTask.json
        └── TestSpecification.json
```

---

## Documentation Map

| Document | Content |
|----------|---------|
| [01-overview](01-overview.md) | Philosophy, pipeline at a glance |
| [02-pipeline/](02-pipeline/) | Skill-by-skill guides |
| [03-patterns](03-patterns.md) | 7 architectural patterns |
| [04-wavesmith](04-wavesmith.md) | Entity layer, operations |
| [05-modular-usage](05-modular-usage.md) | Sessions, resuming, iteration |
| [06-reference](06-reference.md) | This quick reference |
