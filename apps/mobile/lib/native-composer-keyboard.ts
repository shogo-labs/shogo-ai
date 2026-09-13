// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { WEB_WIDE_MIN_WIDTH } from './native-phone-layout'

/** Space between the pill/search bar and the keyboard so the oval stays readable. */
export const NATIVE_COMPOSER_KEYBOARD_GAP = 12
/** NativeWind `max-w-3xl` — same token as the web wide breakpoint. */
export const CHAT_TRANSCRIPT_MAX_WIDTH = WEB_WIDE_MIN_WIDTH
/** Ignore tiny pad deltas so rest safe-area padding is not treated as a keyboard. */
export const NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP = 8
/** Fallback when iOS omits duration or reports it as 0. */
export const NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION = 250
/** iOS keyboard curve (matches `keyboardWillShow` / ChatGPT dock). */
export const NATIVE_COMPOSER_KEYBOARD_EASING = [0.17, 0.59, 0.4, 0.77] as const

export type NativeComposerKeyboardSource = 'show' | 'hide' | 'change'

export type NativeComposerKeyboardEvent = {
  duration?: number
  endCoordinates?: { height?: number; screenY?: number }
}

export function isNativeComposerKeyboardOpen(pad: number, restPad: number): boolean {
  return pad > restPad + NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP
}

export function nativeComposerKeyboardOverlap(
  endCoordinates: { height?: number; screenY?: number } | undefined,
  viewportHeight: number,
): number {
  if (!endCoordinates) return 0
  const fromHeight = Math.max(0, endCoordinates.height ?? 0)
  const fromScreenY =
    typeof endCoordinates.screenY === 'number'
      ? Math.max(0, viewportHeight - endCoordinates.screenY)
      : 0
  return Math.max(fromHeight, fromScreenY)
}

export function nativeComposerKeyboardPad(
  endCoordinates: { height?: number; screenY?: number } | undefined,
  viewportHeight: number,
  gap = NATIVE_COMPOSER_KEYBOARD_GAP,
): number {
  return nativeComposerKeyboardOverlap(endCoordinates, viewportHeight) + gap
}

/** RN iOS sometimes reports keyboard duration in seconds. */
export function nativeComposerKeyboardDuration(duration?: number): number {
  if (duration == null || duration <= 0) return NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION
  return duration < 10 ? Math.round(duration * 1000) : duration
}

/**
 * `keyboardWillChangeFrame` fires a zero-height frame while the keyboard is
 * opening. Treating that as a hide snaps the composer back to a pill.
 */
export function nativeComposerShouldIgnoreClosedFrame(
  overlap: number,
  restPad: number,
  source: NativeComposerKeyboardSource,
): boolean {
  return source === 'change' && !isNativeComposerKeyboardOpen(overlap, restPad)
}

/**
 * `null` means ignore this frame (zero-height `keyboardWillChangeFrame`).
 * Otherwise whether the keyboard should be treated as open.
 */
export function nativeComposerKeyboardOpenFromSource(
  source: NativeComposerKeyboardSource,
  overlap: number,
  restPad: number,
): boolean | null {
  if (nativeComposerShouldIgnoreClosedFrame(overlap, restPad, source)) return null
  if (source === 'hide') return false
  if (source === 'show') return true
  return isNativeComposerKeyboardOpen(overlap, restPad)
}

/** Bottom inset for the home composer. iOS KeyboardAvoidingView already lifts. */
export function nativeComposerDockBottomPad(opts: {
  keyboardOpen: boolean
  overlap: number
  restPad: number
  iosKeyboardAvoiding: boolean
}): number {
  if (!opts.keyboardOpen) return opts.restPad
  if (opts.iosKeyboardAvoiding) return NATIVE_COMPOSER_KEYBOARD_GAP
  return opts.overlap + NATIVE_COMPOSER_KEYBOARD_GAP
}

/**
 * Style for the project composer shell. `keyboardPad` is an Animated.Value
 * and must be applied on `Animated.View` — a regular View ignores it and
 * the pill drops under the iOS keyboard / home indicator.
 */
export function chatComposerDockStyle(opts: {
  measuredWidth?: number
  keyboardPad?: unknown
  webOverflowVisible?: boolean
}): Array<Record<string, unknown> | undefined> {
  const column = opts.measuredWidth
    ? { width: opts.measuredWidth }
    : { width: '100%', maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH }
  if (opts.keyboardPad == null) return [column]
  return [
    column,
    {
      paddingBottom: opts.keyboardPad,
      ...(opts.webOverflowVisible ? { overflow: 'visible' as const } : {}),
    },
  ]
}
