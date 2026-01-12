/**
 * ImplementationPanelContext
 * Task: task-implementation-001
 *
 * Provides shared state for Implementation phase section components.
 * Coordinates selectedExecutionId state between:
 * - TaskExecutionTimelineSection: sets selectedExecutionId when user clicks an execution
 * - LiveOutputTerminalSection: displays selected execution's output, reads selectedExecutionId
 *
 * Also exposes derived state from platformFeatures domain:
 * - latestRun: Most recent ImplementationRun for the feature
 * - sortedExecutions: TaskExecutions sorted by startedAt descending
 * - currentTDDStage: Computed TDD stage (idle, pending, test_failing, test_passing, complete, failed)
 */

import React, { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import type { ProviderWrapperProps } from "../../composition/providerImplementationMap"

/**
 * TDD Stage type representing the current state in the TDD cycle
 */
export type TDDStage = "idle" | "pending" | "test_failing" | "test_passing" | "complete" | "failed"

/**
 * TaskExecution entity from platformFeatures domain
 */
export interface TaskExecution {
  id: string
  task: any
  status: string
  testFilePath?: string
  implementationFilePath?: string
  testOutput?: string
  errorMessage?: string
  startedAt: number
  completedAt?: number
}

/**
 * ImplementationRun entity from platformFeatures domain
 */
export interface ImplementationRun {
  id: string
  session: any
  status: string
  currentTaskId?: string
  completedTasks?: string[]
  failedTasks?: string[]
  startedAt: number
  completedAt?: number
  lastError?: string
}

/**
 * Complete Implementation panel state exposed to consumers
 */
export interface ImplementationPanelState {
  /** Currently selected execution ID, or null if none selected */
  selectedExecutionId: string | null
  /** Set the selected execution ID (called by TaskExecutionTimelineSection) */
  setSelectedExecutionId: (id: string) => void
  /** Clear the selection (reset to null) */
  clearSelectedExecutionId: () => void
  /** Latest implementation run for the feature (null if none) */
  latestRun: ImplementationRun | null
  /** Task executions sorted by startedAt descending (newest first) */
  sortedExecutions: TaskExecution[]
  /** Current TDD stage computed from run and execution status */
  currentTDDStage: TDDStage
}

// Create context with undefined default (enforces provider usage)
const ImplementationPanelContextInternal = createContext<ImplementationPanelState | undefined>(undefined)

/**
 * Provider component props
 */
export interface ImplementationPanelProviderProps extends ProviderWrapperProps {}

/**
 * Provider component that manages Implementation panel state.
 *
 * Provides:
 * - selectedExecutionId: string | null selection state
 * - setSelectedExecutionId: function to select an execution
 * - clearSelectedExecutionId: function to clear selection
 * - latestRun: derived from platformFeatures domain
 * - sortedExecutions: derived from platformFeatures domain
 * - currentTDDStage: computed from run/execution status
 */
export function ImplementationPanelProvider({
  children,
  feature,
  config,
}: ImplementationPanelProviderProps) {
  // Access platformFeatures domain
  const { platformFeatures } = useDomains()

  // Selected execution ID state
  const [selectedExecutionId, setSelectedExecutionIdState] = useState<string | null>(null)

  // Callbacks
  const setSelectedExecutionId = useCallback((id: string) => {
    setSelectedExecutionIdState(id)
  }, [])

  const clearSelectedExecutionId = useCallback(() => {
    setSelectedExecutionIdState(null)
  }, [])

  // Derive latestRun from domain
  const latestRun: ImplementationRun | null = useMemo(() => {
    if (!platformFeatures?.implementationRunCollection?.findLatestBySession) {
      return null
    }
    return platformFeatures.implementationRunCollection.findLatestBySession(feature?.id) ?? null
  }, [platformFeatures, feature?.id])

  // Derive and sort executions from domain
  const sortedExecutions: TaskExecution[] = useMemo(() => {
    if (!latestRun || !platformFeatures?.taskExecutionCollection?.findByRun) {
      return []
    }
    const executions = platformFeatures.taskExecutionCollection.findByRun(latestRun.id) ?? []
    // Sort by startedAt descending (newest first)
    return [...executions].sort((a, b) => b.startedAt - a.startedAt)
  }, [platformFeatures, latestRun])

  // Compute current TDD stage
  const currentTDDStage: TDDStage = useMemo(() => {
    if (!latestRun) {
      return "idle"
    }

    // Check run-level terminal states first
    if (latestRun.status === "complete") {
      return "complete"
    }
    if (latestRun.status === "failed") {
      return "failed"
    }

    // If no executions, we're pending
    if (sortedExecutions.length === 0) {
      return "pending"
    }

    // Get most recent execution (first in sorted array since sorted desc)
    const latestExecution = sortedExecutions[0]
    if (!latestExecution) {
      return "pending"
    }

    // Return execution status as TDD stage (or pending if unknown)
    const status = latestExecution.status as TDDStage
    if (["test_failing", "test_passing", "complete", "failed"].includes(status)) {
      return status
    }

    return "pending"
  }, [latestRun, sortedExecutions])

  const value: ImplementationPanelState = {
    selectedExecutionId,
    setSelectedExecutionId,
    clearSelectedExecutionId,
    latestRun,
    sortedExecutions,
    currentTDDStage,
  }

  return (
    <ImplementationPanelContextInternal.Provider value={value}>
      <div data-provider-wrapper="ImplementationPanelProvider">
        {children}
      </div>
    </ImplementationPanelContextInternal.Provider>
  )
}

// Set display name for DevTools
ImplementationPanelProvider.displayName = "ImplementationPanelProvider"

/**
 * Hook to access Implementation panel context
 *
 * @throws Error if used outside ImplementationPanelProvider
 *
 * @example
 * ```tsx
 * function TaskExecutionTimelineSection() {
 *   const { sortedExecutions, setSelectedExecutionId } = useImplementationPanelContext()
 *   return (
 *     <div>
 *       {sortedExecutions.map(exec => (
 *         <button key={exec.id} onClick={() => setSelectedExecutionId(exec.id)}>
 *           {exec.status}
 *         </button>
 *       ))}
 *     </div>
 *   )
 * }
 *
 * function LiveOutputTerminalSection() {
 *   const { selectedExecutionId, sortedExecutions } = useImplementationPanelContext()
 *   const selectedExecution = sortedExecutions.find(e => e.id === selectedExecutionId)
 *   if (!selectedExecution) return <div>Select an execution</div>
 *   return <pre>{selectedExecution.testOutput}</pre>
 * }
 * ```
 */
export function useImplementationPanelContext(): ImplementationPanelState {
  const context = useContext(ImplementationPanelContextInternal)
  if (context === undefined) {
    throw new Error("useImplementationPanelContext must be used within ImplementationPanelProvider")
  }
  return context
}

export default ImplementationPanelProvider
