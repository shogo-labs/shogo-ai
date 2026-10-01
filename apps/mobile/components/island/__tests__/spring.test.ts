// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { CLOSE_MS, Spring, Tracked, closeCurve, cubicBezier } from "../motion/spring"

describe("Spring", () => {
  test("overshoots slightly on the way to its target, then settles exactly", () => {
    const spring = new Spring(0)
    spring.target = 100
    let peak = 0
    for (let i = 0; i < 120; i++) {
      spring.step(1 / 60)
      peak = Math.max(peak, spring.value)
    }
    expect(peak).toBeGreaterThan(100)
    expect(peak).toBeLessThan(110)
    expect(spring.value).toBe(100)
    expect(spring.settled).toBe(true)
  })

  test("a long frame doesn't blow up", () => {
    const spring = new Spring(0)
    spring.target = 100
    spring.step(0.5)
    expect(Number.isFinite(spring.value)).toBe(true)
    expect(Math.abs(spring.value)).toBeLessThan(200)
  })
})

describe("cubicBezier", () => {
  test("hits the endpoints and is monotonic for the close curve", () => {
    expect(closeCurve(0)).toBe(0)
    expect(closeCurve(1)).toBe(1)
    let prev = 0
    for (let x = 0.05; x <= 1; x += 0.05) {
      const y = closeCurve(x)
      expect(y).toBeGreaterThanOrEqual(prev)
      prev = y
    }
  })

  test("linear control points give a straight line", () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3)
    expect(linear(0.5)).toBeCloseTo(0.5, 3)
  })
})

describe("Tracked", () => {
  test("shrinks along the close curve without undershooting", () => {
    const value = new Tracked(100)
    value.animateTo(0, 0)
    let low = 100
    for (let ms = 16; ms <= CLOSE_MS + 16; ms += 16) {
      value.step(0.016, ms)
      low = Math.min(low, value.value)
    }
    expect(low).toBe(0)
    expect(value.value).toBe(0)
    expect(value.animating).toBe(false)
  })

  test("grows with the spring", () => {
    const value = new Tracked(0)
    value.animateTo(100, 0)
    let peak = 0
    for (let i = 1; i <= 120; i++) {
      value.step(1 / 60, i * 16)
      peak = Math.max(peak, value.value)
    }
    expect(peak).toBeGreaterThan(100)
    expect(value.value).toBe(100)
  })
})
