# Section Component Template

Full template for generating section components from ComponentSpec.

## Base Template

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
 *
 * Config options:
 * - {config option}: {description}
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * {Name}Section Component
 *
 * {One-line description from spec.intent}
 *
 * @param props - SectionRendererProps with feature and optional config
 */
export const {Name}Section = observer(function {Name}Section({
  feature,
  config,
}: SectionRendererProps) {
  // Access domains for data
  const { {primaryDomain} } = useDomains()

  // Extract config options with defaults
  const layout = config?.layout ?? "list"

  // Handle missing feature (e.g., in preview mode)
  if (!feature) {
    return (
      <section data-testid="{kebab-name}-section">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {Section Title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No feature session available
          </p>
        </div>
      </section>
    )
  }

  // Fetch data based on bindings
  const data = {primaryDomain}?.{collection}?.{queryMethod}?.(feature.id) ?? []

  // Handle empty data gracefully
  if (data.length === 0) {
    return (
      <section data-testid="{kebab-name}-section">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {Section Title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No data available
          </p>
        </div>
      </section>
    )
  }

  // Main render
  return (
    <section data-testid="{kebab-name}-section">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        {Section Title} ({data.length})
      </h3>

      <div className="space-y-2">
        {data.map((item: any) => (
          <Card key={item.id} className="p-3">
            {/* Card content based on requirements */}
          </Card>
        ))}
      </div>
    </section>
  )
})
```

## Pattern Variations

### List Layout

```typescript
<div className="space-y-2">
  {data.map((item: any) => (
    <div key={item.id} className="flex items-center gap-2 p-2 rounded hover:bg-muted/50">
      <span className="text-sm">{item.name}</span>
      <Badge variant="secondary">{item.status}</Badge>
    </div>
  ))}
</div>
```

### Grid Layout

```typescript
<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
  {data.map((item: any) => (
    <Card key={item.id}>
      <CardContent className="p-3">
        <p className="font-medium">{item.name}</p>
        <p className="text-sm text-muted-foreground">{item.description}</p>
      </CardContent>
    </Card>
  ))}
</div>
```

### Kanban Layout

```typescript
<div className="flex gap-4 overflow-x-auto pb-4">
  {columns.map((column) => (
    <div key={column.id} className="flex-shrink-0 w-72">
      <h4 className="font-medium mb-2 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${column.color}`} />
        {column.name} ({column.items.length})
      </h4>
      <div className="space-y-2">
        {column.items.map((item: any) => (
          <Card key={item.id} className="p-2">
            <p className="text-sm">{item.name}</p>
          </Card>
        ))}
      </div>
    </div>
  ))}
</div>
```

### Grouped Layout

```typescript
<div className="space-y-4">
  {Object.entries(groupedData).map(([groupKey, items]) => (
    <div key={groupKey}>
      <h4 className="text-sm font-medium text-muted-foreground mb-2">
        {groupKey} ({items.length})
      </h4>
      <div className="space-y-1">
        {items.map((item: any) => (
          <div key={item.id} className="p-2 bg-muted/30 rounded">
            {item.name}
          </div>
        ))}
      </div>
    </div>
  ))}
</div>
```

## Adding Interactivity

### Selection State

```typescript
import { useState } from "react"

export const {Name}Section = observer(function {Name}Section({ ... }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return (
    <div className="space-y-2">
      {data.map((item: any) => (
        <div
          key={item.id}
          onClick={() => setSelectedId(item.id)}
          className={cn(
            "p-2 rounded cursor-pointer transition-colors",
            selectedId === item.id
              ? "bg-primary/10 border-primary"
              : "hover:bg-muted/50"
          )}
        >
          {item.name}
        </div>
      ))}
    </div>
  )
})
```

### Expand/Collapse

```typescript
const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

const toggleExpand = (id: string) => {
  const next = new Set(expandedIds)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  setExpandedIds(next)
}
```

## Common UI Patterns

### Status Badge

```typescript
const statusColors: Record<string, string> = {
  pending: "bg-gray-500",
  active: "bg-blue-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
}

<Badge className={statusColors[item.status]}>
  {item.status}
</Badge>
```

### Priority Indicator

```typescript
const priorityColors: Record<string, string> = {
  high: "text-red-500",
  medium: "text-amber-500",
  low: "text-blue-500",
}

<span className={priorityColors[item.priority]}>
  {item.priority}
</span>
```

### Empty State with Icon

```typescript
import { FileX } from "lucide-react"

<div className="p-8 text-center">
  <FileX className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
  <p className="text-muted-foreground">No items found</p>
  <p className="text-xs text-muted-foreground/60 mt-1">
    Items will appear here when added
  </p>
</div>
```
