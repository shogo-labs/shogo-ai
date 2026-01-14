/**
 * DefinitionPanel - Configure the component being built
 * Task: task-cb-ui-definition-panel
 *
 * Provides controls for:
 * - Component name and category (BuilderHeader)
 * - Data source selection: schema -> model (DataSourcePicker)
 * - Layout type selection: kanban, grid, list (LayoutSelector)
 * - Property selection with toggles (PropertyList)
 * - Custom layout slots (SlotEditor - placeholder)
 *
 * Uses:
 * - useBuilderContext() for UI coordination state (compositionId, selectedPropertyPath)
 * - useDomains() for componentBuilder domain data (Composition entities)
 * - useWavesmithMetaStore() for schema introspection (schemas, models, properties)
 */

import { observer } from "mobx-react-lite"
import { useState, useCallback, useEffect } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { useOptionalWavesmithMetaStore } from "@/contexts/WavesmithMetaStoreContext"
import { useBuilderContext } from "./ComponentBuilderContext"
import { useAvailableSchemas } from "@/hooks/useAvailableSchemas"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { LayoutGrid, List, Columns, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"

// =============================================================================
// Types
// =============================================================================

type LayoutType = "kanban" | "grid" | "list"

/**
 * SlotContent entry structure (matches Composition.slotContent schema)
 */
interface SlotContentEntry {
  slot: string
  component: string
  config?: Record<string, unknown>
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Always returns the PropertyFieldSection component ID.
 *
 * PropertyFieldSection bridges the Section pipeline to the PropertyRenderer
 * pipeline, which handles actual renderer resolution via RendererBinding system.
 * The property metadata is passed via config.propertyMeta.
 */
function getComponentForProperty(_property: any): string {
  // Always use PropertyFieldSection - it delegates to PropertyRenderer
  // which resolves the actual display component via RendererBinding system
  return "comp-property-field-section"
}

interface BuilderHeaderProps {
  name: string
  onNameChange: (name: string) => void
}

interface DataSourcePickerProps {
  schemaNames: string[]
  schemasLoading: boolean
  schemaLoading: boolean
  selectedSchema: string | null
  onSchemaChange: (schema: string | null) => void
  models: any[]
  selectedModel: string | null
  onModelChange: (model: string | null) => void
}

interface LayoutSelectorProps {
  selected: LayoutType
  onChange: (layout: LayoutType) => void
}

interface PropertyListProps {
  properties: any[]
  enabledProperties: Set<string>
  selectedPropertyPath: string | null
  onPropertyToggle: (propertyName: string, enabled: boolean) => void
  onPropertySelect: (path: string | null) => void
}

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * BuilderHeader - Component name input and actions
 */
const BuilderHeader = observer(function BuilderHeader({
  name,
  onNameChange,
}: BuilderHeaderProps) {
  return (
    <div className="flex-none border-b border-border p-4">
      <div className="flex items-center gap-3">
        <Settings2 className="size-5 text-muted-foreground" />
        <div className="flex-1">
          <Label htmlFor="component-name" className="sr-only">
            Component Name
          </Label>
          <Input
            id="component-name"
            placeholder="Component name..."
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="h-8"
          />
        </div>
      </div>
    </div>
  )
})

/**
 * DataSourcePicker - Schema and model selection
 */
const DataSourcePicker = observer(function DataSourcePicker({
  schemaNames,
  schemasLoading,
  schemaLoading,
  selectedSchema,
  onSchemaChange,
  models,
  selectedModel,
  onModelChange,
}: DataSourcePickerProps) {
  return (
    <div className="space-y-4">
      <div className="text-sm font-medium text-foreground">Data Source</div>

      {/* Schema Selection */}
      <div className="space-y-2">
        <Label htmlFor="schema-select" className="text-xs text-muted-foreground">
          Schema (Domain)
        </Label>
        <Select
          value={selectedSchema ?? ""}
          onValueChange={(value) => {
            onSchemaChange(value || null)
          }}
          disabled={schemasLoading}
        >
          <SelectTrigger id="schema-select" className="h-8">
            <SelectValue placeholder={schemasLoading ? "Loading schemas..." : "Select a schema..."} />
          </SelectTrigger>
          <SelectContent>
            {schemaNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Model Selection */}
      <div className="space-y-2">
        <Label htmlFor="model-select" className="text-xs text-muted-foreground">
          Model
        </Label>
        <Select
          value={selectedModel ?? ""}
          onValueChange={(value) => onModelChange(value || null)}
          disabled={!selectedSchema || schemaLoading}
        >
          <SelectTrigger id="model-select" className="h-8">
            <SelectValue
              placeholder={
                schemaLoading
                  ? "Loading models..."
                  : selectedSchema
                  ? "Select a model..."
                  : "Select schema first"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model.id || model.name} value={model.name}>
                {model.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
})

/**
 * LayoutSelector - Visual layout type selection
 */
const LayoutSelector = observer(function LayoutSelector({
  selected,
  onChange,
}: LayoutSelectorProps) {
  const layouts: { type: LayoutType; icon: typeof LayoutGrid; label: string }[] = [
    { type: "list", icon: List, label: "List" },
    { type: "grid", icon: LayoutGrid, label: "Grid" },
    { type: "kanban", icon: Columns, label: "Kanban" },
  ]

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Layout Type</div>
      <div className="flex gap-2">
        {layouts.map(({ type, icon: Icon, label }) => (
          <Button
            key={type}
            variant={selected === type ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(type)}
            className={cn(
              "flex-1 flex-col gap-1 h-auto py-2",
              selected === type && "ring-2 ring-primary ring-offset-2"
            )}
          >
            <Icon className="size-4" />
            <span className="text-xs">{label}</span>
          </Button>
        ))}
      </div>
    </div>
  )
})

/**
 * PropertyList - Property selection with toggles
 */
const PropertyList = observer(function PropertyList({
  properties,
  enabledProperties,
  selectedPropertyPath,
  onPropertyToggle,
  onPropertySelect,
}: PropertyListProps) {
  if (properties.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-sm font-medium text-foreground">Properties</div>
        <div className="text-xs text-muted-foreground italic py-4 text-center border border-dashed rounded-md">
          Select a model to see its properties
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">Properties</div>
        <div className="text-xs text-muted-foreground">
          {enabledProperties.size} / {properties.length} selected
        </div>
      </div>
      <div className="space-y-1 max-h-48 overflow-auto border rounded-md p-2">
        {properties.map((prop) => {
          const propName = prop.name
          const isEnabled = enabledProperties.has(propName)
          const isSelected = selectedPropertyPath === propName
          const typeLabel = prop.type || (prop.$ref ? "ref" : "unknown")

          return (
            <div
              key={propName}
              className={cn(
                "flex items-center gap-3 px-2 py-1.5 rounded-sm cursor-pointer transition-colors",
                isSelected
                  ? "bg-primary/10 border border-primary/30"
                  : "hover:bg-muted/50"
              )}
              onClick={() => onPropertySelect(isSelected ? null : propName)}
            >
              <Checkbox
                id={`prop-${propName}`}
                checked={isEnabled}
                onCheckedChange={(checked: boolean | "indeterminate") =>
                  onPropertyToggle(propName, checked === true)
                }
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              />
              <label
                htmlFor={`prop-${propName}`}
                className="flex-1 text-sm cursor-pointer"
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                {propName}
              </label>
              <span className="text-xs text-muted-foreground font-mono">
                {typeLabel}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
})

/**
 * SlotEditor - Placeholder for custom layout slot editing
 */
const SlotEditor = observer(function SlotEditor() {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground">Custom Slots</div>
      <div className="text-xs text-muted-foreground italic py-4 text-center border border-dashed rounded-md">
        Slot editor coming soon...
      </div>
    </div>
  )
})

// =============================================================================
// Main Component
// =============================================================================

/**
 * DefinitionPanel - Main definition panel component
 *
 * Coordinates:
 * - UI state from ComponentBuilderContext
 * - Domain data from useDomains() (componentBuilder)
 * - Schema introspection from useWavesmithMetaStore() (metaStore)
 */
export const DefinitionPanel = observer(function DefinitionPanel() {
  // Context hooks
  const { componentBuilder } = useDomains<{
    componentBuilder: any
  }>()
  const metaStore = useOptionalWavesmithMetaStore()
  const {
    compositionId,
    selectedPropertyPath,
    setSelectedPropertyPath,
    componentName,
    setComponentName,
    markDirty,
  } = useBuilderContext()

  // Get composition being edited - this is the source of truth for form state
  // Uses async query() pattern from CollectionQueryable mixin
  const [composition, setComposition] = useState<any>(null)

  useEffect(() => {
    if (!compositionId || !componentBuilder?.compositionCollection?.query) {
      setComposition(null)
      return
    }

    componentBuilder.compositionCollection
      .query()
      .where({ id: compositionId })
      .first()
      .then((result: any) => setComposition(result ?? null))
      .catch((err: Error) => {
        console.warn('[DefinitionPanel] Failed to load composition:', err)
        setComposition(null)
      })
  }, [compositionId, componentBuilder])

  // Read form values from composition.dataContext (reactive via MobX observer)
  const dataContext = composition?.dataContext ?? {}
  const selectedSchemaId = (dataContext.schema as string) ?? null
  const selectedModelId = (dataContext.model as string) ?? null
  const selectedLayout = (dataContext.layout as LayoutType) ?? "list"
  const groupByField = (dataContext.groupBy as string) ?? null

  // Local state for enabled properties (stored in composition.slotContent on save)
  const [enabledProperties, setEnabledProperties] = useState<Set<string>>(new Set())

  // Sync component name from composition on initial load
  useEffect(() => {
    if (composition && !componentName) {
      setComponentName(composition.name || "")
    }
  }, [composition, componentName, setComponentName])

  // Initialize enabledProperties from existing composition.slotContent
  // This syncs the checkboxes with existing slot content when editing
  useEffect(() => {
    if (!composition?.slotContent) return

    const slotContent: SlotContentEntry[] = composition.slotContent
    const propertyNames = slotContent
      .map((entry) => entry.config?.property as string)
      .filter(Boolean)

    if (propertyNames.length > 0) {
      setEnabledProperties(new Set(propertyNames))
      console.log('[DefinitionPanel] Initialized enabledProperties from slotContent:', propertyNames)
    }
  }, [composition?.id]) // Only run when composition changes (by ID)

  // Helper to update composition.dataContext
  const updateDataContext = useCallback(
    (updates: Record<string, unknown>) => {
      if (!composition || !componentBuilder?.compositionCollection) return
      const newDataContext = { ...dataContext, ...updates }
      componentBuilder.compositionCollection.updateOne(compositionId, {
        dataContext: newDataContext,
      })
      markDirty()
    },
    [composition, componentBuilder, compositionId, dataContext, markDirty]
  )

  // Schema listing via lightweight hook (calls MCP schema.list)
  const { schemas: schemaNames, loading: schemasLoading } = useAvailableSchemas()

  // Track schema loading state
  const [schemaLoading, setSchemaLoading] = useState(false)

  // Load pre-selected schema on mount (from Claude's suggestions)
  useEffect(() => {
    if (!selectedSchemaId || !metaStore?.loadSchema) return

    // Check if schema is already loaded
    const existing = metaStore?.schemaCollection?.all?.().find((s: any) => s.name === selectedSchemaId)
    if (existing) return

    // Load the schema
    setSchemaLoading(true)
    metaStore.loadSchema(selectedSchemaId)
      .then(() => {
        console.log("[DefinitionPanel] Pre-selected schema loaded:", selectedSchemaId)
      })
      .catch((err: Error) => {
        console.warn("[DefinitionPanel] Failed to load pre-selected schema:", selectedSchemaId, err)
      })
      .finally(() => {
        setSchemaLoading(false)
      })
  }, [selectedSchemaId, metaStore])

  // Find selected schema entity from meta-store (loaded on-demand)
  // We use findByName since schemas are identified by name
  const selectedSchemaEntity = selectedSchemaId
    ? metaStore?.schemaCollection?.all?.().find((s: any) => s.name === selectedSchemaId)
    : null

  // Get models from selected schema (Schema.models computed view)
  const models = selectedSchemaEntity?.models ?? []

  // Find selected model entity by name (dataContext.model stores model name, not ID)
  const selectedModelEntity = selectedModelId
    ? models.find((m: any) => m.name === selectedModelId)
    : null

  // Get properties from selected model (Model.properties computed view)
  const properties = selectedModelEntity?.properties ?? []

  // Handle property toggle - updates both local state and composition.slotContent
  const handlePropertyToggle = useCallback(
    (propertyName: string, enabled: boolean) => {
      // 1. Update local state for immediate UI feedback
      setEnabledProperties((prev) => {
        const next = new Set(prev)
        if (enabled) {
          next.add(propertyName)
        } else {
          next.delete(propertyName)
        }
        return next
      })

      // 2. Get the property object for mapping to component
      const property = properties.find((p: any) => p.name === propertyName)

      // 3. Get fresh slotContent from store (not from stale async state)
      // Use direct .get() for MobX reactivity
      const liveComposition = compositionId
        ? componentBuilder?.compositionCollection?.get(compositionId)
        : null
      const currentSlotContent: SlotContentEntry[] = liveComposition?.slotContent ?? []
      let newSlotContent: SlotContentEntry[]

      if (!enabled) {
        // Remove: filter out entries for this property
        newSlotContent = currentSlotContent.filter(
          (entry) => entry.config?.property !== propertyName
        )
      } else {
        // Add: append new entry for this property
        const componentId = getComponentForProperty(property)
        newSlotContent = [
          ...currentSlotContent,
          {
            slot: "main", // Default to main slot
            component: componentId,
            config: {
              property: propertyName,
              // Pass full property metadata for PropertyFieldSection → PropertyRenderer
              propertyMeta: property
            }
          }
        ]
      }

      // 4. Update composition via domain (triggers MobX reactivity -> PreviewPanel re-render)
      if (compositionId && componentBuilder?.compositionCollection?.updateOne) {
        componentBuilder.compositionCollection.updateOne(compositionId, {
          slotContent: newSlotContent,
          updatedAt: Date.now()
        })
        console.log('[DefinitionPanel] Updated slotContent:', newSlotContent.length, 'entries')
      }

      markDirty()
    },
    [compositionId, componentBuilder, properties, markDirty]
  )

  // Handle schema change - load schema and reset model
  const handleSchemaChange = useCallback(
    async (schemaId: string | null) => {
      // Update dataContext first
      updateDataContext({ schema: schemaId, model: null })
      setEnabledProperties(new Set())
      setSelectedPropertyPath(null)

      // Load the schema into meta-store to get its models
      if (schemaId && metaStore?.loadSchema) {
        setSchemaLoading(true)
        try {
          await metaStore.loadSchema(schemaId)
          console.log("[DefinitionPanel] Schema loaded:", schemaId)
        } catch (err) {
          console.warn("[DefinitionPanel] Failed to load schema:", schemaId, err)
        } finally {
          setSchemaLoading(false)
        }
      }
    },
    [updateDataContext, setSelectedPropertyPath, metaStore]
  )

  // Handle model change - reset properties
  const handleModelChange = useCallback(
    (modelId: string | null) => {
      updateDataContext({ model: modelId })
      setEnabledProperties(new Set())
      setSelectedPropertyPath(null)
    },
    [updateDataContext, setSelectedPropertyPath]
  )

  // Handle layout change
  const handleLayoutChange = useCallback(
    (layout: LayoutType) => {
      updateDataContext({ layout })
    },
    [updateDataContext]
  )

  return (
    <div
      className="h-full flex flex-col overflow-hidden bg-card"
      data-testid="definition-panel"
    >
      {/* Header with component name */}
      <BuilderHeader name={componentName} onNameChange={setComponentName} />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Data Source Picker */}
        <DataSourcePicker
          schemaNames={schemaNames}
          schemasLoading={schemasLoading}
          schemaLoading={schemaLoading}
          selectedSchema={selectedSchemaId}
          onSchemaChange={handleSchemaChange}
          models={models}
          selectedModel={selectedModelId}
          onModelChange={handleModelChange}
        />

        {/* Layout Selector */}
        <LayoutSelector selected={selectedLayout} onChange={handleLayoutChange} />

        {/* Property List */}
        <PropertyList
          properties={properties}
          enabledProperties={enabledProperties}
          selectedPropertyPath={selectedPropertyPath}
          onPropertyToggle={handlePropertyToggle}
          onPropertySelect={setSelectedPropertyPath}
        />

        {/* Slot Editor placeholder */}
        <SlotEditor />
      </div>
    </div>
  )
})

export default DefinitionPanel
