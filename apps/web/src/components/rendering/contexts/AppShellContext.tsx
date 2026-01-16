/**
 * AppShellContext
 * Task: view-builder-implementation
 *
 * React Context for sharing AppShell state with nested sections.
 * This enables nested compositions (like SectionBrowserSection) to access
 * the active navigation item without prop drilling.
 *
 * Usage:
 * - AppShellSection wraps content in AppShellProvider
 * - Nested sections use useAppShell() to access activeItem
 */

import { createContext, useContext, type ReactNode } from "react"

// ============================================================================
// Types
// ============================================================================

interface NavItem {
  id: string
  label: string
  href?: string
  icon?: string
  badge?: string | number
  disabled?: boolean
  /** Original entity data if loaded from dataSource */
  data?: Record<string, unknown>
}

interface AppShellContextValue {
  /** Currently active navigation item ID */
  activeItem: string | null
  /** Update the active navigation item */
  setActiveItem: (itemId: string | null) => void
  /** Whether the sidebar is collapsed (rail mode) */
  sidebarCollapsed: boolean
  /** Toggle sidebar collapsed state */
  toggleSidebar: () => void
  /** Navigation items (static or dynamically loaded) */
  navItems: NavItem[]
  /** Get data for current active item (from navItems) */
  getActiveItemData: () => Record<string, unknown> | undefined
}

// ============================================================================
// Context
// ============================================================================

const AppShellContext = createContext<AppShellContextValue | null>(null)

// ============================================================================
// Hook
// ============================================================================

/**
 * Access AppShell context from nested sections.
 * Returns null if not within an AppShellProvider.
 */
export function useAppShell(): AppShellContextValue | null {
  return useContext(AppShellContext)
}

/**
 * Access AppShell context with a required check.
 * Throws if not within an AppShellProvider.
 */
export function useAppShellRequired(): AppShellContextValue {
  const context = useContext(AppShellContext)
  if (!context) {
    throw new Error(
      "useAppShellRequired must be used within an AppShellProvider. " +
      "Wrap your component tree with AppShellSection or AppShellProvider."
    )
  }
  return context
}

// ============================================================================
// Provider
// ============================================================================

interface AppShellProviderProps {
  children: ReactNode
  value: AppShellContextValue
}

export function AppShellProvider({ children, value }: AppShellProviderProps) {
  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  )
}

// ============================================================================
// Exports
// ============================================================================

export type { NavItem, AppShellContextValue }
