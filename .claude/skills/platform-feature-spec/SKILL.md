---
name: platform-feature-spec
description: >
  Create implementation tasks from analysis findings. Use after
  platform-feature-analysis when integration points are identified and you
  need to define the implementation plan. Transforms integration points into
  ordered tasks with acceptance criteria. Invoke when ready to "create the
  implementation plan", "define the tasks", "spec out the work", or after
  analysis handoff indicates status=spec.
---

# Platform Feature Spec

Transform integration points into implementation tasks with acceptance criteria.

## Input

- `PlatformFeatureSession` with status="spec"
- `Requirement` entities from discovery (platform-features schema)
- `AnalysisFinding` entities from analysis
- `IntegrationPoint` entities from analysis

## Output

- `ImplementationTask` entities with acceptance criteria and dependencies
- Session status updated to "testing"

## Workflow

### Phase 1: Load Context

```javascript
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features")

schema.load("platform-feature-spec")
data.loadAll("platform-feature-spec")
findings = store.list("AnalysisFinding", "platform-feature-spec")
integrationPoints = store.list("IntegrationPoint", "platform-feature-spec")
```

Present summary:
```
Session: {name}
Requirements: {count}
Findings: {count}
Integration Points: {count}

Ready to create implementation tasks?
```

### Phase 2: Group Integration Points

Analyze integration points and group them into logical implementation tasks:

**Grouping heuristics**:
- Same module/feature area (e.g., all auth tools together)
- Shared dependencies (e.g., utility modules before consumers)
- Same package when tightly coupled
- Keep tasks focused (1-3 integration points per task typically)

**Dependency ordering**:
1. Dependencies/configuration (package.json changes)
2. Utility modules (shared code: jwt.ts, password.ts)
3. Core functionality (tools, services)
4. Integration code (registry updates, context wiring)
5. UI components (pages, routes)
6. Tests (can be parallel with implementation)

### Phase 3: Create Tasks (Review Gate)

For each task group, create ImplementationTask:

```javascript
store.create("ImplementationTask", "platform-feature-spec", {
  id: "task-xxx",
  sessionId: session.id,
  integrationPoint: "ip-xxx",  // primary integration point
  requirementId: "req-xxx",    // traceability to requirement
  description: "What this task accomplishes",
  acceptanceCriteria: [
    "Criterion 1 (testable statement)",
    "Criterion 2 (testable statement)"
  ],
  dependencies: ["task-yyy"],  // tasks that must complete first
  status: "planned",
  createdAt: Date.now()
})
```

**Acceptance criteria guidelines**:
- Start with verb: "Returns...", "Creates...", "Validates..."
- Be specific and testable
- Cover success case and key error cases
- Reference requirement IDs for traceability

Present task plan for approval:
```
Implementation Tasks ({count})

1. [task-001] Add auth dependencies
   - Acceptance: package.json includes argon2, jose
   - Dependencies: none

2. [task-002] Create password utilities
   - Acceptance: hashPassword returns valid argon2 hash, verifyPassword validates correctly
   - Dependencies: task-001

...

Does this task breakdown look correct?
```

### Phase 4: Handoff

1. Update session:
```javascript
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  status: "testing",
  updatedAt: Date.now()
})
```

2. Present summary:
```
Spec Complete

Tasks: {count}
Dependency chains: {description}

Coverage:
- All {n} integration points assigned to tasks
- All {n} requirements traceable to tasks

Ready for platform-feature-tests to create test specifications.
```

## Task Granularity Guidelines

| Scope | Task Count | When to Use |
|-------|------------|-------------|
| Fine | 1 IP per task | Complex changes, need precise tracking |
| Medium | 2-3 IPs per task | Related changes in same file/module |
| Coarse | 4+ IPs per task | Simple, mechanical changes |

Default to **medium** granularity. Adjust based on:
- Complexity of changes
- Risk level (security-critical = finer granularity)
- Team preference

## Acceptance Criteria Patterns

**For new files**:
```
- File exists at {path}
- Exports {functions/components}
- {Function} accepts {params} and returns {type}
```

**For modifications**:
```
- {Existing function} now {new behavior}
- {New parameter} is handled correctly
- Backward compatibility maintained for {existing callers}
```

**For integrations**:
```
- {Component A} successfully calls {Component B}
- Error from {B} is handled by {A} with {behavior}
- {Flow} works end-to-end
```

## References

- [task-patterns.md](references/task-patterns.md) - Common task structures by change type
