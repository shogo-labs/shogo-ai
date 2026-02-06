/**
 * AppShell - Main application layout component
 * Task: task-2-1-011, task-registry-provider, task-sdr-v2-004, task-sdr-v2-006
 *
 * Renders the main application layout with:
 * - AppHeader at top (fixed height ~56px)
 * - Main content area (flex-1, overflow-auto) with React Router Outlet
 * - ComponentRegistryProvider for schema-driven rendering
 * - BindingEditorPanel debug panel (toggle with Cmd+Shift+B / Ctrl+Shift+B)
 *
 * Implementation details (per ip-2-1-app-shell, ip-sdr-v2-003, ip-sdr-v2-005):
 * - Uses h-screen with flex flex-col layout
 * - AppHeader at top (fixed height)
 * - Main content area fills remaining space
 * - Renders React Router Outlet for nested routes
 * - Uses bg-background for main content area
 * - Structure supports future sidebar addition (Session 2.2)
 * - Domain-driven registry from componentBuilder domain via useDomains()
 * - BindingEditorPanel accessible via keyboard shortcut
 *
 * Layout Architecture:
 * Session 2.1: Header + Content (this implementation)
 * Session 2.2: Header + (Sidebar + Content) - sidebar added inside main area
 *
 * IMPORTANT: This component MUST be wrapped with observer() because it accesses
 * componentBuilder domain state. Without observer(), the component won't re-render
 * when domain bindings change (e.g., via BindingEditorPanel).
 */

import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react"
import { observer } from "mobx-react-lite"
import { Outlet, useSearchParams } from "react-router-dom"
import { AppHeader } from "./AppHeader"
import { AppSidebar } from "./AppSidebar"
import { BindingEditorPanel } from "./BindingEditorPanel"
import { useDomains, useSDKDomain } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { CommandPalette, useCommandPalette, SettingsModalProvider } from "../shared"
import { useWorkspaceNavigation } from "../workspace/hooks"
import { useToast } from "@/hooks/use-toast"

// Context to share command palette state with sidebar
interface CommandPaletteContextValue {
  openCommandPalette: () => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

export function useCommandPaletteContext() {
  const context = useContext(CommandPaletteContext)
  if (!context) {
    throw new Error("useCommandPaletteContext must be used within AppShell")
  }
  return context
}

// Context to control sidebar collapse from child components (e.g., homepage transition)
interface SidebarCollapseContextValue {
  /** Force sidebar to collapse (for animation coordination) */
  collapseSidebar: () => void
  /** Release forced collapse state (sidebar returns to user preference) */
  releaseSidebar: () => void
  /** Whether sidebar is currently force-collapsed */
  isForceCollapsed: boolean
}

const SidebarCollapseContext = createContext<SidebarCollapseContextValue | null>(null)

export function useSidebarCollapseContext() {
  const context = useContext(SidebarCollapseContext)
  if (!context) {
    throw new Error("useSidebarCollapseContext must be used within AppShell")
  }
  return context
}

/**
 * AppShell component
 *
 * Main application layout container. Provides the shell structure for the
 * authenticated application experience. The flex-col layout with h-screen
 * ensures the app fills the viewport.
 *
 * The Outlet component renders nested route content, supporting React Router v7
 * nested routing patterns for future feature routes (/app/features/:id, etc.).
 *
 * Wraps content with ComponentRegistryProvider to enable schema-driven rendering
 * with domain-driven component registry from componentBuilder domain.
 *
 * Wrapped with observer() to react to MST observable changes in componentBuilder domain.
 * When bindings change (e.g., via BindingEditorPanel), the registry re-creates and
 * components using the registry re-render with updated property renderers.
 */
export const AppShell = observer(function AppShell() {
  // Access componentBuilder domain from DomainProvider
  const { componentBuilder } = useDomains()
  const store = useSDKDomain() as IDomainStore
  const { setWorkspaceSlug, projectId } = useWorkspaceNavigation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { toast } = useToast()
  
  // Determine if we're on the home view (no project selected)
  // On home view, we hide the header for a cleaner Lovable-style layout
  const isHomeView = !projectId

  // State for BindingEditorPanel visibility
  const [isBindingEditorOpen, setIsBindingEditorOpen] = useState(false)

  // Command palette state (global search)
  const { open: isCommandPaletteOpen, setOpen: setCommandPaletteOpen } = useCommandPalette()

  // Sidebar collapse state for homepage transition animation
  // When forceCollapsed is true, sidebar collapses regardless of user preference
  const [sidebarForceCollapsed, setSidebarForceCollapsed] = useState(false)

  const collapseSidebar = useCallback(() => {
    setSidebarForceCollapsed(true)
  }, [])

  const releaseSidebar = useCallback(() => {
    setSidebarForceCollapsed(false)
  }, [])

  // Handle checkout redirect params (workspace, checkout=success|canceled)
  useEffect(() => {
    const workspaceId = searchParams.get("workspace")
    const checkoutStatus = searchParams.get("checkout")

    if (workspaceId && checkoutStatus) {
      // Find workspace by ID and get its slug
      const workspace = store?.workspaceCollection?.all?.find(
        (w: any) => w.id === workspaceId
      )

      if (checkoutStatus === "success") {
        // Switch to the newly created workspace
        if (workspace) {
          setWorkspaceSlug(workspace.slug)
          toast({
            title: "Subscription activated",
            description: `Your workspace "${workspace.name}" is now on a paid plan.`,
          })
        } else {
          // Workspace not found in local state yet - store ID temporarily
          // The workspace should appear after a data refresh
          toast({
            title: "Subscription activated",
            description: "Your subscription is now active.",
          })
        }
      } else if (checkoutStatus === "canceled") {
        // User canceled checkout - optionally delete the workspace
        // For now, just notify them
        toast({
          title: "Checkout canceled",
          description: "No charges were made. The workspace was not upgraded.",
          variant: "destructive",
        })
      }

      // Clean up URL params
      searchParams.delete("workspace")
      searchParams.delete("checkout")
      searchParams.delete("session_id")
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams, store, setWorkspaceSlug, toast])
  
  // Context value for sharing with sidebar
  const commandPaletteContextValue = {
    openCommandPalette: () => setCommandPaletteOpen(true),
  }

  // Context value for sidebar collapse control (used by homepage transition)
  const sidebarCollapseContextValue = {
    collapseSidebar,
    releaseSidebar,
    isForceCollapsed: sidebarForceCollapsed,
  }

  // Toggle binding editor panel
  const toggleBindingEditor = useCallback(() => {
    setIsBindingEditorOpen((prev) => !prev)
  }, [])

  // Keyboard shortcut: Cmd+Shift+B (Mac) or Ctrl+Shift+B (Windows/Linux)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Cmd+Shift+B (Mac) or Ctrl+Shift+B (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault()
        toggleBindingEditor()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [toggleBindingEditor])

  return (
    <div>
      <SettingsModalProvider>
        <CommandPaletteContext.Provider value={commandPaletteContextValue}>
          <SidebarCollapseContext.Provider value={sidebarCollapseContextValue}>
            <div className="h-screen flex">
              {/* Persistent navigation sidebar */}
              <AppSidebar forceCollapsed={sidebarForceCollapsed || undefined} />

              {/* Main content area */}
              <div className="flex-1 flex flex-col min-w-0">
                {/* Header - hidden on home view for cleaner Lovable-style layout */}
                {!isHomeView && <AppHeader />}
                <main className="flex-1 overflow-auto bg-background">
                  <Outlet />
                </main>
              </div>
            </div>

            {/* Global search command palette */}
            <CommandPalette
              open={isCommandPaletteOpen}
              onOpenChange={setCommandPaletteOpen}
            />

            {/* Debug Panel - BindingEditorPanel */}
            <BindingEditorPanel
              isOpen={isBindingEditorOpen}
              onClose={() => setIsBindingEditorOpen(false)}
            />
          </SidebarCollapseContext.Provider>
        </CommandPaletteContext.Provider>
      </SettingsModalProvider>
    </div>
  )
})
