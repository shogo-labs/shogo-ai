// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Extra space so the home composer sits fully above the keyboard, not on its suggestion bar. */
export const NATIVE_COMPOSER_KEYBOARD_GAP = 12
/** Ignore tiny pad deltas so rest safe-area padding is not treated as a keyboard. */
export const NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP = 8

export function isNativeComposerKeyboardOpen(pad: number, restPad: number): boolean {
  return pad > restPad + NATIVE_COMPOSER_KEYBOARD_OPEN_SLOP
}

export function nativeComposerKeyboardPad(
  endCoordinates: { height?: number; screenY?: number } | undefined,
  screenHeight: number,
  gap = NATIVE_COMPOSER_KEYBOARD_GAP,
): number {
  if (!endCoordinates) return gap
  const fromHeight = Math.max(0, endCoordinates.height ?? 0)
  const fromScreenY =
    typeof endCoordinates.screenY === 'number'
      ? Math.max(0, screenHeight - endCoordinates.screenY)
      : 0
  return Math.max(fromHeight, fromScreenY) + gap
}
