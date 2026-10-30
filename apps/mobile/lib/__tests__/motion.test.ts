// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  clampVelocity,
  DECELERATION,
  nearestSnapTarget,
  projectMomentum,
  pxPerMsToUnitsPerSec,
  rubberBand,
  SPRING,
  springFromResponse,
} from '../motion'

describe('springFromResponse', () => {
  test('matches the SwiftUI presets measured on iOS 27', () => {
    expect(SPRING.smooth.stiffness).toBeCloseTo(157.91, 2)
    expect(SPRING.smooth.damping).toBeCloseTo(25.13, 2)
    expect(SPRING.snappy.damping).toBeCloseTo(21.36, 2)
    expect(SPRING.bouncy.damping).toBeCloseTo(17.59, 2)
    expect(SPRING.smooth.mass).toBe(1)
  })

  test('damping ratio 1 is critically damped, below 1 overshoots', () => {
    const ratio = (s: { stiffness: number; damping: number; mass: number }) =>
      s.damping / (2 * Math.sqrt(s.stiffness * s.mass))
    expect(ratio(SPRING.smooth)).toBeCloseTo(1, 5)
    expect(ratio(SPRING.drawer)).toBeCloseTo(1, 5)
    expect(ratio(SPRING.sheet)).toBeCloseTo(0.8, 5)
    expect(ratio(springFromResponse(0.2, 0.5))).toBeCloseTo(0.5, 5)
  })

  test('a shorter response is a stiffer spring', () => {
    expect(springFromResponse(0.3, 1).stiffness).toBeGreaterThan(springFromResponse(0.5, 1).stiffness)
  })
})

describe('rubberBand', () => {
  // Worked example from the article: d = 844pt, c = 0.55.
  const d = 844
  test('reproduces the measured UIKit curve', () => {
    expect(rubberBand(25, d)).toBeCloseTo(13.5, 1)
    expect(rubberBand(100, d)).toBeCloseTo(51.6, 1)
    expect(rubberBand(844, d)).toBeCloseTo(299.5, 1)
    expect(rubberBand(3000, d)).toBeCloseTo(558.4, 1)
  })

  test('is signed, zero at zero, and never reaches the dimension', () => {
    expect(rubberBand(0, d)).toBe(0)
    expect(rubberBand(-100, d)).toBeCloseTo(-51.6, 1)
    expect(rubberBand(1e9, d)).toBeLessThan(d)
    expect(rubberBand(10, 0)).toBe(0)
  })

  test('resistance grows with distance', () => {
    const ratio = (x: number) => rubberBand(x, d) / x
    expect(ratio(25)).toBeGreaterThan(ratio(100))
    expect(ratio(100)).toBeGreaterThan(ratio(844))
    expect(ratio(25)).toBeLessThan(0.55)
  })
})

describe('momentum', () => {
  test('projects exponential decay, not v^2 / 2a', () => {
    expect(projectMomentum(1000, DECELERATION.normal)).toBeCloseTo(499, 0)
    expect(projectMomentum(1000, DECELERATION.fast)).toBeCloseTo(99, 0)
    expect(projectMomentum(-1000, DECELERATION.fast)).toBeCloseTo(-99, 0)
    expect(projectMomentum(0)).toBe(0)
  })

  test('snaps to the target nearest the projected resting point', () => {
    const targets = [0, 1]
    expect(nearestSnapTarget(0.2, 0, targets)).toBe(0)
    expect(nearestSnapTarget(0.6, 0, targets)).toBe(1)
    // a flick right from 0.2 coasts past the midpoint
    expect(nearestSnapTarget(0.2, 6, targets)).toBe(1)
    // a flick left from 0.8 coasts back to closed
    expect(nearestSnapTarget(0.8, -6, targets)).toBe(0)
  })
})

describe('velocity hand-off', () => {
  test('converts px/ms to value-units per second', () => {
    // 50px/s over 100px is 0.5 units/s
    expect(pxPerMsToUnitsPerSec(0.05, 100)).toBeCloseTo(0.5, 5)
    expect(pxPerMsToUnitsPerSec(1, 300)).toBeCloseTo(3.333, 3)
    expect(pxPerMsToUnitsPerSec(1, 0)).toBe(0)
  })

  test('clamps spikes', () => {
    expect(clampVelocity(50)).toBe(20)
    expect(clampVelocity(-50)).toBe(-20)
    expect(clampVelocity(3)).toBe(3)
  })
})
