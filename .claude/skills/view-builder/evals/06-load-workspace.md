# Eval 06: Load Workspace

**Level:** 2 (Workflow Pattern)
**Phase:** 5

## Input

```
"Load the component showcase"
```

## Context

User wants to restore a previously saved workspace configuration.

## Expected Classification

- **Phase:** 5 (Workspace Persistence)
- **Action:** Load
- **Reasoning:** User explicitly says "load", names a composition

## Expected Evidence Gathering

1. Extract composition name from user input
   - Extracted: "component-showcase"

2. Query for composition
   - Method: `store_query` with name filter

## Expected Action

```javascript
// Step 1: Query for the composition
store_query({
  schema: "component-builder",
  model: "Composition",
  filter: { name: "component-showcase" },
  terminal: "first"
})

// Step 2: Apply to workspace (after receiving query result)
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "AppShellSection",
    config: {
      navigationMode: "section-browser",
      showAppBar: true,
      showSideNav: true,
      appBar: { title: "Component Showcase" },
      sideNav: { groups: [...] },
      exampleConfigs: { ... }
    }
  }]
})
```

## Expected Response

"Loading the component showcase workspace..."

[Workspace updates to show the saved configuration]

"Here's the component showcase. It displays all 70 available components organized by category, with live previews. Click any item in the sidebar to see its details."

## Validation Criteria

- [ ] Correctly identified as load workflow
- [ ] Used `store_query` to find composition
- [ ] Used correct filter: `{ name: "component-showcase" }`
- [ ] Mapped layout ID back to set_workspace format
- [ ] Extracted panels from slotContent correctly
- [ ] Used `section` key from slotContent
- [ ] Preserved config from slotContent
- [ ] Confirmed load success to user
- [ ] Described what was loaded

## Layout ID Mapping

| Composition layout ID | set_workspace layout |
|----------------------|---------------------|
| `layout-workspace-flexible` | `single` |
| `layout-workspace-split-h` | `split-h` |
| `layout-workspace-split-v` | `split-v` |

## Variations to Test

1. "Show the my-dashboard app"
2. "Open the analytics workspace"
3. "Restore that view we made earlier" (requires context awareness)
4. "Load my-analytics-dashboard"

## Edge Cases

### Composition not found

```
"Load the nonexistent-dashboard"
```

Expected:
1. Query returns null
2. Response: "I couldn't find a saved workspace named 'nonexistent-dashboard'. Would you like me to list the available workspaces?"

### Ambiguous name

```
"Load the dashboard"
```

If multiple compositions contain "dashboard":
- Query for partial match
- Present options: "I found several dashboards: 'my-dashboard', 'analytics-dashboard'. Which one would you like to load?"

### List request instead

```
"What workspaces do I have saved?"
```

Expected:
```javascript
store_query({
  schema: "component-builder",
  model: "Composition",
  terminal: "toArray"
})
```

Response: "Here are your saved workspaces:
- **workspace** - The active workspace
- **component-showcase** - 70 component sections with navigation
- **my-dashboard** - Split view with data and charts
Would you like me to load any of these?"

## Complex Example: Load and Describe

For complex compositions like AppShell, provide helpful context:

```
User: "Load the component showcase"

Claude: "Loading the component showcase..."

[Workspace updates]

"Here's the component showcase app. It's an AppShell layout with:
- **Top bar**: Title 'Component Showcase'
- **Sidebar**: 12 groups containing 70 components
- **Main area**: Shows component details when you click sidebar items

The sidebar groups are: Layout, Data Display, Navigation, Forms, Feedback, Overlays, Charts, Studio, Schema, Feature Pipeline, Design System, and Composite.

Try clicking on 'DataGridSection' to see a live preview with chat sessions."
```
