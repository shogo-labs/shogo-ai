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
  expanded: { width: 380, height: 420 },
  compose: { width: 360, height: 300 },
}

/** Wide enough that the label and chevron clear the camera housing on
 * either side; the renderer reserves the middle via `--notch-width`. */
const NOTCHED_COLLAPSED_WIDTH = 380

export function isNotchedDisplay(
  display: IslandBoundsDisplay,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  // Electron doesn't expose the safe-area inset. Notched MacBooks report a
  // ~37pt menu bar vs 24pt on other displays.
  return display.workArea.y - display.bounds.y > 24
}

export function getIslandBounds(
  display: IslandBoundsDisplay,
  mode: IslandMode,
  platform: NodeJS.Platform = process.platform,
): { x: number; y: number; width: number; height: number } {
  const notched = isNotchedDisplay(display, platform)
  const size =
    notched && mode === 'collapsed'
      ? { width: NOTCHED_COLLAPSED_WIDTH, height: display.workArea.y - display.bounds.y }
      : SIZES[mode]
  const x = Math.round(display.bounds.x + (display.bounds.width - size.width) / 2)
  const y = notched ? display.bounds.y : display.workArea.y
  return { x, y, ...size }
}
