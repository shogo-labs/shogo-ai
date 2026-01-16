# Generic Section Template

Pattern for creating sections that work with **any** Wavesmith schema/model via config, rather than hardcoding a specific domain.

## When to Use

Use this pattern when building:
- Data browsers (grids, tables, lists)
- Visualization components (charts, graphs)
- Collection viewers that should work across domains
- Reusable workspace components

## Config Interface

```typescript
interface GenericSectionConfig {
  /** Schema name (e.g., "platform-features", "studio-chat") */
  schema: string

  /** Model name (e.g., "Requirement", "ChatSession") */
  model: string

  /** Optional: Specific fields to display */
  columns?: string[]

  /** Optional: Fields to exclude from auto-detection */
  excludeColumns?: string[]

  /** Optional: Section title override */
  title?: string

  /** Optional: Query configuration for async data loading */
  query?: {
    filter?: Record<string, any>
    orderBy?: { field: string; direction: 'asc' | 'desc' }[]
    skip?: number
    take?: number
  }

  /** Optional: Filter by current feature session (default: true when feature present) */
  sessionFilter?: boolean
}
```

## Component Structure

```typescript
/**
 * {Name}Section Component
 *
 * Generic section that renders {description} for any Wavesmith collection.
 * Schema and model specified via config props.
 *
 * Config:
 * - schema: Schema name (required)
 * - model: Model name (required)
 * - query: Async query options (optional)
 * - ...additional options
 */

import { observer } from "mobx-react-lite"
import type { SectionRendererProps } from "../sectionImplementations"

export const {Name}Section = observer(function {Name}Section({
  feature,
  config,
}: SectionRendererProps) {
  const sectionConfig = config as GenericSectionConfig | undefined

  // Extract config with defaults
  const schemaName = sectionConfig?.schema
  const modelName = sectionConfig?.model
  const title = sectionConfig?.title ?? (modelName ? `${modelName} Data` : "Data")

  // === PHASE 1: Validate Config ===
  if (!schemaName || !modelName) {
    return (
      <section data-testid="{kebab-name}-section">
        <ConfigRequiredState
          message="Configuration required: specify schema and model"
          example='{ schema: "platform-features", model: "Requirement" }'
        />
      </section>
    )
  }

  // === PHASE 2: Load Metadata ===
  // Access meta-store for property information
  // Handle async schema loading if needed
  // See: meta-store-integration.md

  // === PHASE 3: Load Data ===
  // Choose sync or async path based on config
  // See: data-loading-patterns.md

  // === PHASE 4: Handle States ===
  if (loading) {
    return <LoadingState title={title} />
  }

  if (error) {
    return <ErrorState title={title} message={error} />
  }

  if (data.length === 0) {
    return <EmptyState title={title} message="No data available" />
  }

  // === PHASE 5: Render ===
  return (
    <section data-testid="{kebab-name}-section">
      <SectionHeader title={title} count={data.length} />
      <ContentArea>
        {/* Render data using property metadata for type-aware display */}
      </ContentArea>
    </section>
  )
})
```

## Key Principles

### 1. Config-Driven, Not Hardcoded

```typescript
// BAD: Hardcoded domain
const { platformFeatures } = useDomains()
const data = platformFeatures.requirementCollection.all()

// GOOD: Config-driven
const schemaName = config?.schema
const modelName = config?.model
// Dynamically access the right domain/collection
```

### 2. Metadata from Meta-Store

```typescript
// BAD: Hardcoded property assumptions
const columns = ['id', 'name', 'status', 'priority']

// GOOD: Derive from metadata
const properties = model.properties ?? []
const columns = config?.columns ?? properties.map(p => p.name)
```

### 3. PropertyRenderer for Type-Aware Display

```typescript
// BAD: Manual type checking
{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}

// GOOD: Delegate to PropertyRenderer
<PropertyRenderer
  property={propertyMetadata}
  value={value}
  entity={entity}
/>
```

### 4. Graceful State Handling

Every generic section must handle:
- Missing config (show config instructions)
- Loading state (show spinner/skeleton)
- Error state (show error message)
- Empty state (show "no data" message)
- Success state (render data)

### 5. Session Context Awareness

```typescript
// Default: Filter by feature session when feature is present
const useSessionFilter = config?.sessionFilter !== false && feature?.id

if (useSessionFilter) {
  // Use session-scoped data
} else {
  // Use full dataset
}
```

## aiGuidance Integration

Generic sections should include comprehensive `aiGuidance` in their ComponentDefinition seed data. This helps AI agents configure the section correctly.

Structure for aiGuidance:
1. **Required Config** - What must be provided
2. **Data Loading** - Sync vs async explanation
3. **Query Examples** - JSON config patterns
4. **Display Options** - Available customizations
5. **When to Use** - Appropriate scenarios
6. **Common Patterns** - User intent → config mappings

See existing DataGridSection aiGuidance as reference.

## Registration Checklist

When implementing a generic section:

- [ ] Component file: `apps/web/src/components/rendering/sections/{Name}Section.tsx`
- [ ] Register in `sectionImplementations.tsx`
- [ ] Add ComponentDefinition to seed data with:
  - [ ] `supportedConfig` listing all config options
  - [ ] `aiGuidance` with configuration patterns
  - [ ] Appropriate `tags` for discoverability
- [ ] Handle all states (config, loading, error, empty, success)
- [ ] Use PropertyRenderer for type-aware field display
- [ ] Support both sync and async data paths via config

## Examples

- **DataGridSection** - Generic table/grid for any collection
- **ChartSection** - Generic D3 visualization for any collection

These serve as reference implementations of the generic section pattern.
