# New Component Guide

Step-by-step guide for creating new renderer components.

---

## Overview

Adding a new renderer requires:
1. React component file
2. Export in index.ts
3. Registration in implementations.ts
4. ComponentDefinition entity via MCP
5. RendererBinding entity via MCP
6. Seed data entry for persistence

---

## Step 1: Create React Component

**Location:** `apps/web/src/components/rendering/displays/{ComponentName}.tsx`

### Template

```typescript
/**
 * {ComponentName} - {Brief description}
 * Task: component-builder-evolution
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - variant: default, muted, emphasized, warning, success, error
 * - {other config you support}
 */

import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { DisplayRendererProps, XRendererConfig } from "../types"

// Size class mapping
const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "",
  lg: "text-lg",
  xl: "text-xl"
}

// Variant class mapping
const variantClasses: Record<NonNullable<XRendererConfig["variant"]>, string> = {
  default: "",
  muted: "text-muted-foreground",
  emphasized: "font-semibold",
  warning: "text-amber-600",
  success: "text-green-600",
  error: "text-red-600"
}

function {ComponentName}Impl({
  value,
  property,
  config = {}
}: DisplayRendererProps) {
  // Handle null/undefined
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  // Build class names from config
  const className = cn(
    sizeClasses[config.size ?? "md"],
    variantClasses[config.variant ?? "default"],
    // Add any component-specific classes
  )

  // Render the value
  return (
    <span className={className}>
      {/* Your rendering logic here */}
      {String(value)}
    </span>
  )
}

// Export with observer wrapper and supportedConfig
export const {ComponentName} = observer({ComponentName}Impl) as typeof {ComponentName}Impl & {
  supportedConfig: string[]
}

{ComponentName}.supportedConfig = ["size", "variant"]  // List all supported config
```

### Key Patterns

**Handle null/undefined:**
```typescript
if (value == null) {
  return <span className="text-muted-foreground">-</span>
}
```

**Use config with defaults:**
```typescript
const size = config.size ?? "md"
const variant = config.variant ?? "default"
```

**Support truncation:**
```typescript
const truncateLen = config.truncate === false
  ? undefined
  : typeof config.truncate === "number"
    ? config.truncate
    : 200  // default

const text = String(value)
const displayText = truncateLen && text.length > truncateLen
  ? `${text.slice(0, truncateLen)}...`
  : text
```

---

## Step 2: Export from Index

**For primitive displays:**
`apps/web/src/components/rendering/displays/index.ts`

```typescript
export { {ComponentName} } from "./{ComponentName}"
```

**For domain displays:**
`apps/web/src/components/rendering/displays/domain/index.ts`

```typescript
export { {ComponentName} } from "./{ComponentName}"
```

---

## Step 3: Register in Implementations Map

**Location:** `apps/web/src/components/rendering/implementations.ts`

```typescript
// Import the component
import { {ComponentName} } from "./displays"
// Or for domain:
import { {ComponentName} } from "./displays/domain"

// Add to the map
export const componentImplementationMap = new Map<
  string,
  ComponentType<DisplayRendererProps>
>([
  // ... existing entries ...
  ["{ComponentName}", {ComponentName}],
])
```

**Critical:** The string key must exactly match `implementationRef` in seed data.

---

## Step 4: Create ComponentDefinition via MCP

```javascript
store.create({
  model: "ComponentDefinition",
  schema: "component-builder",
  data: {
    id: "comp-{kebab-name}",
    name: "{Human Readable Name}",
    category: "display",  // or "input", "layout", "visualization"
    description: "{What it does and when to use it}",
    implementationRef: "{ComponentName}",  // Must match map key exactly
    tags: ["{category}", "{type}", "readonly"],
    supportedConfig: ["size", "variant"],  // List supported config keys
    createdAt: Date.now()
  }
})
```

---

## Step 5: Create RendererBinding via MCP

### For explicit x-renderer binding (recommended for domain components)

```javascript
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "{binding-id}",
    name: "{Binding Name}",
    registry: "studio",
    component: "comp-{kebab-name}",  // Must match ComponentDefinition.id
    matchExpression: { xRenderer: "{renderer-id}" },
    priority: 200,
    defaultConfig: {
      size: "md",
      variant: "default"
    },
    createdAt: Date.now()
  }
})
```

### For type/format-based binding

```javascript
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "{binding-id}",
    name: "{Binding Name}",
    registry: "default",  // or "studio"
    component: "comp-{kebab-name}",
    matchExpression: {
      type: "string",
      format: "custom-format"
    },
    priority: 30,  // Format-level priority
    defaultConfig: { /* defaults */ },
    createdAt: Date.now()
  }
})
```

---

## Step 6: Add to Seed Data

**Location:** `packages/mcp/src/seed-data/component-builder.ts`

### ComponentDefinition entry

```typescript
export const COMPONENT_DEFINITIONS: ComponentDefinitionSeed[] = [
  // ... existing ...
  {
    id: "comp-{kebab-name}",
    name: "{Human Name}",
    category: "display",
    description: "{Description}",
    implementationRef: "{ComponentName}",
    tags: ["{tags}"],
    supportedConfig: ["size", "variant"],
  },
]
```

### RendererBinding entry

```typescript
const STUDIO_BINDINGS: RendererBindingSeed[] = [
  // ... existing ...
  {
    id: "{binding-id}",
    name: "{Binding Name}",
    registry: "studio",
    component: "comp-{kebab-name}",
    matchExpression: { xRenderer: "{renderer-id}" },
    priority: 200,
    defaultConfig: { size: "md" },
  },
]
```

---

## Step 7: Build and Verify

```bash
# Build the project
bun run build

# If you get type errors, check:
# - Import path is correct
# - Component name matches everywhere
# - DisplayRendererProps interface is used
```

---

## Example: Creating a PercentageDisplay

### 1. Component File

`apps/web/src/components/rendering/displays/PercentageDisplay.tsx`

```typescript
/**
 * PercentageDisplay - Renders numeric values as percentages
 * Task: component-builder-evolution
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

function PercentageDisplayImpl({ value, config = {} }: DisplayRendererProps) {
  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const num = Number(value)
  if (isNaN(num)) {
    return <span className="text-muted-foreground">Invalid</span>
  }

  // Determine variant based on value if not specified
  const autoVariant = num >= 80 ? "success" : num >= 50 ? "default" : num >= 20 ? "warning" : "error"
  const variant = config.variant ?? autoVariant

  const className = cn(
    sizeClasses[config.size ?? "md"],
    variantClasses[variant],
    "font-mono"
  )

  return <span className={className}>{num.toFixed(1)}%</span>
}

export const PercentageDisplay = observer(PercentageDisplayImpl) as typeof PercentageDisplayImpl & {
  supportedConfig: string[]
}

PercentageDisplay.supportedConfig = ["size", "variant"]
```

### 2. Export

```typescript
// displays/index.ts
export { PercentageDisplay } from "./PercentageDisplay"
```

### 3. Implementation Map

```typescript
// implementations.ts
import { PercentageDisplay } from "./displays"

// In the map:
["PercentageDisplay", PercentageDisplay],
```

### 4. MCP Operations

```javascript
// Create ComponentDefinition
store.create({
  model: "ComponentDefinition",
  schema: "component-builder",
  data: {
    id: "comp-percentage-display",
    name: "Percentage Display",
    category: "display",
    description: "Renders numeric values as percentages with semantic coloring",
    implementationRef: "PercentageDisplay",
    tags: ["primitive", "numeric", "percentage", "readonly"],
    supportedConfig: ["size", "variant"],
    createdAt: Date.now()
  }
})

// Create RendererBinding
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "percentage-display",
    name: "Percentage Display Binding",
    registry: "studio",
    component: "comp-percentage-display",
    matchExpression: { xRenderer: "percentage" },
    priority: 200,
    defaultConfig: { size: "md" },
    createdAt: Date.now()
  }
})
```

### 5. Seed Data

```typescript
// In COMPONENT_DEFINITIONS
{
  id: "comp-percentage-display",
  name: "Percentage Display",
  category: "display",
  description: "Renders numeric values as percentages with semantic coloring",
  implementationRef: "PercentageDisplay",
  tags: ["primitive", "numeric", "percentage", "readonly"],
  supportedConfig: ["size", "variant"],
},

// In STUDIO_BINDINGS
{
  id: "percentage-display",
  name: "Percentage Display Binding",
  registry: "studio",
  component: "comp-percentage-display",
  matchExpression: { xRenderer: "percentage" },
  priority: 200,
  defaultConfig: { size: "md" },
},
```

---

## Checklist

- [ ] Component file created with observer wrapper
- [ ] supportedConfig static property declared
- [ ] Exported from index.ts
- [ ] Registered in implementations.ts
- [ ] ComponentDefinition created via MCP
- [ ] RendererBinding created via MCP
- [ ] Seed data updated
- [ ] Build passes
- [ ] UI renders correctly
