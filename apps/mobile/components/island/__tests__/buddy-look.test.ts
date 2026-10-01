// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { designFor } from "../buddy/engine"
import {
  BUDDY_PRESETS,
  DEFAULT_BUDDY_LOOK,
  normalizeBuddyLook,
  presetForLook,
  sameLook,
  type BuddyLook,
} from "../buddy/look"

describe("normalizeBuddyLook", () => {
  test("keeps a valid look", () => {
    const look: BuddyLook = { topper: "ears", face: "screen", bolts: true, blush: false }
    expect(normalizeBuddyLook(look)).toEqual(look)
  })

  test("falls back to the default for missing or garbage input", () => {
    expect(normalizeBuddyLook(null)).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook(undefined)).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook("kitty")).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook([1, 2])).toEqual(DEFAULT_BUDDY_LOOK)
  })

  test("replaces only the fields this build doesn't understand", () => {
    expect(normalizeBuddyLook({ topper: "crown", face: "visor", bolts: true, blush: "yes" })).toEqual({
      topper: DEFAULT_BUDDY_LOOK.topper,
      face: "visor",
      bolts: true,
      blush: DEFAULT_BUDDY_LOOK.blush,
    })
  })

  test("fills in a partial look", () => {
    expect(normalizeBuddyLook({ topper: "ears" })).toEqual({ ...DEFAULT_BUDDY_LOOK, topper: "ears" })
  })
})

describe("presets", () => {
  test("ids and looks are unique", () => {
    expect(new Set(BUDDY_PRESETS.map((p) => p.id)).size).toBe(BUDDY_PRESETS.length)
    for (const [i, a] of BUDDY_PRESETS.entries()) {
      for (const b of BUDDY_PRESETS.slice(i + 1)) expect(sameLook(a.look, b.look)).toBe(false)
    }
  })

  test("presetForLook finds exact matches only", () => {
    expect(presetForLook(DEFAULT_BUDDY_LOOK)?.id).toBe("classic")
    for (const preset of BUDDY_PRESETS) expect(presetForLook(preset.look)?.id).toBe(preset.id)
    expect(presetForLook({ ...DEFAULT_BUDDY_LOOK, bolts: true })).toBeUndefined()
  })

  test("every preset survives a normalize round trip", () => {
    for (const preset of BUDDY_PRESETS) {
      expect(normalizeBuddyLook(JSON.parse(JSON.stringify(preset.look)))).toEqual(preset.look)
    }
  })
})

describe("designFor", () => {
  test("every look is the gummy block body", () => {
    const shapes = BUDDY_PRESETS.map((p) => designFor(p.look)).map(({ exp, rx, ry, jelly }) => ({ exp, rx, ry, jelly }))
    for (const shape of shapes) expect(shape).toEqual(shapes[0])
  })

  test("maps accessories onto the design", () => {
    const kitty = designFor({ topper: "ears", face: "classic", bolts: false, blush: true })
    expect(kitty.ears).toBe(true)
    expect(kitty.antenna).toBeNull()
    expect(kitty.blush).toBe(true)

    const visor = designFor({ topper: "stubby", face: "visor", bolts: true, blush: true })
    expect(visor.antenna).toBe("short")
    expect(visor.visor).toBe(true)
    expect(visor.mouth).toBe(false)
    expect(visor.bolts).toBe(true)
    expect(visor.blush).toBe(false)

    const terminal = designFor({ topper: "none", face: "screen", bolts: false, blush: false })
    expect(terminal.antenna).toBeNull()
    expect(terminal.ears).toBe(false)
    expect(terminal.screen).toBe(true)
  })
})
