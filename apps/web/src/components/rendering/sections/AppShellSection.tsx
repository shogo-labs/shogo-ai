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
 * - content: { section: string, config?: object } - What to render in main area (static mode)
 * - showAppBar: boolean - Whether to show the header (default: true)
 * - showSideNav: boolean - Whether to show the sidebar (default: true)
 * - navigationMode: 'static' | 'section-browser' | 'dynamic' - How nav clicks affect content
 *   - 'static': No navigation, shows content config or placeholder (default)
 *   - 'section-browser': Shows ComponentDefinition details when nav items are clicked
 *   - 'dynamic': Renders the actual section component when nav items are clicked
 * - sectionRegistry: Record<string, { section: string, config?: object }> - Maps nav item IDs to sections
 */

import { useState, useCallback, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../types"
import { AppBarSection } from "./AppBarSection"
import { SideNavSection } from "./SideNavSection"
import { DynamicSectionRenderer } from "../sectionImplementations"
import { useDomains } from "@/contexts/DomainProvider"
import { Code, Layout, Tag, FileText, Sparkles } from "lucide-react"

// ============================================================================
// Types
// ============================================================================

type NavigationMode = 'static' | 'section-browser' | 'dynamic'

interface ContentConfig {
  section: string
  config?: Record<string, unknown>
}

interface AppShellConfig {
  /** AppBar configuration (see AppBarSection for options) */
  appBar?: Record<string, unknown>
  /** SideNav configuration (see SideNavSection for options) */
  sideNav?: Record<string, unknown>
  /** Static content to render in main area (when navigationMode is 'static') */
  content?: ContentConfig
  /** Whether to show the AppBar (default: true) */
  showAppBar?: boolean
  /** Whether to show the SideNav (default: true) */
  showSideNav?: boolean
  /** How navigation affects main content (default: 'static') */
  navigationMode?: NavigationMode
  /** Maps nav item IDs to section configs (for 'dynamic' mode) */
  sectionRegistry?: Record<string, ContentConfig>
  /** Default active item when using navigation modes */
  defaultActiveItem?: string
  /** Example configs for live preview in section-browser mode (keyed by section name) */
  exampleConfigs?: Record<string, Record<string, unknown>>
}

// ============================================================================
// Section Browser View - Shows ComponentDefinition details
// ============================================================================

interface SectionBrowserViewProps {
  sectionName: string
  feature: any
  exampleConfig?: Record<string, unknown>
}

const SectionBrowserView = observer(function SectionBrowserView({
  sectionName,
  feature,
  exampleConfig,
}: SectionBrowserViewProps) {
  const domains = useDomains()
  const componentBuilder = domains?.componentBuilder

  // Try to find the ComponentDefinition by name
  const componentDef = componentBuilder?.componentDefinitionCollection?.findByName?.(sectionName)

  if (!componentDef) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Section Not Found</h3>
          <p className="text-muted-foreground text-sm">
            No ComponentDefinition found for "{sectionName}".
            This section may not be registered in the component-builder schema.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Layout className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{componentDef.name}</h1>
            <p className="text-muted-foreground mt-1">{componentDef.description || 'No description available'}</p>
          </div>
        </div>

        {/* Metadata badges */}
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            <Tag className="w-3 h-3" />
            {componentDef.category}
          </span>
          {componentDef.tags?.map((tag: string) => (
            <span
              key={tag}
              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Implementation Reference */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Code className="w-4 h-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">Implementation Reference</h3>
          </div>
          <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
            {componentDef.implementationRef}
          </code>
        </div>

        {/* Supported Config */}
        {componentDef.supportedConfig && componentDef.supportedConfig.length > 0 && (
          <div className="rounded-lg border bg-card p-4">
            <h3 className="font-medium text-sm mb-3">Supported Config Options</h3>
            <div className="flex flex-wrap gap-2">
              {componentDef.supportedConfig.map((configKey: string) => (
                <code
                  key={configKey}
                  className="text-xs bg-muted px-2 py-1 rounded font-mono"
                >
                  {configKey}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* AI Guidance */}
        {componentDef.aiGuidance && (
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-primary" />
              <h3 className="font-medium text-sm">AI Configuration Guide</h3>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-auto whitespace-pre-wrap">
                {componentDef.aiGuidance}
              </pre>
            </div>
          </div>
        )}

        {/* Live Preview */}
        {exampleConfig !== undefined && (
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
              <Layout className="w-4 h-4 text-primary" />
              <h3 className="font-medium text-sm">Live Preview</h3>
              <span className="text-xs text-muted-foreground ml-auto">
                with example config
              </span>
            </div>
            <div className="h-[400px] overflow-auto bg-background">
              <DynamicSectionRenderer
                sectionName={sectionName}
                feature={feature}
                config={exampleConfig}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

// ============================================================================
// Main Content Renderer - Handles different navigation modes
// ============================================================================

interface MainContentProps {
  navigationMode: NavigationMode
  activeItem: string | null
  content?: ContentConfig
  sectionRegistry?: Record<string, ContentConfig>
  exampleConfigs?: Record<string, Record<string, unknown>>
  feature: any
}

function MainContent({
  navigationMode,
  activeItem,
  content,
  sectionRegistry,
  exampleConfigs,
  feature,
}: MainContentProps) {
  // Static mode: render configured content or placeholder
  if (navigationMode === 'static') {
    if (content?.section) {
      return (
        <DynamicSectionRenderer
          sectionName={content.section}
          feature={feature}
          config={content.config}
        />
      )
    }
    return (
      <div className="text-center text-muted-foreground p-8">
        <p className="text-lg font-medium mb-2">Main Content Area</p>
        <p className="text-sm">
          This is where your app content will appear.
        </p>
      </div>
    )
  }

  // No active item selected - show welcome
  if (!activeItem) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Layout className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Select a Section</h3>
          <p className="text-muted-foreground text-sm">
            Click an item in the sidebar to view its details.
          </p>
        </div>
      </div>
    )
  }

  // Section browser mode: show ComponentDefinition details
  if (navigationMode === 'section-browser') {
    const exampleConfig = exampleConfigs?.[activeItem]
    return (
      <SectionBrowserView
        sectionName={activeItem}
        feature={feature}
        exampleConfig={exampleConfig}
      />
    )
  }

  // Dynamic mode: render the actual section from registry
  if (navigationMode === 'dynamic') {
    const sectionConfig = sectionRegistry?.[activeItem]
    if (sectionConfig?.section) {
      return (
        <DynamicSectionRenderer
          sectionName={sectionConfig.section}
          feature={feature}
          config={sectionConfig.config}
        />
      )
    }
    // Fallback: try to render the activeItem as a section name directly
    return (
      <DynamicSectionRenderer
        sectionName={activeItem}
        feature={feature}
        config={{}}
      />
    )
  }

  return null
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
  const navigationMode = shellConfig?.navigationMode ?? 'static'
  const sectionRegistry = shellConfig?.sectionRegistry
  const exampleConfigs = shellConfig?.exampleConfigs
  const content = shellConfig?.content
  const defaultActiveItem = shellConfig?.defaultActiveItem

  // Internal state for sidebar collapsed - defaults to config value or false
  const [sideNavCollapsed, setSideNavCollapsed] = useState(
    (sideNavConfig as any)?.collapsed ?? false
  )

  // Internal state for active navigation item (for non-static modes)
  const [activeItem, setActiveItem] = useState<string | null>(
    defaultActiveItem ?? (sideNavConfig as any)?.activeItem ?? null
  )

  // Toggle callback for sidebar
  const handleSidebarToggle = useCallback(() => {
    setSideNavCollapsed((prev) => !prev)
  }, [])

  // Navigation callback - updates active item for non-static modes
  const handleNavigate = useCallback((itemId: string, href?: string) => {
    if (navigationMode !== 'static') {
      setActiveItem(itemId)
    }
    // Also call any configured onNavigate callback
    const configuredOnNavigate = (sideNavConfig as any)?.onNavigate
    if (typeof configuredOnNavigate === 'function') {
      configuredOnNavigate(itemId, href)
    }
  }, [navigationMode, sideNavConfig])

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
              // Pass active item for highlighting
              activeItem: activeItem ?? undefined,
              // Wire up navigation callback for interactive modes
              onNavigate: handleNavigate,
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
        className="overflow-auto bg-background"
        style={{
          gridColumn: showSideNav ? "2" : "1",
          gridRow: showAppBar ? "2" : "1",
        }}
      >
        <MainContent
          navigationMode={navigationMode}
          activeItem={activeItem}
          content={content}
          sectionRegistry={sectionRegistry}
          exampleConfigs={exampleConfigs}
          feature={feature}
        />
      </main>
    </div>
  )
})
