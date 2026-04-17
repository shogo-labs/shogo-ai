// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import type { PlanData } from "./PlanCard"

export interface PlanStreamContextValue {
  /** True while the agent is streaming in plan mode (researching phase). */
  isPlanStreaming: boolean
  /** Partial PlanData extracted from the streaming create_plan tool args. */
  streamingPlan: PlanData | null
  /** Bumped each time a plan is finalized or updated on disk (triggers PlansPanel re-fetch). */
  planRefreshNonce: number
  /** Set once the plan file is written to disk (from data-plan event). Used to transition the streaming view to the persisted plan. */
  streamingPlanFilepath: string | null

  setIsPlanStreaming: (v: boolean) => void
  setStreamingPlan: (plan: PlanData | null) => void
  setStreamingPlanFilepath: (v: string | null) => void
  notifyPlanCreated: () => void
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

  const notifyPlanCreated = useCallback(() => {
    setPlanRefreshNonce((n) => n + 1)
  }, [])

  return (
    <PlanStreamContext.Provider
      value={{
        isPlanStreaming,
        streamingPlan,
        planRefreshNonce,
        streamingPlanFilepath,
        setIsPlanStreaming,
        setStreamingPlan,
        setStreamingPlanFilepath,
        notifyPlanCreated,
      }}
    >
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
