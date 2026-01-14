# Composition Patterns Reference

Common patterns for composing views from existing components.

## Layout Selection Guide

| User Need | Layout | Slots | When to Use |
|-----------|--------|-------|-------------|
| Single focused view | `single` | main | Default for most requests |
| Side-by-side comparison | `split-h` | left, right | "X and Y together", "compare" |
| Stacked views | `split-v` | top, bottom | "X above Y", sequential workflow |
| Multi-panel dashboard | Custom | varies | 3+ components |

---

## Pattern 1: Single Panel View

**Use when:** User wants to see one type of data

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

**Variations:**
- Schema visualization → `DesignContainerSection`
- Empty state → `WorkspaceBlankStateSection`
- Builder UI → `ComponentBuilderSection`
- Saved view → `DynamicCompositionSection`

---

## Pattern 2: Split View (Horizontal)

**Use when:** User wants two things side by side

```javascript
set_workspace({
  layout: "split-h",
  panels: [
    { slot: "left", section: "SectionA", config: {} },
    { slot: "right", section: "SectionB", config: {} }
  ]
})
```

**Common combinations:**
- Schema + Builder: Design on left, preview on right
- List + Detail: Collection on left, selected item on right
- Compare: Two schemas or two compositions

---

## Pattern 3: Split View (Vertical)

**Use when:** User wants stacked workflow

```javascript
set_workspace({
  layout: "split-v",
  panels: [
    { slot: "top", section: "OverviewSection", config: {} },
    { slot: "bottom", section: "DetailSection", config: {} }
  ]
})
```

**Common combinations:**
- Overview + Detail
- Input + Output
- Configuration + Preview

---

## Pattern 4: Composition with Provider

**Use when:** Sections need shared state

```javascript
// Create composition with provider wrapper
execute({
  operations: [{
    domain: "component-builder",
    action: "create",
    model: "Composition",
    data: {
      id: "composition-with-context",
      name: "with-context",
      layout: "layout-two-column-compact",
      providerWrapper: "AnalysisPanelProvider",
      slotContent: [
        { slot: "main", component: "comp-findings-matrix", config: {} },
        { slot: "sidebar", component: "comp-context-panel", config: {} }
      ]
    }
  }]
})
```

**Available providers:**
- `AnalysisPanelProvider` - Shares finding filter state
- `TestingPanelProvider` - Shares selected test/task
- `ImplementationPanelProvider` - Shares execution selection
- `WorkspaceProvider` - Default for workspace compositions

---

## Pattern 5: Dashboard Composition

**Use when:** User wants multiple data types in one view

```javascript
execute({
  operations: [{
    domain: "component-builder",
    action: "create",
    model: "Composition",
    data: {
      id: "composition-dashboard",
      name: "my-dashboard",
      layout: "layout-discovery-enhanced",  // 7-slot grid
      slotContent: [
        { slot: "hero", component: "comp-phase-hero", config: {} },
        { slot: "overview", component: "comp-session-overview", config: {} },
        { slot: "main-left", component: "comp-requirements-list", config: {} },
        { slot: "main-center", component: "comp-intent-panel", config: {} },
        { slot: "main-right", component: "comp-insights-panel", config: {} }
      ]
    }
  }]
})
```

---

## Pattern 6: Dynamic Data View (via ComponentBuilder)

**Use when:** User wants to configure data display

```javascript
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "ComponentBuilderSection",
    config: {
      suggestedDataSource: {
        schema: "platform-features",
        model: "Requirement"
      },
      suggestedLayout: "kanban",
      suggestedGroupBy: "priority",
      suggestedProperties: ["name", "status", "priority"]
    }
  }]
})
```

**Config options:**
- `suggestedDataSource` - Pre-select schema and model
- `suggestedLayout` - Pre-select layout type (list/grid/kanban)
- `suggestedGroupBy` - Pre-select grouping field
- `suggestedProperties` - Pre-select visible properties

---

## Pattern 7: Container Section with Internal Sub-components

**Use when:** Building complex sections with multiple internal panels that shouldn't be independently discoverable.

**Example:** ComponentBuilderSection contains internal panels but is the only discoverable entry point.

### Structure

```
ComponentBuilderSection (discoverable)
├── ComponentBuilderContext (provider)
├── BuilderLayout (layout orchestrator)
├── DefinitionPanel (internal - not discoverable)
└── PreviewPanel (internal - not discoverable)
```

### Key Characteristics

1. **Only the container is discoverable**
   - Registered in `sectionImplementationMap`
   - Has ComponentDefinition entry
   - Accessible via `set_workspace`

2. **Sub-components use Panel/Display naming**
   ```
   ✅ PreviewPanel, DefinitionPanel
   ❌ PreviewSection, DefinitionSection
   ```

3. **Don't export sub-components from barrel**
   ```typescript
   // index.ts
   export { ComponentBuilderSection } from "./ComponentBuilderSection"
   // Internal components NOT exported:
   // export { PreviewPanel } from "./PreviewPanel"  // ❌
   ```

4. **File structure reflects containment**
   ```
   sections/
   └── component-builder/
       ├── index.ts           # Only exports container
       ├── ComponentBuilderSection.tsx
       ├── ComponentBuilderContext.tsx
       ├── BuilderLayout.tsx
       ├── PreviewPanel.tsx   # Internal
       └── DefinitionPanel.tsx # Internal
   ```

### When to Use This Pattern

**DO use container pattern when:**
- Sub-components only make sense within the container context
- Sub-components share state via the container's provider
- Users should interact with the container, not individual panels
- Adding functionality means extending the container, not creating standalone sections

**DON'T use container pattern when:**
- Sub-components would be useful in other contexts
- You're trying to add a genuinely new visualization type
- The "sub-component" handles different data than the container

### Anti-Pattern: Section Inside Container

```
❌ WRONG: Creating DataGridSection inside ComponentBuilderSection
   - "Section" suffix implies standalone
   - Would need registration, seed data, etc.
   - Creates confusion about discoverability

✅ RIGHT: Creating DataGridPanel inside ComponentBuilderSection
   - "Panel" suffix indicates internal
   - No external registration needed
   - Clear that it's part of ComponentBuilder

✅ ALSO RIGHT: Creating standalone DataGridSection
   - If datagrids should be independently usable
   - Registered in sectionImplementationMap
   - ComponentBuilder could USE it, not contain it
```

### Implementation Checklist

When building a container section:

- [ ] Container registered in `sectionImplementationMap`
- [ ] Container has ComponentDefinition seed data entry
- [ ] Sub-components use `{Name}Panel` or `{Name}Display` naming
- [ ] Sub-components NOT exported from barrel `index.ts`
- [ ] Sub-components NOT registered in sectionImplementationMap
- [ ] Sub-components NOT in seed data as ComponentDefinitions
- [ ] Provider context lives in container directory
- [ ] All sub-components receive context from container's provider

---

## Section Compatibility Matrix

| Section | Single | Split-H | Split-V | Dashboard |
|---------|--------|---------|---------|-----------|
| DesignContainerSection | Yes | Yes | Yes | As panel |
| ComponentBuilderSection | Yes | Yes | No | No |
| DynamicCompositionSection | Yes | Yes | Yes | As panel |
| WorkspaceBlankStateSection | Yes | No | No | No |

---

## Anti-Patterns

### Don't: Nest compositions deeply
```javascript
// Avoid: Composition within composition within composition
{ component: "DynamicCompositionSection", config: { compositionId: "nested-1" } }
// where nested-1 also contains DynamicCompositionSection
```

### Don't: Mix incompatible sections
```javascript
// Avoid: ComponentBuilder expects full width
set_workspace({
  layout: "split-h",
  panels: [
    { slot: "left", section: "ComponentBuilderSection" },  // Cramped
    { slot: "right", section: "ComponentBuilderSection" }  // Cramped
  ]
})
```

### Don't: Use wrong slots for layout
```javascript
// Avoid: split-h only has left/right
set_workspace({
  layout: "split-h",
  panels: [
    { slot: "main", section: "..." }  // Wrong slot name
  ]
})
```

---

## Slot Names by Layout

| Layout | Valid Slots |
|--------|-------------|
| `single` / `layout-workspace-flexible` | main |
| `split-h` / `layout-workspace-split-h` | left, right |
| `split-v` / `layout-workspace-split-v` | top, bottom |
| `layout-phase-two-column` | header, main, sidebar, actions |
| `layout-two-column-compact` | main, sidebar |
| `layout-discovery-enhanced` | hero, overview, main-left, main-center, main-right, insights, actions |

---

## Notes

- Always match slot names to the layout template
- Provider wrappers are optional but enable cross-section state
- DynamicCompositionSection can render any saved composition
- ComponentBuilderSection config pre-populates the builder UI
