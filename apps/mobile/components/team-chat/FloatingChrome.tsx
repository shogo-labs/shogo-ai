// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Glass buttons and pills for the phone conversation chrome that floats over the messages. */
import type { ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'

/** Height of the round buttons and title pill. */
export const CHROME_SIZE = 44

export function GlassButton({ label, onPress, children }: { label: string; onPress?: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="items-center justify-center overflow-hidden rounded-full bg-transparent shadow-sm active:opacity-70"
      style={{ width: CHROME_SIZE, height: CHROME_SIZE }}
    >
      <LiquidGlassBackdrop style={{ borderRadius: CHROME_SIZE / 2 }} />
      {/* On web a bare SVG icon would paint under the absolutely positioned glass. */}
      <View className="items-center justify-center">{children}</View>
    </Pressable>
  )
}

/** A rounded glass surface for non-button chrome (status chips, the join bar). */
export function GlassChip({ className, style, children }: { className?: string; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <View className={cn('overflow-hidden rounded-full bg-transparent shadow-sm', className)} style={style}>
      <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
      {children}
    </View>
  )
}
