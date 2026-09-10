// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable, Platform } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Check } from "lucide-react-native"
import { MODEL_COST_LABEL, MODEL_COST_DETAIL } from "../../lib/model-build-cost"

interface AutoModelOptionProps {
  currentModelId: string
  onSelect: () => void
  presentation?: "menu" | "sheet"
}

export function AutoModelOption({ currentModelId, onSelect, presentation = "menu" }: AutoModelOptionProps) {
  const isNative = Platform.OS !== "web"
  const isSheet = presentation === "sheet"
  const isSelected = currentModelId === AUTO_MODEL_ID
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "flex-row items-center gap-2.5 px-3",
        isSheet ? "min-h-14 py-3" : isNative ? "min-h-12 py-2.5" : "py-2",
        isSelected && "bg-accent"
      )}
    >
      <View className="flex-1">
        <Text className={isNative ? "text-base text-foreground" : "text-sm text-foreground"}>Auto</Text>
        {isSheet ? <Text className="text-xs text-muted-foreground mt-0.5">{MODEL_COST_DETAIL.economy}</Text> : null}
      </View>
      {isSelected ? (
        <Check className="text-primary" size={isNative ? 18 : 14} />
      ) : (
        <Text className={isNative ? "text-xs text-muted-foreground" : "text-[10px] text-muted-foreground"}>
          {MODEL_COST_LABEL.economy}
        </Text>
      )}
    </Pressable>
  )
}
