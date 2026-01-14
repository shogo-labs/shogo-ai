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

4. Query: Does kanban capability exist?
   - Method: Knowledge of ComponentBuilderSection capabilities
   - Result: Yes, ComponentBuilder supports kanban layout

## Expected Action

```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "ComponentBuilderSection",
    config: {
      suggestedDataSource: { schema: "platform-features", model: "Requirement" },
      suggestedLayout: "kanban",
      suggestedGroupBy: "priority"
    }
  }]
})
```

## Expected Response

"I'll show requirements as a kanban board grouped by priority."

[Workspace updates to show ComponentBuilder with kanban preview]

"Here are your requirements organized by priority level. You can drag items between columns or click any requirement for details. Want me to adjust the columns or show additional fields on the cards?"

## Validation Criteria

- [ ] Correctly classified as Branch B
- [ ] Extracted data type (Requirement)
- [ ] Extracted layout (kanban)
- [ ] Extracted groupBy (priority)
- [ ] Used `ComponentBuilderSection` with appropriate config
- [ ] Did NOT ask clarifying questions (all info was in request)
- [ ] Offered refinement options

## Variations to Test

1. "Display tasks in a grid"
2. "Show findings grouped by type"
3. "Requirements sorted by status as a list"
4. "Make the tasks view show items as cards"
