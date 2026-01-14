---
name: view-builder
description: >
  Guide Claude through view/component building flows using the component-builder
  domain and virtual tools. Use when users want to show data, change layouts,
  build dashboards, or create visualizations. Follows "Render First, Refine
  Through Dialogue" philosophy.
---

# View Builder Skill

> **Purpose**: Guide Claude through view/component building flows using the component-builder domain and virtual tools.
> **Philosophy**: "Render First, Refine Through Dialogue" - always show something immediately, then improve through conversation.

## When to Activate

Trigger on patterns like:
- "Show me X" / "Display X"
- "Show X as Y" / "X as kanban/grid/list"
- "Build me a X" / "Create a X view"
- "I want to see X" / "Visualize X"
- Requests to change how data is displayed

---

## Phase 0: Context Loading

**Always start by understanding current state.** Query the component-builder domain:

```
1. Available capabilities:
   - ComponentDefinitions → What sections/renderers exist
   - LayoutTemplates → What arrangements are possible
   - Compositions → What views already exist
   - Registries + Bindings → How properties map to renderers

2. Current state:
   - What's the active feature/session?
   - What composition is currently displayed?
   - What schema context are we working in?
```

Use Wavesmith MCP tools:
- `schema_list` → See available schemas
- `store_query` with model="ComponentDefinition" → List available components
- `store_query` with model="Composition" → List existing views
- `store_query` with model="LayoutTemplate" → List available layouts

---

## Phase 1: Intent Classification

Apply explicit criteria to classify the user's request into one of four branches:

### Branch A: View Existing Data
**Criteria:**
- User asks to "show", "display", or "see" data
- Data type exists as a known schema/model
- No presentation change requested (just "show me X")

**Evidence to gather:**
- Does the model exist? → Query schema list
- Is there an existing section for this model? → Query ComponentDefinitions by category="section"
- Is there a composition already? → Query Compositions by name

**Action:** Use `set_workspace` with appropriate section

---

### Branch B: Change Presentation
**Criteria:**
- User asks to change HOW existing data displays
- Uses layout terms: "kanban", "grid", "list", "table"
- Uses styling terms: "colors", "grouped by", "sorted by"

**Evidence to gather:**
- What layout is requested? → Match against LayoutTemplate names
- What field to group/sort by? → Infer from request or ask (max 1 question)
- Does a binding exist for requested style? → Query RendererBindings

**Action:** Update composition via `execute` or use `set_workspace` with config

---

### Branch C: Compose Multiple
**Criteria:**
- User asks for "dashboard", "combined view", or multiple things together
- Multiple data types or sections mentioned
- Keywords: "side by side", "together", "dashboard"

**Evidence to gather:**
- What components are needed? → Classify each sub-request
- Do all components exist? → Query ComponentDefinitions
- What layout arranges them? → Match slot count to LayoutTemplates

**Action:** Create Composition with multiple slotContent entries via `execute`

---

### Branch D: Novel Visualization
**Criteria:**
- User asks for capability that doesn't exist
- Visualization type not in current ComponentDefinitions
- Examples: "dependency graph", "timeline", "force-directed layout"

**Evidence to gather:**
- What capability is missing? → Classify as relational/temporal/spatial
- Can we approximate? → Find closest existing section
- What would full capability need? → Gather through dialogue (if user wants)

**Action:** Render approximation immediately, offer to build full capability

---

## Phase 2: Execute Branch

### Branch A Execution: View Existing

```javascript
// Use set_workspace to show a section
set_workspace({
  layout: "single",
  panels: [{
    slot: "main",
    section: "RequirementsListSection",  // or appropriate section
    config: { /* context-specific config */ }
  }]
})
```

**Available sections for data viewing:**
- `DesignContainerSection` - Schema visualization
- `RequirementsListSection` - Requirements display (if exists)
- `DynamicCompositionSection` - Render any saved composition

---

### Branch B Execution: Change Presentation

**Option 1: Use set_workspace with config**
```javascript
set_workspace({
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

**Option 2: Update composition directly**
```javascript
execute({
  operations: [{
    domain: "component-builder",
    action: "update",
    model: "Composition",
    id: "composition-workspace",
    data: {
      slotContent: [{
        slot: "main",
        component: "comp-collection-view",
        config: { layout: "kanban", groupBy: "priority" }
      }]
    }
  }]
})
```

---

### Branch C Execution: Compose Multiple

```javascript
// Create a dashboard composition
execute({
  operations: [{
    domain: "component-builder",
    action: "create",
    model: "Composition",
    data: {
      id: "composition-custom-dashboard",
      name: "custom-dashboard",
      layout: "layout-workspace-split-h",
      slotContent: [
        { slot: "left", component: "comp-requirements-section", config: {} },
        { slot: "right", component: "comp-findings-section", config: {} }
      ]
    }
  }]
})

// Then show it
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

### Branch D Execution: Novel Visualization

**Step 1: Render approximation immediately**
```javascript
// Show closest available approximation
set_workspace({
  panels: [{
    slot: "main",
    section: "DesignContainerSection",  // or tree view, list, etc.
    config: { schemaName: "platform-features" }
  }]
})
```

**Step 2: Offer refinement**
Present to user:
- "Here's [approximation]. For a full [requested visualization], I'd need to [gather requirements / create new component]."
- "Want me to build that capability, or is this sufficient?"

**Step 3: If user wants full capability**
Enter planning dialogue to gather requirements:
- Component type (section/renderer/composition)
- Layout decisions with rationale
- Data bindings needed
- Interaction patterns

**Step 3b: Architectural Decision Gate (REQUIRED)**

Before proceeding to spec capture, explicitly decide and confirm with user:

**Decision: Standalone vs Embedded?**

| Option | Description | When to Use |
|--------|-------------|-------------|
| **A) Standalone Section** | Registered in sectionImplementationMap, discoverable via set_workspace | Component is independently useful, multiple contexts might use it, users should compose it into views |
| **B) Embedded Sub-component** | Internal to parent container, not discoverable | Only useful within specific container, needs parent context, shouldn't be user-facing |

**Present to user:**
> "I'm planning to build [description]. Architecturally, this should be:
>
> **Option A: Standalone Section** - Appears in set_workspace, independently discoverable, registered globally
>
> **Option B: Embedded in [ParentContainer]** - Internal only, not discoverable, tightly coupled to parent
>
> Which approach makes sense for your use case?"

**Naming conventions by architecture:**
- Standalone: `{Name}Section` (e.g., `DataGridSection`)
- Embedded: `{Name}Panel` or `{Name}Display` (e.g., `DataGridPanel`)

**Proceed only after user confirms architecture choice.** This decision affects:
- File location
- Registration requirements
- Export patterns
- Discoverability

**Step 4: When user approves plan**
Use `/view-builder-spec` to capture the agreed plan as a ComponentSpec entity:
```javascript
// Creates ComponentSpec with requirements, decisions, bindings
// Shows spec in PlanPreviewSection for review
// User approves → status becomes "approved"
```

**Step 5: Implement the component**
Use `/view-builder-implementation` to generate code from the approved spec:
```javascript
// Creates component file from spec
// Registers in sectionImplementations.tsx
// Adds seed data entry
// Updates ComponentSpec.status to "implemented"
```

See:
- [view-builder-spec](../view-builder-spec/SKILL.md) - Capture specs from dialogue
- [view-builder-implementation](../view-builder-implementation/SKILL.md) - Generate code from specs

---

## Phase 3: Validation

Before finalizing any composition:

1. **Reference validity**: Does slotContent reference valid ComponentDefinitions?
2. **Layout compatibility**: Does the layout support the required slots?
3. **Config validity**: Are config values valid for the target section?

If validation fails, adjust and retry.

---

## Phase 4: Feedback Loop

After rendering:

1. **Present result**: Describe what was rendered
2. **Offer refinements**: "Want me to change X?" / "Should I add Y?"
3. **Handle feedback**:
   - If user refines → Update and re-render (loop back to Phase 2)
   - If user satisfied → Optionally save as named composition
4. **Save if requested**:
   ```javascript
   execute({
     operations: [{
       domain: "component-builder",
       action: "create",
       model: "Composition",
       data: { name: "user-specified-name", ... }
     }]
   })
   ```

---

## Virtual Tools Reference

### set_workspace
Changes what's displayed in the workspace.

**Parameters:**
```typescript
{
  layout?: "single" | "split-h" | "split-v"
  panels: Array<{
    slot: "main" | "left" | "right" | "top" | "bottom"
    section: string  // Component name
    config?: object  // Section-specific config
  }>
}
```

**Available sections:**
- `DesignContainerSection` - Schema visualization
- `WorkspaceBlankStateSection` - Empty state
- `ComponentBuilderSection` - View builder UI
- `DynamicCompositionSection` - Render saved compositions
- `PlanPreviewSection` - Display ComponentSpec during planning (config: `{ specId: "..." }`)

### execute
Performs CRUD operations on domain entities.

**Parameters:**
```typescript
{
  operations: Array<{
    domain: "component-builder" | "studio-chat" | "platform-features"
    action: "create" | "update" | "delete"
    model: string  // Entity type
    id?: string    // Required for update/delete
    data?: object  // Entity data
  }>
}
```

---

## References

- [[component-builder-domain]] - Entity types, queries, seed data
- [[virtual-tools]] - Detailed tool usage and examples
- [[decision-criteria]] - Explicit criteria for each branch
- [[composition-patterns]] - Common composition templates

### Related Skills

- [view-builder-spec](../view-builder-spec/SKILL.md) - Capture ComponentSpec from planning dialogue (Branch D step 4)
- [view-builder-implementation](../view-builder-implementation/SKILL.md) - Generate code from approved specs (Branch D step 5)

---

## Key Principles

1. **Render First**: Always show something immediately, even if rough
2. **Evidence Before Action**: Query domain state before deciding
3. **Minimal Questions**: Infer when possible, ask max 1-2 questions
4. **Explicit Criteria**: Use decision framework, not intuition
5. **Feedback Welcome**: Every render is an invitation to refine
