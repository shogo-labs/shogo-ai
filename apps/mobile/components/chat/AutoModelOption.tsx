// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check } from "lucide-react-native"
import { MODEL_COST_LABEL, MODEL_COST_DETAIL } from "../../lib/model-build-cost"
import { isNativePlatform } from "../../lib/native-phone-layout"
import { NATIVE_MODEL_SHEET } from "./model-picker-sheet-chrome"

interface AutoModelOptionProps {
  currentModelId: string
  onSelect: () => void
  presentation?: "menu" | "sheet"
  hideCostLabels?: boolean
}

export function AutoModelOption({
  currentModelId,
  onSelect,
  presentation = "menu",
  hideCostLabels = false,
}: AutoModelOptionProps) {
  const isNative = isNativePlatform()
  const isSheet = presentation === "sheet"
  const isSelected = currentModelId === AUTO_MODEL_ID
  const nameClass = isSheet
    ? NATIVE_MODEL_SHEET.nameClass
    : isNative
      ? "text-base"
      : "text-sm"
  const metaClass = isSheet
    ? NATIVE_MODEL_SHEET.metaClass
    : isNative
      ? "text-xs"
      : "text-[10px]"
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "flex-row items-center gap-2.5 px-3",
        isSheet ? NATIVE_MODEL_SHEET.rowClass : isNative ? "min-h-12 py-2.5" : "py-2",
        isSelected && "bg-accent"
      )}
    >
      <View className="flex-1">
        <Text className={cn(nameClass, "text-foreground")}>
          Auto
        </Text>
        {isSheet && !hideCostLabels ? (
          <Text className={cn(NATIVE_MODEL_SHEET.metaClass, "text-muted-foreground mt-0.5")}>
            {MODEL_COST_DETAIL.economy}
          </Text>
        ) : null}
      </View>
      {isSelected ? (
        <Check className="text-primary" size={isSheet ? NATIVE_MODEL_SHEET.icon : isNative ? 18 : 14} />
      ) : hideCostLabels ? null : (
        <Text className={cn(metaClass, "text-muted-foreground")}>
          {MODEL_COST_LABEL.economy}
        </Text>
      )}
    </Pressable>
  )
}
