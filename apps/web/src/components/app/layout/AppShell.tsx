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

import { useMemo, useState, useEffect, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { Outlet } from "react-router-dom"
import { AppHeader } from "./AppHeader"
import { BindingEditorPanel } from "./BindingEditorPanel"
import { ComponentRegistryProvider } from "@/components/rendering"
import { createRegistryFromDomain } from "@/components/rendering/registryFactory"
import { useDomains } from "@/contexts/DomainProvider"

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

  // State for BindingEditorPanel visibility
  const [isBindingEditorOpen, setIsBindingEditorOpen] = useState(false)

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

  // Create domain-driven registry
  // Depends on componentBuilder state for reactivity via observer wrapper
  // Falls back gracefully if componentBuilder is undefined (registryFactory handles this)
  const registry = useMemo(() => createRegistryFromDomain(componentBuilder), [componentBuilder])

  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="h-screen flex flex-col">
        <AppHeader />
        <main className="flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
      </div>

      {/* Debug Panel - BindingEditorPanel */}
      <BindingEditorPanel
        isOpen={isBindingEditorOpen}
        onClose={() => setIsBindingEditorOpen(false)}
      />
    </ComponentRegistryProvider>
  )
})
