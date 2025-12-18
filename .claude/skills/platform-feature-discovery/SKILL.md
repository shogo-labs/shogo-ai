---
name: platform-feature-discovery
description: >
  Structured discovery for internal platform development. Use when a developer
  needs to add, design, plan, or build a new capability for the Shogo AI
  platform (auth, MCP tools, skills, persistence features, etc.). Captures
  intent, affected packages, and requirements as Wavesmith entities. Invoke
  when someone says something like "add [feature]", "implement [feature]", "design [capability]",
  "help me build [feature]", "I need [capability] for the platform", "I want
  to add [feature]", or similar requests around building or modifying feature.
---

# Platform Feature Discovery

Capture developer intent and requirements for internal platform features.

## Output

- **FeatureSession** - Container with intent, status, affected packages
- **Requirement entities** - 3-7 requirements derived from intent (must/should/could)

Stored in `platform-features` schema via Wavesmith.

## Workflow

### Phase 1: Capture Intent

1. Understand what the developer wants to add
2. Clarify scope if ambiguous ("What problem does this solve?", "Who needs this?")

**Local State Principle**: All features that have state needs will have local MST models. This is not a question to ask - it's how the platform works. External services own their data, but local state tracks loading/error/cached data for reactive UI. Don't ask "should we sync locally?" - the answer is always yes.

3. **Assess initial archetype** (preliminary - will be validated after analysis):

   | Archetype | Indicators |
   |-----------|------------|
   | **Service** | External API calls, credentials, provider swapping |
   | **Domain** | New entities, business rules, LOCAL data management |
   | **Infrastructure** | Cross-cutting, used by multiple features |
   | **Hybrid** | External provider + local domain modeling (sync/mirror) |

   **Important**: This is an INITIAL ASSESSMENT, not a final classification. The classification skill will validate with evidence after analysis explores the codebase.

   **Key question**: "Does this feature CALL an external API?" NOT "Does it reference external entities?"
   - Storing foreign key refs (user IDs) is NOT calling an API → likely **Domain**
   - Actually calling external service APIs → likely **Service**

   Note any **uncertainties** - things that need validation during classification.

   See [patterns/01-feature-classification.md](references/patterns/01-feature-classification.md) for guidance.

4. Create FeatureSession with initial assessment:
   ```
   store.create("FeatureSession", "platform-features", {
     id: uuid(),
     name: "<short-name>",
     intent: "<original ask>",
     initialAssessment: {
       likelyArchetype: "service" | "domain" | "infrastructure" | "hybrid",
       indicators: ["list of evidence observed"],
       uncertainties: ["what needs validation"]
     },
     status: "discovery",
     createdAt: Date.now()
   })
   ```

   **Note**: `featureArchetype` and `applicablePatterns` are NOT set here - they are set by the classification skill after analysis.

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
store.update(sessionId, "FeatureSession", "platform-features", {
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
  name: "<short-slug>",
  description: "<what it must do>",
  priority: "must",
  status: "proposed",
  createdAt: Date.now()
})
```

Typical count: 3-5 for simple features, 5-7 for complex ones.

**Edge Case Probing** (for complex features): Consider what could go wrong:
- Missing/incomplete data scenarios
- Error handling needs
- Scale considerations

See [edge-case-probing.md](references/edge-case-probing.md) for a lightweight framework. Add 1-2 requirements for critical edge cases discovered.

### Phase 4: Validate & Handoff

1. Summarize session state to developer:
   ```
   Session: {name}
   Initial Assessment: {likelyArchetype}
   Evidence: {indicators}
   Uncertainties: {uncertainties}
   Requirements: {count}
   ```

2. Confirm requirements coverage ("Does this capture what you need?")

3. **Do NOT change session status** - it stays at `discovery`
   - Analysis skill expects `status: "discovery"` to run explore mode
   - Analysis will gather classification evidence and transition to `classification`

4. **Note archetype is NOT finalized**:
   ```
   Discovery complete. Session: {name}
   Status: discovery (unchanged)

   Initial Assessment: {likelyArchetype}
   NOTE: This is a preliminary assessment. The classification skill will
   validate with evidence from codebase analysis.

   Next steps:
   1. Run platform-feature-analysis to explore codebase patterns
   2. Analysis transitions status to "classification"
   3. Run platform-feature-classification to validate archetype with evidence
   4. Classification sets final archetype and transitions to "design"
   ```

## Wavesmith Operations

```javascript
// Load schema
schema.load("platform-features")

// Create session
store.create("FeatureSession", "platform-features", {...})

// Create requirements
store.create("Requirement", "platform-features", {...})

// Update session
store.update(sessionId, "FeatureSession", "platform-features", {...})

// Query existing (if resuming)
store.list("FeatureSession", "platform-features", { name: "auth" })
```

## References

- [codebase-context.md](references/codebase-context.md) - Package structure and purposes
- [example-sessions.md](references/example-sessions.md) - Worked discovery examples
- [edge-case-probing.md](references/edge-case-probing.md) - Lightweight edge case discovery framework
- [patterns/00-pattern-inventory.md](references/patterns/00-pattern-inventory.md) - Complete pattern catalog and decision frameworks
- [patterns/01-feature-classification.md](references/patterns/01-feature-classification.md) - Feature archetype guidance (for initial assessment)
