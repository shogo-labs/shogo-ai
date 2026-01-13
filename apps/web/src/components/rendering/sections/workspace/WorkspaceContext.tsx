/**
 * WorkspaceContext
 * Task: req-wpp-workspace-provider
 *
 * Provides shared state for advanced-chat workspace composition.
 * Coordinates state between virtual tool handlers and workspace rendering.
 *
 * Pattern follows AnalysisPanelProvider but is designed for:
 * - Dynamic workspace composition controlled by Claude via virtual tools
 * - MobX reactivity (Composition entity changes trigger re-render)
 * - Future expansion for multi-panel layouts, panel focus, etc.
 *
 * Currently minimal - state management lives in the Composition entity.
 * This provider exists to:
 * 1. Provide consistent wrapper pattern for ComposablePhaseView
 * 2. Allow future expansion of workspace-specific coordinated state
 * 3. Enable virtual tool handlers to access workspace context
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import type { ProviderWrapperProps } from "../../composition/providerImplementationMap"

/**
 * Layout mode for workspace display
 */
export type WorkspaceLayoutMode = "single" | "split-h" | "split-v" | "grid"

/**
 * Complete Workspace state exposed to consumers
 */
export interface WorkspaceState {
  /** Current layout mode for the workspace */
  layoutMode: WorkspaceLayoutMode
  /** Set the layout mode */
  setLayoutMode: (mode: WorkspaceLayoutMode) => void
  /** Active panel ID (for focus/highlight) */
  activePanel: string | null
  /** Set the active panel */
  setActivePanel: (panelId: string | null) => void
  /** Loading state for virtual tool operations */
  isLoading: boolean
  /** Set loading state */
  setIsLoading: (loading: boolean) => void
}

// Create context with undefined default (enforces provider usage)
const WorkspaceContextInternal = createContext<WorkspaceState | undefined>(undefined)

/**
 * Provider component props
 */
export interface WorkspaceProviderProps extends ProviderWrapperProps {
  /** Initial layout mode (defaults to 'single') */
  initialLayoutMode?: WorkspaceLayoutMode
}

/**
 * Provider component that manages Workspace state.
 *
 * Provides:
 * - layoutMode: 'single' | 'split-h' | 'split-v' | 'grid'
 * - activePanel: currently focused panel ID
 * - isLoading: virtual tool operation in progress
 */
export function WorkspaceProvider({
  children,
  feature,
  config,
}: WorkspaceProviderProps) {
  // Get initial layout mode from config or default to 'single'
  const initialLayoutMode = (config?.defaultLayoutMode as WorkspaceLayoutMode) ?? "single"

  // Layout mode state
  const [layoutMode, setLayoutModeState] = useState<WorkspaceLayoutMode>(initialLayoutMode)

  // Active panel state
  const [activePanel, setActivePanelState] = useState<string | null>(null)

  // Loading state for virtual tool operations
  const [isLoading, setIsLoadingState] = useState<boolean>(false)

  // Callbacks
  const setLayoutMode = useCallback((mode: WorkspaceLayoutMode) => {
    setLayoutModeState(mode)
  }, [])

  const setActivePanel = useCallback((panelId: string | null) => {
    setActivePanelState(panelId)
  }, [])

  const setIsLoading = useCallback((loading: boolean) => {
    setIsLoadingState(loading)
  }, [])

  const value: WorkspaceState = {
    layoutMode,
    setLayoutMode,
    activePanel,
    setActivePanel,
    isLoading,
    setIsLoading,
  }

  return (
    <WorkspaceContextInternal.Provider value={value}>
      <div data-provider-wrapper="WorkspaceProvider" className="h-full">
        {children}
      </div>
    </WorkspaceContextInternal.Provider>
  )
}

// Set display name for DevTools
WorkspaceProvider.displayName = "WorkspaceProvider"

/**
 * Hook to access Workspace context
 *
 * @throws Error if used outside WorkspaceProvider
 *
 * @example
 * ```tsx
 * function WorkspacePanel() {
 *   const { activePanel, setActivePanel, isLoading } = useWorkspaceContext()
 *   // ...
 * }
 * ```
 */
export function useWorkspaceContext(): WorkspaceState {
  const context = useContext(WorkspaceContextInternal)
  if (context === undefined) {
    throw new Error("useWorkspaceContext must be used within WorkspaceProvider")
  }
  return context
}

/**
 * Optional hook that returns undefined if outside provider (no throw)
 * Useful for components that may render in or out of workspace context
 */
export function useOptionalWorkspaceContext(): WorkspaceState | undefined {
  return useContext(WorkspaceContextInternal)
}

export default WorkspaceProvider
