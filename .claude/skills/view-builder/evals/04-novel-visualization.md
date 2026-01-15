# Eval 04: Novel Visualization

**Level:** 4 (Novel + Approximation)
**Branch:** D

## Input

```
"Show me feature dependencies as a graph"
```

## Expected Classification

- **Branch:** D (Novel Visualization)
- **Reasoning:** "Graph" visualization doesn't exist as a configurable section for arbitrary data

## Expected Evidence Gathering

1. Query: What visualization type?
   - Extracted: "graph" → relational capability

2. Query: Does graph component exist for features?
   - Method: Check ComponentDefinitions
   - Result: SpecContainerSection has ReactFlow, but hardcoded for Tasks
   - Conclusion: No generic graph section for Features

3. Query: Can we approximate?
   - Options: Tree list, dependency table, schema view with relationships

## Expected Action (Approximation)

```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "DesignContainerSection",
    config: { schemaName: "platform-features" }
  }]
})
```

## Expected Response

"I'll show you the feature dependencies. We don't have an interactive graph view for features yet, but I can show you the structure."

[Workspace updates to show schema view or approximation]

"Here's the platform-features schema which shows how entities relate. Features connect through FeatureSession → Requirements → Tasks flow.

For a full interactive dependency graph with pan/zoom, I'd need to create a new visualization component. Would you like me to:
1. Continue with this schema view
2. Build a proper graph visualization (this would require creating a new component)
3. Show dependencies as a formatted list instead"

## Validation Criteria

- [ ] Correctly classified as Branch D
- [ ] Recognized "graph" as novel capability
- [ ] Rendered an approximation immediately (didn't say "I can't")
- [ ] Explained the limitation clearly
- [ ] Offered concrete next steps
- [ ] Did NOT block on missing capability

## Key Principle Validation

**"Render First, Refine Through Dialogue"**
- [ ] Something was shown immediately
- [ ] User wasn't asked to configure before seeing anything
- [ ] Path forward was offered

## Variations to Test

1. "Show tasks as a force-directed network"
2. "Timeline of feature progress"
3. "Gantt chart of implementation tasks"
4. "Mind map of requirements"

## Follow-up Scenarios

### If user chooses "Build proper graph":
- Transition to requirements gathering
- Ask: "What should happen when you click a node?"
- Ask: "Should it auto-layout or allow manual positioning?"
- Document requirements for ComponentSpec

### If user chooses "Continue with approximation":
- Offer refinements to current view
- "Would you like to filter to specific features?"
- "Should I highlight dependency paths?"

### If user chooses "Formatted list":
- Use ComponentBuilder with list layout
- Group by dependency depth or type
