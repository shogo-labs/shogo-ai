// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check } from "lucide-react-native"
import { isNativePlatform } from "../../lib/native-phone-layout"
import { NATIVE_MODEL_SHEET } from "./model-picker-sheet-chrome"

interface AutoModelOptionProps {
  currentModelId: string
  onSelect: () => void
  presentation?: "menu" | "sheet"
}

export function AutoModelOption({
  currentModelId,
  onSelect,
  presentation = "menu",
}: AutoModelOptionProps) {
  const isNative = isNativePlatform()
  const isSheet = presentation === "sheet"
  const isSelected = currentModelId === AUTO_MODEL_ID
  const nameClass = isSheet
    ? NATIVE_MODEL_SHEET.nameClass
    : isNative
      ? "text-base"
      : "text-sm"
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "flex-row items-center gap-2.5 px-3",
        isSheet ? NATIVE_MODEL_SHEET.rowClass : isNative ? "min-h-12 py-2.5" : "py-2",
        isNative && isSelected && "bg-accent",
        "web:hover:bg-accent"
      )}
    >
      <View className="flex-1">
        <Text className={cn(nameClass, "text-foreground")}>
          Auto
        </Text>
      </View>
      {isSelected ? (
        <Check
          className={isNative ? "text-primary" : "text-foreground/80"}
          size={isSheet ? NATIVE_MODEL_SHEET.icon : isNative ? 18 : 14}
        />
      ) : null}
    </Pressable>
  )
}
