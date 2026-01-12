/**
 * TestingPanelContext
 * Task: task-testing-001
 *
 * Provides shared state for Testing phase section components.
 * Coordinates selectedSpec state between:
 * - TaskCoverageBarSection: sets selectedSpec when user clicks a test spec
 * - ScenarioSpotlightSection: displays selectedSpec details, clears on close
 *
 * Uses direct context creation (like AnalysisPanelContext) for Testing-specific
 * state management beyond the generic createPanelContext factory.
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import type { ProviderWrapperProps } from "../../composition/providerImplementationMap"

/**
 * TestSpec type representing a TestSpecification from platform-features schema.
 * Simplified interface for the context - full type would come from generated types.
 */
export interface TestSpec {
  id: string
  taskId: string
  scenario: string
  testType: "unit" | "integration" | "acceptance"
  given: string[]
  when: string[]
  then: string[]
}

/**
 * Complete Testing panel state exposed to consumers
 */
export interface TestingPanelState {
  /** Currently selected test specification, or null if none selected */
  selectedSpec: TestSpec | null
  /** Set the selected spec (called by TaskCoverageBarSection) */
  setSelectedSpec: (spec: TestSpec) => void
  /** Clear the selection (called by ScenarioSpotlightSection close button) */
  clearSelectedSpec: () => void
}

// Create context with undefined default (enforces provider usage)
const TestingPanelContextInternal = createContext<TestingPanelState | undefined>(undefined)

/**
 * Provider component props
 */
export interface TestingPanelProviderProps extends ProviderWrapperProps {}

/**
 * Provider component that manages Testing panel state.
 *
 * Provides:
 * - selectedSpec: TestSpec | null selection state
 * - setSelectedSpec: function to select a spec
 * - clearSelectedSpec: function to clear selection
 */
export function TestingPanelProvider({
  children,
  feature,
  config,
}: TestingPanelProviderProps) {
  // Selected spec state
  const [selectedSpec, setSelectedSpecState] = useState<TestSpec | null>(null)

  // Callbacks
  const setSelectedSpec = useCallback((spec: TestSpec) => {
    setSelectedSpecState(spec)
  }, [])

  const clearSelectedSpec = useCallback(() => {
    setSelectedSpecState(null)
  }, [])

  const value: TestingPanelState = {
    selectedSpec,
    setSelectedSpec,
    clearSelectedSpec,
  }

  return (
    <TestingPanelContextInternal.Provider value={value}>
      <div data-provider-wrapper="TestingPanelProvider">
        {children}
      </div>
    </TestingPanelContextInternal.Provider>
  )
}

// Set display name for DevTools
TestingPanelProvider.displayName = "TestingPanelProvider"

/**
 * Hook to access Testing panel context
 *
 * @throws Error if used outside TestingPanelProvider
 *
 * @example
 * ```tsx
 * function TaskCoverageBarSection() {
 *   const { setSelectedSpec } = useTestingPanelContext()
 *   return <button onClick={() => setSelectedSpec(spec)}>View</button>
 * }
 *
 * function ScenarioSpotlightSection() {
 *   const { selectedSpec, clearSelectedSpec } = useTestingPanelContext()
 *   if (!selectedSpec) return null
 *   return (
 *     <div>
 *       <h3>{selectedSpec.scenario}</h3>
 *       <button onClick={clearSelectedSpec}>Close</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useTestingPanelContext(): TestingPanelState {
  const context = useContext(TestingPanelContextInternal)
  if (context === undefined) {
    throw new Error("useTestingPanelContext must be used within TestingPanelProvider")
  }
  return context
}

export default TestingPanelProvider
