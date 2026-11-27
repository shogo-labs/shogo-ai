// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AMBIENT_FRAME_MS, BUDDY_FINISHES, BuddyEngine } from "../buddy/engine"

const realNow = performance.now.bind(performance)
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let clock = 0
/** `later()` timers, on the same virtual clock as the frames (SHO-600). */
let timers: Array<{ id: number; at: number; run: () => void }> = []
let nextTimerId = 1

beforeEach(() => {
  clock = 1_000_000
  timers = []
  nextTimerId = 1
  performance.now = () => clock
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = nextTimerId++
    timers.push({ id, at: clock + ms, run })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers = timers.filter((timer) => timer.id !== (id as unknown as number))
  }) as unknown as typeof clearTimeout
})

afterEach(() => {
  performance.now = realNow
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

/** Moves the clock to `target`, running every timer that comes due on the way. */
function advanceTo(target: number) {
  for (;;) {
    const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    if (due.at > clock) clock = due.at
    timers = timers.filter((timer) => timer.id !== due.id)
    due.run()
  }
  clock = Math.max(clock, target)
}

/** Steps the engine through `ms` of 60 fps frames. */
function run(engine: BuddyEngine, ms: number) {
  for (let t = 0; t < ms; t += 16) {
    advanceTo(clock + 16)
    engine.update(engine.reducedMotion ? 0 : 0.016)
  }
}

/**
 * Runs the render loop the way `ShogoBuddy` and `webview-entry` do — sleep
 * while `resting`, draw at `AMBIENT_FRAME_MS` while the character is only
 * blinking and fidgeting, rAF otherwise — and counts the frames it draws.
 */
function simulateLoop(engine: BuddyEngine, ms: number) {
  const end = clock + ms
  let frames = 0
  let justSlept = false
  while (clock < end) {
    if (!justSlept && engine.resting) {
      const wait = engine.msUntilWake()
      if (wait == null) break
      advanceTo(clock + Math.max(16, wait))
      // The loop's timer wakes it with one frame, exactly like the timeout in
      // `ShogoBuddy`/`webview-entry` does.
      justSlept = true
      continue
    }
    justSlept = false
    frames += 1
    const step = engine.idleAmbient ? AMBIENT_FRAME_MS : 16
    advanceTo(clock + step)
    engine.update(step / 1000)
  }
  return { frames, perSecond: frames / (ms / 1000) }
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

  test("an idle character sleeps between its blinks and fidgets", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    run(engine, 3_000)
    expect(engine.resting).toBe(true)
    const wait = engine.msUntilWake()
    expect(wait).not.toBeNull()
    // Nothing is due for a few seconds: the loop sleeps, it does not spin.
    expect(wait!).toBeGreaterThan(1_000)
    expect(wait!).toBeLessThanOrEqual(24_000)
  })

  test("an idle character averages only a few frames a second, not sixty", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    run(engine, 3_000)
    const idle = simulateLoop(engine, 60_000)
    // Criterion 1 of SHO-600: <= 5 frames/s averaged while Home sits idle. The
    // engine used to ask for 120.
    expect(idle.perSecond).toBeLessThanOrEqual(5)
    // …and it is still alive: blinks and fidgets interrupt the sleep.
    expect(idle.frames).toBeGreaterThan(10)
  })

  test("a working character still draws every frame", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    engine.setState("working")
    expect(simulateLoop(engine, 10_000).perSecond).toBeGreaterThan(30)
  })

  test("an agent's state keeps the character animating", () => {
    const engine = new BuddyEngine()
    engine.showLogo(false)
    for (const state of ["working", "thinking", "approval", "question", "dizzy"] as const) {
      engine.setState(state)
      run(engine, 4_000)
      expect({ state, resting: engine.resting }).toEqual({ state, resting: false })
      expect({ state, wake: engine.msUntilWake() }).toEqual({ state, wake: null })
    }
  })

  test("a reduced-motion character rests once its tweens and timers finish", () => {
    const engine = new BuddyEngine()
    engine.reducedMotion = true
    engine.showLogo(false)
    engine.setState("finished")
    run(engine, 100)
    expect(engine.resting).toBe(false)

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
      () =>
        (engine.look = {
          topper: "ears",
          face: "classic",
          tail: "none",
          eyewear: "none",
          neck: "none",
          bolts: false,
          blush: true,
          color: null,
          finish: "classic",
        }),
      () => (engine.finish = BUDDY_FINISHES.modern),
      () => engine.logoPeek(),
    ]) {
      const before = wakes
      change()
      expect(wakes).toBeGreaterThan(before)
    }
    expect(engine.resting).toBe(false)
  })
})
