// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text, Pressable } from "react-native"
import { Zap } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"

export interface QuickActionChipsProps {
  actions: { label: string; prompt: string }[]
  onActionClick?: (prompt: string) => void
  className?: string
}

export function QuickActionChips({
  actions,
  onActionClick,
  className,
}: QuickActionChipsProps) {
  if (actions.length === 0) return null

  return (
    <View className={cn("gap-2", className)}>
      <View className="flex-row items-center gap-1.5 justify-center">
        <Zap className="text-amber-500" size={12} />
        <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Quick Actions
        </Text>
      </View>
      <View className="flex-row flex-wrap justify-center gap-2 max-w-xs">
        {actions.map((action) => (
          <Pressable
            key={action.label}
            onPress={() => onActionClick?.(action.prompt)}
            className={cn(
              "px-3 py-1.5 rounded-full",
              "bg-amber-50/50 dark:bg-amber-900/20",
              "border border-amber-200/50 dark:border-amber-700/50",
              "active:bg-amber-100 dark:active:bg-amber-900/40"
            )}
          >
            <Text className="text-xs text-foreground font-medium">{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
