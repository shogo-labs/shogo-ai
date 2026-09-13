// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cursor-style plan preview: a bottom sheet with the plan body and
 * Build / model / View plan in the footer. Web keeps the dock PlanCard.
 */
import { useCallback, useEffect, useState } from "react"
import { Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { MarkdownText } from "./MarkdownText"
import { PlanBuildActions } from "./PlanBuildActions"
import { NativePhoneSheet, NativePhoneSheetCloseButton } from "../phone/NativePhoneSheet"
import {
  NATIVE_PHONE_SHEET_BODY_RATIO,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
} from "../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../lib/phone-density"
import { PLAN_READY_CHIP_TEXT } from "./plan-ready-chrome"
import type { PlanData } from "./PlanCard"

export function NativePlanPreviewSheet({
  visible,
  plan,
  selectedModel,
  isPro = true,
  onClose,
  onBuild,
  onViewPlan,
}: {
  visible: boolean
  plan: PlanData
  selectedModel?: string
  isPro?: boolean
  onClose: () => void
  onBuild?: (modelId?: string) => void
  onViewPlan?: () => void
}) {
  const [buildModelId, setBuildModelId] = useState(selectedModel ?? "")

  useEffect(() => {
    if (visible && selectedModel) setBuildModelId(selectedModel)
  }, [visible, selectedModel, plan.filepath, plan.toolCallId])

  const handleViewPlan = useCallback(() => {
    onViewPlan?.()
    onClose()
  }, [onViewPlan, onClose])

  return (
    <NativePhoneSheet
      visible={visible}
      onClose={onClose}
      title="Plan"
      animationType="slide"
      grabber={false}
      maxHeightRatio={NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO}
      bodyMaxHeightRatio={NATIVE_PHONE_SHEET_BODY_RATIO}
      scroll
      testID="native-plan-preview-sheet"
      headerLeft={<NativePhoneSheetCloseButton onPress={onClose} />}
      footer={
        <View className="border-t border-border px-4 pt-3">
          <PlanBuildActions
            buildModelId={buildModelId}
            isPro={isPro}
            nativeSheet
            stacked
            onSelectModel={setBuildModelId}
            onBuild={onBuild}
            onViewPlan={onViewPlan ? handleViewPlan : undefined}
          />
        </View>
      }
    >
      <View className="px-4 pb-3">
        <Text
          accessibilityRole="header"
          className={cn(PHONE_DENSITY.text.title, "font-semibold text-foreground")}
        >
          {plan.name}
        </Text>
        {plan.overview ? (
          <Text className={cn("mt-1 text-muted-foreground", PLAN_READY_CHIP_TEXT)}>{plan.overview}</Text>
        ) : null}
        <View className="mt-4">
          <MarkdownText>{plan.plan}</MarkdownText>
        </View>
      </View>
    </NativePhoneSheet>
  )
}
