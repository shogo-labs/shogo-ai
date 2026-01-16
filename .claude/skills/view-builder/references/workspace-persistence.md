# Workspace Persistence

Save and load workspace configurations as named Compositions for reuse across sessions.

## Overview

The workspace persistence system allows users to:
1. **Save** the current workspace layout as a named Composition
2. **Load** a previously saved Composition to restore a workspace
3. **List** all available saved Compositions

This is achieved agentically using existing Wavesmith MCP tools - no special virtual tools required.

---

## Data Model

Compositions are stored in the `component-builder` schema:

```typescript
interface Composition {
  id: string           // e.g., "composition-my-dashboard"
  name: string         // e.g., "my-dashboard"
  layout: string       // Layout template ID, e.g., "layout-workspace-split-h"
  slotContent: Array<{
    slot: string       // "main", "left", "right", "top", "bottom"
    section: string    // Section name, e.g., "DataGridSection"
    config?: object    // Section-specific configuration
  }>
}
```

**Key distinction**:
- Use `section` key for section names (e.g., "DataGridSection")
- The `component` key is for ComponentDefinition IDs (e.g., "comp-data-grid")

---

## Save Workflow

### When to Trigger

- User explicitly asks: "save this", "remember this layout", "save as X"
- User expresses satisfaction: "perfect", "this is what I wanted"
- Complex layouts are finalized
- User asks for an "app" or "template"

### Steps

1. **Determine composition name** - Ask user or infer from context
2. **Generate unique ID** - Format: `composition-{name}`
3. **Capture current layout** - Map set_workspace layout to template ID
4. **Create composition** via `store_create`

### Example

```javascript
// User says: "save this as my-analytics-dashboard"
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

### Layout Mapping

| set_workspace layout | Composition layout ID |
|---------------------|----------------------|
| `single` | `layout-workspace-flexible` |
| `split-h` | `layout-workspace-split-h` |
| `split-v` | `layout-workspace-split-v` |

---

## Load Workflow

### When to Trigger

- User names a workspace: "load my-dashboard", "show the component showcase"
- User references previous config: "that view we made earlier"
- User asks to restore: "open the X app"

### Steps

1. **Query for composition** by name
2. **Map layout ID** to set_workspace layout type
3. **Extract panels** from slotContent
4. **Apply via set_workspace**

### Example

```javascript
// User says: "load the component showcase"

// Step 1: Query
const result = await store_query({
  schema: "component-builder",
  model: "Composition",
  filter: { name: "component-showcase" },
  terminal: "first"
})

// Step 2-4: Map and apply
set_workspace({
  layout: "single",  // Mapped from layout-workspace-flexible
  panels: [{
    slot: "main",
    section: result.slotContent[0].section,
    config: result.slotContent[0].config
  }]
})
```

### Layout Reverse Mapping

| Composition layout ID | set_workspace layout |
|----------------------|---------------------|
| `layout-workspace-flexible` | `single` |
| `layout-workspace-split-h` | `split-h` |
| `layout-workspace-split-v` | `split-v` |

---

## List Workflow

### When to Trigger

- User asks: "what workspaces do I have?", "list saved views"
- User is unsure which composition to load

### Example

```javascript
// Query all compositions
const compositions = await store_query({
  schema: "component-builder",
  model: "Composition",
  terminal: "toArray"
})

// Present to user
// Example output:
// - workspace (active workspace)
// - component-showcase (70 component sections with navigation)
// - my-dashboard (split view with analytics)
```

---

## Special Cases

### AppShell Compositions

AppShell sections have complex configs with nested structures:

```javascript
{
  id: "composition-component-showcase",
  name: "component-showcase",
  layout: "layout-workspace-flexible",
  slotContent: [{
    slot: "main",
    section: "AppShellSection",
    config: {
      navigationMode: "section-browser",
      showAppBar: true,
      showSideNav: true,
      appBar: { title: "Component Showcase" },
      sideNav: {
        groups: [
          { label: "Layout", items: [...] },
          { label: "Data Display", items: [...] }
        ]
      },
      exampleConfigs: {
        "DataGridSection": { schema: "studio-chat", model: "ChatSession" },
        "DesignContainerSection": { schemaName: "platform-features" }
      }
    }
  }]
}
```

### Overwriting Existing

To update an existing composition, use `store_update`:

```javascript
store_update({
  schema: "component-builder",
  model: "Composition",
  id: "composition-my-dashboard",
  changes: {
    slotContent: [/* new content */]
  }
})
```

---

## Seed Data Distribution

To share compositions across team environments, add them to seed data:

**File**: `packages/mcp/src/seed-data/component-builder.ts`

```typescript
export const COMPOSITIONS: Composition[] = [
  // ... existing compositions
  {
    id: 'composition-my-shared-dashboard',
    name: 'my-shared-dashboard',
    layout: 'layout-workspace-split-h',
    slotContent: [
      { slot: 'left', section: 'DataGridSection', config: { ... } },
      { slot: 'right', section: 'ChartSection', config: { ... } }
    ]
  }
]
```

After adding to seed data:
1. Rebuild packages: `bun run build`
2. Restart MCP server
3. Load schema: `schema_load({ name: "component-builder" })`

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Composition name not found | Return null from query, inform user |
| Duplicate composition name | Suggest alternative or offer to overwrite |
| Invalid section in slotContent | Section renders empty/error state |
| Missing config properties | Section uses defaults |

---

## Related

- [[virtual-tools]] - Pattern 4-6 for save/load/list
- [[component-builder-domain]] - Composition entity details
- [[composition-patterns]] - Common composition templates
