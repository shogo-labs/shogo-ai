// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { StyleProp, ViewStyle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import {
  nativePhoneDockFadeColors,
  NATIVE_PHONE_DOCK_FADE_LOCATIONS,
  nativePhoneCanvas,
} from '../../lib/native-phone-layout'

/**
 * Dissolves scrollable phone content into a fixed bottom dock.
 *
 * Keep this separate from the dock itself: the gradient is visual-only and
 * must never intercept taps on the composer or navigation controls.
 */
export function NativePhoneBottomFade({
  isDark,
  height,
  canvasHex,
  style,
}: {
  isDark: boolean
  height: number
  canvasHex?: string
  style?: StyleProp<ViewStyle>
}) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[...nativePhoneDockFadeColors(isDark, canvasHex ?? nativePhoneCanvas(isDark))]}
      locations={[...NATIVE_PHONE_DOCK_FADE_LOCATIONS]}
      style={[{ height }, style]}
    />
  )
}
