// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { IslandMode } from './island-protocol'

export interface IslandBoundsDisplay {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}

type Size = { width: number; height: number }

const SIZES: Record<IslandMode, Size> = {
  hidden: { width: 220, height: 8 },
  collapsed: { width: 210, height: 36 },
  expanded: { width: 480, height: 640 },
  compose: { width: 480, height: 640 },
}

/** Smallest card the expanded views can render without clipping the header. */
export const ISLAND_MIN_CONTENT_HEIGHT = 120

/** Wide enough that the label and chevron clear the camera housing on
 * either side; the renderer reserves the middle via `--notch-width`. */
const NOTCHED_COLLAPSED_WIDTH = 380
/** Roughly the camera housing on 14"/16" MacBook Pros. */
const NOTCH_HOT_ZONE_WIDTH = 200

export function isNotchedDisplay(
  display: IslandBoundsDisplay,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  // Electron doesn't expose the safe-area inset. Notched MacBooks report a
  // ~37pt menu bar vs 24pt on other displays.
  return display.workArea.y - display.bounds.y > 24
}

/** Menu-bar strip the island overlaps on a notched display, 0 elsewhere. */
export function getIslandTopInset(
  display: IslandBoundsDisplay,
  platform: NodeJS.Platform = process.platform,
): number {
  return isNotchedDisplay(display, platform) ? display.workArea.y - display.bounds.y : 0
}

function isCardMode(mode: IslandMode): boolean {
  return mode === 'expanded' || mode === 'compose'
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
    // The camera housing is dead menu-bar space, so the whole notch can be
    // the hover target without covering menu items.
    size = { width: NOTCH_HOT_ZONE_WIDTH, height: display.workArea.y - display.bounds.y }
  } else if (notched && mode === 'collapsed') {
    size = { width: NOTCHED_COLLAPSED_WIDTH, height: display.workArea.y - display.bounds.y }
  } else if (isCardMode(mode)) {
    const max = Math.min(SIZES[mode].height, Math.floor(display.workArea.height * 0.85))
    const height = contentHeight
      ? Math.max(ISLAND_MIN_CONTENT_HEIGHT, Math.min(max, Math.ceil(contentHeight)))
      : max
    size = { width: SIZES[mode].width, height }
  } else {
    size = SIZES[mode]
  }
  const x = Math.round(display.bounds.x + (display.bounds.width - size.width) / 2)
  const y = notched ? display.bounds.y : display.workArea.y
  return { x, y, ...size }
}
