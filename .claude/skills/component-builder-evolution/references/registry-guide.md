# Registry Guide

Managing component registries for context-specific rendering.

---

## Overview

A **Registry** is a collection of bindings that maps property metadata to components. Registries support inheritance, allowing specialized registries to extend base registries.

---

## Current Registries

### default
- **ID:** `default`
- **Purpose:** Base registry with primitive type bindings
- **Fallback:** `comp-string-display`
- **Bindings:** 12 (type, format, metadata-based)

### studio
- **ID:** `studio`
- **Extends:** `default`
- **Purpose:** Extended registry with domain-specific renderers
- **Bindings:** 18 (explicit x-renderer bindings)

---

## Registry Inheritance

When a registry extends another:
1. Child bindings are checked first
2. Parent bindings are checked if no child matches
3. Fallback component comes from closest registry with one defined

```
studio (extends default)
├── Bindings: priority-badge, archetype-badge, etc.
└── default
    ├── Bindings: string-display, number-display, etc.
    └── Fallback: comp-string-display
```

---

## Creating a New Registry

### Step 1: Create Registry Entity

```javascript
store.create({
  model: "Registry",
  schema: "component-builder",
  data: {
    id: "dashboard",
    name: "dashboard",
    description: "Compact rendering optimized for dashboard views",
    extends: "studio",  // Inherit all studio bindings
    createdAt: Date.now()
  }
})
```

### Step 2: Add Custom Bindings

```javascript
// Override string display with compact config
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
    defaultConfig: {
      size: "xs",
      truncate: 30,
      layout: "compact"
    },
    createdAt: Date.now()
  }
})

// Custom badge styling
store.create({
  model: "RendererBinding",
  schema: "component-builder",
  data: {
    id: "dashboard-enum-compact",
    name: "Dashboard Enum Compact",
    registry: "dashboard",
    component: "comp-enum-badge",
    matchExpression: { enum: { "$exists": true } },
    priority: 50,
    defaultConfig: {
      size: "xs"
    },
    createdAt: Date.now()
  }
})
```

### Step 3: Update Seed Data

Add to `packages/mcp/src/seed-data/component-builder.ts`:

```typescript
export const REGISTRIES: RegistrySeed[] = [
  // ... existing ...
  {
    id: "dashboard",
    name: "dashboard",
    description: "Compact rendering for dashboard views",
    extends: "studio",
  },
]

const DASHBOARD_BINDINGS: RendererBindingSeed[] = [
  {
    id: "dashboard-string-compact",
    name: "Dashboard String Compact",
    registry: "dashboard",
    component: "comp-string-display",
    matchExpression: { type: "string" },
    priority: 10,
    defaultConfig: { size: "xs", truncate: 30, layout: "compact" },
  },
  // ... more bindings ...
]

export const RENDERER_BINDINGS: RendererBindingSeed[] = [
  ...DEFAULT_BINDINGS,
  ...STUDIO_BINDINGS,
  ...DASHBOARD_BINDINGS,
]
```

---

## Use Cases for Custom Registries

### Dashboard Registry
Compact, dense display for overview screens.

```json
{
  "id": "dashboard",
  "extends": "studio",
  "description": "Compact rendering for dashboard views"
}
```

Bindings:
- Smaller text sizes
- Aggressive truncation
- Compact layouts
- Minimal spacing

### Mobile Registry
Touch-friendly, large-target rendering.

```json
{
  "id": "mobile",
  "extends": "studio",
  "description": "Touch-friendly rendering for mobile views"
}
```

Bindings:
- Larger tap targets
- Bigger text
- Full-width layouts
- No truncation

### Admin Registry
Detailed, data-rich rendering for power users.

```json
{
  "id": "admin",
  "extends": "studio",
  "description": "Detailed rendering for admin views"
}
```

Bindings:
- Show all data
- Expandable sections
- Technical details visible
- No hiding/truncation

### Print Registry
Optimized for PDF/print output.

```json
{
  "id": "print",
  "extends": "default",
  "description": "Print-optimized rendering"
}
```

Bindings:
- No interactive elements
- Static displays
- High contrast
- Page-friendly layouts

---

## Registry Selection in UI

Currently, AppShell uses `studio` registry by default. To support switching:

### Option 1: Context-based Selection

```typescript
// In a dashboard route
<ComponentRegistryProvider registry={dashboardRegistry}>
  <DashboardContent />
</ComponentRegistryProvider>
```

### Option 2: User Preference

```typescript
// Store user preference
const { registryPreference } = useUserSettings()
const registry = getRegistryByName(registryPreference)
```

### Option 3: Media Query

```typescript
// Auto-detect based on screen size
const isMobile = useMediaQuery("(max-width: 768px)")
const registry = isMobile ? mobileRegistry : studioRegistry
```

---

## Registry Hierarchy Examples

### Simple Extension
```
default
└── studio
```

### Multi-level
```
default
└── studio
    ├── dashboard
    ├── mobile
    └── admin
```

### Feature-specific
```
default
└── studio
    └── feature-sessions
        ├── feature-discovery
        └── feature-implementation
```

---

## Querying Registries

### List all registries
```javascript
const registries = store.query({
  model: "Registry",
  schema: "component-builder"
})
```

### Get specific registry with bindings
```javascript
const registry = store.query({
  model: "Registry",
  schema: "component-builder",
  filter: { id: "dashboard" },
  terminal: "first"
})

// Get all bindings (including inherited)
// This uses the allBindings computed view
const allBindings = registry.allBindings
```

### Get bindings for a registry
```javascript
const bindings = store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { registry: "dashboard" }
})
```

---

## Modifying Registries

### Update registry metadata
```javascript
store.update({
  model: "Registry",
  schema: "component-builder",
  id: "dashboard",
  changes: {
    description: "Updated description",
    updatedAt: Date.now()
  }
})
```

### Change parent registry
```javascript
store.update({
  model: "Registry",
  schema: "component-builder",
  id: "mobile",
  changes: {
    extends: "dashboard",  // Now inherits from dashboard instead of studio
    updatedAt: Date.now()
  }
})
```

### Set fallback component
```javascript
store.update({
  model: "Registry",
  schema: "component-builder",
  id: "admin",
  changes: {
    fallbackComponent: "comp-object-display",  // Show full object instead of string
    updatedAt: Date.now()
  }
})
```

---

## Deleting Registries

**Warning:** Deleting a registry orphans its bindings and breaks any UI using it.

```javascript
// First, update bindings to point elsewhere
const bindings = store.query({
  model: "RendererBinding",
  schema: "component-builder",
  filter: { registry: "dashboard" }
})

for (const binding of bindings) {
  store.update({
    model: "RendererBinding",
    schema: "component-builder",
    id: binding.id,
    changes: { registry: "studio" }
  })
}

// Then delete the registry
store.delete({
  model: "Registry",
  schema: "component-builder",
  id: "dashboard"
})
```

---

## Best Practices

1. **Always extend** - New registries should extend studio or default
2. **Override selectively** - Only add bindings that differ from parent
3. **Use descriptive names** - dashboard, mobile, admin, print
4. **Document purpose** - Clear description of when to use
5. **Test inheritance** - Verify parent bindings still work
6. **Update seed data** - Persist changes for restart survival

---

## Troubleshooting

### Bindings not appearing
- Check registry ID matches exactly
- Verify extends chain is correct
- Look for typos in registry reference

### Wrong binding resolving
- Child bindings should override parent
- Check priorities between registries
- Use explicit x-renderer for certainty

### Fallback not working
- Verify fallbackComponent is valid ComponentDefinition ID
- Check parent registry has fallback defined
- Ensure component exists in implementations map
