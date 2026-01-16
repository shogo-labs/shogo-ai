# Virtual Tools Reference

Virtual tools allow Claude to control the UI through the chat interface.

## Available Tools

### set_workspace

Changes the workspace layout and visible panels.

**Parameters:**
```typescript
{
  layout?: "single" | "split-h" | "split-v"
  panels: Array<{
    slot: string          // "main", "left", "right", "top", "bottom"
    section: string       // Component name (see Available Sections)
    config?: object       // Section-specific configuration
  }>
}
```

**Layout to Template Mapping:**
| Layout | Template ID | Slots |
|--------|-------------|-------|
| `single` | `layout-workspace-flexible` | main |
| `split-h` | `layout-workspace-split-h` | left, right |
| `split-v` | `layout-workspace-split-v` | top, bottom |

**Available Sections:**
| Section Name | Purpose | Config |
|--------------|---------|--------|
| `DesignContainerSection` | Schema visualization | `{ schemaName: string }` |
| `WorkspaceBlankStateSection` | Empty state | none |
| `DynamicCompositionSection` | Render saved composition | `{ compositionId: string }` |
| `DataGridSection` | Generic data grid/table | `{ schema: string, model: string }` |
| `PlanPreviewSection` | Display ComponentSpec | `{ specId: string }` |

---

### Examples: set_workspace

**Show schema visualization:**
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

**Split view with two panels:**
```javascript
set_workspace({
  layout: "split-h",
  panels: [
    { slot: "left", section: "DesignContainerSection", config: { schemaName: "platform-features" } },
    { slot: "right", section: "DataGridSection", config: { schema: "platform-features", model: "Requirement" } }
  ]
})
```

**Show a saved composition:**
```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "DynamicCompositionSection",
    config: { compositionId: "composition-custom-dashboard" }
  }]
})
```

---

### execute

Performs CRUD operations on domain entities.

**Parameters:**
```typescript
{
  operations: Array<{
    domain: "component-builder" | "studio-chat" | "platform-features"
    action: "create" | "update" | "delete"
    model: string         // Entity type
    id?: string           // Required for update/delete
    data?: object         // Entity data
  }>
}
```

**Domain to Collection Mapping:**
| Domain | Available Models |
|--------|------------------|
| `component-builder` | ComponentDefinition, Registry, RendererBinding, LayoutTemplate, Composition |
| `platform-features` | FeatureSession, Requirement, AnalysisFinding, ImplementationTask, TestSpecification, etc. |
| `studio-chat` | ChatSession, ChatMessage |

---

### Examples: execute

**Create a new composition:**
```javascript
execute({
  operations: [{
    domain: "component-builder",
    action: "create",
    model: "Composition",
    data: {
      id: "composition-my-dashboard",
      name: "my-dashboard",
      layout: "layout-workspace-split-h",
      slotContent: [
        { slot: "left", component: "comp-requirements-list", config: {} },
        { slot: "right", component: "comp-findings-matrix", config: {} }
      ]
    }
  }]
})
```

**Update workspace composition:**
```javascript
execute({
  operations: [{
    domain: "component-builder",
    action: "update",
    model: "Composition",
    id: "composition-workspace",
    data: {
      layout: "layout-workspace-flexible",
      slotContent: [{
        slot: "main",
        component: "comp-design-container",
        config: { schemaName: "platform-features" }
      }]
    }
  }]
})
```

**Update feature session status:**
```javascript
execute({
  operations: [{
    domain: "platform-features",
    action: "update",
    model: "FeatureSession",
    id: "session-123",
    data: { status: "design" }
  }]
})
```

**Multiple operations in one call:**
```javascript
execute({
  operations: [
    {
      domain: "component-builder",
      action: "create",
      model: "Composition",
      data: { id: "comp-new", name: "new-view", ... }
    },
    {
      domain: "platform-features",
      action: "update",
      model: "FeatureSession",
      id: "session-123",
      data: { currentView: "comp-new" }
    }
  ]
})
```

---

## Workflow Patterns

### Pattern 1: Show Existing Data
```javascript
// Query to find appropriate section
store_query({ schema: "component-builder", model: "ComponentDefinition", filter: { category: "section" } })

// Show it
set_workspace({
  panels: [{ slot: "main", section: "DesignContainerSection", config: { schemaName: "..." } }]
})
```

### Pattern 2: Create and Show Composition
```javascript
// Create composition
execute({
  operations: [{
    domain: "component-builder",
    action: "create",
    model: "Composition",
    data: { id: "composition-custom", name: "custom", ... }
  }]
})

// Show it
set_workspace({
  panels: [{
    slot: "main",
    section: "DynamicCompositionSection",
    config: { compositionId: "composition-custom" }
  }]
})
```

### Pattern 3: Update and Refresh
```javascript
// Update existing composition
execute({
  operations: [{
    domain: "component-builder",
    action: "update",
    model: "Composition",
    id: "composition-workspace",
    data: { slotContent: [...] }
  }]
})
// UI automatically re-renders via MobX reactivity
```

### Pattern 4: Save Workspace as Named Composition
```javascript
// Save current workspace layout for later reuse
store_create({
  schema: "component-builder",
  model: "Composition",
  data: {
    id: "composition-my-dashboard",
    name: "my-dashboard",
    layout: "layout-workspace-split-h",
    slotContent: [
      { slot: "left", section: "DataGridSection", config: { schema: "studio-chat", model: "ChatSession" } },
      { slot: "right", section: "DesignContainerSection", config: { schemaName: "platform-features" } }
    ]
  }
})
```
**Important**: Use `section` key in slotContent (not `component`).

### Pattern 5: Load Saved Composition
```javascript
// 1. Query for the saved composition
const result = store_query({
  schema: "component-builder",
  model: "Composition",
  filter: { name: "my-dashboard" },
  terminal: "first"
})

// 2. Apply to workspace
// Map layout ID to layout type and extract panels from slotContent
set_workspace({
  layout: "split-h",  // Map: layout-workspace-split-h → split-h
  panels: result.slotContent.map(item => ({
    slot: item.slot,
    section: item.section,
    config: item.config
  }))
})
```

### Pattern 6: List Available Compositions
```javascript
// Show user what saved workspaces exist
store_query({
  schema: "component-builder",
  model: "Composition",
  terminal: "toArray"
})
// Returns array of compositions with id, name, layout, slotContent
```

---

## Error Handling

- If section name is invalid, the handler logs a warning but doesn't crash
- If composition ID doesn't exist, DynamicCompositionSection shows empty state
- Invalid entity references in slotContent will fail silently

Always validate:
1. Section names are in the available list
2. Composition IDs exist before referencing
3. Layout slots match the layout template

---

## Notes

- `set_workspace` updates the workspace Composition entity under the hood
- `execute` operations trigger MobX reactivity - UI updates automatically
- Multiple operations in one `execute` call are processed sequentially
- The `schemaName` config in DesignContainerSection also updates FeatureSession
