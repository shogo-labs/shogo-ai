# Working with Wavesmith

Wavesmith is the schema-first reactive state system that powers the pipeline. It captures intent as queryable entities and enables "runtime as projection over intent."

## What Wavesmith Does

1. **Stores schemas** - Entity definitions with relationships and constraints
2. **Manages data** - CRUD operations on entity instances
3. **Executes views** - Queries and templates over stored data
4. **Persists state** - Data survives across sessions

The pipeline skills use Wavesmith to capture user intent, track progress, and maintain traceability from requirements to code.

---

## The Two-Schema Model

The pipeline uses two schemas that work together:

### `platform-features` - Discovery/Intent Schema

Captures what the user wants and design decisions made.

| Entity | Purpose | Created By |
|--------|---------|------------|
| `PlatformFeatureSession` | Container for feature development | Discovery |
| `Requirement` | What the feature must accomplish | Discovery |
| `DesignDecision` | Key design choices with rationale | Design |

### `platform-feature-spec` - Implementation Schema

Captures how to build it and execution progress.

| Entity | Purpose | Created By |
|--------|---------|------------|
| `AnalysisFinding` | Codebase exploration results | Analysis |
| `IntegrationPoint` | Where code changes are needed | Analysis |
| `ImplementationTask` | Work items with acceptance criteria | Spec |
| `TestSpecification` | Given/When/Then test cases | Tests |
| `ImplementationRun` | Execution tracking | Implementation |
| `TaskExecution` | Per-task TDD cycle tracking | Implementation |

### Cross-Schema References

Entities reference each other across schemas via `sessionId`:

```
platform-features                    platform-feature-spec
┌─────────────────────┐            ┌──────────────────────┐
│ PlatformFeatureSession │◄────────│ AnalysisFinding      │
│   id: "auth-layer"    │ sessionId │   sessionId: "auth-layer"
└─────────────────────┘            └──────────────────────┘
         │                                    │
         │ session                            │ finding
         ▼                                    ▼
┌─────────────────────┐            ┌──────────────────────┐
│ Requirement         │            │ IntegrationPoint     │
│   session: "auth-layer"│            │   finding: "find-001"│
└─────────────────────┘            └──────────────────────┘
                                             │
                                             │ integrationPoint
                                             ▼
                                   ┌──────────────────────┐
                                   │ ImplementationTask   │
                                   │   integrationPoint: "ip-001"
                                   └──────────────────────┘
                                             │
                                             │ task
                                             ▼
                                   ┌──────────────────────┐
                                   │ TestSpecification    │
                                   │   task: "task-001"   │
                                   └──────────────────────┘
```

---

## Entity Deep Dive

### PlatformFeatureSession

The root entity for a feature development session.

```json
{
  "id": "auth-layer",
  "name": "auth-layer",
  "intent": "Add authentication with Supabase so users can sign up and sign in",
  "status": "discovery",
  "affectedPackages": ["packages/state-api", "apps/web"],
  "schemaName": "auth-layer",
  "createdAt": 1764793352349,
  "updatedAt": 1764793352349
}
```

**Status flow**:
```
discovery → design → integration → testing → complete
```

### Requirement

Captures what the feature must accomplish.

```json
{
  "id": "req-001",
  "session": "auth-layer",
  "description": "Users can sign up with email and password",
  "priority": "must",
  "status": "proposed"
}
```

**Priority values**: `must`, `should`, `could`  
**Status values**: `proposed`, `accepted`, `implemented`

### DesignDecision

Records design choices with rationale for traceability.

```json
{
  "id": "dd-001",
  "session": "auth-layer",
  "question": "What enhancement hooks will the domain need?",
  "decision": "enhanceModels: AuthSession.isExpired; enhanceRootStore: signIn, signOut, initialize",
  "rationale": "All hooks implemented in single domain.ts using createStoreFromScope()"
}
```

### AnalysisFinding

Results from codebase exploration.

```json
{
  "id": "find-001",
  "sessionId": "auth-layer",
  "type": "pattern",
  "description": "Service interface pattern found in persistence module",
  "location": "packages/state-api/src/persistence/",
  "relevantCode": "interface IPersistenceService { ... }",
  "recommendation": "Follow same pattern: IAuthService in types.ts",
  "createdAt": 1764793352349
}
```

**Type values**: `pattern`, `integration_point`, `risk`, `gap`, `existing_test`, `verification`

### IntegrationPoint

Where code changes are needed.

```json
{
  "id": "ip-001",
  "sessionId": "auth-layer",
  "finding": "find-001",
  "package": "packages/state-api",
  "filePath": "src/auth/types.ts",
  "targetFunction": null,
  "changeType": "add",
  "description": "Create IAuthService interface",
  "rationale": "Service abstraction enables testing and provider swapping",
  "createdAt": 1764793352349
}
```

**changeType values**: `add`, `modify`, `extend`, `remove`

### ImplementationTask

Work item with acceptance criteria.

```json
{
  "id": "task-001",
  "sessionId": "auth-layer",
  "integrationPoint": "ip-001",
  "requirementId": "req-001",
  "description": "Create IAuthService interface",
  "acceptanceCriteria": [
    "types.ts exports IAuthService interface",
    "Interface defines signUp, signIn, signOut, getSession methods",
    "NO runtime imports - pure type definitions only"
  ],
  "dependencies": [],
  "status": "planned",
  "createdAt": 1764793352349
}
```

**Status values**: `planned`, `in_progress`, `complete`, `blocked`

### TestSpecification

Given/When/Then test case.

```json
{
  "id": "test-001",
  "sessionId": "auth-layer",
  "task": "task-003",
  "requirementId": "req-001",
  "scenario": "signIn returns session with valid credentials",
  "given": ["MockAuthService configured", "No current session"],
  "when": "signIn({ email: 'test@example.com', password: 'valid' }) called",
  "then": ["Returns AuthSession", "store.isAuthenticated becomes true"],
  "testType": "unit",
  "targetFile": "packages/state-api/src/auth/__tests__/domain.test.ts",
  "createdAt": 1764793352349
}
```

**testType values**: `unit`, `integration`, `acceptance`

### ImplementationRun

Tracks a single execution of the implementation skill.

```json
{
  "id": "run-001",
  "sessionId": "auth-layer",
  "status": "in_progress",
  "currentTaskId": "task-003",
  "completedTasks": ["task-001", "task-002"],
  "failedTasks": [],
  "startedAt": 1764793352349
}
```

**Status values**: `in_progress`, `blocked`, `complete`, `failed`

### TaskExecution

Per-task TDD cycle tracking.

```json
{
  "id": "exec-001",
  "runId": "run-001",
  "taskId": "task-003",
  "status": "test_passing",
  "testFilePath": "src/auth/__tests__/domain.test.ts",
  "implementationFilePath": "src/auth/domain.ts",
  "testOutput": "8/8 tests passing",
  "retryCount": 0,
  "startedAt": 1764793352349,
  "completedAt": 1764793360000
}
```

**Status values**: `pending`, `test_written`, `test_failing`, `implementing`, `test_passing`, `failed`

---

## Wavesmith Operations

Skills interact with Wavesmith through these operations:

### Schema Operations

```javascript
// Load existing schema
schema.load("platform-features")

// Create/update schema
schema.set({
  name: "my-feature",
  format: "enhanced-json-schema",
  payload: schemaDefinition
})

// Get schema definition
schema.load("platform-features")

// List all schemas
schema.list()
```

### Data Operations

```javascript
// Load all data for a schema
store.query("platform-features")

// Load single collection
store.query("Requirement", "platform-features")
```

### Store Operations

```javascript
// Create entity
store.create("Requirement", "platform-features", {
  id: "req-001",
  session: "auth-layer",
  description: "Users can sign up",
  priority: "must",
  status: "proposed"
})

// Get entity by ID
store.get("req-001", "Requirement", "platform-features")

// List entities (with optional filter)
store.query("Requirement", "platform-features", { session: "auth-layer" })

// Update entity
store.update("req-001", "Requirement", "platform-features", {
  status: "accepted"
})
```

### View Operations

```javascript
// Execute a query view
view.execute("platform-features", "requirementsBySession", { sessionId: "auth-layer" })

// Project view output to file
view.project("platform-features", "requirementReport", {
  output_path: "./reports/requirements.md"
})
```

---

## How Skills Use Wavesmith

### Discovery Skill

```javascript
// Create session
store.create("PlatformFeatureSession", "platform-features", {
  id: "auth-layer",
  name: "auth-layer",
  intent: "Add authentication with Supabase",
  status: "discovery",
  createdAt: Date.now()
})

// Create requirements
store.create("Requirement", "platform-features", {
  id: "req-001",
  session: "auth-layer",
  description: "Users can sign up with email/password",
  priority: "must",
  status: "proposed"
})
```

### Analysis Skill

```javascript
// Load context
schema.load("platform-features")
store.query("platform-features")
session = store.query("PlatformFeatureSession", "platform-features", { name: "auth-layer" })[0]

// Load spec schema for findings
schema.load("platform-feature-spec")
store.query("platform-feature-spec")

// Create findings
store.create("AnalysisFinding", "platform-feature-spec", {
  id: "find-001",
  sessionId: session.id,
  type: "pattern",
  description: "Service interface pattern in persistence",
  location: "packages/state-api/src/persistence/",
  createdAt: Date.now()
})

// Create integration points
store.create("IntegrationPoint", "platform-feature-spec", {
  id: "ip-001",
  sessionId: session.id,
  finding: "find-001",
  package: "packages/state-api",
  filePath: "src/auth/types.ts",
  changeType: "add",
  description: "Create IAuthService interface",
  createdAt: Date.now()
})
```

### Design Skill

```javascript
// Load context
schema.load("platform-features")
store.query("platform-features")
session = store.query("PlatformFeatureSession", "platform-features", { name: "auth-layer" })[0]

// Create domain schema
schema.set({
  name: session.name,
  format: "enhanced-json-schema",
  payload: authSchema
})

// Record design decisions
store.create("DesignDecision", "platform-features", {
  id: "dd-001",
  session: session.id,
  question: "What enhancement hooks will the domain need?",
  decision: "enhanceModels: AuthSession.isExpired; enhanceRootStore: signIn, signOut",
  rationale: "All hooks in single domain.ts"
})

// Update session status
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  schemaName: session.name,
  status: "integration"
})
```

### Implementation Skill

```javascript
// Create run record
store.create("ImplementationRun", "platform-feature-spec", {
  id: "run-001",
  sessionId: session.id,
  status: "in_progress",
  completedTasks: [],
  failedTasks: [],
  startedAt: Date.now()
})

// Track task execution
store.create("TaskExecution", "platform-feature-spec", {
  id: "exec-001",
  runId: "run-001",
  taskId: "task-001",
  status: "pending",
  startedAt: Date.now()
})

// Update as TDD progresses
store.update("exec-001", "TaskExecution", "platform-feature-spec", {
  status: "test_failing",
  testFilePath: "src/auth/__tests__/types.test.ts"
})

// Mark complete
store.update("exec-001", "TaskExecution", "platform-feature-spec", {
  status: "test_passing",
  completedAt: Date.now()
})
```

---

## Querying Session State

To inspect current state at any point:

```javascript
// What sessions exist?
schema.load("platform-features")
store.query("platform-features")
sessions = store.query("PlatformFeatureSession", "platform-features")

// What requirements for this session?
requirements = store.query("Requirement", "platform-features", { session: "auth-layer" })

// What design decisions?
decisions = store.query("DesignDecision", "platform-features", { session: "auth-layer" })

// What analysis findings?
schema.load("platform-feature-spec")
store.query("platform-feature-spec")
findings = store.query("AnalysisFinding", "platform-feature-spec", { sessionId: "auth-layer" })

// What tasks and their status?
tasks = store.query("ImplementationTask", "platform-feature-spec", { sessionId: "auth-layer" })
```

---

## Traceability Chain

Wavesmith enables complete traceability from code back to intent:

```
User Intent
    │
    ▼
PlatformFeatureSession.intent
    │
    ▼
Requirement.description
    │
    ▼
AnalysisFinding.recommendation
    │
    ▼
IntegrationPoint.description
    │
    ▼
ImplementationTask.acceptanceCriteria
    │
    ▼
TestSpecification.scenario
    │
    ▼
Generated Code + Tests
```

Every piece of generated code can be traced back through this chain to the original user request.

---

## Data Persistence

Wavesmith persists data to `.schemas/` directory:

```
.schemas/
├── platform-features/
│   ├── schema.json              # Schema definition
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
        ├── TestSpecification.json
        ├── ImplementationRun.json
        └── TaskExecution.json
```

Data is JSON, human-readable, and version-controllable.
