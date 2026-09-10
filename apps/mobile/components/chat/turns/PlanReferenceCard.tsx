// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanReferenceCard — in-stream footprint of create_plan / update_plan.
 *
 * Native phone: Cursor-style "Plan Ready" oval. The composer variant sits
 * above the chat input. Tapping the card opens a bottom sheet; tapping
 * Build starts the plan immediately.
 * Web/desktop keep the compact pointer that opens the Plans tab.
 */

import { useCallback, useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { CheckCircle2, ClipboardList, ChevronRight } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { NATIVE_PHONE_DOCK_COMPOSER_GAP, useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../../lib/phone-density"
import { NativePlanPreviewSheet } from "../NativePlanPreviewSheet"
import {
  PLAN_READY_CHIP_TEXT,
  PLAN_READY_OVAL_BUILD_HEIGHT,
} from "../plan-ready-chrome"
import type { PlanData } from "../PlanCard"

export interface PlanReferenceCardProps {
  plan: PlanData
  isConfirmed: boolean
  /** True for `update_plan` tool calls — flips the label to "Updated plan". */
  isUpdate: boolean
  /** Opens the Plans tab. */
  onViewPlan?: () => void
  /** Builds the pending plan. Omitted when nothing is pending. */
  onBuild?: ((plan?: PlanData | null, modelId?: string) => void) | null
  selectedModel?: string
  isPro?: boolean
  /** Composer oval sits above the input. Stream is the in-message pointer. */
  variant?: "stream" | "composer"
}

export function PlanReferenceCard({
  plan,
  isConfirmed,
  isUpdate,
  onViewPlan,
  onBuild,
  selectedModel,
  isPro = true,
  variant = "stream",
}: PlanReferenceCardProps) {
  const nativePhone = useIsNativePhoneLayout()
  const [sheetOpen, setSheetOpen] = useState(false)
  const canBuild = !isConfirmed && !!onBuild
  const nativeLabel = isConfirmed ? "Plan" : isUpdate ? "Updated plan" : "Plan Ready"
  const webLabel = isConfirmed ? "Plan" : isUpdate ? "Updated plan" : "Created plan"
  const composer = nativePhone && variant === "composer"
  const openSheet = useCallback(() => setSheetOpen(true), [])
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const handleOvalBuild = useCallback(() => {
    onBuild?.(plan, selectedModel)
  }, [onBuild, plan, selectedModel])
  const handleSheetBuild = useCallback(
    (modelId?: string) => {
      onBuild?.(plan, modelId)
      setSheetOpen(false)
    },
    [onBuild, plan],
  )

  if (nativePhone) {
    return (
      <>
        <View
          className={cn(
            "flex-row items-center border border-border bg-card",
            composer
              ? "mx-2 rounded-full px-4 py-2.5"
              : "mx-2 my-1.5 gap-2.5 rounded-2xl px-3 py-3",
          )}
          style={composer ? { marginBottom: NATIVE_PHONE_DOCK_COMPOSER_GAP } : undefined}
        >
          <Pressable
            onPress={openSheet}
            accessibilityRole="button"
            accessibilityLabel={`${nativeLabel}: ${plan.name}`}
            className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
          >
            {composer ? null : (
              <View className="h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                <ClipboardList className="text-primary" size={PHONE_DENSITY.icon.sm} />
              </View>
            )}
            <View className="min-w-0 flex-1">
              <Text className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {nativeLabel}
              </Text>
              <Text
                className={cn(
                  composer ? PLAN_READY_CHIP_TEXT : PHONE_DENSITY.text.body,
                  "font-medium text-foreground",
                )}
                numberOfLines={1}
              >
                {plan.name}
              </Text>
            </View>
          </Pressable>
          {isConfirmed ? (
            <CheckCircle2 className="text-green-500" size={PHONE_DENSITY.icon.md} />
          ) : canBuild ? (
            <Pressable
              onPress={handleOvalBuild}
              accessibilityRole="button"
              accessibilityLabel="Build plan"
              className={cn(
                PLAN_READY_OVAL_BUILD_HEIGHT,
                "items-center justify-center rounded-full bg-primary px-4",
              )}
            >
              <Text className={cn(PLAN_READY_CHIP_TEXT, "font-semibold text-primary-foreground")}>
                Build
              </Text>
            </Pressable>
          ) : (
            <ActivityIndicator size="small" />
          )}
        </View>
        <NativePlanPreviewSheet
          visible={sheetOpen}
          plan={plan}
          selectedModel={selectedModel}
          isPro={isPro}
          onClose={closeSheet}
          onBuild={canBuild ? handleSheetBuild : undefined}
          onViewPlan={onViewPlan}
        />
      </>
    )
  }

  return (
    <Pressable
      onPress={onViewPlan}
      disabled={!onViewPlan}
      accessibilityRole={onViewPlan ? "button" : undefined}
      accessibilityLabel={`${webLabel}: ${plan.name}. View plan.`}
      className={cn(
        "mx-2 my-1.5 flex-row items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5",
        onViewPlan && "active:opacity-70",
      )}
    >
      <View className="h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
        <ClipboardList className="h-3.5 w-3.5 text-primary" size={14} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {webLabel}
        </Text>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {plan.name}
        </Text>
      </View>
      {isConfirmed ? (
        <CheckCircle2 className="h-4 w-4 text-green-500" size={16} />
      ) : !onViewPlan ? (
        <ActivityIndicator size="small" />
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" size={16} />
      )}
    </Pressable>
  )
}
