// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A card in glass: native Liquid Glass on iOS 26, a blur or tint elsewhere
 * (see `LiquidGlassBackdrop`). `tint` colours the glass softly, and `accent`
 * draws a thin border, e.g. orange while an agent waits for approval.
 */
import type { ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { LiquidGlassBackdrop } from './LiquidGlassBackdrop'

export interface GlassCardProps {
  children: ReactNode
  radius?: number
  /** A colour to tint the glass with. */
  tint?: string
  /** A border colour. */
  accent?: string
  style?: StyleProp<ViewStyle>
  testID?: string
}

export function GlassCard({ children, radius = 22, tint, accent, style, testID }: GlassCardProps) {
  return (
    <View
      testID={testID}
      style={[
        { borderRadius: radius, overflow: 'hidden' },
        accent ? { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: accent } : null,
        style,
      ]}
    >
      <LiquidGlassBackdrop tintColor={tint} />
      {children}
    </View>
  )
}
