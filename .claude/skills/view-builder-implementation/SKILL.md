---
name: view-builder-implementation
description: >
  Implement components from approved ComponentSpec entities. Use after
  view-builder-spec when a spec has status='approved'. Generates component
  code, writes tests (TDD-lite), registers in sectionImplementations, and
  updates the spec with implementedAs reference. Invoke when ready to
  "implement the component", "build from spec", or "generate the code".
---

# View Builder Implementation

Generate component code from approved ComponentSpec entities.

## Architectural Decisions

Implementation varies based on the `registrationStrategy` captured in the ComponentSpec. **Always check this field before generating code.**

### Strategy: sectionImplementationMap (Standalone Section)

```
registrationStrategy: "sectionImplementationMap"
isDiscoverable: true
namingConvention: "{Name}Section"
```

**File Location:** `apps/web/src/components/rendering/sections/{Name}Section.tsx`

**Registration Requirements:**
- ✅ Add to `sectionImplementations.tsx` map
- ✅ Create ComponentDefinition seed data entry
- ✅ Export from section barrel file (if in subdirectory)
- ✅ Accessible via `set_workspace`

### Strategy: embedded (Internal Sub-component)

```
registrationStrategy: "embedded"
parentContainer: "ComponentBuilderSection"
isDiscoverable: false
namingConvention: "{Name}Panel"
```

**File Location:** Inside parent container directory
- `apps/web/src/components/rendering/sections/{parent-dir}/{Name}Panel.tsx`

**Registration Requirements:**
- ❌ DO NOT add to `sectionImplementations.tsx`
- ❌ DO NOT create ComponentDefinition seed data
- ❌ DO NOT export from barrel `index.ts`
- ✅ Import only from parent component

**Implementation Pattern:**
```typescript
// Inside parent component
import { NewFeaturePanel } from "./NewFeaturePanel"

// Used within parent's render
<NewFeaturePanel {...contextFromProvider} />
```

### Strategy: rendererBindings (Property Renderer)

```
registrationStrategy: "rendererBindings"
isDiscoverable: false (via bindings)
namingConvention: "{Name}Renderer" or "{Name}Display"
```

**File Location:** `apps/web/src/components/rendering/displays/{Name}Display.tsx`

**Registration Requirements:**
- ✅ Create ComponentDefinition with category="renderer"
- ✅ Create RendererBinding entity linking property patterns to this renderer
- ❌ DO NOT add to sectionImplementationMap

### Strategy: compositionOnly (Composition Template)

```
registrationStrategy: "compositionOnly"
isDiscoverable: true (via composition)
```

**File Location:** None - data only

**Registration Requirements:**
- ✅ Create LayoutTemplate entity (if new layout needed)
- ✅ Create Composition entity
- ❌ No React component file needed
- ❌ No sectionImplementationMap entry

### Pre-Implementation Validation

Before generating any code, verify:

```javascript
// Block if strategy is undecided
if (spec.registrationStrategy === "undecided") {
  throw new Error("Cannot implement spec with undecided registration strategy")
}

// For embedded, verify parent exists
if (spec.registrationStrategy === "embedded" && !spec.parentContainer) {
  throw new Error("Embedded strategy requires parentContainer")
}
```

---

## Input

- `ComponentSpec` with status="approved"
- Component-builder schema loaded
- Requirements, layout decisions, data bindings from spec

## Output

- New React component file (section, renderer, or composition config)
- Component registered in sectionImplementations.tsx
- ComponentDefinition seed data entry
- ComponentSpec.status updated to "implemented"
- ComponentSpec.implementedAs linked to new ComponentDefinition

## Workflow

### Phase 1: Load Spec

```javascript
schema.load("component-builder")

spec = store.query({
  model: "ComponentSpec",
  schema: "component-builder",
  filter: { id: "{specId}" },
  terminal: "first"
})

// Validate spec is approved
if (spec.status !== "approved") {
  // Error: Spec must be approved before implementation
}
```

Present implementation plan:
```
Implementation Plan

Spec: {spec.name}
Type: {spec.componentType}
Intent: {spec.intent}

Architecture:
- Strategy: {spec.registrationStrategy}
- Discoverable: {spec.isDiscoverable}
- Naming: {spec.namingConvention}
{if spec.parentContainer}- Parent: {spec.parentContainer}{/if}

Requirements: {count} ({mustHaveCount} must-have)
Data Bindings: {dataBindings.length} schemas
Reuse: {reuseOpportunities.length} patterns identified

{if spec.registrationStrategy === "sectionImplementationMap"}
Files to create/modify (STANDALONE):
1. apps/web/src/components/rendering/sections/{Name}Section.tsx
2. Update: sectionImplementations.tsx (add import + map entry)
3. Update: packages/mcp/src/seed-data/component-builder.ts
{/if}
{if spec.registrationStrategy === "embedded"}
Files to create/modify (EMBEDDED in {spec.parentContainer}):
1. apps/web/src/components/rendering/sections/{parent-dir}/{Name}Panel.tsx
2. Update: {ParentComponent}.tsx (add import + render)
⚠️ NO registration in sectionImplementations.tsx
⚠️ NO seed data entry
{/if}
{if spec.registrationStrategy === "rendererBindings"}
Files to create/modify (RENDERER):
1. apps/web/src/components/rendering/displays/{Name}Display.tsx
2. Update: packages/mcp/src/seed-data/component-builder.ts (ComponentDefinition + RendererBinding)
{/if}
{if spec.registrationStrategy === "compositionOnly"}
Data to create (COMPOSITION ONLY):
1. LayoutTemplate entity (if new layout)
2. Composition entity
⚠️ NO component file needed
{/if}

Proceed with implementation?
```

### Phase 2: Generate Component Code

Based on `componentType`, use the appropriate template.

#### Section Component Template

```typescript
/**
 * {Name}Section Component
 * Task: view-builder-implementation
 * Spec: {specId}
 *
 * {spec.intent}
 *
 * Data bindings:
 * {for each dataBinding}
 * - {schema}.{model}: {purpose}
 * {/for}
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import type { SectionRendererProps } from "../sectionImplementations"

export const {Name}Section = observer(function {Name}Section({
  feature,
  config,
}: SectionRendererProps) {
  // Access domains for data
  const { {domain} } = useDomains()

  // Handle missing feature
  if (!feature) {
    return (
      <section data-testid="{kebab-name}-section">
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No feature session available
          </p>
        </div>
      </section>
    )
  }

  // Fetch data
  // {based on dataBindings}

  return (
    <section data-testid="{kebab-name}-section">
      {/* Implementation based on layout decisions */}
    </section>
  )
})
```

See [section-template.md](references/section-template.md) for full template with patterns.

#### Renderer Component Template

For `componentType: "renderer"`, create a PropertyRenderer-compatible component:

```typescript
import type { PropertyRendererProps } from "@/components/rendering/PropertyRenderer"

export function {Name}Renderer({ value, property, config }: PropertyRendererProps) {
  // Render based on value and config
  return <span>{/* ... */}</span>
}
```

#### Composition Config

For `componentType: "composition"`, create Wavesmith entities:

```javascript
// Create LayoutTemplate if needed
store.create("LayoutTemplate", "component-builder", {
  id: "layout-{name}",
  name: "{name}",
  slots: [/* based on layoutDecisions */],
  createdAt: Date.now()
})

// Create Composition
store.create("Composition", "component-builder", {
  id: "composition-{name}",
  name: "{name}",
  layout: "layout-{name}",
  slotContent: [/* based on requirements */],
  createdAt: Date.now()
})
```

### Phase 3: TDD-Lite Verification

Lightweight test approach for UI components:

1. **Visual verification** - Render component, check output
2. **Props contract** - Verify required props handled
3. **Empty state** - Check graceful degradation
4. **Data display** - Verify data bindings work

```typescript
// Example test structure (not required to write full test file)
describe("{Name}Section", () => {
  it("renders without feature", () => {
    // Should show empty state message
  })

  it("renders with feature data", () => {
    // Should display expected content
  })

  it("handles empty data gracefully", () => {
    // Should show "no data" message, not crash
  })
})
```

**Verification steps:**
1. Build passes: `bun run build`
2. Component renders in browser without errors
3. Empty state displays correctly
4. With data, displays expected content

### Phase 4: Register Component

**Registration varies by strategy.** Only perform steps that apply to the spec's `registrationStrategy`.

#### Strategy: sectionImplementationMap

```typescript
// 4a. Add to sectionImplementations.tsx
import { {Name}Section } from "./sections/{Name}Section"

// Map entry
["{Name}Section", {Name}Section],

// 4b. Add seed data to component-builder.ts
{
  id: "comp-{kebab-name}-section",
  name: "{Name}Section",
  category: "section",
  description: "{spec.intent}",
  implementationRef: "{Name}Section",
  tags: ["section", /* relevant tags */],
},
```

#### Strategy: embedded

**⚠️ NO sectionImplementations.tsx changes**
**⚠️ NO seed data entry**

```typescript
// Only update parent component to import and use
// In {parentContainer}.tsx:
import { {Name}Panel } from "./{Name}Panel"

// Inside parent render
<{Name}Panel {...propsFromContext} />
```

#### Strategy: rendererBindings

```typescript
// 4a. Add seed data ComponentDefinition
{
  id: "comp-{kebab-name}-display",
  name: "{Name}Display",
  category: "renderer",
  description: "{spec.intent}",
  implementationRef: "{Name}Display",
  tags: ["renderer", /* relevant tags */],
},

// 4b. Create RendererBinding entity
store.create("RendererBinding", "component-builder", {
  id: "binding-{kebab-name}",
  renderer: "comp-{kebab-name}-display",
  propertyPattern: { /* matching criteria */ },
  priority: 10,
  createdAt: Date.now()
})
```

#### Strategy: compositionOnly

**⚠️ NO file registration needed**

```javascript
// Create entities via MCP
store.create("LayoutTemplate", "component-builder", { /* ... */ })
store.create("Composition", "component-builder", { /* ... */ })
```

### Phase 5: Complete Spec

1. Create ComponentDefinition (if not already in seed data):

```javascript
store.create("ComponentDefinition", "component-builder", {
  id: "comp-{kebab-name}",
  name: "{Name}Section",
  category: "section",
  description: spec.intent,
  implementationRef: "{Name}Section",
  tags: ["section", "view-builder"],
  createdAt: Date.now()
})
```

2. Update ComponentSpec:

```javascript
store.update(spec.id, "ComponentSpec", "component-builder", {
  status: "implemented",
  implementedAs: "comp-{kebab-name}",
  updatedAt: Date.now()
})
```

### Phase 6: Handoff

Present completion summary:
```
Implementation Complete

Component: {Name}Section
Spec: {spec.name} (now status=implemented)

Files created/modified:
- apps/web/src/components/rendering/sections/{Name}Section.tsx
- apps/web/src/components/rendering/sectionImplementations.tsx
- packages/mcp/src/seed-data/component-builder.ts

Verification:
- Build: passing
- Render: verified in browser

The component is now available for use via:
- Direct: <{Name}Section feature={...} config={{...}} />
- Composition: slotContent with component="comp-{kebab-name}"
- Virtual tools: set_workspace with section="{Name}Section"
```

## Component Type Specifics

### Section Components

**Location:** `apps/web/src/components/rendering/sections/{Name}Section.tsx`

**Pattern:**
- Use `observer` for MobX reactivity
- Access data via `useDomains()`
- Accept `SectionRendererProps`
- Handle missing/empty states gracefully

### Renderer Components

**Location:** `apps/web/src/components/rendering/displays/{Name}Display.tsx`

**Pattern:**
- Receive value + config via props
- No direct data fetching (value passed in)
- Return inline-compatible JSX

**Registration:**
- Add to component-builder seed data
- Create RendererBinding for matching

### Composition Configs

**Location:** Wavesmith entities (no file needed)

**Pattern:**
- Create via store.create
- Reference existing ComponentDefinitions
- Define slot layout via LayoutTemplate

## Code Generation Guidelines

### From Requirements

| Requirement Pattern | Code Pattern |
|---------------------|--------------|
| "Display X as list" | Map over array, render items |
| "Group by Y" | Filter/reduce to create groups |
| "Show count of Z" | .length or aggregate |
| "Allow selection" | useState for selectedId |
| "Highlight active" | Conditional className |

### From Layout Decisions

| Decision | Implementation |
|----------|----------------|
| "Horizontal columns" | flex with gap, overflow-x-auto |
| "Vertical stack" | flex-col with space-y |
| "Grid layout" | grid with grid-cols-X |
| "Card-based" | rounded border shadow pattern |

### From Data Bindings

```typescript
// Each binding becomes a data fetch
const { {schema} } = useDomains()
const data = {schema}.{collection}.{queryMethod}()
```

### From Interaction Patterns

| Interaction | Hook |
|-------------|------|
| selection | useState<string \| null>(null) |
| drag | useDrag/useDrop (if available) |
| hover | onMouseEnter/onMouseLeave |
| click | onClick handler |

## References

- [section-template.md](references/section-template.md) - Full section component template
- [tdd-lite.md](references/tdd-lite.md) - Lightweight TDD workflow for UI
