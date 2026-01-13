/**
 * DesignContainerSection
 * Task: task-design-001, task-design-002, task-design-003, task-design-004, task-design-005, task-design-006, task-design-007
 *
 * Container section for Design phase with tabbed navigation structure.
 * Demonstrates the container section pattern for complex phases with
 * exclusive content switching (tabs).
 *
 * Internal sub-components (defined in this file, NOT registered separately):
 * - SchemaStatisticsBar: Shows entity/property/reference counts with amber styling (task-design-002)
 * - ReferenceLegend: Displays edge type explanations with visual examples (task-design-003)
 * - SchemaTabContent: Renders the Schema tab content
 * - DecisionsTabContent: Renders the Decisions tab content
 * - HooksTabContent: Renders the Hooks Plan tab content
 *
 * Container Pattern Rules:
 * - Internal state (selectedEntityId, activeTab) uses React useState
 * - Sub-components are NOT registered in sectionImplementationMap
 * - All sub-components are defined inside this file or as local imports
 *
 * @see CONTAINER_SECTION_PATTERN.md for pattern documentation
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { Pencil, Code, GitBranch, Puzzle, MoreHorizontal, Minus, ArrowRight, Box, Layers, Link } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePhaseColor } from "@/hooks/usePhaseColor"
import { EnhancementHooksPlan } from "../../app/stepper/phases/design/EnhancementHooksPlan"
import { DecisionTimeline } from "../../app/stepper/phases/design/DecisionTimeline"
import {
  useSchemaData,
  SchemaGraph,
  EntityDetailsPanel,
  SchemaEmptyState,
  SchemaLoadingSkeleton,
} from "../../app/stepper/phases/design"
import type { EntityReference } from "../../app/stepper/phases/design/ImpactEntityTags"
import type { SectionRendererProps } from "../types"

// =============================================================================
// Configuration Interface
// =============================================================================

/**
 * Configuration options for DesignContainerSection
 *
 * These options can be set via slotContent.config in composition entities
 * and modified at runtime via MCP store.update commands.
 *
 * @example
 * // In composition slotContent:
 * { slot: "main", component: "comp-design-container", config: {
 *   defaultTab: "schema",
 *   expandGraph: true,
 *   showStatistics: true,
 *   showLegend: true,
 *   graphMinHeight: 400
 * }}
 */
interface DesignContainerConfig {
  /**
   * Initial tab to display. Defaults to "schema".
   * Valid values: "schema" | "decisions" | "hooks"
   */
  defaultTab?: string

  /**
   * Whether to allow the graph to expand to fill available vertical space.
   * When true (default), removes min-height constraint and uses flex-1.
   * When false, uses graphMinHeight for consistent sizing.
   * Default: true
   */
  expandGraph?: boolean

  /**
   * Whether to show the statistics bar (entity/property/reference counts).
   * Default: true
   */
  showStatistics?: boolean

  /**
   * Whether to show the reference edge legend.
   * Default: true
   */
  showLegend?: boolean

  /**
   * Minimum height for the graph container in pixels.
   * Only applies when expandGraph is false.
   * Default: 400
   */
  graphMinHeight?: number
}

// =============================================================================
// Internal Sub-Components (NOT exported, NOT registered in sectionImplementationMap)
// =============================================================================

/**
 * SchemaStatisticsBar - Internal sub-component for displaying schema statistics
 * Task: task-design-002
 *
 * Shows entity/property/reference counts at top of Schema tab view.
 * Uses amber phase colors for design aesthetic consistency.
 *
 * @param models - Array of model definitions with fields
 * @param phaseColors - Phase color tokens from usePhaseColor('design')
 *
 * @see DesignView lines 44-92 for original implementation
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

    models.forEach((model) => {
      model.fields?.forEach((field: any) => {
        properties++
        if (field.isReference || field.referenceTarget) {
          references++
        }
      })
    })

    return { entities, properties, references }
  }, [models])

  // Return null for empty or null models
  if (!models || models.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        "flex items-center gap-6 p-3 bg-amber-500/5 rounded-lg border",
        phaseColors.border
      )}
    >
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
 * ReferenceLegend - Internal sub-component for edge type explanations
 * Task: task-design-003
 *
 * Displays a legend explaining the different edge types in schema graphs:
 * - Single Reference: One-to-one relationship (solid line)
 * - Array Reference: One-to-many relationship (solid line with double indicator)
 * - Maybe Reference: Optional relationship (dashed line)
 *
 * @see DesignView lines 98-146 for original implementation
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
      {legendItems.map((item) => (
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
 * SchemaTabContent - Internal tab content for the Schema tab
 * Task: task-design-004
 *
 * Orchestrates the Schema tab with:
 * - SchemaStatisticsBar (entity/property/reference counts)
 * - ReferenceLegend (edge type explanations)
 * - SchemaGraph with blueprint grid background
 * - EntityDetailsPanel for selected entity details
 *
 * Manages selectedEntityId state for graph/panel coordination.
 * Uses useSchemaData hook for async schema loading.
 *
 * @param feature - The current FeatureSession data with schemaName
 * @param phaseColors - Phase color tokens from usePhaseColor('design')
 *
 * @see DesignView lines 187-248 for original implementation pattern
 */
function SchemaTabContent({
  feature,
  phaseColors,
  showStatistics = true,
  showLegend = true,
  config,
}: {
  feature: any
  phaseColors: ReturnType<typeof usePhaseColor>
  showStatistics?: boolean
  showLegend?: boolean
  config?: Record<string, unknown>
}) {
  // Manage selectedEntityId state via useState<string | null>(null)
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  // Extract schemaName from config (panel-specific) or feature (shared)
  // This allows split views to show different schemas per panel
  const schemaName = (config?.schemaName as string | undefined) ?? feature?.schemaName

  // Use useSchemaData hook for async schema loading
  const { models, isLoading, error, refetch } = useSchemaData(schemaName)

  // Compute selectedEntity from models using useMemo based on selectedEntityId
  const selectedEntity = useMemo(() => {
    if (!selectedEntityId || !models) return null
    return models.find((model) => model.name === selectedEntityId) ?? null
  }, [selectedEntityId, models])

  // Handle entity selection from graph node clicks
  const handleSelectEntity = useCallback((entityId: string | null) => {
    setSelectedEntityId(entityId)
  }, [])

  // Handle closing the details panel
  const handleCloseDetails = useCallback(() => {
    setSelectedEntityId(null)
  }, [])

  // Empty state: no schemaName defined
  if (!schemaName) {
    return (
      <div className="p-4">
        <SchemaEmptyState type="no-schema" />
      </div>
    )
  }

  // Loading state: show skeleton while schema loads
  if (isLoading) {
    return <SchemaLoadingSkeleton />
  }

  // Error state: show error with retry option
  if (error) {
    return (
      <div className="p-4">
        <SchemaEmptyState
          type="error"
          errorMessage={error.message}
          onRetry={refetch}
        />
      </div>
    )
  }

  // Empty models state: schema defined but no models found
  if (!models || models.length === 0) {
    return (
      <div className="p-4">
        <SchemaEmptyState type="not-created" />
      </div>
    )
  }

  // Success state: render graph with blueprint aesthetic
  // Layout matches DesignView lines 215-248
  return (
    <div className="flex-1 flex flex-col min-h-0 p-4 gap-3">
      {/* Statistics Bar - conditionally rendered via config.showStatistics */}
      {showStatistics && (
        <SchemaStatisticsBar models={models} phaseColors={phaseColors} />
      )}

      {/* Reference Legend - conditionally rendered via config.showLegend */}
      {showLegend && <ReferenceLegend />}

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

/**
 * DecisionsTabContent - Internal tab content for the Decisions tab
 * Wraps DecisionTimeline with feature context.
 * Task: task-design-005
 *
 * @see DesignView line 282-284 for original TabsContent styling
 */
function DecisionsTabContent({
  feature,
  onEntityClick,
}: {
  feature: any
  onEntityClick?: (entity: EntityReference) => void
}) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <DecisionTimeline featureId={feature.id} onEntityClick={onEntityClick} />
    </div>
  )
}

/**
 * HooksTabContent - Internal tab content for the Hooks Plan tab
 * Wraps EnhancementHooksPlan with feature context.
 * Task: task-design-006
 *
 * @see DesignView line 286-288 for original TabsContent styling
 */
function HooksTabContent({ feature }: { feature: any }) {
  return (
    <div className="overflow-auto p-4">
      <EnhancementHooksPlan featureId={feature.id} />
    </div>
  )
}

// =============================================================================
// Main Container Section Component
// =============================================================================

/**
 * DesignContainerSection - Container section for Design phase
 * Task: task-design-007
 *
 * Features:
 * - Tabbed navigation with schema, decisions, and hooks tabs
 * - Amber active state styling (design phase color)
 * - Full height flex layout matching DesignView pattern
 * - Internal state management via React useState
 * - Wrapped with observer() for MobX domain reactivity
 *
 * @param feature - The current FeatureSession data
 * @param config - Optional configuration (supports defaultTab)
 */
export const DesignContainerSection = observer(function DesignContainerSection({
  feature,
  config,
}: SectionRendererProps) {
  // Get design phase colors for consistent styling
  const phaseColors = usePhaseColor("design")

  // Internal state for entity selection (Schema tab)
  // This state is managed internally per Container Section Pattern
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  // Extract configuration with defaults
  // These options can be modified via MCP store.update to change UI behavior
  const designConfig = (config as DesignContainerConfig) ?? {}
  const defaultTab = designConfig.defaultTab ?? "schema"
  const expandGraph = designConfig.expandGraph ?? true
  const showStatistics = designConfig.showStatistics ?? true
  const showLegend = designConfig.showLegend ?? true
  const graphMinHeight = designConfig.graphMinHeight ?? 400

  return (
    <div
      data-testid="design-container-section"
      className="h-full flex flex-col overflow-hidden"
    >
      {/* Header section with phase-colored styling */}
      <div className={cn("flex items-center gap-2 px-4 py-3 border-b", phaseColors.border)}>
        <Pencil className={cn("h-5 w-5", phaseColors.text)} />
        <h2 className={cn("text-lg font-semibold", phaseColors.text)}>
          Schema Blueprint
        </h2>
      </div>

      {/* Tabbed navigation area */}
      <Tabs
        data-testid="design-tabs"
        defaultValue={defaultTab}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="px-4 pt-3">
          <TabsList className="bg-muted/50">
            <TabsTrigger
              value="schema"
              className={cn(
                "data-[state=active]:bg-amber-500/20",
                "data-[state=active]:text-amber-600 dark:data-[state=active]:text-amber-400",
                "data-[state=active]:border-amber-500/50"
              )}
            >
              <Code className="h-4 w-4 mr-1.5" />
              Schema
            </TabsTrigger>
            <TabsTrigger
              value="decisions"
              className={cn(
                "data-[state=active]:bg-amber-500/20",
                "data-[state=active]:text-amber-600 dark:data-[state=active]:text-amber-400",
                "data-[state=active]:border-amber-500/50"
              )}
            >
              <GitBranch className="h-4 w-4 mr-1.5" />
              Decisions
            </TabsTrigger>
            <TabsTrigger
              value="hooks"
              className={cn(
                "data-[state=active]:bg-amber-500/20",
                "data-[state=active]:text-amber-600 dark:data-[state=active]:text-amber-400",
                "data-[state=active]:border-amber-500/50"
              )}
            >
              <Puzzle className="h-4 w-4 mr-1.5" />
              Hooks
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Tab content areas */}
        <TabsContent
          value="schema"
          className={cn(
            "mt-4 overflow-hidden",
            expandGraph ? "flex-1 min-h-0 flex flex-col" : "min-h-[400px]"
          )}
          style={!expandGraph && graphMinHeight !== 400 ? { minHeight: `${graphMinHeight}px` } : undefined}
        >
          <SchemaTabContent
            feature={feature}
            phaseColors={phaseColors}
            showStatistics={showStatistics}
            showLegend={showLegend}
            config={config}
          />
        </TabsContent>

        <TabsContent value="decisions" className="flex-1 mt-4 overflow-auto">
          <DecisionsTabContent feature={feature} />
        </TabsContent>

        <TabsContent value="hooks" className="flex-1 mt-4 overflow-auto">
          <HooksTabContent feature={feature} />
        </TabsContent>
      </Tabs>
    </div>
  )
})
