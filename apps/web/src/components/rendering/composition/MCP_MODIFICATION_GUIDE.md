# MCP View Modification Guide

This guide documents how Claude can modify phase view compositions via MCP (Model Context Protocol) tools. The composable-phase-views feature enables data-driven UI changes without code modifications.

## Overview

The ComposablePhaseView system allows Claude to:
1. Query current Composition configurations
2. Update slotContent to swap section components
3. Modify view configurations in real-time
4. Trigger reactive UI updates via MobX

## Architecture

```
MCP Tools (Wavesmith)           Component Builder Store
        │                                │
        ▼                                ▼
  store_query ──────────────► compositionCollection
  store_update ─────────────► slotContent changes
        │                                │
        └────────────────────────────────┘
                      │
                      ▼ MobX reactivity
               ComposablePhaseView
                      │
                      ▼
              SlotLayout + Sections
```

## Prerequisites

### Database Migration Required

Before using MCP tools with `category: "section"` components, the Postgres database constraint must be updated:

```sql
-- The component-builder schema includes "section" in the category enum,
-- but the DDL constraint may only have: display, input, layout, visualization

ALTER TABLE component_builder.component_definition
  DROP CONSTRAINT component_definition_category_check;

ALTER TABLE component_builder.component_definition
  ADD CONSTRAINT component_definition_category_check
  CHECK (category IN ('display', 'input', 'layout', 'visualization', 'section'));
```

Run this migration via:
```bash
# Using Wavesmith MCP after system-migrations schema is initialized
mcp__wavesmith__ddl_migrate({ schemaName: "component-builder" })
```

## MCP Workflow

### Step 1: Query Current Composition

First, load the schema and query the composition by phase name:

```javascript
// Load schema (if not already loaded)
mcp__wavesmith__schema_load({
  name: "component-builder"
})

// Query composition by name
mcp__wavesmith__store_query({
  model: "Composition",
  schema: "component-builder",
  filter: { name: "discovery" },
  terminal: "first"
})
```

**Expected Response:**
```json
{
  "ok": true,
  "count": 1,
  "items": [{
    "id": "composition-discovery",
    "name": "discovery",
    "layout": "layout-phase-detail",
    "slotContent": [
      { "slot": "header", "component": "comp-def-intent-terminal-section" },
      { "slot": "main", "component": "comp-def-requirements-list-section" },
      { "slot": "sidebar", "component": "comp-def-initial-assessment-section" },
      { "slot": "actions", "component": "comp-def-phase-actions-section" }
    ],
    "createdAt": 1736400000000
  }]
}
```

### Step 2: Update slotContent

Swap a section component by updating slotContent:

```javascript
// Example: Change main slot from RequirementsList to SessionSummary
mcp__wavesmith__store_update({
  id: "composition-discovery",
  model: "Composition",
  schema: "component-builder",
  changes: {
    slotContent: [
      { "slot": "header", "component": "comp-def-intent-terminal-section" },
      { "slot": "main", "component": "comp-def-session-summary-section" },  // Changed!
      { "slot": "sidebar", "component": "comp-def-initial-assessment-section" },
      { "slot": "actions", "component": "comp-def-phase-actions-section" }
    ],
    updatedAt: Date.now()
  }
})
```

**Expected Response:**
```json
{
  "ok": true,
  "updated": {
    "id": "composition-discovery",
    "slotContent": [
      { "slot": "header", "component": "comp-def-intent-terminal-section" },
      { "slot": "main", "component": "comp-def-session-summary-section" },
      { "slot": "sidebar", "component": "comp-def-initial-assessment-section" },
      { "slot": "actions", "component": "comp-def-phase-actions-section" }
    ]
  }
}
```

### Step 3: Verify UI Update

The MobX observer in ComposablePhaseView automatically re-renders when slotContent changes:

```typescript
// From ComposablePhaseView.tsx
export const ComposablePhaseView = observer(function ComposablePhaseView({
  phaseName,
  feature,
}) {
  const domains = useDomains()
  const componentBuilder = domains?.componentBuilder

  // MobX tracks this access - any changes trigger re-render
  const composition = componentBuilder?.compositionCollection?.findByName?.(phaseName)

  // toSlotSpecs() reads slotContent - also tracked
  const slotSpecs = composition.toSlotSpecs()

  // ...render slotChildren based on slotSpecs
})
```

**Reactivity Chain:**
1. `store_update` modifies slotContent in Wavesmith store
2. MobX detects change in observed `composition.slotContent`
3. `ComposablePhaseView` re-renders
4. New section component appears in UI

### Step 4: Revert Changes

To restore original configuration:

```javascript
mcp__wavesmith__store_update({
  id: "composition-discovery",
  model: "Composition",
  schema: "component-builder",
  changes: {
    slotContent: [
      { "slot": "header", "component": "comp-def-intent-terminal-section" },
      { "slot": "main", "component": "comp-def-requirements-list-section" },  // Restored
      { "slot": "sidebar", "component": "comp-def-initial-assessment-section" },
      { "slot": "actions", "component": "comp-def-phase-actions-section" }
    ],
    updatedAt: Date.now()
  }
})
```

## Available Section Components

| Component ID | Implementation Ref | Description |
|-------------|-------------------|-------------|
| `comp-def-intent-terminal-section` | `IntentTerminalSection` | Terminal-style intent display |
| `comp-def-requirements-list-section` | `RequirementsListSection` | List of captured requirements |
| `comp-def-initial-assessment-section` | `InitialAssessmentSection` | Archetype indicators |
| `comp-def-phase-actions-section` | `PhaseActionsSection` | Action buttons |
| `comp-def-session-summary-section` | `SessionSummarySection` | Session overview |

## Seed Data Setup

Before using the MCP workflow, seed data must exist. Create entities in this order:

### 1. ComponentDefinitions (Section Components)

```javascript
// For each section component
mcp__wavesmith__store_create({
  model: "ComponentDefinition",
  schema: "component-builder",
  data: {
    id: "comp-def-intent-terminal-section",
    name: "Intent Terminal Section",
    category: "section",
    description: "Displays the feature intent in a terminal-style format",
    implementationRef: "IntentTerminalSection",
    tags: ["discovery", "intent", "terminal"],
    createdAt: Date.now()
  }
})
```

### 2. LayoutTemplate

```javascript
mcp__wavesmith__store_create({
  model: "LayoutTemplate",
  schema: "component-builder",
  data: {
    id: "layout-phase-detail",
    name: "Phase Detail Layout",
    description: "Standard layout for phase views with header, main, sidebar, and actions",
    slots: [
      { name: "header", position: "top", required: true },
      { name: "main", position: "left", required: true },
      { name: "sidebar", position: "right", required: false },
      { name: "actions", position: "bottom", required: false }
    ],
    createdAt: Date.now()
  }
})
```

### 3. Composition

```javascript
mcp__wavesmith__store_create({
  model: "Composition",
  schema: "component-builder",
  data: {
    id: "composition-discovery",
    name: "discovery",
    layout: "layout-phase-detail",
    slotContent: [
      { slot: "header", component: "comp-def-intent-terminal-section" },
      { slot: "main", component: "comp-def-requirements-list-section" },
      { slot: "sidebar", component: "comp-def-initial-assessment-section" },
      { slot: "actions", component: "comp-def-phase-actions-section" }
    ],
    createdAt: Date.now()
  }
})
```

## Error Handling

### Component Not Found

If slotContent references a non-existent component:
- `toSlotSpecs()` returns `sectionRef: "FallbackSection"`
- UI displays a placeholder indicating missing section

### Composition Not Found

If `findByName` returns undefined:
- ComposablePhaseView shows "No composition found for phase: {phaseName}"
- Fallback allows graceful degradation

### Validation Errors

Store operations validate against schema:
- Missing required fields fail with VALIDATION_ERROR
- Invalid category values fail constraint checks
- Invalid reference IDs may fail depending on backend

## Testing

See tests in:
- `__tests__/ComposablePhaseView.test.tsx` - Unit tests for component rendering
- `apps/web/src/components/app/stepper/__tests__/PhaseContentPanel.composable.test.tsx` - Integration tests

## Related Files

- `/apps/web/src/components/rendering/composition/ComposablePhaseView.tsx` - Main renderer
- `/apps/web/src/components/rendering/composition/SlotLayout.tsx` - Slot-based layout
- `/apps/web/src/components/rendering/sectionImplementations.tsx` - Section registry
- `/apps/web/src/components/rendering/sections/*.tsx` - Section components
- `/.schemas/component-builder/schema.json` - Schema definition
- `/packages/state-api/src/component-builder/domain.ts` - Domain enhancements
