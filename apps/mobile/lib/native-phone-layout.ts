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
import { Platform, useWindowDimensions, type ViewStyle } from 'react-native'

/** Matches Android `sw600dp` smallest-width bucket for “tablet” layouts. */
const ANDROID_TABLET_MIN_SHORTEST_EDGE = 600

function isIOSPadDevice(): boolean {
  if (Platform.OS !== 'ios') return false
  return (Platform as { isPad?: boolean }).isPad === true
}

function isAndroidHandsetByWindowSize(width: number, height: number): boolean {
  return Math.min(width, height) < ANDROID_TABLET_MIN_SHORTEST_EDGE
}

/** True on iOS/Android. Web (including desktop) stays on existing layouts. */
export function isNativePlatform(): boolean {
  return Platform.OS !== 'web'
}

/** Horizontal padding for native-phone Settings chrome (`px-4`). */
export const NATIVE_PHONE_GUTTER = 16
/** NativeWind `p-4` / `px-4` (chart cards, section padding). */
export const NATIVE_WIND_SPACE_4 = 16
/** NativeWind `p-0.5`. */
export const NATIVE_WIND_SPACE_0_5 = 2
/** Left+right gutter. */
export const NATIVE_PHONE_SECTION_INSET = NATIVE_PHONE_GUTTER * 2
/** Section picker inset (`paddingHorizontal: 12` on each side). */
export const NATIVE_PHONE_PICKER_INSET = 24
/** Tap target for native phone icon buttons (Library refresh, period refresh). */
export const NATIVE_PHONE_CONTROL_SIZE = 44
/** Row gap between native phone chrome controls (`gap-2`). */
export const NATIVE_PHONE_ROW_GAP = 8
/** Wrap-row gap between two-column stat cards (`gap-3`). */
export const NATIVE_PHONE_CARD_GAP = 12
/**
 * Native ChatGPT canvas (`nativeChatGptSurfaces` in the Gluestack provider).
 * Use for style props where NativeWind `bg-background` is not applied.
 */
export const NATIVE_PHONE_CANVAS = { dark: '#000000', light: '#ffffff' } as const

export function nativePhoneCanvas(isDark: boolean): string {
  return isDark ? NATIVE_PHONE_CANVAS.dark : NATIVE_PHONE_CANVAS.light
}

/**
 * True only on iPhone / Android phones — not web, not iPad, not Android tablets.
 * Pure function: reuse window size from an existing `useWindowDimensions()` call
 * to avoid subscribing twice in the same component.
 */
export function isNativePhoneIntegrationsLayout(
  width: number,
  height: number,
): boolean {
  if (!isNativePlatform()) return false
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
 * Library + refresh row that matches the Settings section picker
 * (`windowWidth - NATIVE_PHONE_PICKER_INSET`). Yoga will not honor `flex: 1`
 * on the Library button unless the row itself has this pixel width.
 */
export function nativeSkillsActionWidths(
  paneWidth: number,
  refreshSize = NATIVE_PHONE_CONTROL_SIZE,
  gap = NATIVE_PHONE_ROW_GAP,
): { row: number; library: number; refresh: number } {
  const row = nativeContentWidth(paneWidth, NATIVE_PHONE_PICKER_INSET)
  return {
    row,
    library: Math.max(0, row - refreshSize - gap),
    refresh: refreshSize,
  }
}

/**
 * Equal-width chips for a native phone tab row (e.g. Agents Activity/Tasks/…).
 * `flex: 1` + `min-w-0` + `numberOfLines={1}` ellipsizes labels when the
 * parent has no definite width (Yoga treats `%` / flex as 0).
 */
export function nativeEqualChipWidths(
  paneWidth: number,
  count: number,
  gap = NATIVE_PHONE_ROW_GAP,
  inset = NATIVE_PHONE_PICKER_INSET,
): { row: number; chip: number; lastChip: number } {
  const row = nativeContentWidth(paneWidth, inset)
  if (count <= 0) return { row, chip: 0, lastChip: 0 }
  const inner = Math.max(0, row - gap * (count - 1))
  const chip = Math.floor(inner / count)
  return {
    row,
    chip,
    lastChip: inner - chip * (count - 1),
  }
}

/** Chip width for a wrapping native grid (Growth metric toggles). */
export function nativeGridChipWidth(
  rowWidth: number,
  columns: number,
  gap = 0,
): number {
  const cols = Math.max(1, columns)
  return Math.max(0, Math.floor((rowWidth - gap * (cols - 1)) / cols))
}

/**
 * Flex fill for a settings section. Yoga's default minHeight is the content
 * size, so a `flex: 1` ScrollView grows with its children and never scrolls.
 */
export const nativeSettingsPaneFill: ViewStyle = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
}

/** Pixel-sized settings section root so nested ScrollViews can actually scroll. */
export function nativeSettingsPaneStyle(width: number): ViewStyle {
  return {
    ...nativeSettingsPaneFill,
    width,
    maxWidth: width,
    alignSelf: 'stretch',
  }
}

/**
 * Two equal cards in a wrap row (`gap-3` = 12). NativeWind `w-[48%]` collapses
 * when the parent has no definite width.
 */
export function nativeTwoColumnCardWidth(
  paneWidth: number,
  gap = NATIVE_PHONE_CARD_GAP,
  inset = NATIVE_PHONE_SECTION_INSET,
): number {
  const inner = nativeContentWidth(paneWidth, inset)
  return Math.max(0, Math.floor((inner - gap) / 2))
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
