// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Handset vs tablet detection for native-only UI (Expo / React Native).
 *
 * - Web: always treated as non-handset (existing web layout unchanged).
 * - iOS: iPad via `Platform.isPad` (runtime API; not always in TS types).
 * - Android: smallest window edge vs sw600dp-style threshold. Uses the same
 *   logical units as `useWindowDimensions()` (dp on Android, points on iOS).
 */
import { Platform, useWindowDimensions } from 'react-native'

/** Matches Android `sw600dp` smallest-width bucket for “tablet” layouts. */
const ANDROID_TABLET_MIN_SHORTEST_EDGE = 600

function isIOSPadDevice(): boolean {
  if (Platform.OS !== 'ios') return false
  return (Platform as { isPad?: boolean }).isPad === true
}

function isAndroidHandsetByWindowSize(width: number, height: number): boolean {
  return Math.min(width, height) < ANDROID_TABLET_MIN_SHORTEST_EDGE
}

/** Horizontal padding for native-phone Settings chrome (`px-4`). */
export const NATIVE_PHONE_GUTTER = 16
/** Left+right gutter. */
export const NATIVE_PHONE_SECTION_INSET = NATIVE_PHONE_GUTTER * 2
/** Section picker inset (`paddingHorizontal: 12` on each side). */
export const NATIVE_PHONE_PICKER_INSET = 24

/**
 * True only on iPhone / Android phones — not web, not iPad, not Android tablets.
 * Pure function: reuse window size from an existing `useWindowDimensions()` call
 * to avoid subscribing twice in the same component.
 */
export function isNativePhoneIntegrationsLayout(
  width: number,
  height: number,
): boolean {
  if (Platform.OS === 'web') return false
  if (Platform.OS === 'ios') return !isIOSPadDevice()
  if (Platform.OS === 'android') return isAndroidHandsetByWindowSize(width, height)
  return false
}

/**
 * Absolute fill that uses a pixel width. Percentage `width: '100%'` collapses
 * in this tree when a parent has no definite width (Yoga treats it as 0).
 */
export function nativePhoneFillStyle(width: number): {
  position: 'absolute'
  top: 0
  left: 0
  bottom: 0
  width: number
  maxWidth: number
} {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width,
    maxWidth: width,
  }
}

/** Inner content width for a full-bleed native phone pane. */
export function nativeContentWidth(
  windowWidth: number,
  horizontalPadding = NATIVE_PHONE_SECTION_INSET,
): number {
  return Math.max(0, windowWidth - horizontalPadding)
}

/**
 * One `useWindowDimensions` subscription for phone detection and pixel widths.
 * Prefer this over calling the hook plus `Dimensions.get` in the same component.
 */
export function useNativePhoneWindow(): {
  isPhone: boolean
  width: number
  height: number
} {
  const { width, height } = useWindowDimensions()
  return {
    isPhone: isNativePhoneIntegrationsLayout(width, height),
    width,
    height,
  }
}

/** True on iPhone / Android phones. Web and tablets stay on the existing layout. */
export function useIsNativePhoneLayout(): boolean {
  const { width, height } = useWindowDimensions()
  return isNativePhoneIntegrationsLayout(width, height)
}
