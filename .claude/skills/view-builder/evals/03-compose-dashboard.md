# Eval 03: Compose Multiple

**Level:** 3 (Composition)
**Branch:** C

## Input

```
"Build me a dashboard with the schema on the left and the component builder on the right"
```

## Expected Classification

- **Branch:** C (Compose Multiple)
- **Reasoning:** "Dashboard" keyword + multiple components + spatial arrangement ("left and right")

## Expected Evidence Gathering

1. Query: What components are needed?
   - Extracted: "schema" → DesignContainerSection
   - Extracted: "component builder" → ComponentBuilderSection

2. Query: Do both components exist?
   - Result: Yes, both are available sections

3. Query: What layout arranges them?
   - "Left and right" → split-h layout

## Expected Action

```javascript
set_workspace({
  layout: "split-h",
  panels: [
    { slot: "left", section: "DesignContainerSection", config: { schemaName: "platform-features" } },
    { slot: "right", section: "ComponentBuilderSection", config: {} }
  ]
})
```

## Expected Response

"I'll create a split view with the schema on the left and the component builder on the right."

[Workspace updates to show split layout]

"Here's your dashboard. The schema visualization is on the left - you can explore entities and their relationships. The component builder on the right lets you create custom views. Would you like me to pre-configure the builder for a specific data type?"

## Validation Criteria

- [ ] Correctly classified as Branch C
- [ ] Identified two components
- [ ] Selected split-h layout for "left and right"
- [ ] Mapped components to correct slots
- [ ] Used `set_workspace` with both panels
- [ ] Offered refinement options

## Variations to Test

1. "Show me requirements and findings side by side"
2. "Create a view with tasks on top and test specs below"
3. "Dashboard with schema, builder, and preview"
4. "Put the analysis view next to the design view"

## Edge Cases

### Variation: More than 2 components
```
"Dashboard with schema, builder, and a preview panel"
```

Expected: May need to use `execute` to create a custom LayoutTemplate or Composition, then show via DynamicCompositionSection.

### Variation: Ambiguous arrangement
```
"Show requirements and findings together"
```

Expected: Default to split-h (side by side), or ask ONE question: "Would you like them side by side or stacked?"
