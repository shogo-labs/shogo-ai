// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pressable, Text, View } from "react-native"

type PlanModeSuggestionProps = {
  secondsLeft: number
  onContinueInAgent: () => void
  onSwitchToPlan: () => void
}

export function PlanModeSuggestion({
  secondsLeft,
  onContinueInAgent,
  onSwitchToPlan,
}: PlanModeSuggestionProps) {
  return (
    <View
      className="mb-2 rounded-xl border border-border/70 bg-card/95 p-2.5"
      testID="plan-mode-suggestion"
    >
      <View className="flex-row items-start gap-2.5">
        <View className="mt-1 h-2 w-2 rounded-full bg-amber-400" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground">
            Plan mode may fit this better
          </Text>
          <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">
            Shogo suggests Plan for complex or multi-step work. Auto-sends in Agent in{" "}
            {Math.max(1, secondsLeft)}s.
          </Text>
        </View>
      </View>

      <View className="mt-2 flex-row flex-wrap justify-end gap-2">
        <Pressable
          onPress={onContinueInAgent}
          className="min-h-11 justify-center rounded-md border border-border/70 bg-background/40 px-3 py-2"
          testID="plan-mode-suggestion-continue"
          accessibilityRole="button"
          accessibilityLabel="Send in Agent mode"
        >
          <Text className="text-xs font-medium text-muted-foreground">
            Send in Agent
          </Text>
        </Pressable>
        <Pressable
          onPress={onSwitchToPlan}
          className="min-h-11 justify-center rounded-md bg-amber-500 px-3 py-2"
          testID="plan-mode-suggestion-switch"
          accessibilityRole="button"
          accessibilityLabel="Switch to Plan mode and send"
        >
          <Text className="text-xs font-semibold text-amber-950">
            Switch to Plan mode
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
