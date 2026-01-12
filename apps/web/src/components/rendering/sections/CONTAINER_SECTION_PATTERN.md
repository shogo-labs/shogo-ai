# Container Section Pattern

Container sections encapsulate complex phase UIs that have tightly-coupled interactive elements, internal state management, and exclusive content switching (tabs, panels). Unlike simple sections that render a single piece of content, container sections coordinate multiple internal sub-components.

## When to Use Container Sections

Use the container section pattern when:

1. **Tabs/Exclusive Content** - The UI has tabbed navigation where only one tab is visible at a time (e.g., DesignView with Schema/Decisions/Hooks tabs)
2. **Tightly-Coupled Selection State** - Clicking elements in one area updates another area (e.g., SpecView graph selection → TaskDetailsPanel)
3. **Complex Internal Algorithms** - The section needs internal utilities like graph transformation, dependency calculation, or critical path analysis
4. **Master-Detail Pattern** - A list/graph on one side with a details panel on the other

Do NOT use container sections when:
- Content can render simultaneously in different slots
- Sections are independent and don't share state
- The phase follows a simple layout pattern

## Sub-Component Naming Conventions

Internal sub-components follow a consistent naming pattern based on their role:

### Tab Content Components
Suffix with `TabContent` for components that render tab panel content:
- `SchemaTabContent` - Renders the Schema tab in DesignView
- `DecisionsTabContent` - Renders the Decisions tab
- `HooksTabContent` - Renders the Hooks Plan tab

### Node/Item Components
Use descriptive names for list/graph items:
- `TaskNode` - Custom ReactFlow node for tasks
- `IntegrationPointCard` - Card displaying a single IntegrationPoint
- `EntityNode` - Graph node for schema entities

### Panel Components
Suffix with `Panel` for detail/side panels:
- `TaskDetailsPanel` - Shows selected task details
- `EntityDetailsPanel` - Shows selected entity properties

### Helper Components
Descriptive names for supporting UI:
- `SchemaStatisticsBar` - Shows entity/property/reference counts
- `ReferenceLegend` - Explains graph edge types
- `IntegrationPointsSection` - Groups integration point cards

## Internal State Management Patterns

Container sections manage state internally using `useState` and lift state to the appropriate level for child communication.

### Selection State Pattern
For master-detail UIs, manage selection at the container level:

```tsx
function DesignContainerSection({ feature, config }: SectionRendererProps) {
  // Selection state for Schema tab - lifted to coordinate SchemaGraph and EntityDetailsPanel
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  // Tab state for exclusive content switching
  const [activeTab, setActiveTab] = useState<'schema' | 'decisions' | 'hooks'>(
    config?.defaultTab ?? 'schema'
  )

  // Find selected entity from data
  const selectedEntity = useMemo(() => {
    if (!selectedEntityId || !models) return null
    return models.find((m) => m.name === selectedEntityId) ?? null
  }, [selectedEntityId, models])

  // Handler passed to graph
  const handleSelectEntity = (entityId: string | null) => {
    setSelectedEntityId(entityId)
  }

  // Handler for panel close
  const handleCloseDetails = () => {
    setSelectedEntityId(null)
  }

  return (
    <div>
      <TabContent activeTab={activeTab}>
        <SchemaTabContent
          selectedEntityId={selectedEntityId}
          onSelectEntity={handleSelectEntity}
          selectedEntity={selectedEntity}
          onCloseDetails={handleCloseDetails}
        />
        {/* ... other tabs */}
      </TabContent>
    </div>
  )
}
```

### Tab State Pattern
For exclusive content switching:

```tsx
function SpecContainerSection({ feature, config }: SectionRendererProps) {
  // Task selection for graph interaction
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // Toggle selection on node click (click again to deselect)
  const onNodeClick = useCallback((_, node: Node<TaskNodeData>) => {
    setSelectedTaskId(prev => (prev === node.id ? null : node.id))
  }, [])

  // Close panel handler
  const handleCloseDetails = useCallback(() => {
    setSelectedTaskId(null)
  }, [])

  // Memoize expensive computations that depend on selection
  const { nodes, edges } = useMemo(
    () => transformToGraph(tasks, selectedTaskId),
    [tasks, selectedTaskId]
  )

  return (/* ... */)
}
```

## When to Extract vs Keep Inline

### Keep Inline When:
1. **Single Use** - The component is only used within this container section
2. **Tightly Coupled** - It depends on internal state via closures (handlers, selection state)
3. **Simple** - Less than ~50 lines of JSX

### Extract to Separate File When:
1. **Reusable** - Could be used by multiple container sections
2. **Complex** - Has its own significant state logic or effects
3. **Self-Contained** - Receives all data via props, no closure dependencies
4. **Testable** - Benefits from isolated unit tests

### Examples from Codebase:

**Kept Inline** (in DesignContainerSection):
- `SchemaStatisticsBar` - Simple display, single use, <50 lines
- `ReferenceLegend` - Static content, single use

**Kept Inline** (in SpecContainerSection):
- `TaskNode` - Tightly coupled to ReactFlow node system
- `TaskDetailsPanel` - Depends on closure handlers
- `IntegrationPointCard` - Simple card, single use

**Extracted to Separate File**:
- `SchemaGraph` - Complex ReactFlow component with its own state
- `EntityDetailsPanel` - Self-contained with clear prop interface
- `DecisionTimeline` - Reused across multiple views
- `EnhancementHooksPlan` - Complex querying logic

## Testing Approach for Container Sections

Container sections require integration-style tests that verify sub-component coordination.

### Test File Location
Place tests in `__tests__/` adjacent to the section:
```
sections/
  DesignContainerSection.tsx
  SpecContainerSection.tsx
  __tests__/
    DesignContainerSection.test.tsx
    SpecContainerSection.test.tsx
```

### What to Test

1. **Props Interface** - Accepts `SectionRendererProps` correctly
2. **Initial Render** - Default state renders without errors
3. **State Coordination** - Clicking in one area updates another
4. **Tab Navigation** - Tab switching shows correct content (if applicable)
5. **Empty States** - Graceful handling of missing data
6. **Config Options** - Optional config props work correctly

### Test Structure Example

```tsx
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { Window } from "happy-dom"
// ... DOM setup

import { DesignContainerSection } from "../DesignContainerSection"

describe("DesignContainerSection", () => {
  describe("SectionRendererProps interface", () => {
    test("accepts feature prop and renders without error", () => {
      const feature = { id: "test-1", schemaName: "test-schema" }
      const { container } = render(<DesignContainerSection feature={feature} />)
      expect(container).toBeDefined()
    })

    test("accepts optional config prop", () => {
      const feature = { id: "test-1", schemaName: "test-schema" }
      const config = { defaultTab: "decisions" }
      const { container } = render(
        <DesignContainerSection feature={feature} config={config} />
      )
      expect(container).toBeDefined()
    })
  })

  describe("internal state coordination", () => {
    test("selecting entity shows details panel", async () => {
      const feature = { id: "test-1", schemaName: "test-schema" }
      const { getByTestId, queryByTestId } = render(
        <DesignContainerSection feature={feature} />
      )

      // Initially no details panel
      expect(queryByTestId("entity-details-panel")).toBeNull()

      // Click an entity node
      fireEvent.click(getByTestId("entity-node-User"))

      // Details panel should appear
      expect(getByTestId("entity-details-panel")).toBeDefined()
    })

    test("closing details panel clears selection", async () => {
      // ... test implementation
    })
  })

  describe("tab navigation", () => {
    test("defaults to schema tab", () => {
      // ... test implementation
    })

    test("switching tabs shows correct content", () => {
      // ... test implementation
    })

    test("config.defaultTab overrides default", () => {
      // ... test implementation
    })
  })

  describe("empty states", () => {
    test("handles missing schemaName gracefully", () => {
      const feature = { id: "test-1" } // no schemaName
      const { container } = render(<DesignContainerSection feature={feature} />)
      expect(container.textContent).toMatch(/no schema/i)
    })
  })
})
```

### Testing Internal Sub-Components

For complex internal sub-components, test them indirectly through the container:

```tsx
describe("internal sub-components", () => {
  test("SchemaStatisticsBar shows correct counts", () => {
    // Mock schema data with known entities/properties/references
    const feature = { id: "test-1", schemaName: "test-schema" }
    const { getByText } = render(<DesignContainerSection feature={feature} />)

    // Verify statistics are displayed (counts come from mocked data)
    expect(getByText(/3/)).toBeDefined() // entity count
    expect(getByText(/entities/i)).toBeDefined()
  })
})
```

## Example Structure: DesignContainerSection

```tsx
/**
 * DesignContainerSection
 * Container section for Design phase with tabbed navigation.
 *
 * Internal sub-components:
 * - SchemaTabContent: Renders Schema tab with graph and details
 * - DecisionsTabContent: Wraps DecisionTimeline
 * - HooksTabContent: Wraps EnhancementHooksPlan
 * - SchemaStatisticsBar: Shows entity/property/reference counts
 * - ReferenceLegend: Explains graph edge types
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SectionRendererProps } from "../types"
import { useSchemaData } from "./hooks/useSchemaData"
import { SchemaGraph } from "./SchemaGraph"
import { EntityDetailsPanel } from "./EntityDetailsPanel"
import { DecisionTimeline } from "./DecisionTimeline"
import { EnhancementHooksPlan } from "./EnhancementHooksPlan"

// Internal sub-component: Statistics bar
function SchemaStatisticsBar({ models, phaseColors }: {
  models: Array<{ name: string; fields: any[] }> | null
  phaseColors: any
}) {
  // TODO: Implement statistics calculation
  const statistics = useMemo(() => {
    if (!models) return { entities: 0, properties: 0, references: 0 }
    // ... calculate from models
    return { entities: models.length, properties: 0, references: 0 }
  }, [models])

  return (
    <div className="flex items-center gap-6 p-3">
      {/* TODO: Render statistics */}
    </div>
  )
}

// Internal sub-component: Reference legend
function ReferenceLegend() {
  // TODO: Static legend content
  return <div>{/* Legend items */}</div>
}

// Tab content: Schema
function SchemaTabContent({
  models,
  selectedEntityId,
  onSelectEntity,
  selectedEntity,
  onCloseDetails,
  phaseColors,
}: {
  models: any[] | null
  selectedEntityId: string | null
  onSelectEntity: (id: string | null) => void
  selectedEntity: any | null
  onCloseDetails: () => void
  phaseColors: any
}) {
  // TODO: Handle loading/error states
  return (
    <div className="flex flex-1">
      <SchemaStatisticsBar models={models} phaseColors={phaseColors} />
      <ReferenceLegend />
      <SchemaGraph
        models={models}
        selectedEntityId={selectedEntityId}
        onSelectEntity={onSelectEntity}
      />
      <EntityDetailsPanel entity={selectedEntity} onClose={onCloseDetails} />
    </div>
  )
}

// Tab content: Decisions (thin wrapper)
function DecisionsTabContent({ featureId }: { featureId: string }) {
  return <DecisionTimeline featureId={featureId} />
}

// Tab content: Hooks (thin wrapper)
function HooksTabContent({ featureId }: { featureId: string }) {
  return <EnhancementHooksPlan featureId={featureId} />
}

// Main container section
export const DesignContainerSection = observer(function DesignContainerSection({
  feature,
  config,
}: SectionRendererProps) {
  // Internal state: entity selection (Schema tab)
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  // Load schema data
  const { models, isLoading, error } = useSchemaData(feature?.schemaName)

  // Derived state: selected entity
  const selectedEntity = useMemo(() => {
    if (!selectedEntityId || !models) return null
    return models.find((m) => m.name === selectedEntityId) ?? null
  }, [selectedEntityId, models])

  // Handlers
  const handleSelectEntity = (entityId: string | null) => {
    setSelectedEntityId(entityId)
  }

  const handleCloseDetails = () => {
    setSelectedEntityId(null)
  }

  // Phase colors for styling
  const phaseColors = {} // TODO: usePhaseColor("design")

  return (
    <div data-testid="design-container-section" className="h-full flex flex-col">
      <Tabs defaultValue={config?.defaultTab ?? "schema"}>
        <TabsList>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="hooks">Hooks Plan</TabsTrigger>
        </TabsList>

        <TabsContent value="schema">
          <SchemaTabContent
            models={models}
            selectedEntityId={selectedEntityId}
            onSelectEntity={handleSelectEntity}
            selectedEntity={selectedEntity}
            onCloseDetails={handleCloseDetails}
            phaseColors={phaseColors}
          />
        </TabsContent>

        <TabsContent value="decisions">
          <DecisionsTabContent featureId={feature?.id} />
        </TabsContent>

        <TabsContent value="hooks">
          <HooksTabContent featureId={feature?.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
})
```

## Example Structure: SpecContainerSection

```tsx
/**
 * SpecContainerSection
 * Container section for Spec phase with ReactFlow dependency graph.
 *
 * Internal sub-components:
 * - TaskNode: Custom ReactFlow node for tasks
 * - TaskDetailsPanel: Shows selected task details
 * - IntegrationPointCard: Card for integration point display
 * - IntegrationPointsSection: Groups integration points
 *
 * Internal utilities:
 * - calculateDependencyLevels: Topological sort for layout
 * - findCriticalPath: Longest dependency chain
 * - transformToGraph: Converts tasks to ReactFlow nodes/edges
 */

import { useState, useMemo, useCallback, memo } from "react"
import { observer } from "mobx-react-lite"
import { ReactFlow, Background, Controls, Handle, Position } from "@xyflow/react"
import type { Node, Edge, NodeProps } from "@xyflow/react"
import type { SectionRendererProps } from "../types"
import { useDomains } from "@/contexts/DomainProvider"

// Types
interface TaskNodeData {
  task: Task
  dependencyCount: number
  blocksCount: number
  isSelected: boolean
  isCritical: boolean
}

// Internal sub-component: Task node
const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskNodeData>) {
  const { task, dependencyCount, blocksCount, isSelected, isCritical } = data

  return (
    <div className={/* styles based on isSelected, isCritical */}>
      <Handle type="target" position={Position.Left} />
      {/* TODO: Task content */}
      <div>{task.name}</div>
      <div>{dependencyCount} deps | {blocksCount} blocks</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

// Internal sub-component: Integration point card
function IntegrationPointCard({ integrationPoint }: { integrationPoint: any }) {
  // TODO: Render with PropertyRenderer
  return <div>{integrationPoint.name}</div>
}

// Internal sub-component: Integration points section
function IntegrationPointsSection({ integrationPoints }: { integrationPoints: any[] }) {
  if (!integrationPoints?.length) return null
  return (
    <div>
      {integrationPoints.map(ip => (
        <IntegrationPointCard key={ip.id} integrationPoint={ip} />
      ))}
    </div>
  )
}

// Internal sub-component: Task details panel
function TaskDetailsPanel({
  task,
  integrationPoints,
  onClose,
}: {
  task: any | null
  integrationPoints: any[]
  onClose: () => void
}) {
  if (!task) return null

  const taskIntegrationPoints = integrationPoints.filter(
    (ip: any) => ip.task === task.id
  )

  return (
    <div className="w-80 border-l p-4">
      <button onClick={onClose}>Close</button>
      <h3>{task.name}</h3>
      {/* TODO: Task details with PropertyRenderer */}
      <IntegrationPointsSection integrationPoints={taskIntegrationPoints} />
    </div>
  )
}

// Internal utility: Calculate dependency levels (topological sort)
function calculateDependencyLevels(tasks: any[]): Map<string, number> {
  const levels = new Map<string, number>()
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  function getLevel(taskId: string, visited = new Set<string>()): number {
    if (levels.has(taskId)) return levels.get(taskId)!
    if (visited.has(taskId)) return 0 // Cycle detection

    const task = taskMap.get(taskId)
    if (!task?.dependencies?.length) {
      levels.set(taskId, 0)
      return 0
    }

    visited.add(taskId)
    const maxDepLevel = Math.max(
      ...task.dependencies.map((depId: string) => getLevel(depId, visited))
    )
    const level = maxDepLevel + 1
    levels.set(taskId, level)
    return level
  }

  tasks.forEach(task => getLevel(task.id))
  return levels
}

// Internal utility: Find critical path
function findCriticalPath(tasks: any[]): Set<string> {
  // TODO: Implement critical path finding
  return new Set()
}

// Internal utility: Transform to ReactFlow graph
function transformToGraph(
  tasks: any[],
  selectedTaskId: string | null
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
  // TODO: Implement graph transformation
  return { nodes: [], edges: [] }
}

// Node types for ReactFlow
const nodeTypes = { taskNode: TaskNode }

// Main container section
export const SpecContainerSection = observer(function SpecContainerSection({
  feature,
  config,
}: SectionRendererProps) {
  // Internal state: task selection
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // Access domain data
  const { platformFeatures } = useDomains()
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(feature?.id) ?? []
  const integrationPoints = platformFeatures?.integrationPointCollection?.findBySession?.(feature?.id) ?? []

  // Compute graph
  const { nodes, edges } = useMemo(
    () => transformToGraph(tasks, selectedTaskId),
    [tasks, selectedTaskId]
  )

  // Derived state: selected task
  const selectedTask = useMemo(
    () => tasks.find((t: any) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  )

  // Handlers
  const onNodeClick = useCallback((_: any, node: Node<TaskNodeData>) => {
    setSelectedTaskId(prev => (prev === node.id ? null : node.id))
  }, [])

  const handleCloseDetails = useCallback(() => {
    setSelectedTaskId(null)
  }, [])

  return (
    <div data-testid="spec-container-section" className="h-full flex">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <TaskDetailsPanel
        task={selectedTask}
        integrationPoints={integrationPoints}
        onClose={handleCloseDetails}
      />
    </div>
  )
})
```

## Integration with SectionRendererProps

All container sections implement the `SectionRendererProps` interface:

```typescript
interface SectionRendererProps {
  feature: any      // FeatureSession data (id, name, status, schemaName, etc.)
  config?: Record<string, unknown>  // Optional config from slotContent
}
```

### Accessing Feature Data
```tsx
function MyContainerSection({ feature, config }: SectionRendererProps) {
  // Direct feature properties
  const featureId = feature?.id
  const schemaName = feature?.schemaName
  const status = feature?.status

  // Domain queries using feature.id
  const { platformFeatures } = useDomains()
  const tasks = platformFeatures?.implementationTaskCollection?.findBySession?.(featureId) ?? []
}
```

### Using Config
```tsx
function MyContainerSection({ feature, config }: SectionRendererProps) {
  // Config defaults
  const defaultTab = config?.defaultTab ?? 'schema'
  const showHeader = config?.showHeader !== false
  const maxItems = config?.maxItems ?? 10
}
```

## Registration

Container sections are registered in `sectionImplementations.tsx` like any other section:

```tsx
// sectionImplementations.tsx
import { DesignContainerSection } from "./sections/DesignContainerSection"
import { SpecContainerSection } from "./sections/SpecContainerSection"

export const sectionImplementationMap = new Map<string, SectionComponent>([
  // ... other sections
  ["DesignContainerSection", DesignContainerSection],
  ["SpecContainerSection", SpecContainerSection],
])
```

And referenced in ComponentDefinition seed data:

```typescript
{
  id: "comp-def-design-container",
  name: "Design Container Section",
  category: "section",
  implementationRef: "DesignContainerSection",
  tags: ["section", "design-phase", "container"],
}
```
