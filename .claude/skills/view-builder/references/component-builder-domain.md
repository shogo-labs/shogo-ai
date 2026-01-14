# Component-Builder Domain Reference

The component-builder domain provides the data model for data-driven UI composition.

## Entity Types

### ComponentDefinition
Catalog entry for a UI component.

```typescript
{
  id: string              // "comp-string-display"
  name: string            // "String Display"
  category: "display" | "input" | "layout" | "visualization" | "section"
  description?: string
  implementationRef: string   // Code-side registry key
  tags?: string[]            // ["primitive", "text", "domain"]
  supportedConfig?: string[] // ["variant", "size", "truncate"]
  propsSchema?: object       // JSON Schema for props
  previewRef?: string
}
```

**Seed Data (66 components):**
- **Display (25)**: StringDisplay, NumberDisplay, BooleanDisplay, DateTimeDisplay, EmailDisplay, UriDisplay, EnumBadge, ReferenceDisplay, ComputedDisplay, ArrayDisplay, ObjectDisplay, plus domain badges (PriorityBadge, ArchetypeBadge, TaskStatusBadge, etc.)
- **Visualization (4)**: ProgressBar, DataCard, GraphNode, StatusIndicator
- **Section (27)**: Phase-specific sections (Discovery, Analysis, Classification, Design, Spec, Testing, Implementation)
- **Workspace (3)**: ComponentBuilderSection, DynamicCompositionSection, PropertyFieldSection

---

### Registry
Component registry with inheritance support.

```typescript
{
  id: string
  name: string            // "default", "studio"
  description?: string
  extends?: Registry      // Parent registry (child bindings take priority)
  fallbackComponent?: ComponentDefinition
  bindings: RendererBinding[]  // Computed inverse
}
```

**Seed Data (2 registries):**
- `default` - Base registry with primitive display renderers
- `studio` - Extends default with domain-specific xRenderer bindings

**Computed Views:**
- `allBindings` - All bindings including inherited (child-first priority)
- `toEntrySpecs()` - Converts to hydration format
- `fallbackRef` - Traverses chain to find fallback

---

### RendererBinding
Maps PropertyMetadata patterns to components.

```typescript
{
  id: string
  name: string
  registry: Registry      // Reference
  component: ComponentDefinition  // Reference
  matchExpression: object // MongoDB-style query
  priority: number        // Higher wins (0-200)
  defaultConfig?: XRendererConfig
}
```

**Priority Cascade:**
- 200: Explicit xRenderer (domain-specific)
- 100: Computed properties, references
- 50: Enum values
- 30: Format-based (date-time, email, uri)
- 10: Type-based (string, number, boolean)
- 0: Fallback

**Seed Data (32 bindings):** 12 in default + 20 in studio

---

### LayoutTemplate
Slot-based layout definitions.

```typescript
{
  id: string
  name: string
  description?: string
  slots: Array<{
    name: string          // "main", "sidebar", "header"
    position: string      // CSS grid area or flex position
    required?: boolean
  }>
  defaultBindings?: Record<string, string>  // slotName → componentId
}
```

**Seed Data (7 layouts):**
- `layout-phase-two-column` - Header + main/sidebar + actions
- `layout-single-column` - Single main slot
- `layout-two-column-compact` - Left/right, no header
- `layout-workspace-flexible` - Dynamic single slot
- `layout-workspace-split-h` - Horizontal split (left/right)
- `layout-workspace-split-v` - Vertical split (top/bottom)
- `layout-discovery-enhanced` - 7-slot grid

---

### Composition
Concrete view from LayoutTemplate + slot content.

```typescript
{
  id: string
  name: string
  layout: LayoutTemplate  // Reference
  slotContent: Array<{
    slot: string          // Matches layout slot name
    component: string     // ComponentDefinition ID
    config?: object       // Section-specific config
  }>
  dataContext?: object    // Shared data for all slots
  providerWrapper?: string    // e.g., "AnalysisPanelProvider"
  providerConfig?: object
}
```

**Seed Data (9 compositions):**
- Phase views: `discovery`, `analysis`, `classification`, `design`, `spec`, `testing`, `implementation`
- `discovery-basic` - Legacy discovery
- `workspace` - Dynamic workspace (modified by virtual tools)

**Computed Views:**
- `toSlotSpecs()` - Converts to SlotSpec[] for rendering

---

## Query Patterns

### List Available Components
```javascript
store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  terminal: "toArray"
})

// By category
store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  filter: { category: "section" },
  terminal: "toArray"
})

// By tag
store_query({
  schema: "component-builder",
  model: "ComponentDefinition",
  filter: { tags: { $in: ["discovery-phase"] } },
  terminal: "toArray"
})
```

### List Compositions
```javascript
store_query({
  schema: "component-builder",
  model: "Composition",
  terminal: "toArray"
})

// Find by name
store_query({
  schema: "component-builder",
  model: "Composition",
  filter: { name: "discovery" },
  terminal: "first"
})
```

### List Layout Templates
```javascript
store_query({
  schema: "component-builder",
  model: "LayoutTemplate",
  terminal: "toArray"
})
```

### Get Registry with Bindings
```javascript
store_query({
  schema: "component-builder",
  model: "Registry",
  filter: { name: "studio" },
  terminal: "first"
})
// Registry.bindings gives all RendererBindings
```

---

## Key Implementation References

### Section Components (implementationRef values)
- `DesignContainerSection` → Schema visualization
- `SpecContainerSection` → ReactFlow dependency graph
- `ComponentBuilderSection` → View builder UI
- `DynamicCompositionSection` → Renders compositions by ID
- `RequirementsListSection` → Requirements display
- `RequirementsGridSection` → Grid/kanban requirements
- `FindingMatrixSection` → Analysis findings
- `IntentTerminalSection` → Discovery intent capture

### Display Components
- `StringDisplay`, `NumberDisplay`, `BooleanDisplay`
- `EnumBadge`, `PriorityBadge`, `ArchetypeBadge`
- `ReferenceDisplay`, `ArrayDisplay`, `ObjectDisplay`

---

## Notes

- All entities persist to `.data/component-builder/` as JSON
- Changes are reactive via MobX (update entity → UI re-renders)
- Registries support inheritance (studio extends default)
- Compositions can wrap content with providers (AnalysisPanelProvider, etc.)
