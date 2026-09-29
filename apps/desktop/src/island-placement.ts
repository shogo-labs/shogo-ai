// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type IslandPlacementMode = 'hidden' | 'collapsed' | 'expanded' | 'compose'

export interface IslandBoundsDisplay {
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}

export function isNotchedDisplay(
  display: IslandBoundsDisplay,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  return display.workArea.y - display.bounds.y > 24
}

export function getIslandBounds(
  display: IslandBoundsDisplay,
  mode: IslandPlacementMode,
  platform: NodeJS.Platform = process.platform,
): { x: number; y: number; width: number; height: number } {
  const sizes: Record<IslandPlacementMode, { width: number; height: number }> = {
    hidden: { width: 220, height: 8 },
    collapsed: { width: 210, height: 36 },
    expanded: { width: 380, height: 420 },
    compose: { width: 360, height: 300 },
  }
  const size = sizes[mode]
  const x = Math.round(display.bounds.x + (display.bounds.width - size.width) / 2)
  const y = isNotchedDisplay(display, platform)
    ? display.bounds.y
    : display.workArea.y
  return { x, y, ...size }
}
