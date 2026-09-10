// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native-phone Plan Ready oval above the composer. Web/desktop keep the
 * dock PlanCard via PlanDockPanel.
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
      isUpdate={false}
      onBuild={chat.buildPlan}
      onViewPlan={
        chat.openPlan && plan.filepath ? () => chat.openPlan?.(plan.filepath) : undefined
      }
      selectedModel={chat.selectedModel}
      isPro={chat.isPro}
    />
  )
}
