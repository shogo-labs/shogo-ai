---
name: platform-feature-analysis
description: >
  Agentic codebase exploration for platform feature implementation. Operates in
  two modes: (1) EXPLORE mode after discovery to find patterns before design,
  (2) VERIFY mode before implementation to validate spec alignment. Invoke when
  ready to "analyze the codebase", "find patterns", "verify integration points",
  or when session status is discovery (explore) or testing (verify).
---

# Platform Feature Analysis

Explore and verify codebase patterns for platform feature integration.

## Modes

This skill operates in two modes based on session status:

| Session Status | Mode | Purpose | Output Status |
|----------------|------|---------|---------------|
| `discovery` | **Explore** | Find existing patterns to inform design | `design` |
| `testing` | **Verify** | Validate spec still aligns with code | `implementation` |

## Input

- `PlatformFeatureSession` with status=`discovery` OR `testing`
- `Requirement` entities from discovery
- For verify mode: existing `IntegrationPoint` and `AnalysisFinding` entities

## Output

**Explore mode:**
- `AnalysisFinding` entities (type: pattern, gap, existing_test, risk)
- Session status → `design`

**Verify mode:**
- Validation report (findings still valid or drift detected)
- Updated `AnalysisFinding` entities if drift found
- Session status → `implementation`

---

## Workflow: Explore Mode

Use when session status = `discovery`

### Phase 1: Load Context

```javascript
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })

// Load spec schema for storing findings
schema.load("platform-feature-spec")
```

Present summary:
```
Session: {name}
Status: discovery → will transition to design
Requirements: {count}
Affected packages: {list}

Mode: EXPLORE - Finding existing patterns to inform design

Ready to explore the codebase?
```

### Phase 2: Codebase Exploration (Agentic)

For each affected package, explore to understand:

| Package | Exploration Focus |
|---------|-------------------|
| `packages/mcp` | Tool registration, middleware patterns, transport setup |
| `packages/state-api` | Schema transformation, persistence, environment patterns |
| `apps/web` | Component patterns, hooks, state management, routing |
| `.claude/skills` | Skill structure, Wavesmith usage patterns |

**Pattern Recognition** - For Service/Hybrid features, look for existing implementations of:

| Pattern | What to Look For | Typical Locations |
|---------|------------------|-------------------|
| Service Interface | `interface I{X}Service`, domain types | `src/{domain}/types.ts` |
| Environment Extension | `I{X}Environment extends IEnvironment` | `src/environment/types.ts` |
| Collection Persistence | `CollectionPersistable` mixin usage | `src/{domain}/domain.ts` |
| Enhancement Hooks | `enhanceModels`, `enhanceCollections` | `src/{domain}/hooks.ts` |

See pattern references for full structure details:
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md)
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md)
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md)
- [patterns/06-provider-synchronization.md](references/patterns/06-provider-synchronization.md)

**Exploration techniques**:
- Glob for relevant file patterns
- Grep for existing similar functionality
- Read key files to understand patterns
- Look for test files to understand expected behavior

**What to find**:
1. **Patterns** - How similar features are implemented
2. **Gaps** - Missing infrastructure the feature needs
3. **Existing tests** - Test patterns and coverage expectations
4. **Risks** - Complexity, dependencies, potential conflicts

Record findings as you explore - don't wait until the end.

### Phase 3: Create Findings

For each significant discovery:

```javascript
store.create("AnalysisFinding", "platform-feature-spec", {
  id: "finding-xxx",
  sessionId: session.id,
  type: "pattern|gap|existing_test|risk",
  description: "What was found",
  location: "packages/state-api/src/environment/types.ts",
  relevantCode: "Key snippet or pattern",
  recommendation: "How this informs design",
  createdAt: Date.now()
})
```

Typical finding counts: 5-10 for focused features, 10-20 for cross-cutting features.

**Focus on patterns that inform design:**
- Existing service interfaces to follow
- Environment extension patterns
- Schema conventions used
- Test patterns to replicate

### Phase 4: Handoff to Design

1. Update session:
```javascript
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  status: "design",
  updatedAt: Date.now()
})
```

2. Present summary:
```
Exploration Complete

Findings: {count} ({breakdown by type})

Key patterns discovered:
- {pattern 1}: {location}
- {pattern 2}: {location}

Gaps identified:
- {gap 1}

Risks:
- {risk 1}

Session status: discovery → design
Ready for platform-feature-design to create schema informed by these findings.
```

---

## Workflow: Verify Mode

Use when session status = `testing`

### Phase 1: Load Context

```javascript
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]

schema.load("platform-feature-spec")
data.loadAll("platform-feature-spec")
findings = store.list("AnalysisFinding", "platform-feature-spec", { sessionId: session.id })
integrationPoints = store.list("IntegrationPoint", "platform-feature-spec", { sessionId: session.id })
```

Present summary:
```
Session: {name}
Status: testing → will transition to implementation

Existing Analysis:
- Findings: {count}
- Integration Points: {count}
- Analysis date: {oldest finding createdAt}

Mode: VERIFY - Checking spec alignment with current codebase

Ready to verify?
```

### Phase 2: Validate Integration Points

For each `IntegrationPoint`:

1. **Check file exists**:
   ```javascript
   // If changeType is "add", file should NOT exist yet
   // If changeType is "modify" or "extend", file SHOULD exist
   ```

2. **Check referenced patterns still present**:
   - If finding referenced specific functions/interfaces, verify they exist
   - Grep for key identifiers mentioned in rationale

3. **Check for conflicts**:
   - Has file been modified since analysis?
   - Are there new patterns that should inform implementation?

Record validation results:
```javascript
store.create("AnalysisFinding", "platform-feature-spec", {
  id: "verify-xxx",
  sessionId: session.id,
  type: "verification",
  description: "Validation result for ip-xxx",
  location: integrationPoint.filePath,
  relevantCode: "Current state of file/pattern",
  recommendation: "valid|drift_detected|conflict",
  createdAt: Date.now()
})
```

### Phase 3: Report Results

**If all valid:**
```
Verification Complete ✅

All {n} integration points validated:
- {ip-001}: {filePath} - valid
- {ip-002}: {filePath} - valid
...

No codebase drift detected. Safe to proceed with implementation.
```

**If drift detected:**
```
Verification Complete ⚠️

Drift Detected:
- {ip-003}: {filePath}
  Expected: {original pattern}
  Found: {current state}
  Impact: {what this means for implementation}

Options:
1. Update spec to match current codebase
2. Proceed with caution (manual review during implementation)
3. Re-run full exploration to refresh analysis

Which approach?
```

### Phase 4: Handoff to Implementation

1. Update session (only if proceeding):
```javascript
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  status: "implementation",
  updatedAt: Date.now()
})
```

2. Present summary:
```
Verification Complete

Status: {valid|drift_detected}
Integration Points: {validated}/{total}

Session status: testing → implementation
Ready for platform-feature-implementation to execute TDD.
```

---

## Finding Type Guidance

| Type | Mode | When to Use | Example |
|------|------|-------------|---------|
| `pattern` | Explore | Found reusable approach | "MCP tools follow registerTool() pattern" |
| `gap` | Explore | Missing infrastructure | "No user session management exists" |
| `existing_test` | Explore | Found test patterns | "Tool tests use MockMCPServer helper" |
| `risk` | Both | Potential problem | "Circular dependency if auth imports store" |
| `verification` | Verify | Validation result | "ip-001 validated: file exists, pattern matches" |

---

## Status Flow

```
[Discovery]
     ↓
[Analysis: Explore] ← This skill (explore mode)
     ↓ status=design
[Design]
     ↓ status=integration
[Spec]
     ↓ status=testing
[Tests]
     ↓
[Analysis: Verify] ← This skill (verify mode)
     ↓ status=implementation
[Implementation]
```

---

## References

- [exploration-patterns.md](references/exploration-patterns.md) - Package-specific exploration guidance
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md) - IService abstraction pattern
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md) - MST environment DI pattern
- [patterns/04-enhancement-hooks.md](references/patterns/04-enhancement-hooks.md) - Enhancement hooks pattern
- [patterns/06-provider-synchronization.md](references/patterns/06-provider-synchronization.md) - External state sync pattern
