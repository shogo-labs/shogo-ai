// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanReferenceCard — in-stream footprint of create_plan / update_plan.
 *
 * Native phone: Cursor-style "Plan Ready" card. Build (or the card) opens a
 * bottom sheet with the plan, a model picker, View plan, and Build.
 * Web/desktop keep the compact pointer that opens the Plans tab.
 */

import { useState } from "react"
import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { CheckCircle2, ClipboardList, ChevronRight } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useIsNativePhoneLayout } from "../../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../../lib/phone-density"
import { NativePlanPreviewSheet } from "../NativePlanPreviewSheet"
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
}

export function PlanReferenceCard({
  plan,
  isConfirmed,
  isUpdate,
  onViewPlan,
  onBuild,
  selectedModel,
  isPro = true,
}: PlanReferenceCardProps) {
  const nativePhone = useIsNativePhoneLayout()
  const [sheetOpen, setSheetOpen] = useState(false)
  const canBuild = !isConfirmed && !!onBuild
  const nativeLabel = isConfirmed ? "Plan" : isUpdate ? "Updated plan" : "Plan Ready"
  const webLabel = isConfirmed ? "Plan" : isUpdate ? "Updated plan" : "Created plan"

  if (nativePhone) {
    return (
      <>
        <View className="mx-2 my-1.5 flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-3">
          <Pressable
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${nativeLabel}: ${plan.name}`}
            className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
          >
            <View className="h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
              <ClipboardList className="text-primary" size={PHONE_DENSITY.icon.sm} />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {nativeLabel}
              </Text>
              <Text
                className={cn(PHONE_DENSITY.text.body, "font-medium text-foreground")}
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
              onPress={() => setSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Build plan"
              className={cn(
                PHONE_DENSITY.rowMin,
                "items-center justify-center rounded-full bg-primary px-4",
              )}
            >
              <Text className={cn(PHONE_DENSITY.text.body, "font-semibold text-primary-foreground")}>
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
          onClose={() => setSheetOpen(false)}
          onBuild={
            canBuild
              ? (modelId) => {
                  onBuild?.(plan, modelId)
                  setSheetOpen(false)
                }
              : undefined
          }
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
