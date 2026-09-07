// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Dock panel for the session's latest plan — reuses the existing `PlanCard`
 * in `embedded` mode (no outer rounded/border/bg card of its own, since
 * `DockPanel` already provides one), fed by the same `pendingPlan` /
 * `confirmedPlan` state `ChatPanel` already tracks. No new runtime plumbing.
 */

import { useMemo } from "react"
import { ClipboardList } from "lucide-react-native"
import { PlanCard, type PlanData } from "../../PlanCard"
import { useDockPanel } from "../useDockPanel"
import type { DockPanelDescriptor } from "../../../../lib/chat-dock-store"

export interface PlanDockPanelProps {
  pendingPlan: PlanData | null
  confirmedPlan: PlanData | null
  onBuild: ((plan: PlanData) => void) | null
  onOpenPlan?: (filepath: string) => void
  /** Resolved value is intentionally untyped: `ChatPanel`'s generator
   *  resolves with the generated text, but `PlanCard` only awaits
   *  completion to know when to clear its loading state. */
  onGenerateSummary?: (filepath: string) => Promise<unknown> | void
}

export function PlanDockPanel({ pendingPlan, confirmedPlan, onBuild, onOpenPlan, onGenerateSummary }: PlanDockPanelProps) {
  const plan = pendingPlan ?? confirmedPlan
  const isConfirmed = !!confirmedPlan && !pendingPlan

  const descriptor = useMemo<DockPanelDescriptor | null>(() => {
    if (!plan) return null
    return {
      id: "plan",
      kind: "status",
      order: 20,
      title: "Plan",
      icon: ClipboardList,
      summary: plan.name,
      defaultExpanded: !isConfirmed,
      render: () => (
        <PlanCard
          plan={plan}
          embedded
          onBuild={!isConfirmed && onBuild ? () => onBuild(plan) : undefined}
          onOpenPlan={onOpenPlan && plan.filepath ? () => onOpenPlan(plan.filepath!) : undefined}
          onGenerateSummary={
            onGenerateSummary && plan.filepath
              ? async () => {
                  await onGenerateSummary(plan.filepath!)
                }
              : undefined
          }
          isConfirmed={isConfirmed}
        />
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, isConfirmed, onBuild, onOpenPlan, onGenerateSummary])

  useDockPanel(descriptor)
  return null
}
