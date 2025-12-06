---
name: platform-feature-implementation
description: >
  Execute TDD implementation from tasks and test specifications. Use after
  platform-feature-tests when tasks and test specs are ready. Implements each
  task in dependency order: write test (RED), implement code, verify pass
  (GREEN). Invoke when ready to "implement the feature", "start implementing",
  "execute the plan", "run TDD", or when session status=testing and test specs
  are complete.
---

# Platform Feature Implementation

Execute TDD implementation from tasks and test specifications.

## Input

- `PlatformFeatureSession` with status=`testing` or `implementation`
- `ImplementationTask` entities with dependencies and acceptance criteria
- `TestSpecification` entities with Given/When/Then format
- `IntegrationPoint` entities with file paths
- `AnalysisFinding` entities (patterns to follow, risks to watch)
- Domain schema from design phase

## Output

- Actual code files (types.ts, implementations, mocks, tests)
- Updated `ImplementationTask.status` to `complete` or `blocked`
- `ImplementationRun` entity tracking the execution
- `TaskExecution` entities for each task attempt
- Session status → `complete`

---

## Workflow

### Phase 1: Load Context

```javascript
// Load session context
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })

// Load implementation artifacts
schema.load("platform-feature-spec")
data.loadAll("platform-feature-spec")
tasks = store.list("ImplementationTask", "platform-feature-spec", { sessionId: session.id })
testSpecs = store.list("TestSpecification", "platform-feature-spec", { sessionId: session.id })
integrationPoints = store.list("IntegrationPoint", "platform-feature-spec", { sessionId: session.id })
findings = store.list("AnalysisFinding", "platform-feature-spec", { sessionId: session.id })

// Load domain schema if exists
if (session.schemaName) {
  schema.load(session.schemaName)
}
```

Present context summary:
```
Session: {name}
Status: {status}

Tasks: {total} ({pending} pending, {in_progress} in progress, {complete} complete)
Test Specs: {count}
Integration Points: {count}

Domain Schema: {schemaName or "none"}

Key patterns from analysis:
- {pattern finding 1}
- {pattern finding 2}

Risks identified:
- {risk finding 1}

Ready to begin implementation?
```

### Phase 2: Pre-Implementation Verification

**Check for existing run:**
```javascript
const existingRun = store.list("ImplementationRun", "platform-feature-spec", {
  sessionId: session.id,
  status: "in_progress"
})[0]

if (existingRun) {
  // Resume capability
}
```

If resuming:
```
Found existing implementation run from {date}.
Completed: {n}/{total} tasks
Last task: {taskDescription}

Options:
1. Resume from where we left off
2. Restart from beginning (discards progress)

Which approach?
```

**Run analysis verification** (invoke analysis skill in verify mode):
- Check if analysis findings are stale (>7 days)
- Validate IntegrationPoints still match codebase
- If drift detected, pause and report

```
Analysis Verification:
- Findings age: {days} days
- Integration points: {validated}/{total} valid

{If drift detected}
⚠️ Drift detected in {n} integration points. Run full re-analysis?
```

### Phase 3: Order Tasks

Build dependency graph and compute execution order:

```javascript
// Topological sort tasks
const ordered = topologicalSort(tasks)

// Identify dependency levels
const levels = computeLevels(tasks)
```

Present execution plan:
```
Execution Order (dependency-sorted):

Level 0 (no dependencies):
  [task-001] Create IAuthService interface
  [task-002] Add auth dependencies

Level 1:
  [task-003] Implement SupabaseAuthService (depends: task-001)
  [task-004] Implement MockAuthService (depends: task-001)

Level 2:
  [task-005] Create auth domain store (depends: task-001, task-003)

...

Total: {n} tasks across {m} dependency levels

Proceed with implementation?
```

### Phase 4: TDD Loop

Create implementation run record:
```javascript
store.create("ImplementationRun", "platform-feature-spec", {
  id: `run-${Date.now()}`,
  sessionId: session.id,
  status: "in_progress",
  completedTasks: [],
  failedTasks: [],
  startedAt: Date.now()
})
```

**For each task in dependency order:**

#### 4.1 Task Setup

```javascript
store.create("TaskExecution", "platform-feature-spec", {
  id: `exec-${task.id}-${Date.now()}`,
  runId: currentRun.id,
  taskId: task.id,
  status: "pending",
  startedAt: Date.now()
})

store.update(task.id, "ImplementationTask", "platform-feature-spec", {
  status: "in_progress",
  updatedAt: Date.now()
})
```

Present task context:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: {task.description}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Integration Point: {integrationPoint.filePath}
Change Type: {integrationPoint.changeType}

Acceptance Criteria:
- {criterion 1}
- {criterion 2}

Test Specifications ({count}):
- {test-001}: {scenario}
- {test-002}: {scenario}
```

#### 4.2 Write Tests (RED Phase)

For each `TestSpecification` associated with this task:

1. **Generate test file** from Given/When/Then spec:

```typescript
/**
 * Generated from TestSpecification: {testSpec.id}
 * Task: {task.id}
 * Requirement: {requirementId}
 */

import { describe, test, expect, beforeEach } from "bun:test"
// ... imports based on task type

describe("{testSpec.scenario}", () => {
  // Given: {given statements as setup}
  beforeEach(() => {
    // Setup code derived from given statements
  })

  test("{when} -> {then[0]}", () => {
    // When: {when}
    // Then: {then[0]}
  })

  // Additional then assertions as separate tests if needed
})
```

2. **Run tests** - verify they fail (RED):

```bash
bun test {targetFile}
```

Expected: Tests should fail because implementation doesn't exist yet.

```
Test Status: RED (expected)
Failing: {n} tests
- {test name}: {error}

Proceeding to implementation...
```

Update execution:
```javascript
store.update(execId, "TaskExecution", "platform-feature-spec", {
  status: "test_failing",
  testFilePath: targetFile,
  testOutput: testOutput
})
```

#### 4.3 Implement Code

Based on `IntegrationPoint.changeType`:

| changeType | Action |
|------------|--------|
| `add` | Create new file with implementation |
| `modify` | Edit existing file |
| `extend` | Add to existing pattern (registry, router, etc.) |

**Consult pattern references:**
- Service interface → [patterns/02-service-interface.md](../platform-feature-analysis/references/patterns/02-service-interface.md)
- Environment extension → [patterns/03-environment-extension.md](../platform-feature-analysis/references/patterns/03-environment-extension.md)
- Enhancement hooks → [patterns/04-enhancement-hooks.md](../platform-feature-analysis/references/patterns/04-enhancement-hooks.md)
- Mock service → [patterns/05-mock-service-testing.md](../platform-feature-analysis/references/patterns/05-mock-service-testing.md)
- Provider sync → [patterns/06-provider-synchronization.md](../platform-feature-analysis/references/patterns/06-provider-synchronization.md)
- React context → [patterns/07-react-context-integration.md](../platform-feature-analysis/references/patterns/07-react-context-integration.md)

Present implementation:
```
Implementing: {task.description}

File: {filePath}
Action: {changeType}

{Show code being written/modified}

Implementation complete. Running tests...
```

#### 4.4 Verify Tests Pass (GREEN Phase)

```bash
bun test {targetFile}
```

**If tests pass:**
```
Test Status: GREEN ✅
Passing: {n}/{n} tests

All acceptance criteria met:
✅ {criterion 1}
✅ {criterion 2}
```

Update execution:
```javascript
store.update(execId, "TaskExecution", "platform-feature-spec", {
  status: "test_passing",
  implementationFilePath: implFile,
  testOutput: testOutput
})
```

**If tests fail (retry up to 3x):**
```
Test Status: RED (unexpected)
Failing: {n} tests
- {test name}: {error}

Analyzing failure... (attempt {n}/3)
```

On persistent failure (3+ attempts):
```javascript
store.update(execId, "TaskExecution", "platform-feature-spec", {
  status: "failed",
  errorMessage: lastError,
  retryCount: attempts
})

store.update(task.id, "ImplementationTask", "platform-feature-spec", {
  status: "blocked",
  updatedAt: Date.now()
})
```

Present:
```
Task blocked after {n} attempts.
Error: {lastError}

Options:
1. Skip and continue with non-dependent tasks
2. Pause implementation for manual intervention
3. Discard task changes and retry fresh

Which approach?
```

#### 4.5 Complete Task

After GREEN, update records:
```javascript
store.update(execId, "TaskExecution", "platform-feature-spec", {
  status: "test_passing",
  completedAt: Date.now()
})

store.update(task.id, "ImplementationTask", "platform-feature-spec", {
  status: "complete",
  updatedAt: Date.now()
})
```

Present:
```
Task Complete ✅

Progress: {completed}/{total} tasks
Remaining: {remaining tasks}

Continuing to next task...
```

### Phase 5: Integration Verification

After all tasks complete (or all non-blocked tasks):

1. **Run full test suite**:
```bash
bun test
```

2. **Run type check**:
```bash
bun run typecheck
```

3. **Run build**:
```bash
bun run build
```

Present results:
```
Integration Verification

Tests: {pass}/{total} passing
TypeCheck: {status}
Build: {status}

{If issues found}
Issues:
- {issue 1}
- {issue 2}
```

If issues found, analyze and fix before proceeding.

### Phase 6: Handoff

1. Update run record:
```javascript
store.update(currentRun.id, "ImplementationRun", "platform-feature-spec", {
  status: "complete",
  completedAt: Date.now()
})
```

2. Update session:
```javascript
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  status: "complete",
  updatedAt: Date.now()
})
```

3. Present final summary:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Session: {name}
Duration: {time}

Tasks: {completed}/{total} complete
Tests: {pass}/{total} passing

{If blocked tasks}
Blocked Tasks:
- {task}: {reason}

Files Created/Modified:
- {file 1}
- {file 2}
...

Feature is ready for review.
```

---

## Error Handling

### Task Failure Strategies

| Failure Type | Default Action | Alternatives |
|--------------|----------------|--------------|
| Test never passes | Mark blocked, skip | Retry with different approach, manual intervention |
| Dependency failed | Skip dependent tasks | Implement partial, ask user |
| File conflict | Stop and report | Merge manually, retry |
| Build failure | Analyze, fix | Revert last commit, pause |

### Recovery from Partial Progress

The skill can resume from any point using `ImplementationRun` state:

```javascript
const existingRun = store.list("ImplementationRun", "platform-feature-spec", {
  sessionId: session.id,
  status: "in_progress"
})[0]

if (existingRun) {
  const completedIds = new Set(existingRun.completedTasks)
  const remainingTasks = tasks.filter(t => !completedIds.has(t.id))
  // Resume from remaining tasks
}
```

---

## Status Flow

```
[Tests]
     ↓ status=testing
[Analysis: Verify] ← Invoked by this skill
     ↓ status=implementation
[Implementation] ← This skill
     ↓
  For each task:
     RED → GREEN
     ↓
[Integration Verification]
     ↓ status=complete
[Done]
```

---

## References

- [tdd-workflow.md](references/tdd-workflow.md) - Detailed RED/GREEN cycle
- [test-templates.md](references/test-templates.md) - Test generation patterns
- [../platform-feature-analysis/references/patterns/](../platform-feature-analysis/references/patterns/) - Implementation patterns
