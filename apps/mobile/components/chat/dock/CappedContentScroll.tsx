// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Native ScrollView with only `maxHeight` often collapses to 0 (Error
 * painted over the composer) or, if omitted, grows without bound (Plan
 * pushes the composer off screen). Pin an explicit pixel height: start at
 * `maxHeight` so the first frame cannot overflow, then shrink to content
 * once measured.
 */

import { useState, type ReactNode } from "react"
import { ScrollView } from "react-native"

export function CappedContentScroll({
  maxHeight,
  children,
  testID,
}: {
  maxHeight: number
  children: ReactNode
  testID?: string
}) {
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const height = Math.min(contentHeight ?? maxHeight, maxHeight)
  const scrolling = (contentHeight ?? 0) > maxHeight

  return (
    <ScrollView
      testID={testID}
      style={{ height, flexGrow: 0 }}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={scrolling}
      scrollEnabled={scrolling}
      bounces={false}
      alwaysBounceVertical={false}
      overScrollMode="never"
      onContentSizeChange={(_w, h) => {
        const next = Math.round(h)
        setContentHeight((prev) => (prev === next ? prev : next))
      }}
    >
      {children}
    </ScrollView>
  )
}
