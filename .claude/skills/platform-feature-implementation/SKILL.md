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

- `FeatureSession` with status=`testing` or `implementation`
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

## Modes

This skill operates in two modes based on user request:

| Mode | When to Use | Executes |
|------|-------------|----------|
| **Orchestrate** | "implement the feature", "run full TDD", no specific task mentioned | All tasks in dependency order with parallel execution where possible |
| **Single-Task** | "implement task-003", when invoked by orchestrator agent with specific task ID | One specific task only |

### Mode Detection

**When you (Claude) are invoked with this skill:**

1. Load session context from Wavesmith (Phase 1)
2. Check if user mentioned a specific task ID or task name:
   - User says: "implement task-003" → **Single-task mode**
   - User says: "implement the feature" → **Orchestrate mode**
   - Agent instructs: "Focus on task-003 only" → **Single-task mode**
3. If single-task mode detected:
   - Extract task ID from user request
   - Skip to **Workflow: Single-Task Mode** (see below)
4. If orchestrate mode (default):
   - Continue with **Workflow: Orchestrate Mode** (see below)

---

## Workflow: Orchestrate Mode

**Use when**: Implementing entire feature with all tasks

### Phase 1: Load Context

```javascript
// Load session context and all implementation artifacts
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("FeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })
tasks = store.list("ImplementationTask", "platform-features", { session: session.id })
testSpecs = store.list("TestSpecification", "platform-features", { task: tasks.map(t => t.id) })
integrationPoints = store.list("IntegrationPoint", "platform-features", { session: session.id })
findings = store.list("AnalysisFinding", "platform-features", { session: session.id })

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
const existingRun = store.list("ImplementationRun", "platform-features", {
  session: session.id,
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

### Phase 3: Compute Dependency Levels & Present Execution Plan

**Compute dependency graph:**

1. For each task, examine the `dependencies` field (array of task IDs referencing other tasks)
2. Compute dependency levels using topological sort:
   - **Level 0**: Tasks with empty `dependencies` array
   - **Level 1**: Tasks whose dependencies are all in Level 0
   - **Level N**: Tasks whose dependencies are all in levels < N
3. Group tasks by level

**Algorithm**:
- Start with all tasks that have no dependencies (Level 0)
- For each subsequent level, find tasks whose dependencies are all satisfied by previous levels
- Continue until all tasks are assigned to a level

**Present execution plan to user:**

```
Execution Plan: {total} tasks across {n} dependency levels

Level 0 ({count} task{s}):
  → [task-001] Create core interfaces and types

Level 1 ({count} tasks - PARALLEL):
  → [task-002] Implement service interface
  → [task-003] Add utility functions

Level 2 ({count} tasks - PARALLEL):
  → [task-004] Implement provider A (depends: task-002)
  → [task-005] Implement provider B (depends: task-002)

Level 3 ({count} task{s}):
  → [task-006] Wire up integration (depends: task-004, task-005)

Level 4 ({count} task{s}):
  → [task-007] Add integration tests (depends: task-006)

Estimated speedup: ~40% (7 sequential → 4 parallel levels)

Proceed with parallel execution? (yes/no)
```

**Wait for user approval** before proceeding to Phase 4.

**Note**: Mark levels with 2+ tasks as "PARALLEL" in the output.

**CRITICAL TRANSITION**: After user approves, you MUST proceed to Phase 4 (Orchestrated TDD Execution). **Do NOT execute TDD yourself**. Instead, spawn subagents using the Task tool, and instruct each subagent to invoke this skill in single-task mode.

---

## Schema-First Principle

**NEVER hand-code MST models.** Always use the schematic pipeline:

1. Domain entities defined in ArkType scope (translate from design phase schema)
2. `domain()` generates MST models + collections + root store with auto-composed CollectionPersistable
3. Enhancements add domain behavior:
   - `models`: Computed views on entities
   - `collections`: Query methods
   - `rootStore`: Domain actions, CRUD operations

### The domain.ts Pattern

Every feature MUST have a `domain.ts` that exports:
- `{Feature}Domain` - ArkType scope defining entities
- `{feature}Domain` - Named domain result from `domain({ name, from, enhancements })`

**CRITICAL**: `domain.name` MUST match the schema name from the design skill (stored in `.schemas/{name}/schema.json`).

See [domain-pattern.md](references/domain-pattern.md) for the full template and examples.

### What NOT to Do

❌ Don't create `mixin.ts` with hand-coded MST models
❌ Don't use `types.model()` directly for domain entities
❌ Don't create standalone `hooks.ts` applied to manual models
❌ Don't define MST models inline in React contexts
❌ Don't manually compose CollectionPersistable (it's auto-composed)
❌ Don't create custom context/provider per domain (use DomainProvider)

✅ Always use `domain()` with inline enhancements
✅ Let the schematic pipeline generate MST boilerplate
✅ Add behavior via enhancements, not manual composition
✅ Use `useDomains()` hook for React access

---

### Phase 4: Orchestrated TDD Execution

Create implementation run record:
```javascript
store.create("ImplementationRun", "platform-features", {
  id: `run-${Date.now()}`,
  session: session.id,
  status: "in_progress",
  completedTasks: [],
  failedTasks: [],
  startedAt: Date.now()
})
```

**For each dependency level (in order):**

#### 4.1 Spawn Agents for Level Tasks

**IMPORTANT**: You (the orchestrator) do NOT execute TDD yourself. You spawn subagents who will invoke this skill.

For EVERY task in the current level (whether 1 task or multiple):

1. **Use the Task tool** to spawn a foreground subagent per task
2. **Instruct the subagent to invoke this skill** in single-task mode
3. **Set `run_in_background: false`** so agents have MCP access to Wavesmith

**How to spawn an agent:**

You must call the Task tool with these parameters:
- `description`: Brief description of what this agent will do
- `subagent_type`: "general-purpose"
- `prompt`: Instructions telling the agent to invoke /platform-feature-implementation skill
- `run_in_background`: false (CRITICAL for MCP access)

**Agent prompt template:**

When you invoke the Task tool, use this prompt structure:

```
Implement task {task.id} for the {session.name} feature using TDD.

Instructions:
1. Invoke the /platform-feature-implementation skill by typing: /platform-feature-implementation
2. When the skill loads and asks what to implement, respond with: "implement task {task.id} only"
3. The skill will detect single-task mode and guide you through the TDD cycle for this one task
4. Follow all TDD guidelines (RED → GREEN cycle)
5. The skill will use Wavesmith MCP tools to track your progress
6. Report when the task completes (tests pass) or fails

Task details:
- ID: {task.id}
- Name: {task.name}
- Description: {task.description}
- Acceptance Criteria: {task.acceptanceCriteria}

Focus exclusively on implementing this one task. Do not work on any other tasks.
```

**Concrete example - Level 1 with 2 tasks:**

When you reach Level 1, you should make TWO Task tool calls (in the same message for parallelization):

**First agent (for task-002):**
```
Tool: Task
Parameters:
  description: "Implement task-002"
  subagent_type: "general-purpose"
  prompt: "Implement task task-002 for the ddl-generator feature using TDD.

Instructions:
1. Invoke the /platform-feature-implementation skill by typing: /platform-feature-implementation
2. When the skill asks what to implement, respond with: 'implement task-002 only'
3. The skill will guide you through TDD for this task
4. Follow all TDD guidelines (RED → GREEN cycle)

Task: Implement service interface
Description: {task.description}

Focus exclusively on task-002."
  run_in_background: false
```

**Second agent (for task-003):**
```
Tool: Task
Parameters:
  description: "Implement task-003"
  subagent_type: "general-purpose"
  prompt: "Implement task task-003 for the ddl-generator feature using TDD.

Instructions:
1. Invoke the /platform-feature-implementation skill by typing: /platform-feature-implementation
2. When the skill asks what to implement, respond with: 'implement task-003 only'
3. The skill will guide you through TDD for this task
4. Follow all TDD guidelines (RED → GREEN cycle)

Task: Add utility functions
Description: {task.description}

Focus exclusively on task-003."
  run_in_background: false
```

**You spawn these agents by making actual Task tool calls**, not by writing JavaScript code.

2. **Wait for all agents in the level to complete** (blocking wait using TaskOutput)

3. **Verify completion** by checking Wavesmith:
```javascript
// After agents complete, verify task status
for (task of currentLevelTasks) {
  const updatedTask = store.get(task.id, "ImplementationTask", "platform-features")

  if (updatedTask.status === "complete") {
    console.log(`✅ ${task.name} completed`)
  } else if (updatedTask.status === "blocked") {
    console.log(`❌ ${task.name} blocked - marking dependent tasks`)
    // Mark tasks that depend on this one as blocked
  }
}
```

4. **Present level completion:**
```
Level {n} Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Completed:
✅ [task-002] {task.name}
✅ [task-003] {task.name}

Time: {duration}
Progress: {completed}/{total} tasks

Continuing to Level {n+1}...
```

#### 4.2 Handle Blocked Tasks

If any task in the level failed:
- Identify all tasks that depend on the failed task
- Mark those tasks as `blocked` in Wavesmith
- Do NOT spawn agents for blocked tasks in subsequent levels
- Continue with tasks that don't depend on failed ones

```javascript
// Example: If task-002 fails, block task-005 which depends on it
if (task002.status === "blocked") {
  const dependentTasks = tasks.filter(t =>
    t.dependencies.includes(task002.id)
  )

  for (const dep of dependentTasks) {
    store.update(dep.id, "ImplementationTask", "platform-features", {
      status: "blocked",
      updatedAt: Date.now()
    })
  }
}
```

#### 4.3 Continue to Next Level

After all tasks in current level complete (or are blocked):
- Move to next dependency level
- Repeat 4.1-4.2 until all levels processed

**Important**: The orchestrator (you, the main thread) does NOT execute the TDD loop directly. Agents do that by invoking this skill in single-task mode.

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

**Proof-of-Work Verification with Browser Automation**

The proof-of-work page validates the complete feature integration. After passing unit tests, typecheck, and build, use Chrome DevTools MCP for browser-based verification.

**Pre-requisites**:
- Unit tests pass (`bun test`)
- Type check passes (`bun run typecheck`)
- Build succeeds (`bun run build`)
- Chrome DevTools MCP server available

**Step 1: Start Dev Server**

```bash
# Start Vite dev server in background
cd apps/web && bun run dev &
```

Wait for server ready message. Default URL: `http://localhost:5173`

**Step 2: Navigate and Basic Verification**

Using Chrome DevTools MCP tools:

1. `navigate_page` to `http://localhost:5173/{demo-page-path}`
2. `wait_for` main content element (e.g., `[data-testid="demo-container"]`)
3. `list_console_messages` to check for errors
4. `take_screenshot` for visual baseline

**Success criteria**:
- No JavaScript errors in console
- No unhandled promise rejections
- Main UI elements render correctly

**Step 3: Service/Persistence Verification**

**External Service Features** (auth, payments, analytics, etc.):

```javascript
// Use evaluate_script to verify real service
evaluate_script: "window.__services?.auth?.constructor?.name !== 'MockAuthService'"

// Verify real API calls
list_network_requests // Should show calls to real endpoints (not localhost mocks)
```

1. Page renders without errors
2. Real provider service injected (not MockService)
3. Real credentials from env vars (`VITE_*`, etc.)
4. Real data displays from external service
5. Error states tested with real service responses

**Internal Domain Features** (workspace management, project tracking, etc.):

```javascript
// Use evaluate_script to verify real persistence
evaluate_script: "window.__persistence?.constructor?.name !== 'NullPersistence'"
```

1. Page renders without errors
2. Real persistence service (`MCPPersistence` for browser-side demos)
3. **NOT** `NullPersistence` (mocks are for unit tests only)
4. Data round-trips through save/load cycle:
   - Create entity via UI (`click`, `fill_form`)
   - `navigate_page` to same URL (refresh)
   - `wait_for` entity still visible
5. CRUD operations persist to disk and reload correctly

**Step 4: Interaction Verification**

Test core user flows using input tools:

```
click -> "Create" button
wait_for -> Form modal visible
fill_form -> { name: "Test Entity", ... }
click -> "Save"
wait_for -> Success indicator
list_console_messages -> No new errors
```

**Step 5: Performance Check (Optional)**

For performance-critical features:

```
performance_start_trace
navigate_page -> demo URL
wait_for -> fully loaded
performance_stop_trace
performance_analyze_insight
```

**Acceptable thresholds**:
- First Contentful Paint: < 2s
- No blocking long tasks > 50ms

**Step 6: Production Build Verification (Optional)**

If dev server tests pass, verify production build:

```bash
bun run build && bun run preview
# Navigate to http://localhost:4173/{demo-page-path}
```

Repeat Steps 2-4 against the preview server to catch build-only issues.

**Test vs Proof-of-Work distinction:**

| Context | Persistence | Service Layer | Verification |
|---------|-------------|---------------|--------------|
| Unit tests | `NullPersistence` | `MockService` | `bun test` |
| Proof-of-work | `MCPPersistence` (browser) | Real provider | Chrome DevTools MCP |

**What NullPersistence is for:**
- Unit tests only (fast, isolated, no file I/O)
- **Never** in proof-of-work pages
- **Never** for validating feature integration

**If Browser Tests Fail**

Do NOT mark the feature complete. Instead:

1. Capture screenshot and console logs
2. Identify failure point (render, service, interaction)
3. Return to TDD cycle if code changes needed
4. Re-run browser verification after fixes

The implementation is only complete when both:
- All unit tests pass (TDD cycle)
- Browser verification succeeds (proof-of-work)

See [08-browser-verification.md](references/08-browser-verification.md) for detailed patterns and tool reference.

### Phase 6: Handoff

1. Update run record:
```javascript
store.update(currentRun.id, "ImplementationRun", "platform-features", {
  status: "complete",
  completedAt: Date.now()
})
```

2. Update session:
```javascript
store.update(session.id, "FeatureSession", "platform-features", {
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

## Workflow: Single-Task Mode

**Use when**: Invoked by orchestrator agent to implement one specific task

This mode is triggered when:
- User explicitly mentions a task ID: "implement task-003"
- Agent prompt instructs: "Focus on task {task.id} only"
- User says: "work on [task description matching a single task]"

### Phase 1: Load Context and Identify Task

```javascript
// Load session context
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("FeatureSession", "platform-features", { name: "..." })[0]
tasks = store.list("ImplementationTask", "platform-features", { session: session.id })

// Identify which task to execute
// Extract task ID from user request or agent instruction
const taskId = extractTaskIdFromRequest(userRequest)  // e.g., "task-003"
const task = tasks.find(t => t.id === taskId)

if (!task) {
  console.error(`Task ${taskId} not found in session ${session.name}`)
  // List available tasks and ask user to clarify
  return
}

// Load related entities for this task only
const testSpecs = store.list("TestSpecification", "platform-features", {
  task: task.id
})
const integrationPoint = store.list("IntegrationPoint", "platform-features", {
  task: task.id
})[0]
```

Present task context:
```
Single-Task Mode: {task.name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Task ID: {task.id}
Description: {task.description}
Status: {task.status}

Dependencies: {dependencies.length}
{if dependencies}
  - {dep1.name}
  - {dep2.name}
{endif}

Test Specs: {testSpecs.length}
Integration Point: {integrationPoint.filePath}

Proceeding with TDD cycle...
```

### Phase 2: Validate Dependencies (Optional Check)

```javascript
// Verify all dependency tasks are complete
const incompleteDeps = task.dependencies.filter(depId => {
  const dep = tasks.find(t => t.id === depId)
  return dep.status !== "complete"
})

if (incompleteDeps.length > 0) {
  console.warn(`Warning: ${incompleteDeps.length} dependencies not complete`)
  console.warn(`This task may fail due to missing prerequisites`)
  // Continue anyway - orchestrator should handle this
}
```

### Phase 3: Execute TDD Cycle for This Task Only

Execute the **exact same TDD loop** as Orchestrate Mode Phase 4, but for **only this task**:

#### 3.1 Task Setup

```javascript
store.create("TaskExecution", "platform-features", {
  id: `exec-${task.id}-${Date.now()}`,
  task: task.id,
  status: "pending",
  startedAt: Date.now()
})

store.update(task.id, "ImplementationTask", "platform-features", {
  status: "in_progress",
  updatedAt: Date.now()
})
```

#### 3.2 Write Tests (RED Phase)

For each TestSpecification associated with this task:

1. **Generate test file** from Given/When/Then spec:

```typescript
/**
 * Generated from TestSpecification: {testSpec.id}
 * Task: {task.id}
 * Requirement: {requirement}
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
store.update(execId, "TaskExecution", "platform-features", {
  status: "test_failing",
  testFilePath: targetFile,
  testOutput: testOutput
})
```

### TDD Gate: Mandatory Test Execution

**CRITICAL**: Do NOT proceed to implementation (3.3) until tests have been:
1. Written to the test file
2. Executed with `bun test {testFile}`
3. Confirmed to be RED (failing)

**Gate Check**:
```
Before implementing {task.description}:
[ ] Test file created: {testFilePath}
[ ] Tests executed: bun test {testFilePath}
[ ] Status: RED (tests failing as expected)

Proceeding to implementation...
```

If tests pass before implementation, **STOP** — either:
- Tests are not testing new functionality (test is wrong)
- Implementation already exists (task may be duplicate)
- Tests are not correctly written (assertions never fire)

**Resolution**: Investigate and fix the test before proceeding. A passing test before implementation means the test cannot verify the code you're about to write.

#### 3.3 Implement Code

Based on `IntegrationPoint.changeType`:
- `add`: Create new file with implementation
- `modify`: Edit existing file
- `extend`: Add to existing pattern (registry, router, etc.)

**Consult pattern references:**
- [patterns/02-service-interface.md](../platform-feature-analysis/references/patterns/02-service-interface.md)
- [patterns/03-environment-extension.md](../platform-feature-analysis/references/patterns/03-environment-extension.md)
- [patterns/04-enhancement-hooks.md](../platform-feature-analysis/references/patterns/04-enhancement-hooks.md)
- [patterns/05-mock-service-testing.md](../platform-feature-analysis/references/patterns/05-mock-service-testing.md)
- [patterns/06-provider-synchronization.md](../platform-feature-analysis/references/patterns/06-provider-synchronization.md)
- [patterns/07-react-context-integration.md](../platform-feature-analysis/references/patterns/07-react-context-integration.md)

Write implementation code to make tests pass.

#### 3.4 Verify Tests Pass (GREEN Phase)

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

**GREEN Gate Check**:
```
Implementation complete for {task.description}:
[ ] Tests executed: bun test {testFilePath}
[ ] Status: GREEN (all tests passing)
[ ] No regressions: bun test (full suite)

Task complete.
```

Do NOT mark task complete until GREEN is confirmed via actual test execution.

Update execution:
```javascript
store.update(execId, "TaskExecution", "platform-features", {
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
store.update(execId, "TaskExecution", "platform-features", {
  status: "failed",
  errorMessage: lastError,
  retryCount: attempts
})

store.update(task.id, "ImplementationTask", "platform-features", {
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

#### 3.5 Complete Task

```javascript
store.update(execId, "TaskExecution", "platform-features", {
  status: "test_passing",
  completedAt: Date.now()
})

store.update(task.id, "ImplementationTask", "platform-features", {
  status: "complete",
  updatedAt: Date.now()
})
```

Present:
```
Task Complete ✅

Task: {task.name}
Status: COMPLETE (tests passing)
Duration: {time}

This task is done. Returning control to orchestrator.
```

### TDD Cycle Enforcement Summary

For EVERY task with TestSpecifications, the cycle MUST be:

| Step | Action | Validation | Cannot Skip |
|------|--------|------------|-------------|
| 1 | **WRITE** test file from specs | File exists | ❌ |
| 2 | **RUN** tests | `bun test {file}` executes | ❌ |
| 3 | **VERIFY** RED | Tests fail as expected | ❌ |
| 4 | **IMPLEMENT** code | Code written to files | ❌ |
| 5 | **RUN** tests again | `bun test {file}` executes | ❌ |
| 6 | **VERIFY** GREEN | All tests pass | ❌ |
| 7 | **MARK** complete | Task status updated | ❌ |

**Exception**: Tasks with no TestSpecifications (e.g., dependency-only tasks like "add packages") can skip steps 1-3, 5-6.

**Anti-pattern: Writing all tests then all implementations**
```
❌ WRONG:
  Write test-001, test-002, test-003
  Implement task-001, task-002, task-003
  Run all tests at end

✅ CORRECT (per task):
  Write test-001 → Run (RED) → Implement → Run (GREEN) → Complete
  Write test-002 → Run (RED) → Implement → Run (GREEN) → Complete
  Write test-003 → Run (RED) → Implement → Run (GREEN) → Complete
```

The TDD cycle provides immediate feedback and catches issues early. Batching defeats the purpose.

### Phase 4: Exit (No Integration or Handoff)

**Important**: Single-task mode does NOT perform:
- Integration verification (orchestrator handles this)
- Session status updates (orchestrator handles this)
- Full test suite runs (orchestrator may do this between levels)

Simply complete the task and exit. The orchestrator will:
- Wait for all tasks in the level to complete
- Check for failures
- Continue to next level

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
const existingRun = store.list("ImplementationRun", "platform-features", {
  session: session.id,
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

## Frontend Technology Defaults

When implementing features that involve frontend development (React components, UI, dashboards, etc.), use these defaults:

### Default Stack
- **UI Components**: shadcn/ui - accessible, customizable component library built on Radix UI
- **Styling**: Tailwind CSS - utility-first CSS framework
- **Icons**: Lucide React (included with shadcn/ui)

### Current Setup (apps/web)

The demo app has this stack configured:
- Tailwind CSS v4 with `@tailwindcss/vite` plugin
- Theme colors in `src/index.css` using `@theme` directive:
  - `--color-background`, `--color-foreground`, `--color-primary`, `--color-secondary`
  - `--color-card`, `--color-muted`, `--color-border`, `--color-ring`
- shadcn/ui foundation: `components.json`, `src/lib/utils.ts` with `cn()` helper
- Path alias `@/` configured in tsconfig and vite
- Button component as reference pattern in `src/components/ui/button.tsx`

### Implementation Patterns

**Use Tailwind classes instead of inline styles:**
```tsx
// ❌ Don't use inline styles
<div style={{ padding: '1rem', background: '#1e1e1e' }}>

// ✅ Use Tailwind classes
<div className="p-4 bg-card">
```

**Use cn() for conditional classes:**
```tsx
import { cn } from "@/lib/utils"

<button className={cn(
  "px-4 py-2 rounded-md font-bold",
  isActive ? "bg-primary text-primary-foreground" : "bg-secondary"
)}>
```

**Use shadcn components when available:**
```tsx
import { Button } from "@/components/ui/button"

<Button variant="default" size="sm">Click me</Button>
```

### Adding New shadcn Components

Follow the existing Button pattern in `src/components/ui/button.tsx`:
1. Create file in `src/components/ui/{component}.tsx`
2. Use `cva()` for variant definitions
3. Use `cn()` for class merging
4. Export component and variants

Available components to add: Card, Input, Label, Dialog, Sheet, Tabs, Badge, Separator.

---

## References

- [domain-pattern.md](references/domain-pattern.md) - **Schema-first domain.ts pattern (CRITICAL)**
- [tdd-workflow.md](references/tdd-workflow.md) - Detailed RED/GREEN cycle
- [test-templates.md](references/test-templates.md) - Test generation patterns
- [../platform-feature-analysis/references/patterns/](../platform-feature-analysis/references/patterns/) - Implementation patterns
