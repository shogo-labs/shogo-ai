// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gesture maths for an edge-anchored drawer panel whose open amount is a
 * 0..1 progress value. The panel follows the finger 1:1 while it is down, and
 * on release a spring carries the finger's velocity to the nearest end.
 *
 * Pure so the same rules can be unit-tested and reused by any drawer.
 */
import { clampVelocity, nearestSnapTarget, pxPerMsToUnitsPerSec } from './motion'

/** Finger travel before a horizontal drag claims the gesture from children. */
export const DRAWER_CAPTURE_SLOP = 8

/**
 * How far a released drawer coasts: between UIScrollView's `normal` (0.998,
 * too eager for a ~300pt panel) and `fast` (0.99, which makes a hard flick
 * from the edge close again). About 0.66 of the panel per 1 px/ms.
 * A starting point to tune on a device.
 */
export const DRAWER_DECELERATION = 0.995

/** Open amount while dragging: 1:1 with the finger, held between closed (0) and open (1). */
export function drawerProgressFromDelta(start: number, dx: number, width: number): number {
  return Math.min(1, Math.max(0, start + dx / Math.max(1, width)))
}

/** A clearly horizontal right-swipe on the closed screen opens the drawer. */
export function shouldCaptureOpenSwipe(dx: number, dy: number): boolean {
  return dx > DRAWER_CAPTURE_SLOP && Math.abs(dx) > Math.abs(dy)
}

/** A clearly horizontal left-swipe on the open panel closes the drawer. */
export function shouldCaptureCloseSwipe(dx: number, dy: number): boolean {
  return dx < -DRAWER_CAPTURE_SLOP && Math.abs(dx) > Math.abs(dy)
}

/** Release velocity as progress-per-second, ready to hand to `Animated.spring`. */
export function drawerReleaseVelocity(vxPxPerMs: number, width: number): number {
  return clampVelocity(pxPerMsToUnitsPerSec(vxPxPerMs, width))
}

/** Where a released drawer should settle: nearest end to where it would coast to. */
export function drawerSettleTarget(progress: number, vxPxPerMs: number, width: number): 0 | 1 {
  const velocity = drawerReleaseVelocity(vxPxPerMs, width)
  return nearestSnapTarget(progress, velocity, [0, 1], DRAWER_DECELERATION) === 1 ? 1 : 0
}
