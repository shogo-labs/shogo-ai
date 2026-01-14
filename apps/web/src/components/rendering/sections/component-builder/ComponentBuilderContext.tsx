/**
 * ComponentBuilderContext - UI coordination state for the component builder
 * Task: task-cb-ui-provider
 *
 * IMPORTANT: This context holds ONLY UI state (layout mode, active tab, etc.)
 * Domain data (Composition, ComponentDefinition) is accessed via useDomains()
 *
 * Provides shared UI coordination state for Component Builder section components:
 * - BuilderLayout: uses layoutMode, activeTab
 * - DefinitionPanel: uses selectedPropertyPath
 * - PreviewPanel: uses sampleDataEnabled, sampleDataCount
 * - All panels: read compositionId to access domain data via useDomains()
 *
 * Uses direct context creation (like AnalysisPanelContext, TestingPanelContext)
 * for Component Builder-specific UI state management.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import type { ProviderWrapperProps } from "../../composition/providerImplementationMap"
import { useDomains } from "@/contexts/DomainProvider"
import { useOptionalWavesmithMetaStore } from "@/contexts/WavesmithMetaStoreContext"

/**
 * Layout mode for the builder interface
 * - 'split': side-by-side definition and preview panels
 * - 'tabbed': tabbed interface switching between panels
 */
export type LayoutMode = "split" | "tabbed"

/**
 * Active tab when in tabbed layout mode
 * - 'definition': Component definition editor
 * - 'preview': Live preview with sample data
 * - 'schema': Schema/JSON view
 */
export type ActiveTab = "definition" | "preview" | "schema"

/**
 * Suggested data source from set_workspace config
 * Pre-populates the schema/model selection in DefinitionPanel
 */
export interface SuggestedDataSource {
  /** Domain/schema name (e.g., "platform-features") */
  domain: string
  /** Model name within the schema (e.g., "Requirement") */
  model: string
}

/**
 * Layout types for data visualization
 */
export type DataLayoutType = "list" | "kanban" | "grid" | "cards"

/**
 * Complete Component Builder UI coordination state exposed to consumers
 */
export interface ComponentBuilderContextValue {
  // Layout coordination
  /** Current layout mode: 'split' shows side-by-side, 'tabbed' shows tabs */
  layoutMode: LayoutMode
  /** Set the layout mode */
  setLayoutMode: (mode: LayoutMode) => void

  // Tab coordination (for tabbed mode)
  /** Currently active tab in tabbed mode */
  activeTab: ActiveTab
  /** Set the active tab */
  setActiveTab: (tab: ActiveTab) => void

  // Property selection (for highlighting across panels)
  /** Currently selected property path, or null if none selected */
  selectedPropertyPath: string | null
  /** Set the selected property path (for cross-panel highlighting) */
  setSelectedPropertyPath: (path: string | null) => void

  // Composition reference (ID only, not entity)
  /** ID of the composition being edited, or null if creating new */
  compositionId: string | null

  // Component name for save flow
  /** User-provided component name (synced to Composition on save) */
  componentName: string
  /** Set the component name */
  setComponentName: (name: string) => void

  // Dirty state tracking
  /** Whether there are unsaved changes */
  isDirty: boolean
  /** Mark the form as dirty (has unsaved changes) */
  markDirty: () => void
  /** Clear the dirty state (after save or discard) */
  clearDirty: () => void

  // Sample data settings
  /** Whether to show sample data in preview */
  sampleDataEnabled: boolean
  /** Set sample data enabled state */
  setSampleDataEnabled: (enabled: boolean) => void
  /** Number of sample items to generate for preview */
  sampleDataCount: number
  /** Set the sample data count */
  setSampleDataCount: (count: number) => void

  // Entity selection for real data preview
  /** ID of the selected entity to preview (from the selected model's collection) */
  selectedEntityId: string | null
  /** Set the selected entity ID */
  setSelectedEntityId: (id: string | null) => void

  // Suggested values from set_workspace config (read-only, for initial state)
  /** Suggested data source from Claude's set_workspace call */
  suggestedDataSource: SuggestedDataSource | null
  /** Suggested layout type (kanban, grid, list, cards) */
  suggestedLayout: DataLayoutType | null
  /** Suggested groupBy field for kanban layout */
  suggestedGroupBy: string | null
}

// Create context with undefined default (enforces provider usage)
const ComponentBuilderContextInternal = createContext<ComponentBuilderContextValue | undefined>(
  undefined
)

/**
 * Provider component props
 */
export interface ComponentBuilderProviderProps extends ProviderWrapperProps {
  /** Initial composition ID (from config or route) */
  initialCompositionId?: string
  /** Initial layout mode (defaults to 'split') */
  initialLayoutMode?: LayoutMode
}

/**
 * Provider component that manages Component Builder UI coordination state.
 *
 * Provides:
 * - layoutMode: 'split' | 'tabbed' layout selection
 * - activeTab: current tab when in tabbed mode
 * - selectedPropertyPath: cross-panel property highlighting
 * - compositionId: ID reference to the composition being edited
 * - sampleData settings: enabled state and count
 *
 * @example
 * ```tsx
 * <ComponentBuilderProvider feature={feature} config={{ compositionId: 'comp-123' }}>
 *   <BuilderLayout />
 * </ComponentBuilderProvider>
 * ```
 */
export function ComponentBuilderProvider({
  children,
  feature,
  config,
}: ComponentBuilderProviderProps) {
  // Access component-builder domain for creating draft Composition
  const { componentBuilder } = useDomains<{ componentBuilder: any }>()
  // Access meta-store for loading suggested schema
  const metaStore = useOptionalWavesmithMetaStore()

  // Extract initial values from config
  const initialCompositionId = (config?.compositionId as string) ?? null
  const initialLayoutMode = (config?.layoutMode as LayoutMode) ?? "split"
  const initialComponentName = (config?.componentName as string) ?? ""

  // Extract suggested values from set_workspace config (for pre-populating form)
  const suggestedDataSource = (config?.suggestedDataSource as SuggestedDataSource) ?? null
  const suggestedLayout = (config?.suggestedLayout as DataLayoutType) ?? null
  const suggestedGroupBy = (config?.suggestedGroupBy as string) ?? null

  // Track the composition ID (either provided or created as draft)
  const [compositionId, setCompositionId] = useState<string | null>(initialCompositionId)
  const draftCreatedRef = useRef(false)

  // Create draft Composition when suggestions provided and no existing composition
  useEffect(() => {
    // Skip if already have a composition or already created draft
    if (compositionId || draftCreatedRef.current) return
    // Skip if no suggestions or no domain access
    if (!suggestedDataSource || !componentBuilder?.compositionCollection) return

    // Generate PREDICTABLE draft ID based on data source
    // This allows Claude to calculate the same ID when updating via execute tool
    const draftId = `draft-${suggestedDataSource.domain}-${suggestedDataSource.model}`

    // Check if this draft already exists
    const existingDraft = componentBuilder.compositionCollection.get(draftId)
    if (existingDraft) {
      // Reuse existing draft instead of creating duplicate
      setCompositionId(draftId)
      draftCreatedRef.current = true
      console.log("[ComponentBuilder] Reusing existing draft composition:", draftId)
      return
    }

    // Set flag first to prevent duplicate calls during async operation
    draftCreatedRef.current = true

    // Create draft Composition with suggestions in dataContext
    const draftComposition = {
      id: draftId,
      name: `${suggestedDataSource.model} ${suggestedLayout || "kanban"}`,
      layout: "layout-workspace-flexible", // Default flexible layout
      slotContent: [], // Empty - user will build this
      dataContext: {
        schema: suggestedDataSource.domain,
        model: suggestedDataSource.model,
        layout: suggestedLayout || "list",
        groupBy: suggestedGroupBy || null,
      },
      createdAt: Date.now(), // Required by Composition schema
    }

    // Insert into collection (async - await before setting compositionId)
    ;(async () => {
      try {
        await componentBuilder.compositionCollection.insertOne(draftComposition)
        setCompositionId(draftId)
        console.log("[ComponentBuilder] Created draft composition:", draftId, draftComposition)
      } catch (err) {
        console.error("[ComponentBuilder] Failed to create draft:", err)
        draftCreatedRef.current = false // Allow retry on error
      }
    })()
  }, [compositionId, suggestedDataSource, suggestedLayout, suggestedGroupBy, componentBuilder])

  // Load suggested schema into meta-store so DefinitionPanel dropdown can show it
  const schemaLoadedRef = useRef(false)
  useEffect(() => {
    if (schemaLoadedRef.current) return
    if (!suggestedDataSource?.domain || !metaStore?.loadSchema) return

    schemaLoadedRef.current = true
    const schemaName = suggestedDataSource.domain

    console.log("[ComponentBuilder] Loading suggested schema:", schemaName)
    metaStore.loadSchema(schemaName).then((schema: any) => {
      console.log("[ComponentBuilder] Schema loaded:", schemaName, schema?.name)
    }).catch((err: Error) => {
      console.warn("[ComponentBuilder] Failed to load schema:", schemaName, err)
    })
  }, [suggestedDataSource, metaStore])

  // Layout mode state
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(initialLayoutMode)

  // Active tab state (for tabbed mode)
  const [activeTab, setActiveTabState] = useState<ActiveTab>("definition")

  // Property selection state (for cross-panel highlighting)
  const [selectedPropertyPath, setSelectedPropertyPathState] = useState<string | null>(null)

  // Component name state (synced to Composition on save)
  const [componentName, setComponentNameState] = useState<string>(initialComponentName)

  // Dirty state tracking
  const [isDirty, setIsDirty] = useState(false)

  // Sample data settings
  const [sampleDataEnabled, setSampleDataEnabledState] = useState(true)
  const [sampleDataCount, setSampleDataCountState] = useState(5)

  // Entity selection for real data preview
  const [selectedEntityId, setSelectedEntityIdState] = useState<string | null>(null)

  // Callbacks (stable references)
  const setLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutModeState(mode)
  }, [])

  const setActiveTab = useCallback((tab: ActiveTab) => {
    setActiveTabState(tab)
  }, [])

  const setSelectedPropertyPath = useCallback((path: string | null) => {
    setSelectedPropertyPathState(path)
  }, [])

  const setComponentName = useCallback((name: string) => {
    setComponentNameState(name)
    setIsDirty(true) // Changing name marks as dirty
  }, [])

  const markDirty = useCallback(() => {
    setIsDirty(true)
  }, [])

  const clearDirty = useCallback(() => {
    setIsDirty(false)
  }, [])

  const setSampleDataEnabled = useCallback((enabled: boolean) => {
    setSampleDataEnabledState(enabled)
  }, [])

  const setSampleDataCount = useCallback((count: number) => {
    setSampleDataCountState(count)
  }, [])

  const setSelectedEntityId = useCallback((id: string | null) => {
    setSelectedEntityIdState(id)
  }, [])

  const value: ComponentBuilderContextValue = {
    layoutMode,
    setLayoutMode,
    activeTab,
    setActiveTab,
    selectedPropertyPath,
    setSelectedPropertyPath,
    compositionId, // Now uses stateful ID (provided or created draft)
    componentName,
    setComponentName,
    isDirty,
    markDirty,
    clearDirty,
    sampleDataEnabled,
    setSampleDataEnabled,
    sampleDataCount,
    setSampleDataCount,
    // Entity selection for real data preview
    selectedEntityId,
    setSelectedEntityId,
    // Suggested values from set_workspace (read-only)
    suggestedDataSource,
    suggestedLayout,
    suggestedGroupBy,
  }

  return (
    <ComponentBuilderContextInternal.Provider value={value}>
      <div data-provider-wrapper="ComponentBuilderProvider">{children}</div>
    </ComponentBuilderContextInternal.Provider>
  )
}

// Set display name for DevTools
ComponentBuilderProvider.displayName = "ComponentBuilderProvider"

/**
 * Hook to access Component Builder UI coordination context
 *
 * @throws Error if used outside ComponentBuilderProvider
 *
 * @example
 * ```tsx
 * function BuilderLayout() {
 *   const { layoutMode, setLayoutMode, compositionId } = useBuilderContext()
 *
 *   // Access domain data via useDomains(), not from context
 *   const { componentBuilder } = useDomains()
 *   const composition = compositionId
 *     ? componentBuilder.compositions.get(compositionId)
 *     : null
 *
 *   return layoutMode === 'split' ? <SplitView /> : <TabbedView />
 * }
 *
 * function DefinitionPanel() {
 *   const { selectedPropertyPath, setSelectedPropertyPath } = useBuilderContext()
 *   // Highlight the selected property, update on click
 * }
 *
 * function PreviewPanel() {
 *   const { sampleDataEnabled, sampleDataCount, compositionId } = useBuilderContext()
 *   // Render preview with sample data based on settings
 * }
 * ```
 */
export function useBuilderContext(): ComponentBuilderContextValue {
  const context = useContext(ComponentBuilderContextInternal)
  if (context === undefined) {
    throw new Error("useBuilderContext must be used within ComponentBuilderProvider")
  }
  return context
}

export default ComponentBuilderProvider
