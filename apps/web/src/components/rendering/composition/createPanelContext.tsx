/**
 * createPanelContext Factory
 * Task: task-prephase-001
 *
 * Factory function that generates React Context with selection state pattern.
 * Produces Provider component, custom hook, and typed state interface.
 * Reduces boilerplate for Analysis, Testing, and Implementation panel contexts.
 *
 * @example
 * ```tsx
 * // Create a context for test spec selection
 * const { Provider, useContext } = createPanelContext<TestSpec>("Testing")
 *
 * // Use in a parent component
 * <Provider>
 *   <TaskCoverageBar />
 *   <ScenarioSpotlight />
 * </Provider>
 *
 * // Use in child components
 * function TaskCoverageBar() {
 *   const { setSelectedItem } = useContext()
 *   return <button onClick={() => setSelectedItem(spec)}>Select</button>
 * }
 * ```
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from "react"

/**
 * Value returned by the generated context hook.
 * Contains the selected item and functions to modify it.
 */
export interface PanelContextValue<TSelectedItem> {
  /** The currently selected item, or null if nothing selected */
  selectedItem: TSelectedItem | null
  /** Set the selected item */
  setSelectedItem: (item: TSelectedItem) => void
  /** Clear the selection (set to null) */
  clearSelectedItem: () => void
}

/**
 * Props for the generated Provider component
 */
export interface PanelProviderProps<TSelectedItem> {
  /** Child components that can access the context */
  children: ReactNode
  /** Optional initial value for selectedItem */
  initialState?: TSelectedItem | null
}

/**
 * Return type from createPanelContext factory
 */
export interface PanelContextResult<TSelectedItem> {
  /** Provider component to wrap consumers */
  Provider: React.FC<PanelProviderProps<TSelectedItem>>
  /** Hook to access context value */
  useContext: () => PanelContextValue<TSelectedItem>
  /** Name of the context (for debugging) */
  contextName: string
}

/**
 * Creates a Panel Context with selection state pattern.
 *
 * This factory generates:
 * 1. A Provider component that manages selectedItem state
 * 2. A useContext hook that returns { selectedItem, setSelectedItem, clearSelectedItem }
 * 3. Error handling when hook is used outside Provider
 *
 * @param name - Name for the context (used in error messages and debugging)
 * @returns Object containing Provider, useContext hook, and contextName
 *
 * @example
 * ```tsx
 * // For Testing phase - selecting test specifications
 * const { Provider: TestingPanelProvider, useContext: useTestingPanelContext } =
 *   createPanelContext<TestSpec>("Testing")
 *
 * // For Analysis phase - selecting finding filters
 * interface FindingFilter { type: string | null; location: string | null }
 * const { Provider: AnalysisPanelProvider, useContext: useAnalysisPanelContext } =
 *   createPanelContext<FindingFilter>("Analysis")
 * ```
 */
export function createPanelContext<TSelectedItem>(
  name: string
): PanelContextResult<TSelectedItem> {
  // Create the actual React context with undefined default
  const Context = createContext<PanelContextValue<TSelectedItem> | undefined>(undefined)

  // Generate display name for DevTools
  const providerName = `${name}Provider`
  const hookName = `use${name}Context`

  /**
   * Provider component that manages selection state
   */
  function Provider({ children, initialState = null }: PanelProviderProps<TSelectedItem>) {
    const [selectedItem, setSelectedItemState] = useState<TSelectedItem | null>(initialState)

    const setSelectedItem = useCallback((item: TSelectedItem) => {
      setSelectedItemState(item)
    }, [])

    const clearSelectedItem = useCallback(() => {
      setSelectedItemState(null)
    }, [])

    const value: PanelContextValue<TSelectedItem> = {
      selectedItem,
      setSelectedItem,
      clearSelectedItem,
    }

    return <Context.Provider value={value}>{children}</Context.Provider>
  }

  // Set display name for DevTools
  Provider.displayName = providerName

  /**
   * Hook to access the panel context
   * @throws Error if used outside Provider
   */
  function usePanelContext(): PanelContextValue<TSelectedItem> {
    const context = useContext(Context)
    if (context === undefined) {
      throw new Error(`${hookName} must be used within ${providerName}`)
    }
    return context
  }

  return {
    Provider,
    useContext: usePanelContext,
    contextName: name,
  }
}

export default createPanelContext
