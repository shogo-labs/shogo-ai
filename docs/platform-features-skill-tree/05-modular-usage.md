# Modular Usage & Session Management

The pipeline supports both end-to-end execution and modular, resumable work. This guide covers session management, partial progress, and iterating on previous work.

## Session State Flow

Sessions progress through defined statuses:

```
┌───────────────────────────────────────────────────────────────┐
│                     Session Status Flow                        │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│   ┌─────────┐    ┌─────────┐    ┌───────────┐                │
│   │discovery│───►│ design  │───►│integration│                │
│   └─────────┘    └─────────┘    └─────┬─────┘                │
│        │              │               │                        │
│        │              │               ▼                        │
│        │              │         ┌─────────┐    ┌─────────┐   │
│        │              │         │ testing │───►│complete │   │
│        │              │         └─────────┘    └─────────┘   │
│        │              │               │                        │
│        │              ▼               ▼                        │
│        │        ┌──────────────────────────┐                  │
│        └───────►│ Can re-invoke skill to   │                  │
│                 │ iterate or resume        │                  │
│                 └──────────────────────────┘                  │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

| Status | Meaning | Next Skill |
|--------|---------|------------|
| `discovery` | Requirements being captured | Discovery or Analysis |
| `design` | Schema creation in progress | Design |
| `integration` | Analysis/spec work | Analysis or Spec |
| `testing` | Test specs or implementation | Tests or Implementation |
| `complete` | Feature fully implemented | — |

---

## Picking Up Where You Left Off

### Finding Existing Sessions

To resume work, first find your session:

```javascript
schema.load("platform-features")
store.query("platform-features")

// List all sessions
sessions = store.query("PlatformFeatureSession", "platform-features")

// Filter by status
inProgress = sessions.filter(s => s.status !== "complete")

// Find by name
authSession = sessions.find(s => s.name === "auth-layer")
```

### Checking Session Progress

See what's been completed:

```javascript
// Requirements
requirements = store.query("Requirement", "platform-features", { session: sessionId })
console.log(`Requirements: ${requirements.length}`)

// Design decisions
decisions = store.query("DesignDecision", "platform-features", { session: sessionId })
console.log(`Decisions: ${decisions.length}`)

// Load spec schema
schema.load("platform-feature-spec")
store.query("platform-feature-spec")

// Analysis findings
findings = store.query("AnalysisFinding", "platform-feature-spec", { sessionId })
console.log(`Findings: ${findings.length}`)

// Tasks
tasks = store.query("ImplementationTask", "platform-feature-spec", { sessionId })
byStatus = {
  planned: tasks.filter(t => t.status === "planned").length,
  in_progress: tasks.filter(t => t.status === "in_progress").length,
  complete: tasks.filter(t => t.status === "complete").length,
  blocked: tasks.filter(t => t.status === "blocked").length
}
console.log(`Tasks: ${JSON.stringify(byStatus)}`)
```

---

## Re-Running Skills

### When to Re-Run Discovery

Re-run Discovery when:
- Requirements have changed
- New requirements have emerged
- Initial scope was incomplete

What happens:
- New `Requirement` entities added
- Existing requirements can be updated
- Session stays in `discovery` status

### When to Re-Run Analysis

**EXPLORE mode** - Re-run after discovery changes:
- New requirements need pattern exploration
- Additional integration points needed
- Initial analysis missed patterns

**VERIFY mode** - Re-run before implementation:
- Check if analysis findings are still valid
- Detect codebase drift since spec was created
- Validate integration points still match

```javascript
// Analysis VERIFY mode checks for:
// - Files that have moved
// - Functions that were renamed
// - Patterns that changed

// If drift detected:
// "⚠️ Integration point ip-003 references src/auth/types.ts
//  but file structure has changed. Re-analyze?"
```

### When to Re-Run Design

Re-run Design when:
- Requirements changed after schema was created
- Enhancement hooks need adjustment
- Entity relationships need revision

What happens:
- Schema can be updated via `schema.set`
- New `DesignDecision` entities added
- Status returns to `design` if significant changes

### When to Re-Run Spec

Re-run Spec when:
- Integration points changed
- Task dependencies need adjustment
- Acceptance criteria need refinement

What happens:
- Tasks can be added, modified, or removed
- Dependencies recalculated
- Status returns to `testing`

### When to Re-Run Tests

Re-run Tests when:
- Tasks were modified
- Test coverage gaps identified
- Acceptance criteria refined

What happens:
- New `TestSpecification` entities created
- Existing specs can be updated
- Coverage report regenerated

---

## Resuming Implementation

Implementation tracks progress via `ImplementationRun`:

```javascript
// Check for existing run
schema.load("platform-feature-spec")
store.query("platform-feature-spec")

existingRun = store.query("ImplementationRun", "platform-feature-spec", {
  sessionId,
  status: "in_progress"
})[0]

if (existingRun) {
  console.log("Found existing run:")
  console.log(`Completed: ${existingRun.completedTasks.length}`)
  console.log(`Current: ${existingRun.currentTaskId}`)
  console.log(`Failed: ${existingRun.failedTasks.length}`)
}
```

### Resume Options

When resuming, implementation offers:

```
Found existing implementation run from 2 days ago.
Completed: 3/7 tasks
Last task: Create MockAuthService

Options:
1. Resume from where we left off
2. Restart from beginning (discards progress)

Which approach?
```

**Resume**: Picks up from last incomplete task  
**Restart**: Clears run record, starts fresh

---

## Handling Blocked Tasks

When tasks fail repeatedly:

```javascript
// Check blocked tasks
blocked = store.query("ImplementationTask", "platform-feature-spec", {
  sessionId,
  status: "blocked"
})

// Each blocked task has execution history
executions = store.query("TaskExecution", "platform-feature-spec", {
  taskId: blocked[0].id
})

lastExec = executions.sort((a, b) => b.startedAt - a.startedAt)[0]
console.log(`Error: ${lastExec.errorMessage}`)
console.log(`Attempts: ${lastExec.retryCount}`)
```

### Resolution Options

1. **Skip and continue** - Work on non-dependent tasks
2. **Manual fix** - Fix code manually, then resume
3. **Revise task** - Update acceptance criteria/approach
4. **Discard and retry** - Clear task state, try fresh

```javascript
// To unblock a task after manual fix:
store.update(taskId, "ImplementationTask", "platform-feature-spec", {
  status: "planned"  // Reset to planned
})
```

---

## Iterating on Design Decisions

Design decisions inform later skills. To revise:

### Update Enhancement Hooks Decision

```javascript
// Find existing decision
decisions = store.query("DesignDecision", "platform-features", {
  session: sessionId
})

hooksDecision = decisions.find(d => 
  d.question.includes("enhancement hooks")
)

// Update it
store.update(hooksDecision.id, "DesignDecision", "platform-features", {
  decision: "enhanceModels: AuthSession.isExpired, AuthSession.isActive; enhanceRootStore: signIn, signOut, initialize, refreshSession",
  rationale: "Added refreshSession action and isActive view per user feedback"
})
```

### Impact of Changes

| Changed Entity | Affected Skills |
|---------------|-----------------|
| `Requirement` | Design, Spec (may need new tasks) |
| `DesignDecision` | Spec (acceptance criteria), Implementation |
| `AnalysisFinding` | Spec (integration points), Implementation |
| `IntegrationPoint` | Spec (tasks), Implementation |
| `ImplementationTask` | Tests (specs), Implementation |

---

## Session Inspection Workflow

Comprehensive session inspection:

```javascript
// 1. Load both schemas
schema.load("platform-features")
store.query("platform-features")
schema.load("platform-feature-spec")
store.query("platform-feature-spec")

// 2. Get session
session = store.query("PlatformFeatureSession", "platform-features", { name: "auth-layer" })[0]

// 3. Discovery artifacts
requirements = store.query("Requirement", "platform-features", { session: session.id })
decisions = store.query("DesignDecision", "platform-features", { session: session.id })

// 4. Analysis artifacts
findings = store.query("AnalysisFinding", "platform-feature-spec", { sessionId: session.id })
integrationPoints = store.query("IntegrationPoint", "platform-feature-spec", { sessionId: session.id })

// 5. Spec artifacts
tasks = store.query("ImplementationTask", "platform-feature-spec", { sessionId: session.id })
testSpecs = store.query("TestSpecification", "platform-feature-spec", { sessionId: session.id })

// 6. Execution artifacts
runs = store.query("ImplementationRun", "platform-feature-spec", { sessionId: session.id })
executions = store.query("TaskExecution", "platform-feature-spec")
  .filter(e => runs.some(r => r.id === e.runId))

// Summary
console.log(`
Session: ${session.name}
Status: ${session.status}

Discovery:
  Requirements: ${requirements.length}
  Decisions: ${decisions.length}

Analysis:
  Findings: ${findings.length}
  Integration Points: ${integrationPoints.length}

Spec:
  Tasks: ${tasks.length}
  Test Specs: ${testSpecs.length}

Execution:
  Runs: ${runs.length}
  Task Executions: ${executions.length}
`)
```

---

## Common Workflows

### Start Feature, Pause, Resume Later

```
Day 1:
/platform-feature-discovery
→ Creates session, requirements
→ User pauses work

Day 2:
"Resume auth feature"
→ Load session by name
→ Continue with /platform-feature-analysis
```

### Run Analysis, Return to Discovery

```
/platform-feature-analysis (EXPLORE mode)
→ Discovers complex integration needs
→ User realizes requirements are incomplete

/platform-feature-discovery
→ Add new requirements
→ Session stays in discovery

/platform-feature-analysis
→ Re-run with complete requirements
```

### Implementation Fails, Fix Manually, Resume

```
/platform-feature-implementation
→ Task 5 fails after 3 retries
→ Marked as blocked

User manually fixes the issue in code

/platform-feature-implementation
→ Detects existing run
→ User selects "Resume"
→ Task 5 retried, now passes
→ Continues to task 6
```

### VERIFY Before Long-Delayed Implementation

```
(2 weeks since spec was created)

/platform-feature-analysis (VERIFY mode)
→ Checks integration points still valid
→ Reports: "2 of 8 points have drifted"
→ User confirms re-analysis

/platform-feature-analysis (EXPLORE mode)
→ Updates findings for changed files
→ New integration points created

/platform-feature-spec
→ Re-generates tasks for new points
```

---

## Best Practices

### For Long-Running Features

1. **Check status before continuing** - Load session, inspect progress
2. **Run VERIFY before implementation** - Catch drift early
3. **Keep sessions focused** - One feature per session
4. **Document blocking issues** - Update task with resolution notes

### For Iterative Development

1. **Don't modify generated code directly** - Re-run skills instead
2. **Update requirements first** - Let changes cascade through pipeline
3. **Track design decisions** - Future sessions can reference them
4. **Use meaningful session names** - Easy to find later

### For Team Collaboration

1. **Commit session data** - `.schemas/` is version-controlled
2. **Review before resuming** - Check what's changed since last work
3. **Coordinate on blocked tasks** - Manual fixes affect everyone
4. **Share session inspection** - Team visibility into progress
