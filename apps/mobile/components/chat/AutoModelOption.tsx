// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check } from "lucide-react-native"

interface AutoModelOptionProps {
  currentModelId: string
  onSelect: () => void
}

export function AutoModelOption({ currentModelId, onSelect }: AutoModelOptionProps) {
  const isNative = Platform.OS !== "web"
  const isSelected = currentModelId === AUTO_MODEL_ID
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "flex-row items-center gap-2.5 px-3",
        isNative ? "min-h-12 py-2.5" : "py-2",
        isSelected && "bg-accent",
      )}
    >
      <View className="flex-1">
        <Text className={isNative ? "text-base text-foreground" : "text-sm text-foreground"}>Auto</Text>
      </View>
      {isSelected ? (
        <Check className="text-primary" size={isNative ? 18 : 14} />
      ) : (
        <Text className={isNative ? "text-xs text-muted-foreground" : "text-[10px] text-muted-foreground"}>Efficiency</Text>
      )}
    </Pressable>
  )
}
