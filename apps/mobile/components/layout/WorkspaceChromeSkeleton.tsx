// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View } from 'react-native'

/**
 * Fixed-height placeholders used while the workspace kind is unknown.
 * The row count stays constant so the shell does not jump when the real
 * nav replaces it.
 */
export function WorkspaceChromeSkeletonRows({
  count,
  testID,
}: {
  count: number
  testID?: string
}) {
  return (
    <View testID={testID} className="gap-2 px-2 py-1">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="h-8 rounded-md bg-muted" />
      ))}
    </View>
  )
}
