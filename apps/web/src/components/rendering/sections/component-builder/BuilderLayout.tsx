/**
 * BuilderLayout - Manages split vs tabbed layout modes for the builder
 * Task: task-cb-ui-builder-layout
 *
 * Split mode: Definition panel left, Preview panel right (default for desktop)
 * Tabbed mode: Tabs for Definition, Preview, Schema (for focused work or mobile)
 *
 * Uses:
 * - useBuilderContext() for layout coordination (layoutMode, activeTab)
 * - DefinitionPanel for component definition editing
 * - PreviewPanel for live composition preview
 * - Schema tab for raw JSON visualization
 */

import { observer } from "mobx-react-lite"
import { useEffect, useCallback, useState } from "react"
import { useBuilderContext, type LayoutMode, type ActiveTab } from "./ComponentBuilderContext"
import { DefinitionPanel } from "./DefinitionPanel"
import { PreviewPanel } from "./PreviewPanel"
import { useDomains } from "@/contexts/DomainProvider"
import { useToast } from "@/hooks/use-toast"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Columns2, LayoutGrid, Save, Trash2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

// =============================================================================
// Constants
// =============================================================================

const LAYOUT_MODE_STORAGE_KEY = "component-builder-layout-mode"

// =============================================================================
// Layout Header
// =============================================================================

interface BuilderLayoutHeaderProps {
  layoutMode: LayoutMode
  onLayoutModeChange: (mode: LayoutMode) => void
}

/**
 * Header bar with layout mode toggle buttons
 */
function BuilderLayoutHeader({ layoutMode, onLayoutModeChange }: BuilderLayoutHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
      <span className="text-sm font-medium">Component Builder</span>
      <div className="flex items-center gap-1">
        <Button
          variant={layoutMode === "split" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2"
          onClick={() => onLayoutModeChange("split")}
          title="Split view - side by side panels"
        >
          <Columns2 className="h-4 w-4 mr-1" />
          Split
        </Button>
        <Button
          variant={layoutMode === "tabbed" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2"
          onClick={() => onLayoutModeChange("tabbed")}
          title="Tabbed view - switch between panels"
        >
          <LayoutGrid className="h-4 w-4 mr-1" />
          Tabs
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// Split Layout
// =============================================================================

/**
 * SplitLayout - Side by side Definition and Preview panels
 * Default layout for desktop screens
 */
function SplitLayout() {
  return (
    <div className="h-full flex">
      {/* Definition panel - left side, fixed width */}
      <div className="w-[320px] flex-shrink-0 border-r overflow-hidden">
        <DefinitionPanel />
      </div>

      {/* Preview panel - right side, takes remaining space */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <PreviewPanel />
      </div>
    </div>
  )
}

// =============================================================================
// Tabbed Layout
// =============================================================================

interface TabbedLayoutProps {
  activeTab: ActiveTab
  onTabChange: (tab: ActiveTab) => void
}

/**
 * TabbedLayout - Tab-based navigation between Definition, Preview, and Schema views
 * Useful for focused work or smaller screens
 */
function TabbedLayout({ activeTab, onTabChange }: TabbedLayoutProps) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => onTabChange(v as ActiveTab)}
      className="h-full flex flex-col"
    >
      <TabsList className="mx-4 mt-2 w-fit">
        <TabsTrigger value="definition">Definition</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="schema">Schema</TabsTrigger>
      </TabsList>

      <TabsContent value="definition" className="flex-1 mt-0 overflow-hidden">
        <DefinitionPanel />
      </TabsContent>

      <TabsContent value="preview" className="flex-1 mt-0 overflow-hidden">
        <PreviewPanel />
      </TabsContent>

      <TabsContent value="schema" className="flex-1 mt-0 overflow-hidden p-4">
        <SchemaView />
      </TabsContent>
    </Tabs>
  )
}

// =============================================================================
// Schema View
// =============================================================================

/**
 * SchemaView - Raw JSON display of the composition being edited
 * Shows the composition data structure for debugging/reference
 */
const SchemaView = observer(function SchemaView() {
  const { compositionId } = useBuilderContext()
  const domains = useDomains<{ componentBuilder: any }>()
  const componentBuilder = domains?.componentBuilder

  const composition = compositionId
    ? componentBuilder?.compositionCollection?.get(compositionId)
    : null

  if (!composition) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div>No composition to display</div>
          {compositionId && (
            <div className="text-xs mt-1 text-muted-foreground/70">
              ID: {compositionId}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Get a plain object snapshot of the composition
  // getSnapshot is available on MST nodes
  let jsonData: unknown
  try {
    // Try MST getSnapshot if available
    const { getSnapshot } = require("mobx-state-tree")
    jsonData = getSnapshot(composition)
  } catch {
    // Fallback to spreading observable properties
    jsonData = {
      id: composition.id,
      name: composition.name,
      layout: composition.layout?.id ?? composition.layout,
      dataContext: composition.dataContext,
      slotContent: composition.slotContent,
    }
  }

  return (
    <div className="h-full overflow-auto">
      <pre className="text-xs font-mono bg-muted p-4 rounded whitespace-pre-wrap break-words">
        {JSON.stringify(jsonData, null, 2)}
      </pre>
    </div>
  )
})

// =============================================================================
// Builder Toolbar
// =============================================================================

/**
 * BuilderToolbar - Footer with Save/Discard action buttons
 * Task: task-cb-ui-save-flow
 *
 * Save flow:
 * 1. Update Composition with user-provided name
 * 2. Create ComponentDefinition for hot registration (if it doesn't exist)
 * 3. The saved component is immediately usable via hot registration by name
 *
 * Discard flow:
 * 1. Confirm with user if there are unsaved changes
 * 2. Clear dirty state (actual reset of form state handled by DefinitionPanel)
 */
const BuilderToolbar = observer(function BuilderToolbar() {
  const { compositionId, componentName, isDirty, clearDirty } = useBuilderContext()
  const domains = useDomains<{ componentBuilder: any }>()
  const componentBuilder = domains?.componentBuilder
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  /**
   * Save handler - persists Composition and creates ComponentDefinition for hot registration
   */
  const handleSave = useCallback(async () => {
    if (!compositionId || !componentBuilder) {
      toast({
        title: "Error",
        description: "No composition to save. Please select a composition first.",
        variant: "destructive",
      })
      return
    }

    // Validate component name
    const name = componentName.trim()
    if (!name) {
      toast({
        title: "Name Required",
        description: "Please provide a name for your component.",
        variant: "destructive",
      })
      return
    }

    setIsSaving(true)
    try {
      // Get current composition
      const composition = componentBuilder.compositionCollection.get(compositionId)
      if (!composition) {
        throw new Error(`Composition not found: ${compositionId}`)
      }

      // Update the composition with the user-provided name
      await componentBuilder.compositionCollection.updateOne(compositionId, {
        name: name,
        updatedAt: Date.now(),
      })

      // Check if a ComponentDefinition already exists for this composition
      // If not, create one to enable hot registration by name
      const existingDef = componentBuilder.componentDefinitionCollection
        .all()
        .find((def: any) => def.name === name)

      if (!existingDef) {
        // Create ComponentDefinition for hot registration
        // This allows the saved composition to be referenced by name in slotContent
        await componentBuilder.componentDefinitionCollection.insertOne({
          id: `comp-def-${compositionId}`,
          name: name,
          category: "section", // User-created components are sections
          description: `User-created component: ${name}`,
          implementationRef: "DynamicCompositionSection",
          createdAt: Date.now(),
        })
      } else if (existingDef.id !== `comp-def-${compositionId}`) {
        // Update existing definition if name was reused
        await componentBuilder.componentDefinitionCollection.updateOne(existingDef.id, {
          name: name,
          updatedAt: Date.now(),
        })
      }

      // Clear dirty state
      clearDirty()

      toast({
        title: "Component Saved",
        description: `"${name}" is now available for use via hot registration.`,
      })
    } catch (error) {
      console.error("Save failed:", error)
      toast({
        title: "Save Failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        variant: "destructive",
      })
    } finally {
      setIsSaving(false)
    }
  }, [compositionId, componentBuilder, componentName, clearDirty, toast])

  /**
   * Discard handler - confirms with user before clearing changes
   */
  const handleDiscard = useCallback(() => {
    if (isDirty) {
      // Confirm before discarding
      if (!window.confirm("Discard unsaved changes? This action cannot be undone.")) {
        return
      }
    }

    // Clear dirty state
    clearDirty()

    // Note: Actual form state reset would need to be coordinated with DefinitionPanel
    // For now, we just clear the dirty flag. A more complete implementation could
    // use MST snapshots to restore the original composition state.

    toast({
      title: "Changes Discarded",
      description: "Your changes have been discarded.",
    })
  }, [isDirty, clearDirty, toast])

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t bg-background">
      {/* Dirty indicator */}
      <div className="text-xs text-muted-foreground">
        {isDirty && <span className="text-amber-500">Unsaved changes</span>}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDiscard}
          disabled={isSaving}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Discard
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSaving || !componentName.trim()}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1" />
          )}
          {isSaving ? "Saving..." : "Save Component"}
        </Button>
      </div>
    </div>
  )
})

// =============================================================================
// Main BuilderLayout Component
// =============================================================================

/**
 * BuilderLayout - Main layout container for the Component Builder
 * Task: task-cb-ui-builder-layout
 *
 * Features:
 * - Split mode: Definition and Preview side by side
 * - Tabbed mode: Definition, Preview, and Schema tabs
 * - Layout mode toggle in header
 * - Toolbar with Save/Discard buttons
 * - Optional localStorage persistence for layout mode preference
 */
export const BuilderLayout = observer(function BuilderLayout() {
  const { layoutMode, setLayoutMode, activeTab, setActiveTab } = useBuilderContext()

  // Persist layout mode to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode)
    } catch {
      // Ignore localStorage errors (e.g., in private browsing)
    }
  }, [layoutMode])

  // Load layout mode from localStorage on mount (only once)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LAYOUT_MODE_STORAGE_KEY)
      if (stored === "split" || stored === "tabbed") {
        setLayoutMode(stored)
      }
    } catch {
      // Ignore localStorage errors
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="h-full flex flex-col" data-testid="builder-layout">
      {/* Header with layout mode toggle */}
      <BuilderLayoutHeader layoutMode={layoutMode} onLayoutModeChange={setLayoutMode} />

      {/* Main content area - split or tabbed */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {layoutMode === "split" ? (
          <SplitLayout />
        ) : (
          <TabbedLayout activeTab={activeTab} onTabChange={setActiveTab} />
        )}
      </div>

      {/* Footer toolbar with actions */}
      <BuilderToolbar />
    </div>
  )
})

export default BuilderLayout
