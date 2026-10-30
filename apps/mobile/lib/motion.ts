// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared motion language for gesture-driven UI on iOS, Android and web.
 *
 * Pure functions and constants only (no React Native imports) so every
 * platform animates with the same numbers and the maths is unit-testable.
 *
 * Sources: the iOS 27 UIKit/SwiftUI measurements at
 * https://blog.justinbuilds.mov/ios/ (rubber band, spring presets) and the
 * Apple-style fluid interface rules in the `ios-app-craft` skill (velocity
 * handoff, momentum projection). Those numbers were read from the binary and
 * measured on a Mac, not on a phone: treat them as strong defaults to tune.
 */

/** Physical spring in the units `Animated.spring` / Reanimated `withSpring` take. */
export interface SpringConfig {
  mass: number
  stiffness: number
  damping: number
}

/**
 * SwiftUI-style spring: `response` is the time (s) to reach the target and
 * `dampingRatio` 1 means no overshoot. Mass is fixed at 1.
 */
export function springFromResponse(response: number, dampingRatio: number): SpringConfig {
  return {
    mass: 1,
    stiffness: (2 * Math.PI / response) ** 2,
    damping: (4 * Math.PI * dampingRatio) / response,
  }
}

export const SPRING = {
  /** SwiftUI `.smooth`, the default: no bounce. */
  smooth: springFromResponse(0.5, 1),
  /** SwiftUI `.snappy`. */
  snappy: springFromResponse(0.5, 0.85),
  /** SwiftUI `.bouncy`. */
  bouncy: springFromResponse(0.5, 0.7),
  /** Repositioning something on screen. */
  move: springFromResponse(0.4, 1),
  /** A sheet or drawer released from a momentum gesture: a touch of life. */
  sheet: springFromResponse(0.3, 0.8),
  /** A drawer panel anchored to the screen edge. It must never overshoot (it would expose a gap). */
  drawer: springFromResponse(0.34, 1),
} as const

/** Rest thresholds for a 0..1 progress value (about half a point on a phone). */
export const PROGRESS_REST = {
  restDisplacementThreshold: 0.002,
  restSpeedThreshold: 0.02,
} as const

/** `c` for a finger on glass: content moves ~55% of the finger near the edge. */
export const RUBBER_BAND_TOUCH = 0.55

/**
 * Progressive resistance past a boundary, as UIScrollView applies it:
 * `c*x*d / (d + c*x)`. `overshoot` is how far the finger is past the edge,
 * `dimension` the size of the scrolling view on that axis. The result is
 * signed like `overshoot` and can never reach `dimension`.
 */
export function rubberBand(overshoot: number, dimension: number, c = RUBBER_BAND_TOUCH): number {
  if (overshoot === 0 || dimension <= 0) return 0
  const x = Math.abs(overshoot)
  const banded = (c * x * dimension) / (dimension + c * x)
  return overshoot < 0 ? -banded : banded
}

/** UIScrollView deceleration rates: `normal` is the default, `fast` snaps sooner. */
export const DECELERATION = { normal: 0.998, fast: 0.99 } as const

/**
 * Distance a value coasts after release, given its release velocity in
 * units per second. This is exponential decay, not `v^2 / (2 * decel)`.
 */
export function projectMomentum(velocityPerSec: number, rate: number = DECELERATION.normal): number {
  return ((velocityPerSec / 1000) * rate) / (1 - rate)
}

/**
 * Pick the snap target nearest to where the value would coast to.
 * Returns the index into `targets` (e.g. `[0, 1]` for closed/open).
 */
export function nearestSnapTarget(
  position: number,
  velocityPerSec: number,
  targets: readonly number[],
  rate: number = DECELERATION.fast,
): number {
  const projected = position + projectMomentum(velocityPerSec, rate)
  let best = 0
  for (let i = 1; i < targets.length; i++) {
    if (Math.abs(targets[i] - projected) < Math.abs(targets[best] - projected)) best = i
  }
  return best
}

/**
 * `PanResponder` reports `vx`/`vy` in px per ms; `Animated.spring` wants
 * value-units per second. `spanPx` is how many px the 0..1 value spans.
 */
export function pxPerMsToUnitsPerSec(velocityPxPerMs: number, spanPx: number): number {
  if (spanPx <= 0) return 0
  return (velocityPxPerMs * 1000) / spanPx
}

/** Keep a hand-off velocity sane if the gesture reports a spike. */
export function clampVelocity(velocityPerSec: number, max = 20): number {
  return Math.max(-max, Math.min(max, velocityPerSec))
}
