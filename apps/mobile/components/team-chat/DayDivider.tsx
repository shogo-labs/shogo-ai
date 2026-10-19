// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Text, View } from 'react-native'

/**
 * The date, centered on a hairline, above the first message of a day. Slack's
 * timeline divider: a way to place a run of messages in time without reading
 * every timestamp.
 */
export function DayDivider({ label }: { label: string }) {
  return (
    <View
      className="flex-row items-center gap-2 px-4 pb-1 pt-3"
      testID="day-divider"
      accessibilityRole="header"
      accessibilityLabel={label}
    >
      <View className="h-px flex-1 bg-border" />
      <Text className="text-[11px] font-semibold text-muted-foreground">{label}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  )
}
