// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Sentry JAVASCRIPT-REACT-6E: `IndexSizeError: Failed to execute
 * 'createRadialGradient' … The r1 provided is less than 0`, thrown from
 * `BuddyEngine#drawGlow` on 58 events between Oct 13 and Nov 18. The radius
 * logged was 8.7e6, which is `oy` having run away: the exponential smoothing
 * in `update` converges only for a positive step, and a frame delta can
 * arrive negative (a `requestAnimationFrame` timestamp is the time the frame
 * began, which can precede the `performance.now()` that scheduled it). Each
 * negative frame multiplied `oy` by more than one until the glow radius
 * overflowed what a canvas will accept.
 *
 * These tests drive the engine the way a frame loop does — including the
 * deltas a frame loop can actually produce — and assert that no gradient is
 * ever handed a radius a canvas would reject.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BuddyEngine } from "../buddy/engine"

const realNow = performance.now.bind(performance)
let clock = 0

/** Bun has no canvas, so the engine's `Path2D` bodies need a stand-in. */
class StubPath2D {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
  closePath() {}
}

beforeEach(() => {
  clock = 1_000_000
  performance.now = () => clock
  ;(globalThis as { Path2D?: unknown }).Path2D = StubPath2D
})

afterEach(() => {
  performance.now = realNow
})

/**
 * A 2D context that records every gradient radius and rejects one the way a
 * real canvas does: `IndexSizeError` for a negative radius, `TypeError` for a
 * non-finite one. Anything else is a no-op, so the engine can draw a whole
 * frame against it.
 */
function recordingContext() {
  const radii: number[] = []
  const gradient = { addColorStop() {} }
  const target: Record<string, unknown> = {
    createRadialGradient: (
      _x0: number,
      _y0: number,
      r0: number,
      _x1: number,
      _y1: number,
      r1: number,
    ) => {
      for (const r of [r0, r1]) {
        if (!Number.isFinite(r)) {
          throw new TypeError("The provided double value is non-finite.")
        }
        if (r < 0) {
          throw new RangeError("The r1 provided is less than 0.")
        }
      }
      radii.push(r1)
      return gradient
    },
    createLinearGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 0 }),
  }
  const ctx = new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, radii }
}

const W = 200
const H = Math.round(W * 1.4)

/** Draws one frame and returns every radius the frame handed to a gradient. */
function drawFrame(engine: BuddyEngine) {
  const { ctx, radii } = recordingContext()
  engine.draw(ctx, W, H)
  return radii
}

describe("BuddyEngine gradient radii", () => {
  test("a huge frame delta never produces a radius a canvas rejects", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)

    // A tab that was backgrounded for minutes: the frame loop's own clamp
    // caps this, but the engine must not depend on its callers for it.
    expect(() => engine.update(1_000_000)).not.toThrow()
    const radii = drawFrame(engine)
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) {
      expect(Number.isFinite(r)).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
    }
  })

  test("a negative frame delta never lets the glow radius run away", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)

    // The production shape: a frame loop that keeps handing the engine a
    // delta from before the previous frame. Before the step was sanitised
    // this diverged — `oy` grew by ~1.4x per frame — and the glow radius
    // reached 8.7e6 within a couple of seconds.
    for (let i = 0; i < 400; i++) {
      clock += 16
      engine.update(-0.05)
    }

    expect(Math.abs(engine.oy)).toBeLessThan(1)
    const radii = drawFrame(engine)
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) {
      expect(Number.isFinite(r)).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
    }
  })

  test("a non-finite frame delta is treated as no time passing", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    const before = engine.oy

    engine.update(Number.NaN)
    engine.update(Number.POSITIVE_INFINITY)
    engine.update(Number.NEGATIVE_INFINITY)

    expect(engine.oy).toBe(before)
    expect(() => drawFrame(engine)).not.toThrow()
  })

  test("a runaway offset is clamped at the gradient, not thrown", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)

    // Belt and braces: even if some future path leaves the offset at a value
    // the smoothing never produced, the frame still draws.
    engine.oy = -1_000_000
    const radii = drawFrame(engine)
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) {
      expect(Number.isFinite(r)).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
    }
  })

  test("a non-finite offset draws a centred frame instead of throwing", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    engine.oy = Number.NaN
    engine.ox = Number.NaN
    expect(() => drawFrame(engine)).not.toThrow()
  })
})
