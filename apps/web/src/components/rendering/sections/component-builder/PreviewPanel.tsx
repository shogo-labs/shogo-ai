/**
 * PreviewPanel - Live preview of the composition being built
 * Task: task-cb-ui-preview-panel
 *
 * Renders the composition in real-time as changes are made.
 * Uses MobX reactivity - changes to Composition entity trigger re-render.
 *
 * Architecture:
 * - Uses useDomains() for componentBuilder store access (Composition entities)
 * - Uses useBuilderContext() for UI coordination state (compositionId, sampleData settings)
 * - TWO rendering modes:
 *   1. Collection mode (kanban/grid/list): Renders all entities from the collection
 *   2. Detail mode (default): Renders single entity properties via SlotLayout
 *
 * Data Flow:
 * 1. useBuilderContext() -> compositionId
 * 2. useDomains() -> componentBuilder store
 * 3. compositionCollection.get(compositionId) -> Composition entity
 * 4. composition.dataContext.layout -> determines rendering mode
 * 5. For collection mode: load all entities, render in layout
 * 6. For detail mode: composition.toSlotSpecs() -> SlotLayout
 *
 * Sub-components:
 * - PreviewHeader: Zoom, refresh, sample data toggle controls
 * - CollectionPreview: Renders kanban/grid/list of multiple entities
 * - PropertyHighlighter: Click-to-highlight interaction (placeholder)
 */

import { observer } from "mobx-react-lite"
import { useState, useCallback, useEffect, useMemo, type ReactNode } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { useBuilderContext } from "./ComponentBuilderContext"
import { SlotLayout } from "../../composition/SlotLayout"
import { getSectionComponent } from "../../sectionImplementations"
import { PropertyRenderer } from "../../PropertyRenderer"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RefreshCw, ZoomIn, ZoomOut, Eye, EyeOff, Database } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SlotSpec } from "@shogo/state-api"
import type { PropertyMetadata } from "../../types"

// =============================================================================
// Types for Collection Preview
// =============================================================================

type LayoutType = "kanban" | "grid" | "list"

interface SlotContentEntry {
  slot: string
  component: string
  config?: {
    property?: string
    propertyMeta?: PropertyMetadata
    [key: string]: unknown
  }
}

// =============================================================================
// PreviewHeader Sub-component
// =============================================================================

/** Entity option for the picker dropdown */
interface EntityOption {
  id: string
  label: string
}

interface PreviewHeaderProps {
  /** Current zoom percentage (50-150) */
  zoom: number
  /** Zoom in by 10% */
  onZoomIn: () => void
  /** Zoom out by 10% */
  onZoomOut: () => void
  /** Refresh preview (force re-render) */
  onRefresh: () => void
  /** Whether sample data is enabled */
  sampleDataEnabled: boolean
  /** Toggle sample data visibility */
  onSampleDataToggle: (enabled: boolean) => void
  /** Available entities to preview */
  entityOptions: EntityOption[]
  /** Currently selected entity ID */
  selectedEntityId: string | null
  /** Entity selection callback */
  onEntitySelect: (id: string | null) => void
  /** Model name for display */
  modelName: string | null
}

/**
 * Header bar with preview controls.
 * Provides zoom, refresh, entity picker, and sample data toggle functionality.
 */
function PreviewHeader({
  zoom,
  onZoomIn,
  onZoomOut,
  onRefresh,
  sampleDataEnabled,
  onSampleDataToggle,
  entityOptions,
  selectedEntityId,
  onEntitySelect,
  modelName,
}: PreviewHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b bg-background">
      <span className="text-sm font-medium">Live Preview</span>
      <div className="flex items-center gap-2">
        {/* Entity picker - only show when entities available */}
        {entityOptions.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={selectedEntityId ?? ""}
              onValueChange={(value) => onEntitySelect(value || null)}
            >
              <SelectTrigger className="h-7 w-[160px] text-xs">
                <SelectValue placeholder={`Select ${modelName || "entity"}...`} />
              </SelectTrigger>
              <SelectContent>
                {entityOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id} className="text-xs">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onZoomOut}
            disabled={zoom <= 50}
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs w-10 text-center tabular-nums">{zoom}%</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onZoomIn}
            disabled={zoom >= 150}
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Refresh button */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRefresh}
          title="Refresh preview"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>

        {/* Sample data toggle */}
        <Button
          variant={sampleDataEnabled ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2 gap-1"
          onClick={() => onSampleDataToggle(!sampleDataEnabled)}
          title={sampleDataEnabled ? "Hide sample data" : "Show sample data"}
        >
          {sampleDataEnabled ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
          <span className="text-xs">Sample</span>
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// PropertyHighlighter Sub-component (Placeholder)
// =============================================================================

interface PropertyHighlighterProps {
  /** Currently selected property path */
  selectedPath: string | null
  /** Children to wrap with highlighting */
  children: ReactNode
}

/**
 * Placeholder for click-to-highlight property interaction.
 * Future implementation will:
 * - Overlay highlighting on selected property
 * - Handle click events to select properties
 * - Sync selection with DefinitionPanel
 */
function PropertyHighlighter({ selectedPath, children }: PropertyHighlighterProps) {
  // TODO: Implement click-to-highlight interaction
  // For now, just render children directly
  return <>{children}</>
}

// =============================================================================
// EntityCard Sub-component - Renders a single entity as a card
// =============================================================================

interface EntityCardProps {
  entity: Record<string, unknown>
  properties: Array<{ property: string; propertyMeta: PropertyMetadata }>
  variant?: "default" | "compact"
}

/**
 * EntityCard - Renders an entity with selected properties
 */
function EntityCard({ entity, properties, variant = "default" }: EntityCardProps) {
  const isCompact = variant === "compact"

  // Find title property (first string property, or 'name', 'title', 'description')
  const titleProp = properties.find(p =>
    p.property === "name" || p.property === "title" || p.property === "description"
  ) || properties[0]

  const otherProps = properties.filter(p => p !== titleProp)

  return (
    <div className={cn(
      "bg-card rounded-lg border shadow-sm",
      isCompact ? "p-2" : "p-3"
    )}>
      {/* Card title */}
      {titleProp && (
        <div className={cn(
          "font-medium text-foreground",
          isCompact ? "text-sm mb-1" : "text-base mb-2"
        )}>
          {String(entity[titleProp.property] ?? "Untitled")}
        </div>
      )}

      {/* Other properties */}
      {otherProps.length > 0 && (
        <div className={cn("space-y-1", isCompact && "text-xs")}>
          {otherProps.map(({ property, propertyMeta }) => (
            <div key={property} className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs min-w-[60px]">
                {property}:
              </span>
              <div className="flex-1">
                <PropertyRenderer
                  property={propertyMeta}
                  value={entity[property]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// CollectionPreview Sub-component - Renders multiple entities in layout
// =============================================================================

interface CollectionPreviewProps {
  entities: Array<Record<string, unknown>>
  properties: Array<{ property: string; propertyMeta: PropertyMetadata }>
  layout: LayoutType
  groupBy?: string | null
}

/**
 * CollectionPreview - Renders entities in kanban/grid/list layout
 */
function CollectionPreview({
  entities,
  properties,
  layout,
  groupBy
}: CollectionPreviewProps) {
  // Group entities for kanban layout
  const groupedEntities = useMemo(() => {
    if (layout !== "kanban" || !groupBy) return null

    const groups: Record<string, Array<Record<string, unknown>>> = {}
    for (const entity of entities) {
      const key = String(entity[groupBy] ?? "Other")
      if (!groups[key]) groups[key] = []
      groups[key].push(entity)
    }
    return groups
  }, [entities, layout, groupBy])

  // Empty state
  if (entities.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Database className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <div>No entities found</div>
          <div className="text-xs mt-1">Check that the data source has records</div>
        </div>
      </div>
    )
  }

  // No properties selected
  if (properties.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div>Select properties to display</div>
          <div className="text-xs mt-1">Toggle properties in the definition panel</div>
        </div>
      </div>
    )
  }

  // KANBAN LAYOUT
  if (layout === "kanban" && groupedEntities) {
    // Define column colors for common priority values
    const columnColors: Record<string, { dot: string; text: string }> = {
      must: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
      high: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
      should: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
      medium: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
      could: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
      low: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
    }

    const sortedKeys = Object.keys(groupedEntities).sort((a, b) => {
      // Sort by priority order: must/high -> should/medium -> could/low -> other
      const order = ["must", "high", "should", "medium", "could", "low"]
      const aIdx = order.indexOf(a.toLowerCase())
      const bIdx = order.indexOf(b.toLowerCase())
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b)
      if (aIdx === -1) return 1
      if (bIdx === -1) return -1
      return aIdx - bIdx
    })

    return (
      <div className="h-full flex gap-4 overflow-x-auto px-2 pb-2">
        {sortedKeys.map((groupKey) => {
          const items = groupedEntities[groupKey]
          const colors = columnColors[groupKey.toLowerCase()] || {
            dot: "bg-gray-500",
            text: "text-gray-600 dark:text-gray-400"
          }

          return (
            <div key={groupKey} className="flex-shrink-0 w-72 flex flex-col">
              {/* Column header */}
              <div className="mb-3 flex items-center gap-2 sticky top-0 bg-background/95 backdrop-blur-sm pb-2 z-10">
                <span className={cn("w-2 h-2 rounded-full", colors.dot)} />
                <h4 className={cn("text-sm font-medium capitalize", colors.text)}>
                  {groupKey} ({items.length})
                </h4>
              </div>

              {/* Column content */}
              <div className="flex-1 space-y-2 overflow-y-auto">
                {items.map((entity, idx) => (
                  <EntityCard
                    key={String(entity.id ?? idx)}
                    entity={entity}
                    properties={properties}
                    variant="compact"
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // GRID LAYOUT
  if (layout === "grid") {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-2">
        {entities.map((entity, idx) => (
          <EntityCard
            key={String(entity.id ?? idx)}
            entity={entity}
            properties={properties}
            variant="compact"
          />
        ))}
      </div>
    )
  }

  // LIST LAYOUT (default)
  return (
    <div className="space-y-2 p-2">
      {entities.map((entity, idx) => (
        <EntityCard
          key={String(entity.id ?? idx)}
          entity={entity}
          properties={properties}
        />
      ))}
    </div>
  )
}

// =============================================================================
// PreviewPanel Main Component
// =============================================================================

/**
 * PreviewPanel - Live composition renderer
 * Task: task-cb-ui-preview-panel
 *
 * Renders the composition being edited in real-time.
 * All rendering logic is delegated to the composition rendering pipeline
 * (toSlotSpecs -> getSectionComponent -> SlotLayout).
 *
 * MobX observer wrapper ensures instant reactivity when:
 * - Composition slotContent changes
 * - Layout template changes
 * - ComponentDefinition references change
 */
export const PreviewPanel = observer(function PreviewPanel() {
  // ---------------------------------------------------------------------------
  // Access stores and UI state
  // ---------------------------------------------------------------------------

  // UI coordination state from ComponentBuilderContext
  const {
    compositionId,
    sampleDataEnabled,
    setSampleDataEnabled,
    sampleDataCount,
    selectedPropertyPath,
    selectedEntityId,
    setSelectedEntityId,
  } = useBuilderContext()

  // Domain store access - include platformFeatures for entity loading
  const domains = useDomains<{ componentBuilder: any; platformFeatures: any }>()
  const componentBuilder = domains?.componentBuilder
  const platformFeatures = domains?.platformFeatures

  // Local UI state
  const [zoom, setZoom] = useState(100)
  const [refreshKey, setRefreshKey] = useState(0)
  const [entityOptions, setEntityOptions] = useState<EntityOption[]>([])

  // ---------------------------------------------------------------------------
  // Callbacks
  // ---------------------------------------------------------------------------

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + 10, 150))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - 10, 50))
  }, [])

  const handleRefresh = useCallback(() => {
    // Force re-render by incrementing key
    setRefreshKey((k) => k + 1)
  }, [])

  // ---------------------------------------------------------------------------
  // Get composition being edited
  // ---------------------------------------------------------------------------

  const composition = compositionId
    ? componentBuilder?.compositionCollection?.get(compositionId)
    : null

  // ---------------------------------------------------------------------------
  // Extract data source and layout from composition.dataContext
  // ---------------------------------------------------------------------------

  const dataContext = composition?.dataContext ?? {}
  const selectedSchema = (dataContext.schema as string) ?? null
  const selectedModel = (dataContext.model as string) ?? null
  const selectedLayout = (dataContext.layout as LayoutType) ?? "list"
  const groupByField = (dataContext.groupBy as string) ?? "priority"

  // Determine if we're in collection mode (showing multiple entities)
  const isCollectionMode = selectedLayout === "kanban" || selectedLayout === "grid" || selectedLayout === "list"

  // ---------------------------------------------------------------------------
  // Load ALL entities for collection mode preview
  // ---------------------------------------------------------------------------

  const [allEntities, setAllEntities] = useState<Array<Record<string, unknown>>>([])

  useEffect(() => {
    if (!selectedSchema || !selectedModel) {
      setAllEntities([])
      return
    }

    const loadAllEntities = async () => {
      try {
        let entities: any[] = []

        if (selectedSchema === "platform-features" && platformFeatures) {
          const collectionName = `${selectedModel.charAt(0).toLowerCase()}${selectedModel.slice(1)}Collection`
          const collection = platformFeatures[collectionName]

          if (collection?.query) {
            entities = await collection.query().toArray()
          } else if (collection?.all) {
            entities = collection.all()
          }
        }

        setAllEntities(entities)
        console.log(`[PreviewPanel] Loaded ${entities.length} ${selectedModel} entities for collection preview`)
      } catch (err) {
        console.warn("[PreviewPanel] Failed to load entities for collection:", err)
        setAllEntities([])
      }
    }

    loadAllEntities()
  }, [selectedSchema, selectedModel, platformFeatures, refreshKey])

  // ---------------------------------------------------------------------------
  // Load entities for the entity picker dropdown (same as before)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!selectedSchema || !selectedModel) {
      setEntityOptions([])
      return
    }

    // Map schema/model to domain collection
    // Currently supports platform-features domain
    const loadEntities = async () => {
      try {
        let entities: any[] = []

        if (selectedSchema === "platform-features" && platformFeatures) {
          // Map model name to collection
          const collectionName = `${selectedModel.charAt(0).toLowerCase()}${selectedModel.slice(1)}Collection`
          const collection = platformFeatures[collectionName]

          if (collection?.query) {
            entities = await collection.query().toArray()
          } else if (collection?.all) {
            entities = collection.all()
          }
        }

        // Build options with display label
        const options: EntityOption[] = entities.slice(0, 50).map((entity: any) => ({
          id: entity.id,
          label: entity.name || entity.title || entity.id,
        }))

        setEntityOptions(options)
        console.log(`[PreviewPanel] Loaded ${options.length} ${selectedModel} entities`)
      } catch (err) {
        console.warn("[PreviewPanel] Failed to load entities:", err)
        setEntityOptions([])
      }
    }

    loadEntities()
  }, [selectedSchema, selectedModel, platformFeatures])

  // ---------------------------------------------------------------------------
  // Extract enabled properties from slotContent (must be before early returns)
  // ---------------------------------------------------------------------------

  const slotContent: SlotContentEntry[] = composition?.slotContent ?? []
  const enabledProperties = useMemo(() => {
    return slotContent
      .filter((entry) => entry.config?.property && entry.config?.propertyMeta)
      .map((entry) => ({
        property: entry.config!.property as string,
        propertyMeta: entry.config!.propertyMeta as PropertyMetadata,
      }))
  }, [slotContent])

  // ---------------------------------------------------------------------------
  // Get selected entity data
  // ---------------------------------------------------------------------------

  const selectedEntity = (() => {
    if (!selectedEntityId || !selectedSchema || !selectedModel) return null

    if (selectedSchema === "platform-features" && platformFeatures) {
      const collectionName = `${selectedModel.charAt(0).toLowerCase()}${selectedModel.slice(1)}Collection`
      const collection = platformFeatures[collectionName]
      return collection?.get?.(selectedEntityId) ?? null
    }

    return null
  })()

  // ---------------------------------------------------------------------------
  // Common PreviewHeader props
  // ---------------------------------------------------------------------------

  const headerProps = {
    zoom,
    onZoomIn: handleZoomIn,
    onZoomOut: handleZoomOut,
    onRefresh: handleRefresh,
    sampleDataEnabled,
    onSampleDataToggle: setSampleDataEnabled,
    entityOptions,
    selectedEntityId,
    onEntitySelect: setSelectedEntityId,
    modelName: selectedModel,
  }

  // ---------------------------------------------------------------------------
  // Render: No composition state
  // ---------------------------------------------------------------------------

  if (!composition) {
    return (
      <div className="h-full flex flex-col">
        <PreviewHeader {...headerProps} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <div>No composition to preview</div>
            {compositionId && (
              <div className="text-xs mt-1 text-muted-foreground/70">
                ID: {compositionId}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Get layout template
  // ---------------------------------------------------------------------------

  // composition.layout can be an MST reference (object) or string ID
  const layoutRef = composition.layout
  const layoutId = typeof layoutRef === "string" ? layoutRef : layoutRef?.id
  const layoutTemplate =
    componentBuilder?.layoutTemplateCollection?.get?.(layoutId) ?? layoutRef

  if (!layoutTemplate || !layoutTemplate.slots) {
    return (
      <div className="h-full flex flex-col">
        <PreviewHeader {...headerProps} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <div>No layout template found</div>
            <div className="text-sm mt-1">
              Composition: {composition.name ?? compositionId}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Get slot specifications from composition
  // ---------------------------------------------------------------------------

  const slotSpecs: SlotSpec[] = composition.toSlotSpecs?.() ?? []

  // ---------------------------------------------------------------------------
  // COLLECTION MODE: Render kanban/grid/list of multiple entities
  // ---------------------------------------------------------------------------

  if (isCollectionMode && enabledProperties.length > 0) {
    // KANBAN/GRID/LIST LAYOUTS: Use CollectionPreview
    return (
      <div className="h-full flex flex-col">
        <PreviewHeader {...headerProps} />
        <div
          className={cn(
            "flex-1 overflow-auto bg-muted/30",
            zoom !== 100 && "origin-top-left"
          )}
          style={{
            transform: zoom !== 100 ? `scale(${zoom / 100})` : undefined,
            width: zoom < 100 ? `${10000 / zoom}%` : undefined,
            height: zoom < 100 ? `${10000 / zoom}%` : undefined,
          }}
        >
          <CollectionPreview
            key={`collection-${refreshKey}`}
            entities={allEntities}
            properties={enabledProperties}
            layout={selectedLayout}
            groupBy={groupByField}
          />
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render: Empty composition state (no properties selected)
  // ---------------------------------------------------------------------------

  if (slotSpecs.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <PreviewHeader {...headerProps} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <div>Select properties to preview</div>
            <div className="text-xs mt-2 text-muted-foreground/70">
              Toggle properties in the definition panel
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Resolve section components and build slot children
  // ---------------------------------------------------------------------------

  // Group by slot name to support slot stacking (multiple sections in same slot)
  const slotChildren: Record<string, ReactNode | ReactNode[]> = {}

  for (const spec of slotSpecs) {
    const SectionComponent = getSectionComponent(spec.sectionRef)

    // Get the property name from config to lookup value from selected entity
    const propertyName = spec.config?.property as string | undefined
    const entityValue = selectedEntity && propertyName
      ? selectedEntity[propertyName]
      : undefined

    // Build config with entity data and sample data settings
    const configWithData = {
      ...spec.config,
      // Pass the actual entity value if an entity is selected
      value: entityValue,
      // Pass the full entity for context
      entity: selectedEntity,
      // Sample data settings (for fallback display)
      _sampleData: sampleDataEnabled
        ? { enabled: true, count: sampleDataCount }
        : undefined,
    }

    const element = (
      <SectionComponent
        key={`${spec.sectionRef}-${refreshKey}-${selectedEntityId ?? "none"}`}
        feature={null}
        config={configWithData}
      />
    )

    // If slot already has content, convert to array or push to existing array
    if (slotChildren[spec.slotName] !== undefined) {
      const existing = slotChildren[spec.slotName]
      if (Array.isArray(existing)) {
        existing.push(element)
      } else {
        slotChildren[spec.slotName] = [existing as ReactNode, element]
      }
    } else {
      slotChildren[spec.slotName] = element
    }
  }

  // ---------------------------------------------------------------------------
  // Render: Full preview
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col">
      <PreviewHeader {...headerProps} />
      <div
        className={cn(
          "flex-1 overflow-auto p-4 bg-muted/30",
          // When zoomed, ensure content doesn't clip
          zoom !== 100 && "origin-top-left"
        )}
        style={{
          transform: zoom !== 100 ? `scale(${zoom / 100})` : undefined,
          // Adjust container size when zoomed to prevent clipping
          width: zoom < 100 ? `${10000 / zoom}%` : undefined,
          height: zoom < 100 ? `${10000 / zoom}%` : undefined,
        }}
      >
        <PropertyHighlighter selectedPath={selectedPropertyPath}>
          <SlotLayout layout={layoutTemplate} className="h-full">
            {slotChildren}
          </SlotLayout>
        </PropertyHighlighter>
      </div>
    </div>
  )
})

export default PreviewPanel
