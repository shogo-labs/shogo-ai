/**
 * SideNavSection Component
 * Task: view-builder-implementation
 * Spec: spec-sidenav-section
 *
 * Reusable side navigation panel with support for flat links, grouped/collapsible
 * sections, and icon-only collapsed mode. Standalone section for composing into app layouts.
 *
 * Config options:
 * - items: Array<NavItem | NavGroup> - Static navigation items and groups
 * - dataSource: { schema, model, idField, labelField, groupBy, filter, orderBy } - Dynamic nav items from Wavesmith store
 * - collapsed: boolean - Icon-only rail mode (default: false)
 * - activeItem: string - ID of currently active nav item
 * - header: { title?: string, logo?: { src: string, alt: string } } - Optional header
 * - showCollapseToggle: boolean - Show collapse/expand button (default: true)
 * - onNavigate: (itemId: string, href?: string, data?: object) => void - Navigation callback
 * - onCollapsedChange: (collapsed: boolean) => void - Collapse state callback
 * - width: { expanded?: number, collapsed?: number } - Width overrides
 * - theme: { background?: string, text?: string, accent?: string } - Theme overrides
 *
 * Dynamic Data (dataSource):
 * When dataSource is provided, items are loaded from the specified Wavesmith schema/model.
 * The dataSource config supports:
 * - schema: Schema name (e.g., "component-builder")
 * - model: Model name (e.g., "ComponentDefinition")
 * - idField: Field to use as item ID (default: "id")
 * - labelField: Field to use as item label (default: "name")
 * - iconField: Field to use as item icon (optional)
 * - groupBy: Field to group items by (creates collapsible sections)
 * - filter: MongoDB-style filter for querying
 * - orderBy: Sort configuration array
 */

import { useState, useCallback, useMemo, type ReactNode } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../sectionImplementations"
import { useSideNavData } from "./hooks"
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Home,
  Settings,
  User,
  Folder,
  File,
  Star,
  Bell,
  Search,
  Layout,
  Database,
  Code,
  type LucideIcon,
} from "lucide-react"

// ============================================================================
// Types
// ============================================================================

interface NavItem {
  type?: "item"
  id: string
  label: string
  href?: string
  icon?: string
  badge?: string | number
  disabled?: boolean
}

interface NavGroup {
  type: "group"
  id: string
  label: string
  icon?: string
  items: NavItem[]
  defaultExpanded?: boolean
}

type NavEntry = NavItem | NavGroup

interface HeaderConfig {
  title?: string
  logo?: {
    src: string
    alt?: string
  }
}

interface ThemeConfig {
  background?: string
  text?: string
  accent?: string
  hoverBg?: string
  activeBg?: string
}

interface WidthConfig {
  expanded?: number
  collapsed?: number
}

/**
 * DataSource configuration for loading nav items from Wavesmith stores.
 * When provided, items are dynamically loaded instead of using static `items` array.
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
  /** Static navigation items and groups */
  items?: NavEntry[]
  /** Dynamic data source for loading items from Wavesmith store */
  dataSource?: DataSourceConfig
  /** Icon-only rail mode */
  collapsed?: boolean
  /** ID of currently active nav item */
  activeItem?: string
  /** Optional header content */
  header?: HeaderConfig
  /** Show collapse/expand button */
  showCollapseToggle?: boolean
  /** Navigation callback - receives entity data when using dataSource */
  onNavigate?: (itemId: string, href?: string, data?: Record<string, unknown>) => void
  /** Collapse state callback */
  onCollapsedChange?: (collapsed: boolean) => void
  /** Width overrides */
  width?: WidthConfig
  /** Theme overrides */
  theme?: ThemeConfig
}

// Icon mapping for string-based icon names
const iconMap: Record<string, LucideIcon> = {
  home: Home,
  settings: Settings,
  user: User,
  folder: Folder,
  file: File,
  star: Star,
  bell: Bell,
  search: Search,
  layout: Layout,
  database: Database,
  code: Code,
}

function getIcon(iconName: string): LucideIcon {
  return iconMap[iconName.toLowerCase()] ?? File
}

// ============================================================================
// Sub-components
// ============================================================================

function NavHeader({
  config,
  collapsed,
}: {
  config?: HeaderConfig
  collapsed: boolean
}) {
  if (!config) return null

  return (
    <div className="px-3 py-4 border-b">
      <div className="flex items-center gap-3">
        {config.logo?.src ? (
          <img
            src={config.logo.src}
            alt={config.logo.alt ?? "Logo"}
            className="h-8 w-8 object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
            <span className="text-sm font-bold text-primary">
              {config.title?.charAt(0) ?? "N"}
            </span>
          </div>
        )}
        {!collapsed && config.title && (
          <span className="font-semibold text-foreground truncate">
            {config.title}
          </span>
        )}
      </div>
    </div>
  )
}

function NavItemButton({
  item,
  collapsed,
  isActive,
  onClick,
  theme,
}: {
  item: NavItem
  collapsed: boolean
  isActive: boolean
  onClick: () => void
  theme?: ThemeConfig
}) {
  const Icon = item.icon ? getIcon(item.icon) : null

  return (
    <button
      onClick={onClick}
      disabled={item.disabled}
      title={collapsed ? item.label : undefined}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left",
        collapsed && "justify-center px-2",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
        item.disabled && "opacity-50 cursor-not-allowed"
      )}
      style={
        isActive && theme?.activeBg
          ? { backgroundColor: theme.activeBg }
          : undefined
      }
    >
      {Icon && <Icon className="h-5 w-5 flex-shrink-0" />}
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge && (
            <span className="ml-auto bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full">
              {item.badge}
            </span>
          )}
        </>
      )}
    </button>
  )
}

function NavGroupSection({
  group,
  collapsed,
  activeItem,
  onNavigate,
  theme,
}: {
  group: NavGroup
  collapsed: boolean
  activeItem?: string
  onNavigate?: (itemId: string, href?: string) => void
  theme?: ThemeConfig
}) {
  const [expanded, setExpanded] = useState(group.defaultExpanded ?? true)
  const Icon = group.icon ? getIcon(group.icon) : Folder

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  // In collapsed mode, show just the group icon as a button
  if (collapsed) {
    return (
      <div className="py-1">
        <button
          title={group.label}
          className="w-full flex items-center justify-center px-2 py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Icon className="h-5 w-5" />
        </button>
      </div>
    )
  }

  return (
    <div className="py-1">
      {/* Group header */}
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform",
            !expanded && "-rotate-90"
          )}
        />
      </button>

      {/* Group items */}
      {expanded && (
        <div className="ml-4 mt-1 space-y-0.5">
          {group.items.map((item) => (
            <NavItemButton
              key={item.id}
              item={item}
              collapsed={false}
              isActive={activeItem === item.id}
              onClick={() => onNavigate?.(item.id, item.href)}
              theme={theme}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-center px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {collapsed ? (
        <ChevronRight className="h-5 w-5" />
      ) : (
        <ChevronLeft className="h-5 w-5" />
      )}
    </button>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export const SideNavSection = observer(function SideNavSection({
  feature,
  config,
}: SectionRendererProps) {
  const sideNavConfig = config as SideNavConfig | undefined

  // Local collapsed state (can be controlled or uncontrolled)
  const [localCollapsed, setLocalCollapsed] = useState(
    sideNavConfig?.collapsed ?? false
  )

  // Use controlled value if provided, otherwise use local state
  const collapsed = sideNavConfig?.collapsed ?? localCollapsed

  // Extract config
  const staticItems = sideNavConfig?.items ?? []
  const dataSource = sideNavConfig?.dataSource
  const activeItem = sideNavConfig?.activeItem
  const header = sideNavConfig?.header
  const showCollapseToggle = sideNavConfig?.showCollapseToggle ?? true
  const onNavigate = sideNavConfig?.onNavigate
  const onCollapsedChange = sideNavConfig?.onCollapsedChange
  const width = sideNavConfig?.width
  const theme = sideNavConfig?.theme

  // Load dynamic items if dataSource is configured
  const { items: dynamicItems, flatItems, loading, error } = useSideNavData(dataSource)

  // Use dynamic items if dataSource is configured, otherwise use static items
  const items = useMemo(() => {
    if (dataSource) {
      return dynamicItems
    }
    return staticItems
  }, [dataSource, dynamicItems, staticItems])

  // Handle collapse toggle
  const handleCollapseToggle = useCallback(() => {
    const newCollapsed = !collapsed
    setLocalCollapsed(newCollapsed)
    onCollapsedChange?.(newCollapsed)
  }, [collapsed, onCollapsedChange])

  // Handle item click - pass entity data when using dataSource
  const handleItemClick = useCallback(
    (itemId: string, href?: string) => {
      // Find item data if using dataSource
      let itemData: Record<string, unknown> | undefined
      if (dataSource && flatItems) {
        const item = flatItems.find((i) => i.id === itemId)
        itemData = item?.data
      }
      onNavigate?.(itemId, href, itemData)
    },
    [dataSource, flatItems, onNavigate]
  )

  // Calculate widths
  const expandedWidth = width?.expanded ?? 256 // 16rem = 256px
  const collapsedWidth = width?.collapsed ?? 64 // 4rem = 64px
  const currentWidth = collapsed ? collapsedWidth : expandedWidth

  // Build style overrides from theme
  const themeStyles: React.CSSProperties = {
    width: currentWidth,
    minWidth: currentWidth,
  }
  if (theme?.background) themeStyles.backgroundColor = theme.background
  if (theme?.text) themeStyles.color = theme.text

  // Helper to check if entry is a group
  const isGroup = (entry: NavEntry): entry is NavGroup => entry.type === "group"

  return (
    <aside
      data-testid="sidenav-section"
      className={cn(
        "h-full flex flex-col bg-background border-r transition-all duration-200",
        collapsed && "items-center"
      )}
      style={themeStyles}
    >
      {/* Header */}
      <NavHeader config={header} collapsed={collapsed} />

      {/* Navigation items */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-4">
            <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        {/* Items */}
        {!loading && !error && (
          <div className="space-y-1">
            {items.map((entry) => {
              if (isGroup(entry)) {
                return (
                  <NavGroupSection
                    key={entry.id}
                    group={entry}
                    collapsed={collapsed}
                    activeItem={activeItem}
                    onNavigate={handleItemClick}
                    theme={theme}
                  />
                )
              }

              // Regular item
              const item = entry as NavItem
              return (
                <NavItemButton
                  key={item.id}
                  item={item}
                  collapsed={collapsed}
                  isActive={activeItem === item.id}
                  onClick={() => handleItemClick(item.id, item.href)}
                  theme={theme}
                />
              )
            })}
          </div>
        )}
      </nav>

      {/* Collapse toggle */}
      {showCollapseToggle && (
        <div className="border-t py-2">
          <CollapseToggle collapsed={collapsed} onToggle={handleCollapseToggle} />
        </div>
      )}
    </aside>
  )
})
