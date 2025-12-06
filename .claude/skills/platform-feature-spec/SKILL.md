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

**Pattern-Based Task Templates** - Use patterns as task templates:

| Pattern | Task Type | Typical Acceptance Criteria |
|---------|-----------|----------------------------|
| Service Interface | Add types.ts, {provider}.ts, mock.ts | Interface has no runtime imports; mock implements full interface |
| Environment Extension | Extend IEnvironment | Services accessible via getEnv() |
| **Domain Store** | Add domain.ts with createStoreFromScope | Exports {Domain}Domain scope and create{Domain}Store factory; enhancement hooks add views/actions |
| React Context | Add Provider, hook, observer components | useRef for store; cleanup in useEffect |

See pattern references for detailed structure and anti-patterns:
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md)
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md)
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md)
- [patterns/07-react-context-integration.md](references/patterns/07-react-context-integration.md)

**Grouping heuristics**:
- **Domain store = single task**: All enhancement hooks (models, collections, root) belong together in domain.ts - never split into separate mixin.ts or hooks.ts files
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

### Package Placement Guidance

**Default: `packages/state-api/src/{domain}/`**

Domain logic belongs in state-api for isomorphic reuse across consumers (web, mcp, tests).

| Component | Package | Path |
|-----------|---------|------|
| Service interface (`I{Domain}Service`) | state-api | `src/{domain}/types.ts` |
| Service implementations | state-api | `src/{domain}/{provider}.ts` |
| Mock service | state-api | `src/{domain}/mock.ts` |
| Domain store (`create{Domain}Store`) | state-api | `src/{domain}/domain.ts` |
| Environment extension | state-api | `src/environment/types.ts` |
| React Provider/Context | apps/web | `src/contexts/{Domain}Context.tsx` |
| UI Components | apps/web | `src/components/{Domain}/*.tsx` |
| MCP Tools (if needed) | packages/mcp | `src/tools/{domain}.ts` |

**Exception:** Pure UI features with no domain logic can live entirely in apps/web.

**Decision Tree:**
1. Does feature have service interface? → state-api
2. Does feature have MST store with domain logic? → state-api
3. Does feature need to be used from MCP? → state-api
4. Is it only React UI with no business logic? → apps/web

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

## Domain Store Task Template

When a feature needs domain logic with MST state, create a **single task** for the domain store. This is the most important pattern - never split domain logic across multiple files.

**Task structure:**
```javascript
store.create("ImplementationTask", "platform-feature-spec", {
  id: "task-domain-store",
  sessionId: session.id,
  integrationPoint: "ip-domain",
  description: "Create {domain} domain store with enhancement hooks",
  acceptanceCriteria: [
    "domain.ts exports {Domain}Domain ArkType scope",
    "domain.ts exports create{Domain}Store() factory using createStoreFromScope",
    "enhanceModels adds computed views: {list from DesignDecision}",
    "enhanceCollections adds query methods: {list from DesignDecision}",
    "enhanceRootStore adds initialize() and domain actions",
    "Store integrates with I{Domain}Service via getEnv()"
  ],
  dependencies: ["task-service-interface", "task-environment-extension"],
  status: "planned",
  createdAt: Date.now()
})
```

**What this pattern replaces** (DO NOT create these):
- ❌ "Create {Domain}Mixin" task → would create mixin.ts with hand-coded MST
- ❌ "Create enhancement hooks" task → would create separate hooks.ts
- ❌ Multiple tasks for views/actions/initialization → fragments cohesive domain logic

**Single domain.ts contains:**
- ArkType scope defining all domain entities
- `createStoreFromScope()` call with all three enhancement hook callbacks
- All domain logic in one cohesive, testable unit

See [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) for the complete hook API and examples.

## References

- [task-patterns.md](references/task-patterns.md) - Common task structures by change type
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md) - Service task template
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md) - Environment task template
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) - **Domain store pattern (CRITICAL)**
- [patterns/07-react-context-integration.md](references/patterns/07-react-context-integration.md) - React integration template
