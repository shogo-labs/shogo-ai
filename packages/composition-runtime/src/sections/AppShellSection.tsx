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
 * - navigationMode: 'static' | 'section-browser' | 'dynamic' | 'composition' - How nav clicks affect content
 *   - 'static': No navigation, shows content config or placeholder (default)
 *   - 'section-browser': Shows ComponentDefinition details when nav items are clicked
 *   - 'dynamic': Renders the actual section component when nav items are clicked
 *   - 'composition': Renders nested compositions per nav item (most flexible)
 * - sectionRegistry: Record<string, { section: string, config?: object }> - Maps nav item IDs to sections
 * - contentComposition: CompositionConfig - Default nested composition for main content area
 * - contentByItem: Record<string, CompositionConfig> - Per-nav-item compositions (for 'composition' mode)
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "../utils/cn"
import type { SectionRendererProps } from "../types"
import { AppBarSection } from "./AppBarSection"
import { SideNavSection } from "./SideNavSection"
import { DynamicSectionRenderer } from "./sectionImplementations"
import { Layout, Search } from "lucide-react"
import { AppShellProvider, type NavItem, type AppShellContextValue } from "./contexts/AppShellContext"
import { useSideNavData } from "./hooks"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui"
import { Input } from "../ui"

// ============================================================================
// Types
// ============================================================================

type NavigationMode = 'static' | 'section-browser' | 'dynamic' | 'composition'

interface ContentConfig {
  section: string
  config?: Record<string, unknown>
}

/**
 * Panel configuration for nested compositions.
 * Each panel renders a section in a specific slot.
 */
interface PanelConfig {
  /** Slot name (e.g., 'main', 'left', 'right', 'sidebar') */
  slot: string
  /** Section name to render */
  section: string
  /** Optional config passed to the section */
  config?: Record<string, unknown>
}

/**
 * Composition configuration for nested layouts.
 * Allows rendering multiple sections in a layout within the main content area.
 */
interface CompositionConfig {
  /** Layout mode for arranging panels */
  layout?: 'single' | 'split-h' | 'split-v'
  /** Array of panels to render */
  panels: PanelConfig[]
}

/**
 * DataSource configuration for loading nav items from Wavesmith stores.
 * Same structure as SideNavSection's dataSource.
 */
interface DataSourceConfig {
  /** Schema name (e.g., "component-builder") */
  schema: string
  /** Model name (e.g., "ComponentDefinition") */
  model: string
  /** Field to use as nav item ID (default: "id") */
  idField?: string
  /** Field to use as nav item label (default: "name") */
  labelField?: string
  /** Field to use as nav item icon (optional) */
  iconField?: string
  /** Field to group items by (creates NavGroups) */
  groupBy?: string
  /** MongoDB-style filter */
  filter?: Record<string, any>
  /** Sort configuration */
  orderBy?: { field: string; direction: "asc" | "desc" }[]
}

interface SideNavConfig {
  /** Static navigation items (passed to SideNavSection) */
  items?: unknown[]
  /** Dynamic data source for loading items from Wavesmith store */
  dataSource?: DataSourceConfig
  /** Header configuration */
  header?: { title?: string; logo?: { src: string; alt?: string } }
  /** Icon-only rail mode */
  collapsed?: boolean
  /** ID of currently active nav item */
  activeItem?: string
  /** Any other SideNavSection config */
  [key: string]: unknown
}

interface AppShellConfig {
  /** AppBar configuration (see AppBarSection for options) */
  appBar?: Record<string, unknown>
  /** SideNav configuration (see SideNavSection for options) */
  sideNav?: SideNavConfig
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
  /** Default nested composition for main content area (for 'composition' mode) */
  contentComposition?: CompositionConfig
  /** Per-nav-item compositions - maps item IDs to composition configs (for 'composition' mode) */
  contentByItem?: Record<string, CompositionConfig>
}

// ============================================================================
// Nested Composition - Renders a composition config within AppShell main content
// ============================================================================

interface NestedCompositionProps {
  composition: CompositionConfig
  feature: any
}

/**
 * NestedComposition renders a CompositionConfig as a layout with panels.
 * This enables arbitrarily complex nested layouts within the AppShell main content area.
 *
 * Supports three layout modes:
 * - 'single': Full-width single panel (default)
 * - 'split-h': Two panels side by side (horizontal split)
 * - 'split-v': Two panels stacked (vertical split)
 */
function NestedComposition({ composition, feature }: NestedCompositionProps) {
  const { layout = 'single', panels } = composition

  if (!panels || panels.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 min-h-[300px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <Layout className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Empty Composition</h3>
          <p className="text-muted-foreground text-sm">
            No panels configured for this composition.
          </p>
        </div>
      </div>
    )
  }

  // Layout container classes based on layout mode
  const layoutClasses: Record<string, string> = {
    'single': 'flex flex-col h-full',
    'split-h': 'grid grid-cols-2 gap-4 h-full',
    'split-v': 'grid grid-rows-2 gap-4 h-full',
  }

  return (
    <div className={cn('p-4', layoutClasses[layout] || layoutClasses.single)}>
      {panels.map((panel, index) => (
        <div key={`${panel.slot}-${panel.section}-${index}`} className="min-h-0 overflow-auto">
          <DynamicSectionRenderer
            sectionName={panel.section}
            feature={feature}
            config={panel.config}
          />
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// Search Dialog Component
// ============================================================================

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: NavItem[]
  onSelect: (itemId: string) => void
}

function SearchDialog({ open, onOpenChange, items, onSelect }: SearchDialogProps) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when dialog opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Reset query when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
    }
  }, [open])

  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!query.trim()) return items.slice(0, 10) // Show first 10 when no query

    const lowerQuery = query.toLowerCase()
    return items.filter((item) => {
      const label = item.label?.toLowerCase() ?? ""
      const id = item.id?.toLowerCase() ?? ""
      const description = (item.data?.description as string)?.toLowerCase() ?? ""
      const tags = (item.data?.tags as string[])?.join(" ").toLowerCase() ?? ""

      return (
        label.includes(lowerQuery) ||
        id.includes(lowerQuery) ||
        description.includes(lowerQuery) ||
        tags.includes(lowerQuery)
      )
    })
  }, [items, query])

  const handleSelect = (itemId: string) => {
    onSelect(itemId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Search Components</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search by name, description, or tags..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {filteredItems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No components found matching "{query}"
              </div>
            ) : (
              filteredItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item.id)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors"
                >
                  <div className="font-medium text-sm">{item.label}</div>
                  {typeof item.data?.description === "string" && item.data.description && (
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {item.data.description}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
          {filteredItems.length > 0 && (
            <div className="text-xs text-muted-foreground text-center">
              {query.trim() ? `${filteredItems.length} result(s)` : `Showing first 10 of ${items.length}`}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// Main Content Renderer - Handles different navigation modes
// ============================================================================

interface MainContentProps {
  navigationMode: NavigationMode
  activeItem: string | null
  content?: ContentConfig
  sectionRegistry?: Record<string, ContentConfig>
  exampleConfigs?: Record<string, Record<string, unknown>>
  contentComposition?: CompositionConfig
  contentByItem?: Record<string, CompositionConfig>
  feature: any
}

function MainContent({
  navigationMode,
  activeItem,
  content,
  sectionRegistry,
  exampleConfigs,
  contentComposition,
  contentByItem,
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

  // No active item selected - show welcome (for interactive modes)
  if (!activeItem && navigationMode !== 'composition') {
    return (
      <div className="flex items-center justify-center p-8 min-h-[300px]">
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

  // Section browser mode: use SectionBrowserSection via context
  // The SectionBrowserSection reads activeItem from AppShellContext
  if (navigationMode === 'section-browser') {
    return (
      <DynamicSectionRenderer
        sectionName="SectionBrowserSection"
        feature={feature}
        config={{
          useActiveItem: true,
          exampleConfigs: exampleConfigs,
        }}
      />
    )
  }

  // Dynamic mode: render the actual section from registry
  if (navigationMode === 'dynamic') {
    const sectionConfig = sectionRegistry?.[activeItem!]
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
        sectionName={activeItem!}
        feature={feature}
        config={{}}
      />
    )
  }

  // Composition mode: render nested compositions per nav item
  if (navigationMode === 'composition') {
    // Resolution order:
    // 1. If activeItem exists, check contentByItem for item-specific composition
    // 2. Fall back to contentComposition (default composition)
    // 3. Show placeholder if neither exists
    const resolvedComposition = activeItem && contentByItem?.[activeItem]
      ? contentByItem[activeItem]
      : contentComposition

    if (resolvedComposition) {
      return (
        <NestedComposition
          composition={resolvedComposition}
          feature={feature}
        />
      )
    }

    // No composition configured - show placeholder
    return (
      <div className="flex items-center justify-center p-8 min-h-[300px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <Layout className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">
            {activeItem ? `No Composition for "${activeItem}"` : "Select an Item"}
          </h3>
          <p className="text-muted-foreground text-sm">
            {activeItem
              ? "Configure contentByItem or contentComposition to render content here."
              : "Click an item in the sidebar to view its content."}
          </p>
        </div>
      </div>
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
  const contentComposition = shellConfig?.contentComposition
  const contentByItem = shellConfig?.contentByItem

  // Extract dataSource from sideNav config (if present)
  const dataSource = sideNavConfig?.dataSource

  // Load dynamic nav items if dataSource is configured
  // This is used to populate navItems in the context for nested sections
  const { flatItems: dynamicNavItems } = useSideNavData(dataSource)

  // Internal state for sidebar collapsed - defaults to config value or false
  const [sideNavCollapsed, setSideNavCollapsed] = useState(
    sideNavConfig?.collapsed ?? false
  )

  // Internal state for active navigation item (for non-static modes)
  const [activeItem, setActiveItem] = useState<string | null>(
    defaultActiveItem ?? sideNavConfig?.activeItem as string ?? null
  )

  // Internal state for active tab filter (from AppBar navLinks)
  // The first navLink with active:true is the initial filter, or null for "all"
  const navLinksArray = Array.isArray(appBarConfig?.navLinks) ? appBarConfig.navLinks : []
  const initialActiveTab = navLinksArray.find((link: { active?: boolean }) => link.active)?.id as string | null ?? null
  const [activeTabFilter, setActiveTabFilter] = useState<string | null>(initialActiveTab)

  // Internal state for search dialog
  const [searchDialogOpen, setSearchDialogOpen] = useState(false)

  // Handle AppBar action button clicks
  const handleAction = useCallback((actionId: string) => {
    if (actionId === 'search') {
      setSearchDialogOpen(true)
    }
    // Future: handle other actions like 'settings'
  }, [])

  // Handle search result selection
  const handleSearchSelect = useCallback((itemId: string) => {
    if (navigationMode !== 'static') {
      setActiveItem(itemId)
    }
  }, [navigationMode])

  // Handle AppBar navLink clicks - updates the tab filter
  const handleNavLinkClick = useCallback((linkId: string) => {
    setActiveTabFilter(linkId)
    // Clear active item when switching tabs to avoid showing stale content
    setActiveItem(null)
  }, [])

  // Toggle callback for sidebar
  const handleSidebarToggle = useCallback(() => {
    setSideNavCollapsed((prev) => !prev)
  }, [])

  // Navigation callback - updates active item for non-static modes
  const handleNavigate = useCallback((itemId: string, href?: string, data?: Record<string, unknown>) => {
    if (navigationMode !== 'static') {
      setActiveItem(itemId)
    }
    // Also call any configured onNavigate callback
    const configuredOnNavigate = sideNavConfig?.onNavigate as
      | ((itemId: string, href?: string, data?: Record<string, unknown>) => void)
      | undefined
    if (typeof configuredOnNavigate === 'function') {
      configuredOnNavigate(itemId, href, data)
    }
  }, [navigationMode, sideNavConfig])

  // Build context value for AppShellProvider
  const contextValue = useMemo<AppShellContextValue>(() => ({
    activeItem,
    setActiveItem: (itemId: string | null) => {
      if (navigationMode !== 'static') {
        setActiveItem(itemId)
      }
    },
    sidebarCollapsed: sideNavCollapsed,
    toggleSidebar: handleSidebarToggle,
    navItems: dynamicNavItems,
    getActiveItemData: () => {
      if (!activeItem) return undefined
      const item = dynamicNavItems.find((i) => i.id === activeItem)
      return item?.data
    },
  }), [activeItem, navigationMode, sideNavCollapsed, handleSidebarToggle, dynamicNavItems])

  // Calculate grid layout based on what's shown
  const gridTemplateRows = showAppBar ? "auto 1fr" : "1fr"
  const gridTemplateColumns = showSideNav ? "auto 1fr" : "1fr"

  // Compute filtered dataSource based on active tab
  // Maps tab IDs to category filters (customize this mapping as needed)
  const tabToCategoryMap: Record<string, string> = {
    sections: "section",
    display: "display",
    visualization: "visualization",
  }

  const filteredDataSource = useMemo(() => {
    if (!dataSource || !activeTabFilter) return dataSource

    const categoryFilter = tabToCategoryMap[activeTabFilter]
    if (!categoryFilter) return dataSource

    // Merge the category filter with any existing filter
    return {
      ...dataSource,
      filter: {
        ...(dataSource.filter || {}),
        category: categoryFilter,
      },
    }
  }, [dataSource, activeTabFilter])

  return (
    <AppShellProvider value={contextValue}>
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
                // Update navLinks to reflect active tab state
                navLinks: navLinksArray.map((link: { id: string; active?: boolean }) => ({
                  ...link,
                  active: link.id === activeTabFilter,
                })),
                // Enable sidebar toggle when sideNav is shown
                showSidebarToggle: showSideNav,
                sidebarCollapsed: sideNavCollapsed,
                onSidebarToggle: handleSidebarToggle,
                // Handle tab clicks for filtering
                onNavigate: handleNavLinkClick,
                // Handle action button clicks (e.g., search)
                onAction: handleAction,
              }}
            />
          </div>
        )}

        {/* SideNav - sits below AppBar on the left */}
        {showSideNav && (
          <div
            className="overflow-hidden"
            style={{
              gridColumn: "1",
              gridRow: showAppBar ? "2" : "1",
            }}
          >
            <SideNavSection
              feature={feature}
              config={{
                ...sideNavConfig,
                // Override dataSource with filtered version if tab filtering is active
                dataSource: filteredDataSource,
                // Use managed collapsed state, override any config value
                collapsed: sideNavCollapsed,
                // Pass active item for highlighting
                activeItem: activeItem ?? undefined,
                // Wire up navigation callback for interactive modes
                onNavigate: handleNavigate,
                // Hide the header when inside AppShell (AppBar handles branding)
                header: sideNavConfig?.header,
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
            contentComposition={contentComposition}
            contentByItem={contentByItem}
            feature={feature}
          />
        </main>
      </div>

      {/* Search Dialog - opens when search action is clicked */}
      <SearchDialog
        open={searchDialogOpen}
        onOpenChange={setSearchDialogOpen}
        items={dynamicNavItems}
        onSelect={handleSearchSelect}
      />
    </AppShellProvider>
  )
})
