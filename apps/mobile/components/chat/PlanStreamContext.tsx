// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import type { PlanData } from "./PlanCard"

export type BusinessPlanStatus = "idle" | "pending" | "ready" | "error"

export interface PlanStreamContextValue {
  /** True while the agent is streaming in plan mode (researching phase). */
  isPlanStreaming: boolean
  /** Partial PlanData extracted from the streaming create_plan tool args. */
  streamingPlan: PlanData | null
  /** Bumped each time a plan is finalized or updated on disk (triggers PlansPanel re-fetch). */
  planRefreshNonce: number
  /** Set once the plan file is written to disk (from data-plan event). Used to transition the streaming view to the persisted plan. */
  streamingPlanFilepath: string | null
  /** Lifecycle of the business-language translation for the current streaming plan. */
  businessStatus: BusinessPlanStatus
  /** Final business-language markdown once translation completes. */
  streamingBusinessPlan: string | null
  /** Error message if translation failed. */
  businessError: string | null

  setIsPlanStreaming: (v: boolean) => void
  setStreamingPlan: (plan: PlanData | null) => void
  setStreamingPlanFilepath: (v: string | null) => void
  notifyPlanCreated: () => void
  setBusinessStatus: (s: BusinessPlanStatus) => void
  setStreamingBusinessPlan: (v: string | null) => void
  setBusinessError: (v: string | null) => void
  resetBusinessPlan: () => void
}

const PlanStreamContext = createContext<PlanStreamContextValue | null>(null)

export interface PlanStreamProviderProps {
  children: ReactNode
}

export function PlanStreamProvider({ children }: PlanStreamProviderProps) {
  const [isPlanStreaming, setIsPlanStreaming] = useState(false)
  const [streamingPlan, setStreamingPlan] = useState<PlanData | null>(null)
  const [planRefreshNonce, setPlanRefreshNonce] = useState(0)
  const [streamingPlanFilepath, setStreamingPlanFilepath] = useState<string | null>(null)
  const [businessStatus, setBusinessStatus] = useState<BusinessPlanStatus>("idle")
  const [streamingBusinessPlan, setStreamingBusinessPlan] = useState<string | null>(null)
  const [businessError, setBusinessError] = useState<string | null>(null)

  const notifyPlanCreated = useCallback(() => {
    setPlanRefreshNonce((n) => n + 1)
  }, [])

  const resetBusinessPlan = useCallback(() => {
    setBusinessStatus("idle")
    setStreamingBusinessPlan(null)
    setBusinessError(null)
  }, [])

  // Memoize the context value so its identity only changes when one of the
  // four state slots actually changes. Without this, every render of this
  // provider produced a fresh object literal, forcing every `usePlanStream()`
  // consumer (including `ChatPanel`) to re-render and re-run effects keyed on
  // `planStream` — a major contributor to streaming-time render storms.
  // `setIsPlanStreaming`/`setStreamingPlan`/`setStreamingPlanFilepath` are
  // already-stable `useState` setters, and `notifyPlanCreated` is wrapped in
  // `useCallback([])`, so they don't need to be in the deps array.
  const value = useMemo<PlanStreamContextValue>(
    () => ({
      isPlanStreaming,
      streamingPlan,
      planRefreshNonce,
      streamingPlanFilepath,
      businessStatus,
      streamingBusinessPlan,
      businessError,
      setIsPlanStreaming,
      setStreamingPlan,
      setStreamingPlanFilepath,
      notifyPlanCreated,
      setBusinessStatus,
      setStreamingBusinessPlan,
      setBusinessError,
      resetBusinessPlan,
    }),
    [
      isPlanStreaming,
      streamingPlan,
      planRefreshNonce,
      streamingPlanFilepath,
      businessStatus,
      streamingBusinessPlan,
      businessError,
      notifyPlanCreated,
      resetBusinessPlan,
    ],
  )

  return (
    <PlanStreamContext.Provider value={value}>
      {children}
    </PlanStreamContext.Provider>
  )
}

export function usePlanStream(): PlanStreamContextValue {
  const context = useContext(PlanStreamContext)
  if (!context) {
    throw new Error(
      "usePlanStream must be used within a PlanStreamProvider."
    )
  }
  return context
}

export function usePlanStreamSafe(): PlanStreamContextValue | null {
  return useContext(PlanStreamContext)
}
