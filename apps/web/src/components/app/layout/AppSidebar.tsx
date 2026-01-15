/**
 * AppSidebar - Persistent navigation sidebar component
 * 
 * Renders the main navigation sidebar with:
 * - Logo and sidebar collapse toggle at top
 * - Workspace switcher
 * - Navigation sections (Home, Search)
 * - Projects section (Recent, All projects, Starred, Shared with me)
 * - Resources section (Discover, Templates, Learn)
 * - User avatar and inbox at bottom
 * 
 * Inspired by Lovable.dev's sidebar design for better navigation UX.
 */

import { useState, useCallback, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { Link, useLocation } from "react-router-dom"
import {
  Home,
  Search,
  Clock,
  LayoutGrid,
  Star,
  Users,
  Compass,
  FileCode2,
  BookOpen,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  ExternalLink,
  Plus,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { WorkspaceSwitcher } from "../workspace"
import { useWorkspaceNavigation, useWorkspaceData } from "../workspace"
import { useCommandPaletteContext } from "./AppShell"

interface NavItemProps {
  icon: React.ElementType
  label: string
  to?: string
  href?: string
  active?: boolean
  collapsed?: boolean
  onClick?: () => void
  external?: boolean
  shortcut?: string
}

function NavItem({ icon: Icon, label, to, href, active, collapsed, onClick, external, shortcut }: NavItemProps) {
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && shortcut && (
        <kbd className="ml-auto h-5 px-1.5 inline-flex items-center rounded border border-border bg-muted font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
      {!collapsed && external && <ExternalLink className="h-3 w-3 ml-auto opacity-50" />}
    </>
  )

  const className = cn(
    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors w-full",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
    collapsed && "justify-center px-2"
  )

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={collapsed ? label : undefined}
      >
        {content}
      </a>
    )
  }

  if (to) {
    return (
      <Link to={to} className={className} title={collapsed ? label : undefined}>
        {content}
      </Link>
    )
  }

  return (
    <button onClick={onClick} className={className} title={collapsed ? label : undefined}>
      {content}
    </button>
  )
}

interface NavSectionProps {
  title: string
  children: React.ReactNode
  collapsed?: boolean
  defaultExpanded?: boolean
}

function NavSection({ title, children, collapsed, defaultExpanded = true }: NavSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (collapsed) {
    return <div className="py-2">{children}</div>
  }

  return (
    <div className="py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider w-full hover:text-muted-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {title}
      </button>
      {expanded && <div className="mt-1">{children}</div>}
    </div>
  )
}

/**
 * AppSidebar component
 * 
 * Persistent navigation sidebar that provides global navigation across the app.
 * Collapsible to icons-only mode. State persisted to localStorage.
 */
export const AppSidebar = observer(function AppSidebar() {
  const location = useLocation()
  const { setOrg: setWorkspace } = useWorkspaceNavigation()
  const { workspaces, currentWorkspace, isLoading } = useWorkspaceData()
  const { openCommandPalette } = useCommandPaletteContext()

  // Sidebar collapse state - persisted to localStorage
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem("app-sidebar-collapsed")
    return saved === "true"
  })

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem("app-sidebar-collapsed", String(collapsed))
  }, [collapsed])

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // Handle workspace change
  const handleWorkspaceChange = (slug: string) => {
    setWorkspace(slug)
  }

  // Check if current path matches
  const isActive = (path: string) => location.pathname === path

  return (
    <aside
      className={cn(
        "h-full border-r border-border bg-card flex flex-col transition-all duration-200",
        collapsed ? "w-16" : "w-64"
      )}
      data-testid="app-sidebar"
    >
      {/* Logo and collapse toggle */}
      <div className={cn(
        "h-14 border-b border-border flex items-center relative",
        collapsed ? "justify-center px-2" : "justify-between px-4"
      )}>
        {!collapsed && (
          <Link to="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">S</span>
            </div>
            <span className="font-semibold">Shogo</span>
          </Link>
        )}
        {collapsed && (
          <Link to="/" className="flex items-center justify-center">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">S</span>
            </div>
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapse}
          className={cn(
            "h-8 w-8",
            collapsed && "absolute -right-3 top-1/2 -translate-y-1/2 bg-card border border-border rounded-full z-10 shadow-sm"
          )}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Workspace switcher */}
      <div className={cn("p-2 border-b border-border", collapsed && "px-1")}>
        {collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            className="w-full h-10"
            title={currentWorkspace?.name || "Select workspace"}
          >
            <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-xs font-medium">
              {currentWorkspace?.name?.[0]?.toUpperCase() || "W"}
            </div>
          </Button>
        ) : (
          <WorkspaceSwitcher
            workspaces={workspaces}
            currentWorkspace={currentWorkspace ?? null}
            onWorkspaceChange={handleWorkspaceChange}
            isLoading={isLoading}
          />
        )}
      </div>

      {/* Main navigation - scrollable */}
      <nav className="flex-1 overflow-y-auto py-2">
        {/* Primary nav */}
        <div className="px-2">
          <NavItem
            icon={Home}
            label="Home"
            to="/"
            active={isActive("/")}
            collapsed={collapsed}
          />
          <NavItem
            icon={Search}
            label="Search"
            collapsed={collapsed}
            onClick={openCommandPalette}
            shortcut="⌘K"
          />
        </div>

        {/* Projects section */}
        <NavSection title="Projects" collapsed={collapsed}>
          <div className="px-2">
            <NavItem
              icon={Clock}
              label="Recent"
              to="/"
              active={isActive("/")}
              collapsed={collapsed}
            />
            <NavItem
              icon={LayoutGrid}
              label="All projects"
              to="/projects"
              active={isActive("/projects")}
              collapsed={collapsed}
            />
            <NavItem
              icon={Star}
              label="Starred"
              to="/starred"
              active={isActive("/starred")}
              collapsed={collapsed}
            />
            <NavItem
              icon={Users}
              label="Shared with me"
              to="/shared"
              active={isActive("/shared")}
              collapsed={collapsed}
            />
          </div>
        </NavSection>

        {/* Resources section */}
        <NavSection title="Resources" collapsed={collapsed}>
          <div className="px-2">
            <NavItem
              icon={Compass}
              label="Discover"
              to="/discover"
              active={isActive("/discover")}
              collapsed={collapsed}
            />
            <NavItem
              icon={FileCode2}
              label="Templates"
              to="/templates"
              active={isActive("/templates")}
              collapsed={collapsed}
            />
            <NavItem
              icon={BookOpen}
              label="Learn"
              href="https://docs.shogo.ai"
              collapsed={collapsed}
              external
            />
          </div>
        </NavSection>
      </nav>

      {/* Bottom section - upgrade CTA */}
      {!collapsed && (
        <div className="p-3 border-t border-border">
          <Link
            to="/billing"
            className="flex items-center gap-2 px-3 py-2 rounded-md bg-gradient-to-r from-blue-500/10 to-purple-500/10 hover:from-blue-500/20 hover:to-purple-500/20 transition-colors"
          >
            <div className="h-5 w-5 rounded bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Plus className="h-3 w-3 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Upgrade to Pro</div>
              <div className="text-xs text-muted-foreground">Unlock more features</div>
            </div>
          </Link>
        </div>
      )}
    </aside>
  )
})
