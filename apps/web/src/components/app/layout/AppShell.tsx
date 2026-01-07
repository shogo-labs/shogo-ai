/**
 * AppShell - Main application layout component
 * Task: task-2-1-011, task-registry-provider
 *
 * Renders the main application layout with:
 * - AppHeader at top (fixed height ~56px)
 * - Main content area (flex-1, overflow-auto) with React Router Outlet
 * - ComponentRegistryProvider for schema-driven rendering
 *
 * Implementation details (per ip-2-1-app-shell):
 * - Uses h-screen with flex flex-col layout
 * - AppHeader at top (fixed height)
 * - Main content area fills remaining space
 * - Renders React Router Outlet for nested routes
 * - Uses bg-background for main content area
 * - Structure supports future sidebar addition (Session 2.2)
 *
 * Layout Architecture:
 * Session 2.1: Header + Content (this implementation)
 * Session 2.2: Header + (Sidebar + Content) - sidebar added inside main area
 */

import { useMemo } from "react"
import { Outlet } from "react-router-dom"
import { AppHeader } from "./AppHeader"
import { ComponentRegistryProvider } from "@/components/rendering"
import { createStudioRegistry } from "@/components/rendering/studioRegistry"

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
 * with domain-specific badge renderers for platform-features.
 */
export function AppShell() {
  // Create studio registry once (stable across renders)
  const registry = useMemo(() => createStudioRegistry(), [])

  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="h-screen flex flex-col">
        <AppHeader />
        <main className="flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
      </div>
    </ComponentRegistryProvider>
  )
}
