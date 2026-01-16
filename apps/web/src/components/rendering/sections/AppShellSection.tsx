/**
 * AppShellSection Component
 * Task: view-builder-implementation
 *
 * Composite section that combines AppBar + SideNav + Main content in a proper
 * app shell layout. This solves the layout limitation where split-h/split-v
 * can't produce the standard app pattern:
 *
 * ┌─────────────────────────────────────────┐
 * │              AppBar (header)            │
 * ├──────────┬──────────────────────────────┤
 * │          │                              │
 * │ SideNav  │         Main Content         │
 * │          │                              │
 * │          │                              │
 * └──────────┴──────────────────────────────┘
 *
 * Config options:
 * - appBar: AppBarSection config (logo, title, navLinks, actions, sticky, theme)
 * - sideNav: SideNavSection config (items, collapsed, activeItem, header, etc.)
 * - content: { section: string, config?: object } - What to render in main area
 * - showAppBar: boolean - Whether to show the header (default: true)
 * - showSideNav: boolean - Whether to show the sidebar (default: true)
 */

import { useState, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../types"
import { AppBarSection } from "./AppBarSection"
import { SideNavSection } from "./SideNavSection"

// ============================================================================
// Types
// ============================================================================

interface AppShellConfig {
  /** AppBar configuration (see AppBarSection for options) */
  appBar?: Record<string, unknown>
  /** SideNav configuration (see SideNavSection for options) */
  sideNav?: Record<string, unknown>
  /** Whether to show the AppBar (default: true) */
  showAppBar?: boolean
  /** Whether to show the SideNav (default: true) */
  showSideNav?: boolean
}

// ============================================================================
// Main Component
// ============================================================================

export const AppShellSection = observer(function AppShellSection({
  feature,
  config,
}: SectionRendererProps) {
  const shellConfig = config as AppShellConfig | undefined

  // Extract config with defaults
  const showAppBar = shellConfig?.showAppBar ?? true
  const showSideNav = shellConfig?.showSideNav ?? true
  const appBarConfig = shellConfig?.appBar ?? {}
  const sideNavConfig = shellConfig?.sideNav ?? {}

  // Internal state for sidebar collapsed - defaults to config value or false
  const [sideNavCollapsed, setSideNavCollapsed] = useState(
    (sideNavConfig as any)?.collapsed ?? false
  )

  // Toggle callback for sidebar
  const handleSidebarToggle = useCallback(() => {
    setSideNavCollapsed((prev) => !prev)
  }, [])

  // Calculate grid layout based on what's shown
  const gridTemplateRows = showAppBar ? "auto 1fr" : "1fr"
  const gridTemplateColumns = showSideNav ? "auto 1fr" : "1fr"

  return (
    <div
      data-testid="app-shell-section"
      className="h-full w-full"
      style={{
        display: "grid",
        gridTemplateRows,
        gridTemplateColumns,
      }}
    >
      {/* AppBar - spans full width when present */}
      {showAppBar && (
        <div
          style={{
            gridColumn: showSideNav ? "1 / -1" : "1",
            gridRow: "1",
          }}
        >
          <AppBarSection
            feature={feature}
            config={{
              ...appBarConfig,
              // Enable sidebar toggle when sideNav is shown
              showSidebarToggle: showSideNav,
              sidebarCollapsed: sideNavCollapsed,
              onSidebarToggle: handleSidebarToggle,
            }}
          />
        </div>
      )}

      {/* SideNav - sits below AppBar on the left */}
      {showSideNav && (
        <div
          style={{
            gridColumn: "1",
            gridRow: showAppBar ? "2" : "1",
          }}
        >
          <SideNavSection
            feature={feature}
            config={{
              ...sideNavConfig,
              // Use managed collapsed state, override any config value
              collapsed: sideNavCollapsed,
              // Hide the header (no "Navigation" title)
              header: undefined,
              // Hide the collapse toggle in SideNav since AppBar controls it
              showCollapseToggle: false,
            }}
          />
        </div>
      )}

      {/* Main Content - fills remaining space */}
      <main
        className="overflow-auto bg-background flex items-center justify-center"
        style={{
          gridColumn: showSideNav ? "2" : "1",
          gridRow: showAppBar ? "2" : "1",
        }}
      >
        <div className="text-center text-muted-foreground p-8">
          <p className="text-lg font-medium mb-2">Main Content Area</p>
          <p className="text-sm">
            This is where your app content will appear.
          </p>
        </div>
      </main>
    </div>
  )
})
