---
name: component-builder-evolution
description: >
  Intent-based UI evolution via the dynamic renderer binding system. Use when
  users want to change how data displays, add new visualization components,
  adjust rendering styles, or customize property presentation. Translates
  high-level UI intent into component-builder domain operations via MCP.
---

# Component Builder Evolution

Enable intent-based UI evolution by manipulating the dynamic renderer binding system.

## When to Use

Invoke this skill when users want to:
- Change how properties display ("make emails more prominent")
- Add custom renderers for specific data types
- Adjust rendering configuration (size, variant, truncation)
- Create new display components
- Build context-specific registries (dashboard, mobile, admin)

## Output

- Modified **RendererBinding** entities (config, priority, matchExpression)
- New **ComponentDefinition** entities (when creating components)
- New **Registry** entities (for context-specific rendering)
- Generated React component code (when creating new renderers)
- Updated seed data for persistence

---

## Workflow

### Phase 1: Load Context

Always start by loading the component-builder domain and querying current state.

```javascript
// Load the schema
schema.load("component-builder")

// Query current components
const components = store.query({
  model: "ComponentDefinition",
  schema: "component-builder"
})

// Query current bindings
const bindings = store.query({
  model: "RendererBinding",
  schema: "component-builder"
})

// Query registries
const registries = store.query({
  model: "Registry",
  schema: "component-builder"
})
```

Present a summary to the user:
```
Component Builder State:
- Components: {count} (display: X, input: Y, visualization: Z)
- Registries: default, studio (extends default)
- Bindings: {count} total (default: X, studio: Y)

Current binding priorities:
- 200: Explicit x-renderer bindings
- 100: Computed, references
- 50: Enums
- 30: Format (email, uri, date-time)
- 10: Type (string, number, boolean)

What would you like to change?
```

### Phase 2: Classify Intent

Determine which type of change the user wants:

| Intent Type | Indicators | Action |
|-------------|------------|--------|
| **Config Adjustment** | "bigger", "smaller", "muted", "emphasized", "truncate" | Update `defaultConfig` on existing binding |
| **Priority Change** | "prioritize", "prefer", "override" | Update `priority` values |
| **New Binding** | "add badge for", "render X as", "display Y with" | Create new RendererBinding |
| **New Component** | "create renderer", "custom display", "new visualization" | Generate code + entities |
| **New Registry** | "dashboard view", "mobile rendering", "admin styles" | Create Registry extending studio |

### Phase 3: Execute Changes

#### Config Adjustment

Find the relevant binding and update its config:

```javascript
// Find binding by various criteria
const binding = store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { id: "email-display" },  // or by matchExpression, component, etc.
  terminal: "first"
})

// Update config
store.update({
  model: "RendererBinding",
  schema: "component-builder",
  id: binding.id,
  changes: {
    defaultConfig: {
      size: "lg",
      variant: "emphasized",
      clickable: true
    },
    updatedAt: Date.now()
  }
})
```

#### New Binding

Create a binding that maps a match expression to a component:

```javascript
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "custom-status-badge",
    name: "Custom Status Badge Binding",
    registry: "studio",  // or "default" for base bindings
    component: "comp-enum-badge",  // ComponentDefinition.id
    matchExpression: { xRenderer: "custom-status" },  // or type/format match
    priority: 200,
    defaultConfig: { variant: "warning", size: "sm" },
    createdAt: Date.now()
  }
})
```

#### New Component (Full Lifecycle)

When creating a new renderer component:

**Step 1: Generate the React component file**

Create at `apps/web/src/components/rendering/displays/{ComponentName}.tsx`:

```typescript
/**
 * {ComponentName} - {Description}
 * Task: component-builder-evolution
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - variant: default, muted, emphasized, warning, success, error
 * - {other supported config}
 */

import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { DisplayRendererProps, XRendererConfig } from "../types"

const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "",
  lg: "text-lg",
  xl: "text-xl"
}

const variantClasses: Record<NonNullable<XRendererConfig["variant"]>, string> = {
  default: "",
  muted: "text-muted-foreground",
  emphasized: "font-semibold",
  warning: "text-amber-600",
  success: "text-green-600",
  error: "text-red-600"
}

function {ComponentName}Impl({ value, config = {} }: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const className = cn(
    sizeClasses[config.size ?? "md"],
    variantClasses[config.variant ?? "default"]
  )

  return <span className={className}>{/* render value */}</span>
}

export const {ComponentName} = observer({ComponentName}Impl) as typeof {ComponentName}Impl & {
  supportedConfig: string[]
}

{ComponentName}.supportedConfig = ["size", "variant"]
```

**Step 2: Export from displays/index.ts**

Add to `apps/web/src/components/rendering/displays/index.ts`:
```typescript
export { {ComponentName} } from "./{ComponentName}"
```

**Step 3: Register in implementations.ts**

Add to `apps/web/src/components/rendering/implementations.ts`:
```typescript
import { {ComponentName} } from "./displays"
// In componentImplementationMap:
["{ComponentName}", {ComponentName}],
```

**Step 4: Create ComponentDefinition via MCP**

```javascript
store.create({
  model: "ComponentDefinition",
  schema: "component-builder",
  data: {
    id: "comp-{kebab-name}",
    name: "{Human Name}",
    category: "display",  // or "input", "layout", "visualization"
    description: "{What it does}",
    implementationRef: "{ComponentName}",  // Must match map key
    tags: ["custom", "domain"],
    supportedConfig: ["size", "variant"],
    createdAt: Date.now()
  }
})
```

**Step 5: Create RendererBinding via MCP**

```javascript
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "{binding-id}",
    name: "{Binding Name}",
    registry: "studio",
    component: "comp-{kebab-name}",
    matchExpression: { xRenderer: "{renderer-id}" },
    priority: 200,
    defaultConfig: { /* defaults */ },
    createdAt: Date.now()
  }
})
```

**Step 6: Update seed data**

Add entries to `packages/mcp/src/seed-data/component-builder.ts` for persistence.

**Step 7: Run build**

```bash
bun run build
```

#### New Registry

Create a registry that extends studio with custom bindings:

```javascript
// Create the registry
store.create({
  model: "Registry",
  schema: "component-builder",
  data: {
    id: "dashboard",
    name: "dashboard",
    description: "Compact rendering for dashboard views",
    extends: "studio",  // Inherits all studio bindings
    createdAt: Date.now()
  }
})

// Add custom bindings to the new registry
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "dashboard-string-compact",
    name: "Dashboard String Compact",
    registry: "dashboard",
    component: "comp-string-display",
    matchExpression: { type: "string" },
    priority: 10,
    defaultConfig: { size: "xs", truncate: 50, layout: "compact" },
    createdAt: Date.now()
  }
})
```

### Phase 4: Verify Changes

After making changes:

1. **Query to confirm**:
```javascript
const updated = store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { id: "{binding-id}" },
  terminal: "first"
})
// Show the updated entity
```

2. **Instruct user to check UI**:
```
Changes applied successfully.

For MCP-only changes (bindings, config):
- UI should update immediately via MobX reactivity
- Open BindingEditorPanel (Cmd+Shift+B) to verify

For code changes (new components):
- Run: bun run build
- Restart dev server if needed
- Check the affected views
```

---

## Wavesmith Operations Reference

### Schema Operations
```javascript
schema.load("component-builder")  // Load schema into memory
schema.list()                      // List all schemas
```

### Store Operations
```javascript
// Query with filter
store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { registry: "studio" },
  terminal: "toArray"  // or "first", "count"
})

// Get by ID
store.get({
  model: "RendererBinding",
  schema: "component-builder",
  id: "binding-id"
})

// Create
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: { /* entity data */ }
})

// Update
store.update({
  model: "RendererBinding",
  schema: "component-builder",
  id: "binding-id",
  changes: { /* partial update */ }
})

// Delete
store.delete({
  model: "RendererBinding",
  schema: "component-builder",
  id: "binding-id"
})
```

---

## Common Patterns

### Make a property type more prominent
```javascript
// Find the binding for the type
const binding = store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { matchExpression: { type: "string", format: "email" } },
  terminal: "first"
})

// Update its config
store.update({
  model: "RendererBinding",
  schema: "component-builder",
  id: binding.id,
  changes: {
    defaultConfig: { size: "lg", variant: "emphasized" },
    updatedAt: Date.now()
  }
})
```

### Add a custom badge for an enum
```javascript
// Create binding with explicit xRenderer match
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "custom-priority-badge",
    name: "Custom Priority Badge",
    registry: "studio",
    component: "comp-enum-badge",
    matchExpression: { xRenderer: "priority-badge" },
    priority: 200,
    defaultConfig: { variant: "warning" },
    createdAt: Date.now()
  }
})
```

### Override type-based rendering for specific format
```javascript
// Higher priority binding for format takes precedence over type
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "custom-format-binding",
    name: "Custom Format Binding",
    registry: "studio",
    component: "comp-code-path-display",
    matchExpression: { type: "string", format: "path" },
    priority: 35,  // Higher than type (10), lower than explicit (200)
    defaultConfig: { truncate: 80 },
    createdAt: Date.now()
  }
})
```

---

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| "Component not found" | `implementationRef` not in map | Add to `implementations.ts` |
| "Binding not taking effect" | Lower priority than competing | Increase priority or use explicit xRenderer |
| "Registry not found" | Typo in `extends` | Verify parent registry exists |
| "Invalid matchExpression" | Bad MongoDB syntax | Check JSON and field names |

---

## References

- [match-expressions.md](references/match-expressions.md) - MongoDB query syntax
- [config-options.md](references/config-options.md) - XRendererConfig options
- [component-catalog.md](references/component-catalog.md) - All 29 components
- [new-component-guide.md](references/new-component-guide.md) - Creating renderers
- [priority-guide.md](references/priority-guide.md) - Priority conventions
- [registry-guide.md](references/registry-guide.md) - Registry management
