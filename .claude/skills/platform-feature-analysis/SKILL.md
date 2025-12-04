---
name: platform-feature-analysis
description: >
  Agentic codebase exploration for platform feature implementation. Use after
  platform-feature-design when the schema is complete and you need to understand
  how the feature integrates with existing code. Explores affected packages,
  identifies patterns, finds integration points, and surfaces risks. Invoke when
  ready to "analyze the codebase", "find where to integrate", "explore how this
  fits", "understand the integration points", or after design handoff indicates
  status=integration.
---

# Platform Feature Analysis

Explore the codebase to understand how a platform feature should be integrated.

## Input

- `PlatformFeatureSession` with status="integration" and schemaName set
- `Requirement` entities from discovery
- Domain schema from design phase

## Output

- `AnalysisFinding` entities in `platform-feature-spec` schema
- `IntegrationPoint` entities identifying specific change locations
- Session status updated to "spec"

## Workflow

### Phase 1: Load Context

```javascript
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features")

schema.load("platform-feature-spec")
schema.load(session.schemaName)  // domain schema from design
```

Present summary:
```
Session: {name}
Schema: {schemaName}
Requirements: {count}
Affected packages: {list}

Ready to explore the codebase?
```

### Phase 2: Codebase Exploration (Agentic)

For each affected package, explore to understand:

| Package | Exploration Focus |
|---------|-------------------|
| `packages/mcp` | Tool registration, middleware patterns, transport setup |
| `packages/state-api` | Schema transformation, persistence, meta-store usage |
| `apps/web` | Component patterns, hooks, state management, routing |
| `.claude/skills` | Skill structure, Wavesmith usage patterns |

**Pattern Recognition** - For Service/Hybrid features, look for existing implementations of:

| Pattern | What to Look For | Typical Locations |
|---------|------------------|-------------------|
| Service Interface | `interface I{X}Service`, domain types | `src/{domain}/types.ts` |
| Environment Extension | `I{X}Environment extends IEnvironment` | `src/environment/types.ts` |
| Provider Sync | `_syncFromProvider`, `setupSubscription` | `src/{domain}/domain.ts` |

See pattern references for full structure details:
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md)
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md)
- [patterns/06-provider-synchronization.md](references/patterns/06-provider-synchronization.md)

When patterns don't exist, record as integration point with `changeType: "add"`.

**Exploration techniques**:
- Glob for relevant file patterns
- Grep for existing similar functionality
- Read key files to understand patterns
- Look for test files to understand expected behavior

**What to find**:
1. **Patterns** - How similar features are implemented
2. **Integration points** - Specific files/functions to modify
3. **Risks** - Complexity, dependencies, potential conflicts
4. **Gaps** - Missing infrastructure the feature needs
5. **Existing tests** - Test patterns and coverage expectations

Record findings as you explore - don't wait until the end.

### Phase 3: Create Findings

For each significant discovery:

```javascript
store.create("AnalysisFinding", "platform-feature-spec", {
  id: "finding-xxx",
  sessionId: session.id,
  type: "pattern|integration_point|risk|gap|existing_test",
  description: "What was found",
  location: "packages/mcp/src/tools/store.ts",
  relevantCode: "Key snippet or pattern",
  recommendation: "How this informs implementation",
  createdAt: Date.now()
})
```

Typical finding counts: 5-10 for focused features, 10-20 for cross-cutting features.

### Phase 4: Identify Integration Points

Transform findings into specific change locations:

```javascript
store.create("IntegrationPoint", "platform-feature-spec", {
  id: "ip-xxx",
  sessionId: session.id,
  finding: "finding-xxx",  // reference to supporting finding
  package: "packages/mcp",
  filePath: "src/tools/auth.ts",  // new file
  changeType: "add",
  description: "New auth middleware for JWT validation",
  rationale: "Follows existing middleware pattern in transport.ts",
  createdAt: Date.now()
})
```

**changeType guidance**:
- `add` - New file or new export
- `modify` - Change existing function behavior
- `extend` - Add to existing pattern (new tool, new route, new hook)
- `remove` - Delete obsolete code

### Phase 5: Handoff

1. Update session:
```javascript
store.update(session.id, "PlatformFeatureSession", "platform-features", {
  status: "spec",
  updatedAt: Date.now()
})
```

2. Present summary:
```
Analysis Complete

Findings: {count} ({breakdown by type})
Integration Points: {count} ({breakdown by package})

Key insights:
- {insight 1}
- {insight 2}

Risks identified:
- {risk 1}

Ready for platform-feature-spec to create implementation tasks.
```

## Finding Type Guidance

| Type | When to Use | Example |
|------|-------------|---------|
| `pattern` | Found reusable approach | "MCP tools follow registerTool() pattern" |
| `integration_point` | Identified specific location | "Auth middleware goes in transport.ts" |
| `risk` | Potential problem | "Circular dependency if auth imports store" |
| `gap` | Missing infrastructure | "No user session management exists" |
| `existing_test` | Found relevant test patterns | "Tool tests use MockMCPServer helper" |

## References

- [exploration-patterns.md](references/exploration-patterns.md) - Package-specific exploration guidance
- [patterns/02-service-interface.md](references/patterns/02-service-interface.md) - IService abstraction pattern
- [patterns/03-environment-extension.md](references/patterns/03-environment-extension.md) - MST environment DI pattern
- [patterns/06-provider-synchronization.md](references/patterns/06-provider-synchronization.md) - External state sync pattern
