// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** ChatGPT docks flush on the keyboard. A gap leaves the pill looking sliced. */
export const NATIVE_COMPOSER_KEYBOARD_GAP = 0
/** Ignore tiny pad deltas so rest safe-area padding is not treated as a keyboard. */
export const NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP = 8
/** Fallback when iOS omits duration or reports it as 0. */
export const NATIVE_COMPOSER_KEYBOARD_DEFAULT_DURATION = 250
/** iOS keyboard curve (matches `keyboardWillShow` / ChatGPT dock). */
export const NATIVE_COMPOSER_KEYBOARD_EASING = [0.17, 0.59, 0.4, 0.77] as const
/**
 * Dock fill behind the home pill. `#212121` / white, matching
 * `CHATGPT_COMPOSER` fill so the keyboard morph does not flash the canvas.
 */
export const NATIVE_COMPOSER_DOCK_FILL = {
  dark: ['rgba(33,33,33,0)', 'rgba(33,33,33,1)'],
  light: ['rgba(255,255,255,0)', 'rgba(255,255,255,1)'],
} as const

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
  if (opts.iosKeyboardAvoiding) return 0
  return opts.overlap
}
