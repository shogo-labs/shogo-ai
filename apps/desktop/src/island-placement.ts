// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { IslandMode } from './island-protocol'

export interface IslandBoundsDisplay {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}

type Size = { width: number; height: number }

const SIZES: Record<IslandMode, Size> = {
  hidden: { width: 140, height: 28 },
  collapsed: { width: 210, height: 36 },
  expanded: { width: 480, height: 640 },
  compose: { width: 480, height: 640 },
}

/** Smallest card the expanded views can render without clipping the header. */
export const ISLAND_MIN_CONTENT_HEIGHT = 120

/** Camera housing on 14"/16" MacBook Pros. */
const NOTCH_WIDTH = 200
/** Collapsed wings are lopsided: a narrow left wing for the status icon and
 * a wide right wing for text. Must match `IslandCollapsed`. */
export const NOTCHED_COLLAPSED_LEFT_WING = 40
export const NOTCHED_COLLAPSED_RIGHT_WING = 170
/** Camera housing (~200pt on 14"/16" MacBook Pros) plus room for the idle
 * wings to grow on hover. */
const NOTCHED_IDLE_WIDTH = 272

export function isNotchedDisplay(display: IslandBoundsDisplay, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return false
  // Electron doesn't expose the safe-area inset. Notched MacBooks report a
  // ~37pt menu bar vs 24pt on other displays.
  return display.workArea.y - display.bounds.y > 24
}

/** Menu-bar strip the island overlaps on a notched display, 0 elsewhere. */
export function getIslandTopInset(display: IslandBoundsDisplay, platform: NodeJS.Platform = process.platform): number {
  return isNotchedDisplay(display, platform) ? display.workArea.y - display.bounds.y : 0
}

function isCardMode(mode: IslandMode): boolean {
  return mode === 'expanded' || mode === 'compose'
}

export function isIslandFocusable(mode: IslandMode, platform: NodeJS.Platform = process.platform): boolean {
  return mode === 'compose' || (mode === 'expanded' && platform !== 'darwin')
}

export function getIslandBounds(
  display: IslandBoundsDisplay,
  mode: IslandMode,
  platform: NodeJS.Platform = process.platform,
  contentHeight?: number,
): { x: number; y: number; width: number; height: number } {
  const notched = isNotchedDisplay(display, platform)
  let size: Size
  if (notched && mode === 'hidden') {
    // The camera housing is dead menu-bar space, so the notch plus slim
    // wings can be the hover target without covering menu items.
    size = {
      width: NOTCHED_IDLE_WIDTH,
      height: display.workArea.y - display.bounds.y,
    }
  } else if (notched && mode === 'collapsed') {
    const width = NOTCHED_COLLAPSED_LEFT_WING + NOTCH_WIDTH + NOTCHED_COLLAPSED_RIGHT_WING
    const notchLeft = display.bounds.x + (display.bounds.width - NOTCH_WIDTH) / 2
    return {
      x: Math.round(notchLeft - NOTCHED_COLLAPSED_LEFT_WING),
      y: display.bounds.y,
      width,
      height: display.workArea.y - display.bounds.y,
    }
  } else if (isCardMode(mode)) {
    const max = Math.min(SIZES[mode].height, Math.floor(display.workArea.height * 0.85))
    const height = contentHeight ? Math.max(ISLAND_MIN_CONTENT_HEIGHT, Math.min(max, Math.ceil(contentHeight))) : max
    size = { width: SIZES[mode].width, height }
  } else {
    size = SIZES[mode]
  }
  const x = Math.round(display.bounds.x + (display.bounds.width - size.width) / 2)
  const y = notched ? display.bounds.y : display.workArea.y
  return { x, y, ...size }
}
