// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build / model / View plan controls shared by the in-chat plan sheet
 * and the dock PlanCard. Plan pickers never show cheaper / higher-cost.
 */
import { Pressable, Text, View } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { ChevronRight } from "lucide-react-native"
import { ComposerModelPicker } from "./ModelPickerMenu"
import { PHONE_DENSITY } from "../../lib/phone-density"
import { resolveShortName } from "../../lib/visible-models"

const COMPACT_MODEL_TRIGGER_MAX_WIDTH = 168

export function PlanBuildActions({
  buildModelId,
  isPro,
  nativeSheet,
  stacked = false,
  onSelectModel,
  onBuild,
  onViewPlan,
}: {
  buildModelId: string
  isPro: boolean
  /** Model picker uses the native bottom sheet (also true on narrow web). */
  nativeSheet: boolean
  /** Stacked footer for NativePlanPreviewSheet only — dock PlanCard stays a row. */
  stacked?: boolean
  onSelectModel: (modelId: string) => void
  onBuild?: (modelId?: string) => void
  onViewPlan?: () => void
}) {
  const modelName = buildModelId ? resolveShortName(buildModelId) : ""
  const btnH = stacked ? PHONE_DENSITY.rowMin : "h-8"
  const labelClass = stacked
    ? cn(PHONE_DENSITY.text.body, "font-semibold")
    : "text-xs font-semibold"
  const mutedLabel = stacked
    ? cn(PHONE_DENSITY.text.body, "font-medium text-foreground")
    : "text-xs font-medium text-foreground"

  const modelPicker =
    onBuild && buildModelId ? (
      <ComposerModelPicker
        currentModelId={buildModelId}
        effectiveIsPro={isPro}
        nativeSheet={nativeSheet}
        hideCostLabels
        triggerClassName={cn(
          "min-w-0 flex-row items-center gap-1 rounded-full bg-muted px-3",
          stacked ? "flex-1" : null,
          btnH,
        )}
        triggerStyle={stacked ? { flexShrink: 1 } : { maxWidth: COMPACT_MODEL_TRIGGER_MAX_WIDTH, flexShrink: 1 }}
        labelClassName={mutedLabel}
        chevronSize={stacked ? PHONE_DENSITY.icon.sm : 12}
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
          "flex-row items-center gap-1 rounded-full bg-muted px-3",
          btnH,
        )}
      >
        <Text className={mutedLabel} numberOfLines={1}>
          View plan
        </Text>
        <ChevronRight
          className="text-muted-foreground"
          size={stacked ? PHONE_DENSITY.icon.sm : 14}
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
          stacked ? "w-full" : "gap-1.5",
          btnH,
        )}
      >
        <Text className={cn(labelClass, "text-primary-foreground")}>Build</Text>
      </Pressable>
    ) : null

  if (stacked) {
    return (
      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          {modelPicker}
          {viewPlan}
        </View>
        {build}
      </View>
    )
  }

  return (
    <View className="flex-row items-center gap-2">
      {modelPicker}
      {viewPlan}
      {build}
    </View>
  )
}
