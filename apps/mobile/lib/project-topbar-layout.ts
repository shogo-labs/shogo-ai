// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Keep native project-header icons clear of the bottom hairline. */
export const NATIVE_HEADER_PAD_BOTTOM = 12

/** Center the project title against whichever header side is wider. */
export function nativePhoneTitleInset(leftChrome: number, rightChrome: number): number {
  return Math.max(leftChrome, rightChrome)
}

export type IdeAlignmentPosition = 'left' | 'right'

export const IDE_ALIGNMENT_TOGGLE_TEST_ID = 'ide-sidebar-alignment-toggle'

export function nextIdeAlignment(
  position: IdeAlignmentPosition,
): IdeAlignmentPosition {
  return position === 'left' ? 'right' : 'left'
}

export function ideAlignmentLabel(nextPosition: IdeAlignmentPosition): string {
  return `Switch IDE files and tabs to ${nextPosition} alignment`
}
