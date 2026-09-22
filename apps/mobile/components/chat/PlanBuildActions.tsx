// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build / model / View plan controls shared by the dock PlanCard.
 * Plan pickers never show cheaper / higher-cost.
 */
import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronRight } from "lucide-react-native"
import { ComposerModelPicker } from "./ModelPickerMenu"
import { resolveShortName } from "../../lib/visible-models"
import {
  PLAN_READY_COMPACT_CHEVRON,
  PLAN_READY_COMPACT_CHIP_HEIGHT,
  PLAN_READY_MODEL_TRIGGER_MAX_WIDTH,
  PLAN_READY_ROW_CHEVRON,
} from "./plan-ready-chrome"

export function PlanBuildActions({
  buildModelId,
  isPro,
  nativeSheet,
  onSelectModel,
  onBuild,
  onViewPlan,
}: {
  buildModelId: string
  isPro: boolean
  /** Model picker uses the native bottom sheet (also true on narrow web). */
  nativeSheet: boolean
  onSelectModel: (modelId: string) => void
  onBuild?: (modelId?: string) => void
  onViewPlan?: () => void
}) {
  const modelName = buildModelId ? resolveShortName(buildModelId) : ""
  const labelClass = "text-xs font-semibold"
  const mutedLabel = "text-xs font-medium text-foreground"

  const modelPicker =
    onBuild && buildModelId ? (
      <ComposerModelPicker
        currentModelId={buildModelId}
        effectiveIsPro={isPro}
        nativeSheet={nativeSheet}
        hideCostLabels
        triggerClassName={cn(
          "flex-row items-center gap-1 rounded-full bg-muted px-3",
          "min-w-0",
          PLAN_READY_COMPACT_CHIP_HEIGHT,
        )}
        triggerStyle={{
          maxWidth: PLAN_READY_MODEL_TRIGGER_MAX_WIDTH,
          flexShrink: 1,
        }}
        labelClassName={mutedLabel}
        chevronSize={PLAN_READY_COMPACT_CHEVRON}
        hitSlop={8}
        label={modelName}
        sheetTitle="Build with"
        triggerAccessibilityLabel={`Choose model to build this plan, currently ${modelName}`}
        onSelect={onSelectModel}
      />
    ) : null

  const viewPlan =
    onViewPlan ? (
      <Pressable
        onPress={onViewPlan}
        accessibilityRole="button"
        accessibilityLabel="View plan in Plans"
        className={cn(
          "flex-row items-center rounded-full bg-muted",
          "gap-1 px-3",
          PLAN_READY_COMPACT_CHIP_HEIGHT,
        )}
      >
        <Text className={mutedLabel} numberOfLines={1}>
          View plan
        </Text>
        <ChevronRight
          className="text-muted-foreground"
          size={PLAN_READY_ROW_CHEVRON}
        />
      </Pressable>
    ) : null

  const build =
    onBuild ? (
      <Pressable
        onPress={() => onBuild(buildModelId || undefined)}
        accessibilityRole="button"
        accessibilityLabel="Build plan"
        className={cn(
          "flex-row items-center justify-center rounded-full bg-primary px-4",
          cn(PLAN_READY_COMPACT_CHIP_HEIGHT, "gap-1.5"),
        )}
      >
        <Text className={cn(labelClass, "text-primary-foreground")}>Build</Text>
      </Pressable>
    ) : null

  return (
    <View className="flex-row items-center gap-2">
      {modelPicker}
      {viewPlan}
      {build}
    </View>
  )
}
