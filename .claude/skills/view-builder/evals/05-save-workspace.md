# Eval 05: Save Workspace

**Level:** 2 (Workflow Pattern)
**Phase:** 5

## Input

```
"Save this workspace as my-analytics-dashboard"
```

## Context

User has been iterating on a workspace and now wants to save it for later reuse. Current workspace is a split-h layout with DataGridSection on left and ChartSection on right.

## Expected Classification

- **Phase:** 5 (Workspace Persistence)
- **Action:** Save
- **Reasoning:** User explicitly says "save", provides a name, wants to persist current layout

## Expected Evidence Gathering

1. Determine composition name from user input
   - Extracted: "my-analytics-dashboard"

2. Know current workspace state (from conversation context)
   - Layout: split-h
   - Left panel: DataGridSection
   - Right panel: ChartSection

## Expected Action

```javascript
store_create({
  schema: "component-builder",
  model: "Composition",
  data: {
    id: "composition-my-analytics-dashboard",
    name: "my-analytics-dashboard",
    layout: "layout-workspace-split-h",
    slotContent: [
      {
        slot: "left",
        section: "DataGridSection",
        config: { schema: "platform-features", model: "Requirement" }
      },
      {
        slot: "right",
        section: "ChartSection",
        config: { chartType: "bar" }
      }
    ]
  }
})
```

## Expected Response

"I've saved the current workspace as 'my-analytics-dashboard'. You can load it anytime by saying 'load my-analytics-dashboard' or 'show the analytics dashboard'."

## Validation Criteria

- [ ] Correctly identified as save workflow
- [ ] Used `store_create` with `component-builder` schema
- [ ] Used `Composition` model
- [ ] Generated proper ID format: `composition-{name}`
- [ ] Used `section` key (not `component`) in slotContent
- [ ] Mapped layout type to template ID correctly
- [ ] Captured current panel configs accurately
- [ ] Confirmed save success to user
- [ ] Explained how to load it later

## Variations to Test

1. "Remember this layout" (infer name from context or ask)
2. "Save this as an app" (implies persistence)
3. "This is perfect, save it" (satisfaction + save intent)
4. "Can you save this dashboard for later?" (explicit save request)

## Edge Cases

### No explicit name provided

```
"Save this workspace"
```

Expected: Either infer a name from context (e.g., "analytics-dashboard" if showing analytics) or ask user: "What would you like to call this workspace?"

### Composition already exists

```
"Save this as my-dashboard"
```

If `composition-my-dashboard` already exists:
- Warn user: "A composition named 'my-dashboard' already exists. Would you like to overwrite it or use a different name?"
- If overwrite: Use `store_update` instead of `store_create`

### Complex AppShell configuration

When saving an AppShell workspace, ensure all nested config is captured:

```javascript
{
  slot: "main",
  section: "AppShellSection",
  config: {
    navigationMode: "section-browser",
    showAppBar: true,
    showSideNav: true,
    appBar: { title: "My App" },
    sideNav: { groups: [...] },
    exampleConfigs: { ... }
  }
}
```
