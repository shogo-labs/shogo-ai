# Eval 01: View Existing Data

**Level:** 1 (Direct Mapping)
**Branch:** A

## Input

```
"Show me the platform-features schema"
```

## Expected Classification

- **Branch:** A (View Existing Data)
- **Reasoning:** User is asking to "show" data, schema exists, no presentation format specified

## Expected Evidence Gathering

1. Query: Does "platform-features" schema exist?
   - Method: `schema_list` or implicit knowledge
   - Result: Yes, platform-features is a known schema

2. Query: What section renders schemas?
   - Method: Knowledge of available sections
   - Result: `DesignContainerSection`

## Expected Action

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

"I'll show you the platform-features schema."

[Workspace updates to show schema visualization]

"Here's the platform-features schema. It contains entities like FeatureSession, Requirement, AnalysisFinding, and more. Would you like me to focus on a specific entity or show it in a different format?"

## Validation Criteria

- [ ] Correctly classified as Branch A
- [ ] Used `set_workspace` (not `execute`)
- [ ] Selected `DesignContainerSection`
- [ ] Passed correct `schemaName` in config
- [ ] Offered refinement options after rendering

## Variations to Test

1. "Display the component-builder schema"
2. "Let me see the studio-chat entities"
3. "What's in the platform-features schema?"
