/**
 * DesignView Component
 * Task: task-2-3c-012
 *
 * Main container for the Design phase view with tabbed interface.
 *
 * Per design-2-3c-012:
 * - Wrapped with observer() for MobX reactivity
 * - Three tabs: Schema (graph), Decisions, Hooks Plan
 * - Schema tab shows SchemaGraph + EntityDetailsPanel
 * - Handles loading/error/empty states
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import type { FeatureForPanel } from "../../PhaseContentPanel"
import { SchemaGraph } from "./SchemaGraph"
import { EntityDetailsPanel } from "./EntityDetailsPanel"
import { DesignDecisionsList } from "./DesignDecisionsList"
import { EnhancementHooksPlan } from "./EnhancementHooksPlan"
import { SchemaEmptyState, SchemaLoadingSkeleton } from "./SchemaEmptyStates"
import { useSchemaData } from "./hooks/useSchemaData"

/**
 * Props for DesignView component
 */
export interface DesignViewProps {
  feature: FeatureForPanel
}

/**
 * DesignView Component
 *
 * Main container rendering the Design phase with tabbed navigation.
 * Schema tab shows the visual graph, Decisions shows list, Hooks Plan shows the plan.
 */
export const DesignView = observer(function DesignView({
  feature,
}: DesignViewProps) {
  // Selected entity state for Schema tab
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  // Load schema data using the hook
  const { models, isLoading, error, refetch } = useSchemaData(feature.schemaName)

  // Find selected entity from models
  const selectedEntity = useMemo(() => {
    if (!selectedEntityId || !models) return null
    return models.find((m) => m.name === selectedEntityId) ?? null
  }, [selectedEntityId, models])

  // Handle entity selection from graph
  const handleSelectEntity = (entityId: string | null) => {
    setSelectedEntityId(entityId)
  }

  // Handle close details panel
  const handleCloseDetails = () => {
    setSelectedEntityId(null)
  }

  // Render Schema tab content based on state
  const renderSchemaContent = () => {
    // No schema assigned
    if (!feature.schemaName) {
      return <SchemaEmptyState type="no-schema" />
    }

    // Loading state
    if (isLoading) {
      return <SchemaLoadingSkeleton />
    }

    // Error state
    if (error) {
      return (
        <SchemaEmptyState
          type="error"
          errorMessage={error}
          onRetry={refetch}
        />
      )
    }

    // No models loaded (schema created but empty or not found)
    if (!models || models.length === 0) {
      return <SchemaEmptyState type="not-created" />
    }

    // Success state - render graph with optional details panel
    return (
      <div className="flex h-full">
        <div className="flex-1">
          <SchemaGraph
            models={models}
            selectedEntityId={selectedEntityId}
            onSelectEntity={handleSelectEntity}
          />
        </div>
        <EntityDetailsPanel
          entity={selectedEntity}
          onClose={handleCloseDetails}
        />
      </div>
    )
  }

  return (
    <div data-testid="design-view" className="h-full flex flex-col">
      <Tabs
        data-testid="design-view-tabs"
        defaultValue="schema"
        className="flex-1 flex flex-col"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="hooks">Hooks Plan</TabsTrigger>
        </TabsList>

        <TabsContent value="schema" className="flex-1 mt-4">
          {renderSchemaContent()}
        </TabsContent>

        <TabsContent value="decisions" className="flex-1 mt-4 overflow-auto">
          <DesignDecisionsList featureId={feature.id} />
        </TabsContent>

        <TabsContent value="hooks" className="flex-1 mt-4 overflow-auto">
          <EnhancementHooksPlan featureId={feature.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
})
