// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Handset vs tablet detection for native-only UI (Expo / React Native).
 *
 * - Web: always treated as non-handset (existing web layout unchanged).
 * - iOS: iPad via `Platform.isPad` (runtime API; not always in TS types).
 * - Android: smallest window edge vs sw600dp-style threshold. Uses the same
 *   logical units as `useWindowDimensions()` (dp on Android, points on iOS).
 */
import { Platform } from 'react-native'

/** Matches Android `sw600dp` smallest-width bucket for “tablet” layouts. */
const ANDROID_TABLET_MIN_SHORTEST_EDGE = 600

function isIOSPadDevice(): boolean {
  if (Platform.OS !== 'ios') return false
  return (Platform as { isPad?: boolean }).isPad === true
}

function isAndroidHandsetByWindowSize(width: number, height: number): boolean {
  return Math.min(width, height) < ANDROID_TABLET_MIN_SHORTEST_EDGE
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
  if (Platform.OS === 'web') return false
  if (Platform.OS === 'ios') return !isIOSPadDevice()
  if (Platform.OS === 'android') return isAndroidHandsetByWindowSize(width, height)
  return false
}
