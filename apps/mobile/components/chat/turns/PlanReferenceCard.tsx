// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanReferenceCard — the in-stream footprint of a `create_plan` /
 * `update_plan` tool call. The full interactive plan (technical/summary
 * tabs, Build, generate-summary) now lives on the dedicated Plans page
 * (`PlansPanel`) and in the floating `PlanDockPanel`, so this is
 * deliberately just a clickable pointer: name, status, tap to navigate.
 */

import { View, Text, Pressable, ActivityIndicator } from "react-native"
import { CheckCircle2, ClipboardList, ChevronRight } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { PlanData } from "../PlanCard"

export interface PlanReferenceCardProps {
  plan: PlanData
  isConfirmed: boolean
  /** True for `update_plan` tool calls — flips the label to "Updated plan". */
  isUpdate: boolean
  /** Navigates to the Plans page. Omitted while the plan is still
   *  streaming and has no saved filepath yet, in which case the card
   *  renders disabled with a spinner. */
  onPress?: () => void
}

export function PlanReferenceCard({ plan, isConfirmed, isUpdate, onPress }: PlanReferenceCardProps) {
  const label = isConfirmed ? "Plan" : isUpdate ? "Updated plan" : "Created plan"

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${label}: ${plan.name}. View plan.`}
      className={cn(
        "mx-2 my-1.5 flex-row items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5",
        onPress && "active:opacity-70",
      )}
    >
      <View className="h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
        <ClipboardList className="h-3.5 w-3.5 text-primary" size={14} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </Text>
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {plan.name}
        </Text>
      </View>
      {isConfirmed ? (
        <CheckCircle2 className="h-4 w-4 text-green-500" size={16} />
      ) : !onPress ? (
        <ActivityIndicator size="small" />
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" size={16} />
      )}
    </Pressable>
  )
}
