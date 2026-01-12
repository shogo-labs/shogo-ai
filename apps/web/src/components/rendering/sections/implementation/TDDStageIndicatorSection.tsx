/**
 * TDDStageIndicatorSection
 * Task: task-implementation-002
 *
 * Displays the current TDD stage with color-coded visual badge.
 * Reads currentTDDStage from ImplementationPanelContext.
 *
 * Stage mappings:
 * - idle: Clock icon, muted colors, label "IDLE"
 * - pending: Clock icon, amber colors, label "PENDING"
 * - test_failing: XCircle icon, red colors, label "RED"
 * - test_passing: CheckCircle icon, green colors, label "GREEN"
 * - complete: CheckCircle icon, emerald colors, label "COMPLETE"
 * - failed: XCircle icon, dark red colors, label "FAILED"
 */

import React from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { Clock, CheckCircle, XCircle } from "lucide-react"
import type { SectionRendererProps } from "../../types"
import { useImplementationPanelContext, type TDDStage } from "./ImplementationPanelContext"

/**
 * Stage configuration for TDD indicator
 */
const stageConfig: Record<TDDStage, {
  label: string
  icon: React.ElementType
  bgColor: string
  textColor: string
  borderColor: string
}> = {
  idle: {
    label: "IDLE",
    icon: Clock,
    bgColor: "bg-muted/30",
    textColor: "text-muted-foreground",
    borderColor: "border-muted",
  },
  pending: {
    label: "PENDING",
    icon: Clock,
    bgColor: "bg-amber-500/10",
    textColor: "text-amber-500",
    borderColor: "border-amber-500/30",
  },
  test_failing: {
    label: "RED",
    icon: XCircle,
    bgColor: "bg-red-500/10",
    textColor: "text-red-500",
    borderColor: "border-red-500/30",
  },
  test_passing: {
    label: "GREEN",
    icon: CheckCircle,
    bgColor: "bg-green-500/10",
    textColor: "text-green-500",
    borderColor: "border-green-500/30",
  },
  complete: {
    label: "COMPLETE",
    icon: CheckCircle,
    bgColor: "bg-emerald-500/10",
    textColor: "text-emerald-500",
    borderColor: "border-emerald-500/30",
  },
  failed: {
    label: "FAILED",
    icon: XCircle,
    bgColor: "bg-red-500/20",
    textColor: "text-red-400",
    borderColor: "border-red-500/50",
  },
}

/**
 * TDDStageIndicatorSection Component
 *
 * Shows the current TDD stage with visual distinction.
 * Reads currentTDDStage from ImplementationPanelContext.
 */
export const TDDStageIndicatorSection = observer(function TDDStageIndicatorSection({
  feature,
  config,
}: SectionRendererProps) {
  const { currentTDDStage } = useImplementationPanelContext()
  const stageInfo = stageConfig[currentTDDStage]
  const Icon = stageInfo.icon

  return (
    <div
      data-testid="tdd-stage-indicator-section"
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-lg border",
        stageInfo.bgColor,
        stageInfo.borderColor
      )}
    >
      <Icon className={cn("h-5 w-5", stageInfo.textColor)} data-testid={`tdd-stage-icon-${currentTDDStage}`} />
      <span className={cn("font-bold text-sm tracking-wider", stageInfo.textColor)} data-testid="tdd-stage-label">
        {stageInfo.label}
      </span>
    </div>
  )
})

export default TDDStageIndicatorSection
