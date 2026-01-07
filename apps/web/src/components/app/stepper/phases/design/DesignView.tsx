/**
 * DesignView Component - Enhanced
 * Task: task-w2-design-view-enhance
 *
 * "Schema Blueprint Studio" aesthetic with:
 * - SchemaStatisticsBar: Shows entity/property/reference counts at top
 * - ReferenceLegend: Shows different edge type meanings
 * - Blueprint grid background styling
 * - Enhanced EntityNode with CAD-style technical drawing aesthetic
 *
 * Uses phase-design color tokens (amber) throughout.
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { Layers, Box, Link, ArrowRight, Minus, MoreHorizontal, Pencil } from "lucide-react"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import type { FeatureForPanel } from "../../PhaseContentPanel"
import { SchemaGraph } from "./SchemaGraph"
import { EntityDetailsPanel } from "./EntityDetailsPanel"
import { DecisionTimeline } from "./DecisionTimeline"
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
 * SchemaStatisticsBar Component
 * Shows entity/property/reference counts at top of view
 */
function SchemaStatisticsBar({
  models,
  phaseColors,
}: {
  models: Array<{ name: string; fields: any[] }> | null
  phaseColors: ReturnType<typeof usePhaseColor>
}) {
  const statistics = useMemo(() => {
    if (!models) return { entities: 0, properties: 0, references: 0 }

    const entities = models.length
    let properties = 0
    let references = 0

    models.forEach(model => {
      model.fields?.forEach((field: any) => {
        properties++
        if (field.isReference || field.referenceTarget) {
          references++
        }
      })
    })

    return { entities, properties, references }
  }, [models])

  return (
    <div className={cn(
      "flex items-center gap-6 p-3 bg-amber-500/5 rounded-lg border",
      phaseColors.border
    )}>
      <div className="flex items-center gap-2">
        <Box className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">{statistics.entities}</span>
        <span className="text-xs text-muted-foreground">entities</span>
      </div>
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-medium">{statistics.properties}</span>
        <span className="text-xs text-muted-foreground">properties</span>
      </div>
      <div className="flex items-center gap-2">
        <Link className="h-4 w-4 text-amber-300" />
        <span className="text-sm font-medium">{statistics.references}</span>
        <span className="text-xs text-muted-foreground">references</span>
      </div>
    </div>
  )
}

/**
 * ReferenceLegend Component
 * Shows different edge type meanings with visual examples
 */
function ReferenceLegend() {
  const legendItems = [
    {
      type: "single",
      label: "Single Reference",
      lineStyle: "solid",
      description: "One-to-one relationship",
    },
    {
      type: "array",
      label: "Array Reference",
      lineStyle: "solid",
      description: "One-to-many relationship",
      hasDouble: true,
    },
    {
      type: "maybe-ref",
      label: "Maybe Reference",
      lineStyle: "dashed",
      description: "Optional relationship",
    },
  ]

  return (
    <div className="flex items-center gap-4 p-2 bg-muted/30 rounded-lg text-xs">
      <span className="text-muted-foreground font-medium">Edge Legend:</span>
      {legendItems.map(item => (
        <div key={item.type} className="flex items-center gap-2">
          <div className="flex items-center w-8">
            {item.lineStyle === "dashed" ? (
              <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
            ) : item.hasDouble ? (
              <>
                <Minus className="h-3 w-3 text-amber-500" />
                <ArrowRight className="h-3 w-3 text-amber-500 -ml-1" />
              </>
            ) : (
              <>
                <Minus className="h-3 w-3 text-amber-500" />
                <ArrowRight className="h-3 w-3 text-amber-500 -ml-1" />
              </>
            )}
          </div>
          <span className="text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * DesignView Component
 *
 * Main container rendering the Design phase with tabbed navigation.
 * Enhanced with "Schema Blueprint Studio" aesthetic:
 * - Statistics bar at top showing entity/property/reference counts
 * - Reference legend explaining edge types
 * - Blueprint grid background on graph canvas
 * - Phase-design amber color tokens throughout
 */
export const DesignView = observer(function DesignView({
  feature,
}: DesignViewProps) {
  // Phase colors for design (amber)
  const phaseColors = usePhaseColor("design")

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

    // Success state - render graph with blueprint aesthetic
    return (
      <div className="space-y-3 h-full flex flex-col">
        {/* Statistics Bar */}
        <SchemaStatisticsBar models={models} phaseColors={phaseColors} />

        {/* Reference Legend */}
        <ReferenceLegend />

        {/* Graph with Blueprint Background */}
        <div className="flex flex-1 min-h-0">
          <div
            className="flex-1 rounded-lg overflow-hidden border border-amber-500/20"
            style={{
              background: `
                linear-gradient(to right, rgba(245, 158, 11, 0.03) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(245, 158, 11, 0.03) 1px, transparent 1px),
                linear-gradient(135deg, rgba(245, 158, 11, 0.01) 0%, transparent 100%)
              `,
              backgroundSize: "20px 20px, 20px 20px, 100% 100%",
            }}
          >
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
      </div>
    )
  }

  return (
    <div data-testid="design-view" className="h-full flex flex-col overflow-hidden">
      {/* Blueprint Studio Header */}
      <div className={cn("flex items-center gap-2 pb-3 mb-3 border-b min-w-0", phaseColors.border)}>
        <Pencil className={cn("h-5 w-5 shrink-0", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold truncate", phaseColors.text)}>
          Schema Blueprint
        </h2>
      </div>

      <Tabs
        data-testid="design-view-tabs"
        defaultValue="schema"
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="schema" className="data-[state=active]:bg-amber-500/20">
            Schema
          </TabsTrigger>
          <TabsTrigger value="decisions" className="data-[state=active]:bg-amber-500/20">
            Decisions
          </TabsTrigger>
          <TabsTrigger value="hooks" className="data-[state=active]:bg-amber-500/20">
            Hooks Plan
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schema" className="flex-1 mt-4 min-h-[400px]">
          {renderSchemaContent()}
        </TabsContent>

        <TabsContent value="decisions" className="flex-1 mt-4 overflow-auto">
          <DecisionTimeline featureId={feature.id} />
        </TabsContent>

        <TabsContent value="hooks" className="flex-1 mt-4 overflow-auto">
          <EnhancementHooksPlan featureId={feature.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
})
