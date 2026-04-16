// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text, Pressable } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { AUTO_MODEL_ID } from "@shogo/model-catalog"
import { Zap, Check } from "lucide-react-native"

interface AutoModelOptionProps {
  currentModelId: string
  onSelect: () => void
  compact?: boolean
}

export function AutoModelOption({ currentModelId, onSelect, compact }: AutoModelOptionProps) {
  const isSelected = currentModelId === AUTO_MODEL_ID
  return (
    <Pressable
      onPress={onSelect}
      className={cn(
        "flex-row items-center gap-2.5 px-3",
        compact ? "py-2" : "py-2.5",
        isSelected && "bg-accent",
      )}
    >
      <Zap size={14} className="text-primary" />
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">Auto</Text>
        <Text className="text-[10px] text-muted-foreground">Best model per turn</Text>
      </View>
      {isSelected && <Check className="h-3.5 w-3.5 text-primary" size={14} />}
    </Pressable>
  )
}
