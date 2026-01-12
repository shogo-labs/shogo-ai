/**
 * AnalysisPanelContext
 * Task: task-analysis-001
 *
 * Provides shared state for Analysis phase section components.
 * Coordinates viewMode and activeFilter state between:
 * - EvidenceBoardHeaderSection: sets viewMode
 * - FindingMatrixSection: reads viewMode, sets activeFilter
 * - FindingListSection: reads viewMode and activeFilter
 * - LocationHeatBarSection: reads findings (no state dependency)
 *
 * Uses the createPanelContext factory but extends it with additional
 * Analysis-specific state beyond simple selection.
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import type { ProviderWrapperProps } from "../../composition/providerImplementationMap"

/**
 * Finding type values from the platform-features domain
 */
export type FindingType =
  | "pattern"
  | "gap"
  | "risk"
  | "classification_evidence"
  | "integration_point"
  | "verification"
  | "existing_test"

/**
 * View mode for displaying findings
 */
export type ViewMode = "matrix" | "list"

/**
 * Active filter for narrowing displayed findings
 */
export interface FindingFilter {
  type: FindingType | null
  location: string | null
}

/**
 * Complete Analysis panel state exposed to consumers
 */
export interface AnalysisPanelState {
  /** Current view mode: 'matrix' shows grid, 'list' shows cards */
  viewMode: ViewMode
  /** Set the view mode */
  setViewMode: (mode: ViewMode) => void
  /** Currently active finding filter */
  activeFilter: FindingFilter
  /** Set a filter by type and/or location */
  setActiveFilter: (filter: FindingFilter) => void
  /** Clear all filters */
  clearFilter: () => void
}

// Create context with undefined default (enforces provider usage)
const AnalysisPanelContextInternal = createContext<AnalysisPanelState | undefined>(undefined)

/**
 * Provider component props
 */
export interface AnalysisPanelProviderProps extends ProviderWrapperProps {
  /** Initial view mode (defaults to 'matrix') */
  initialViewMode?: ViewMode
}

/**
 * Provider component that manages Analysis panel state.
 *
 * Provides:
 * - viewMode: 'matrix' | 'list' toggle
 * - activeFilter: type/location filter
 * - State update functions
 */
export function AnalysisPanelProvider({
  children,
  feature,
  config,
}: AnalysisPanelProviderProps) {
  // Get initial view mode from config or default to 'matrix'
  const initialViewMode = (config?.defaultViewMode as ViewMode) ?? "matrix"

  // View mode state
  const [viewMode, setViewModeState] = useState<ViewMode>(initialViewMode)

  // Active filter state
  const [activeFilter, setActiveFilterState] = useState<FindingFilter>({
    type: null,
    location: null,
  })

  // Callbacks
  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode)
  }, [])

  const setActiveFilter = useCallback((filter: FindingFilter) => {
    setActiveFilterState(filter)
  }, [])

  const clearFilter = useCallback(() => {
    setActiveFilterState({ type: null, location: null })
  }, [])

  const value: AnalysisPanelState = {
    viewMode,
    setViewMode,
    activeFilter,
    setActiveFilter,
    clearFilter,
  }

  return (
    <AnalysisPanelContextInternal.Provider value={value}>
      <div data-provider-wrapper="AnalysisPanelProvider">
        {children}
      </div>
    </AnalysisPanelContextInternal.Provider>
  )
}

// Set display name for DevTools
AnalysisPanelProvider.displayName = "AnalysisPanelProvider"

/**
 * Hook to access Analysis panel context
 *
 * @throws Error if used outside AnalysisPanelProvider
 *
 * @example
 * ```tsx
 * function FindingMatrixSection() {
 *   const { viewMode, setActiveFilter } = useAnalysisPanelContext()
 *   // ...
 * }
 * ```
 */
export function useAnalysisPanelContext(): AnalysisPanelState {
  const context = useContext(AnalysisPanelContextInternal)
  if (context === undefined) {
    throw new Error("useAnalysisPanelContext must be used within AnalysisPanelProvider")
  }
  return context
}

export default AnalysisPanelProvider
