// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from "react-native"

interface ContextTrackerProps {
  inputTokens: number
  contextWindowTokens: number
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`
  }
  return String(tokens)
}

export function ContextTracker({ inputTokens, contextWindowTokens }: ContextTrackerProps) {
  const percentage = Math.min((inputTokens / contextWindowTokens) * 100, 100)

  return (
    <View className="rounded-full bg-muted/80 px-3 py-1">
      <Text className="text-[11px] text-muted-foreground">
        {percentage.toFixed(1)}% · {formatTokenCount(inputTokens)} / {formatTokenCount(contextWindowTokens)} context used
      </Text>
    </View>
  )
}
