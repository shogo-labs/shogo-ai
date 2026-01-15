# Eval 02: Change Presentation (Layout)

**Level:** 2 (Configuration)
**Branch:** B

## Input

```
"Show me requirements as a kanban grouped by priority"
```

## Expected Classification

- **Branch:** B (Change Presentation)
- **Reasoning:** User specifies a layout format ("kanban") and grouping ("priority")

## Expected Evidence Gathering

1. Query: What data type?
   - Extracted: "requirements" → platform-features.Requirement

2. Query: What layout format?
   - Extracted: "kanban"

3. Query: What grouping field?
   - Extracted: "priority"

4. Query: Does a kanban section exist?
   - Method: Query ComponentDefinitions for kanban-capable sections
   - Result: Check for existing capability, if none exists → render approximation

## Expected Action (Approximation Approach)

**Step 1:** Check for existing kanban capability
```javascript
store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  filter: { tags: { $in: ["kanban", "grid", "collection"] } },
  terminal: "toArray"
})
```

**Step 2a:** If no kanban section exists, render approximation:
```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "DataGridSection",  // or DesignContainerSection as approximation
    config: {
      schema: "platform-features",
      model: "Requirement"
    }
  }]
})
```

**Step 2b:** Offer to build full capability:
> "Here are your requirements in a table view. For a full kanban board with drag-and-drop grouped by priority, I can build that capability. Would you like me to?"

**Step 3:** If user accepts, follow Branch D to plan and implement.

## Expected Response

"I'll show requirements for you. Let me check what visualization options are available..."

[Renders approximation]

"Here are your requirements in a data grid. For a full kanban board grouped by priority columns, I can build that visualization. Would you like me to create that component?"

## Validation Criteria

- [ ] Correctly classified as Branch B
- [ ] Extracted data type (Requirement)
- [ ] Extracted layout (kanban)
- [ ] Extracted groupBy (priority)
- [ ] Checked for existing capability first
- [ ] Rendered approximation using available sections
- [ ] Offered to build full capability (routes to Branch D if accepted)
- [ ] Did NOT ask clarifying questions (all info was in request)

## Variations to Test

1. "Display tasks in a grid"
2. "Show findings grouped by type"
3. "Requirements sorted by status as a list"
4. "Make the tasks view show items as cards"
