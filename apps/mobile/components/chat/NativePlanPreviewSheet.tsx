// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cursor-style plan preview: a bottom sheet with the plan body and
 * Build / model / View plan in the footer. Web keeps the dock PlanCard.
 */
import { useEffect, useState } from "react"
import { Pressable, Text, View } from "react-native"
import { X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { MarkdownText } from "./MarkdownText"
import { PlanBuildActions } from "./PlanBuildActions"
import { NativePhoneSheet } from "../phone/NativePhoneSheet"
import {
  NATIVE_PHONE_SHEET_BODY_RATIO,
  NATIVE_PHONE_SHEET_MAX_HEIGHT_RATIO,
} from "../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../lib/phone-density"
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
      headerLeft={
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityLabel="Close"
          accessibilityRole="button"
          className={cn(
            PHONE_DENSITY.hitSize,
            "items-center justify-center rounded-full bg-muted",
          )}
        >
          <X size={PHONE_DENSITY.icon.md} className="text-foreground" />
        </Pressable>
      }
      footer={
        <View className="border-t border-border px-4 pt-3">
          <PlanBuildActions
            buildModelId={buildModelId}
            isPro={isPro}
            nativeSheet
            stacked
            onSelectModel={setBuildModelId}
            onBuild={onBuild}
            onViewPlan={
              onViewPlan
                ? () => {
                    onViewPlan()
                    onClose()
                  }
                : undefined
            }
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
          <Text className="mt-1 text-[15px] text-muted-foreground">{plan.overview}</Text>
        ) : null}
        <View className="mt-4">
          <MarkdownText>{plan.plan}</MarkdownText>
        </View>
      </View>
    </NativePhoneSheet>
  )
}
