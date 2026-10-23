// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** A small spinner and "<Agent> is working" for a card whose agent reply is running. */
import { ActivityIndicator, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { workingLabel } from '../../lib/board-layout'
import type { WorkingAgent } from '../../lib/work-boards-api'

export function WorkingIndicator({ working, showLabel = true, testID, className }: {
  working: WorkingAgent[] | undefined
  /** Off for compact spots where only the spinner fits. */
  showLabel?: boolean
  testID?: string
  className?: string
}) {
  if (!working?.length) return null
  const label = workingLabel(working)
  return (
    <View className={cn('min-w-0 flex-row items-center gap-1', className)} accessibilityLabel={label} testID={testID}>
      <ActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }] }} />
      {showLabel ? <Text className="max-w-40 text-[11px] text-muted-foreground" numberOfLines={1}>{label}</Text> : null}
    </View>
  )
}
