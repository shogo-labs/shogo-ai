---
name: platform-feature-discovery
description: >
  Structured discovery for internal platform development. Use when a developer
  needs to add, design, plan, or build a new capability for the Shogo AI
  platform (auth, MCP tools, skills, persistence features, etc.). Captures
  intent, affected packages, and requirements as Wavesmith entities. Invoke
  when someone says "add [feature]", "implement [feature]", "design [capability]",
  "help me build [feature]", "I need [capability] for the platform", "I want
  to add [feature]", or similar requests for internal platform work.
---

# Platform Feature Discovery

Capture developer intent and requirements for internal platform features.

## Output

- **PlatformFeatureSession** - Container with intent, status, affected packages
- **Requirement entities** - 3-7 requirements derived from intent (must/should/could)

Stored in `platform-features` schema via Wavesmith.

## Workflow

### Phase 1: Capture Intent

1. Understand what the developer wants to add
2. Clarify scope if ambiguous ("What problem does this solve?", "Who needs this?")
3. Create PlatformFeatureSession:
   ```
   store.create("PlatformFeatureSession", "platform-features", {
     id: uuid(),
     name: "<short-name>",
     intent: "<original ask>",
     status: "discovery",
     createdAt: Date.now()
   })
   ```

### Phase 2: Identify Affected Areas

Determine which packages this feature touches:

| Package | What It Contains |
|---------|------------------|
| `packages/state-api` | Schema transformation, meta-store, persistence |
| `packages/mcp` | MCP server, tools, agent.chat |
| `apps/web` | React demo, Unit 1-3 components |
| `.claude/skills` | Claude skills for app building |
| `.schemas` | Schema definitions |

Update session with affected packages:
```
store.update(sessionId, "PlatformFeatureSession", "platform-features", {
  affectedPackages: ["packages/mcp", ...],
  updatedAt: Date.now()
})
```

### Phase 3: Derive Requirements

Extract requirements from intent. For each requirement:
- **must** - Essential, feature doesn't work without it
- **should** - Important, expected behavior
- **could** - Nice to have, can defer

Create Requirement entities:
```
store.create("Requirement", "platform-features", {
  id: uuid(),
  session: sessionId,
  description: "<what it must do>",
  priority: "must",
  status: "proposed"
})
```

Typical count: 3-5 for simple features, 5-7 for complex ones.

### Phase 4: Validate & Handoff

1. Summarize session state to developer
2. Confirm requirements coverage ("Does this capture what you need?")
3. Update session status if moving forward:
   ```
   store.update(sessionId, "PlatformFeatureSession", "platform-features", {
     status: "design",
     updatedAt: Date.now()
   })
   ```
4. Indicate readiness for `platform-feature-design` skill

## Wavesmith Operations

```javascript
// Load schema
schema.load("platform-features")

// Create session
store.create("PlatformFeatureSession", "platform-features", {...})

// Create requirements
store.create("Requirement", "platform-features", {...})

// Update session
store.update(sessionId, "PlatformFeatureSession", "platform-features", {...})

// Query existing (if resuming)
store.list("PlatformFeatureSession", "platform-features", { name: "auth" })
```

## References

- [codebase-context.md](references/codebase-context.md) - Package structure and purposes
- [example-sessions.md](references/example-sessions.md) - Worked discovery examples
