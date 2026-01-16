/**
 * AppBarSection Component
 * Task: view-builder-implementation
 * Spec: spec-appbar-section
 *
 * Reusable application header component with logo, horizontal navigation links,
 * and action buttons. Standalone section for composing into app layouts.
 *
 * Config options:
 * - logo: { src?: string, alt?: string, component?: ReactNode } - Logo config
 * - title: string - App title displayed next to logo
 * - navLinks: Array<{ id: string, label: string, href?: string, icon?: string, active?: boolean }>
 * - actions: Array<{ id: string, icon: string, label?: string, variant?: string, onClick?: () => void }>
 * - sticky: boolean - Whether header sticks on scroll (default: false)
 * - onNavigate: (href: string) => void - Navigation callback
 * - onAction: (actionId: string) => void - Action button callback
 * - theme: { background?: string, text?: string, accent?: string } - Theme overrides
 */

import { useState, useCallback, type ReactNode } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../sectionImplementations"
import {
  Menu,
  X,
  Home,
  Settings,
  User,
  Bell,
  Search,
  ChevronDown,
  PanelLeftClose,
  PanelLeft,
  type LucideIcon,
} from "lucide-react"

// ============================================================================
// Types
// ============================================================================

interface NavLink {
  id: string
  label: string
  href?: string
  icon?: string
  active?: boolean
}

interface ActionButton {
  id: string
  icon: string
  label?: string
  variant?: "default" | "ghost" | "outline"
  onClick?: () => void
}

interface LogoConfig {
  src?: string
  alt?: string
  component?: ReactNode
}

interface ThemeConfig {
  background?: string
  text?: string
  accent?: string
}

interface AppBarConfig {
  /** Logo configuration */
  logo?: LogoConfig
  /** App title displayed next to logo */
  title?: string
  /** Horizontal navigation links */
  navLinks?: NavLink[]
  /** Right-side action buttons */
  actions?: ActionButton[]
  /** Whether header sticks on scroll */
  sticky?: boolean
  /** Navigation callback */
  onNavigate?: (href: string) => void
  /** Action button callback */
  onAction?: (actionId: string) => void
  /** Theme overrides */
  theme?: ThemeConfig
  /** Show sidebar toggle button next to logo */
  showSidebarToggle?: boolean
  /** Whether sidebar is currently collapsed */
  sidebarCollapsed?: boolean
  /** Callback when sidebar toggle is clicked */
  onSidebarToggle?: () => void
}

// Icon mapping for string-based icon names
const iconMap: Record<string, LucideIcon> = {
  home: Home,
  settings: Settings,
  user: User,
  bell: Bell,
  search: Search,
  menu: Menu,
}

function getIcon(iconName: string): LucideIcon {
  return iconMap[iconName.toLowerCase()] ?? Home
}

// ============================================================================
// Sub-components
// ============================================================================

function Logo({ config, title }: { config?: LogoConfig; title?: string }) {
  if (config?.component) {
    return <>{config.component}</>
  }

  return (
    <div className="flex items-center gap-2">
      {config?.src ? (
        <img
          src={config.src}
          alt={config.alt ?? "Logo"}
          className="h-8 w-8 object-contain"
        />
      ) : (
        <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
          <span className="text-sm font-bold text-primary">
            {title?.charAt(0) ?? "A"}
          </span>
        </div>
      )}
      {title && (
        <span className="font-semibold text-foreground hidden sm:inline">
          {title}
        </span>
      )}
    </div>
  )
}

function NavLinks({
  links,
  onNavigate,
  className,
}: {
  links: NavLink[]
  onNavigate?: (linkIdOrHref: string) => void
  className?: string
}) {
  return (
    <nav className={cn("flex items-center gap-1", className)}>
      {links.map((link) => {
        const Icon = link.icon ? getIcon(link.icon) : null
        return (
          <button
            key={link.id}
            onClick={() => onNavigate?.(link.href ?? link.id)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              link.active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            <span>{link.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function ActionButtons({
  actions,
  onAction,
}: {
  actions: ActionButton[]
  onAction?: (actionId: string) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {actions.map((action) => {
        const Icon = getIcon(action.icon)
        const handleClick = () => {
          action.onClick?.()
          onAction?.(action.id)
        }

        return (
          <button
            key={action.id}
            onClick={handleClick}
            title={action.label}
            className={cn(
              "flex items-center justify-center rounded-md transition-colors",
              action.variant === "outline"
                ? "border border-border px-3 py-2 hover:bg-muted"
                : action.variant === "ghost"
                  ? "p-2 hover:bg-muted"
                  : "p-2 hover:bg-muted"
            )}
          >
            <Icon className="h-5 w-5" />
            {action.label && action.variant === "outline" && (
              <span className="ml-2 text-sm hidden sm:inline">{action.label}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function MobileMenu({
  isOpen,
  onClose,
  links,
  onNavigate,
}: {
  isOpen: boolean
  onClose: () => void
  links: NavLink[]
  onNavigate?: (href: string) => void
}) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed top-0 left-0 h-full w-64 bg-background border-r shadow-lg p-4">
        <div className="flex justify-between items-center mb-6">
          <span className="font-semibold">Menu</span>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-md">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          {links.map((link) => {
            const Icon = link.icon ? getIcon(link.icon) : null
            return (
              <button
                key={link.id}
                onClick={() => {
                  onNavigate?.(link.href ?? link.id)
                  onClose()
                }}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left",
                  link.active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                {Icon && <Icon className="h-4 w-4" />}
                <span>{link.label}</span>
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export const AppBarSection = observer(function AppBarSection({
  feature,
  config,
}: SectionRendererProps) {
  const appBarConfig = config as AppBarConfig | undefined

  // State for mobile menu
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Extract config
  const logo = appBarConfig?.logo
  const title = appBarConfig?.title ?? "App"
  const navLinks = appBarConfig?.navLinks ?? []
  const actions = appBarConfig?.actions ?? []
  const sticky = appBarConfig?.sticky ?? false
  const onNavigate = appBarConfig?.onNavigate
  const onAction = appBarConfig?.onAction
  const theme = appBarConfig?.theme
  const showSidebarToggle = appBarConfig?.showSidebarToggle ?? false
  const sidebarCollapsed = appBarConfig?.sidebarCollapsed ?? false
  const onSidebarToggle = appBarConfig?.onSidebarToggle

  const toggleMobileMenu = useCallback(() => {
    setMobileMenuOpen((prev) => !prev)
  }, [])

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false)
  }, [])

  // Build style overrides from theme
  const themeStyles: React.CSSProperties = {}
  if (theme?.background) themeStyles.backgroundColor = theme.background
  if (theme?.text) themeStyles.color = theme.text

  return (
    <>
      <header
        data-testid="appbar-section"
        className={cn(
          "w-full h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
          sticky && "sticky top-0 z-40"
        )}
        style={themeStyles}
      >
        <div className="flex items-center justify-between h-full px-4 max-w-screen-2xl mx-auto">
          {/* Left zone: Logo + Sidebar Toggle + Title */}
          <div className="flex items-center gap-2">
            {/* Mobile hamburger */}
            {navLinks.length > 0 && (
              <button
                onClick={toggleMobileMenu}
                className="p-2 hover:bg-muted rounded-md md:hidden"
                aria-label="Toggle menu"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}

            <Logo config={logo} title={title} />

            {/* Sidebar toggle button */}
            {showSidebarToggle && (
              <button
                onClick={onSidebarToggle}
                className="p-2 hover:bg-muted rounded-md border border-border hidden md:flex items-center justify-center"
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {sidebarCollapsed ? (
                  <PanelLeft className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </button>
            )}
          </div>

          {/* Center zone: Navigation Links (hidden on mobile) */}
          {navLinks.length > 0 && (
            <NavLinks
              links={navLinks}
              onNavigate={onNavigate}
              className="hidden md:flex"
            />
          )}

          {/* Right zone: Action buttons */}
          {actions.length > 0 && (
            <ActionButtons actions={actions} onAction={onAction} />
          )}
        </div>
      </header>

      {/* Mobile menu drawer */}
      <MobileMenu
        isOpen={mobileMenuOpen}
        onClose={closeMobileMenu}
        links={navLinks}
        onNavigate={onNavigate}
      />
    </>
  )
})
