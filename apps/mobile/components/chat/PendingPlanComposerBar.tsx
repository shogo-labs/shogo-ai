// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-phone plan summary above the composer. Web/desktop keep the dock
 * PlanCard via PlanDockPanel.
 */
import { useChatContextSafe } from "./ChatContext"
import { useIsNativePhoneLayout } from "../../lib/native-phone-layout"
import { PlanReferenceCard } from "./turns/PlanReferenceCard"

export function PendingPlanComposerBar() {
  const nativePhone = useIsNativePhoneLayout()
  const chat = useChatContextSafe()
  const plan = chat?.pendingPlan
  if (!nativePhone || !plan) return null

  return (
    <PlanReferenceCard
      variant="composer"
      plan={plan}
      isConfirmed={false}
      isUpdate={plan.isUpdate === true}
      onBuild={chat.buildPlan}
      onViewPlan={
        chat.openPlan ? () => chat.openPlan?.(plan.filepath ?? null) : undefined
      }
      selectedModel={chat.selectedModel}
    />
  )
}
