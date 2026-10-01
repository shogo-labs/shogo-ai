// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BuddyEngine } from "../buddy/engine"

const realNow = performance.now.bind(performance)
let clock = 0

beforeEach(() => {
  clock = 1_000_000
  performance.now = () => clock
})

afterEach(() => {
  performance.now = realNow
})

/** Steps the engine through `ms` of 60 fps frames. */
function run(engine: BuddyEngine, ms: number) {
  for (let t = 0; t < ms; t += 16) {
    clock += 16
    engine.update(engine.reducedMotion ? 0 : 0.016)
  }
}

describe("BuddyEngine resting", () => {
  test("the resting mark settles, then asks to wake for its next sheen", () => {
    const engine = new BuddyEngine()
    engine.isMini = true
    engine.showLogo(true)
    expect(engine.resting).toBe(false)

    run(engine, 2_000)
    expect(engine.resting).toBe(true)
    expect(engine.msUntilWake()).not.toBeNull()
  })

  test("the full character never rests", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    run(engine, 3_000)
    expect(engine.resting).toBe(false)
    expect(engine.msUntilWake()).toBeNull()
  })

  test("a reduced-motion character rests once its tweens and timers finish", async () => {
    const engine = new BuddyEngine()
    engine.reducedMotion = true
    engine.showLogo(false)
    engine.setState("finished")
    run(engine, 1_000)
    expect(engine.resting).toBe(false)

    // The finish hop schedules its confetti on real timers.
    await Bun.sleep(500)
    run(engine, 2_000)
    expect(engine.resting).toBe(true)
  })

  test("changes wake a sleeping loop", () => {
    const engine = new BuddyEngine()
    engine.showLogo(true)
    run(engine, 2_000)
    let wakes = 0
    engine.onWake = () => wakes++

    for (const change of [
      () => engine.setState("working"),
      () => engine.setBodyColor("#00ff00"),
      () => (engine.look = { topper: "ears", face: "classic", bolts: false, blush: true }),
      () => engine.logoPeek(),
    ]) {
      const before = wakes
      change()
      expect(wakes).toBeGreaterThan(before)
    }
    expect(engine.resting).toBe(false)
  })
})
