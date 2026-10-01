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
    const look: BuddyLook = {
      topper: "fox",
      face: "screen",
      tail: "fox",
      eyewear: "sunglasses",
      neck: "scarf",
      bolts: true,
      blush: false,
    }
    expect(normalizeBuddyLook(look)).toEqual(look)
  })

  test("falls back to the default for missing or garbage input", () => {
    expect(normalizeBuddyLook(null)).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook(undefined)).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook("kitty")).toEqual(DEFAULT_BUDDY_LOOK)
    expect(normalizeBuddyLook([1, 2])).toEqual(DEFAULT_BUDDY_LOOK)
  })

  test("replaces only the fields this build doesn't understand", () => {
    expect(
      normalizeBuddyLook({
        topper: "unicorn",
        face: "visor",
        tail: "lion",
        eyewear: "sunglasses",
        neck: "bowtie",
        bolts: true,
        blush: "yes",
      }),
    ).toEqual({
      topper: DEFAULT_BUDDY_LOOK.topper,
      face: "visor",
      tail: DEFAULT_BUDDY_LOOK.tail,
      eyewear: "sunglasses",
      neck: "bowtie",
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
    const kitty = designFor({ ...DEFAULT_BUDDY_LOOK, topper: "ears" })
    expect(kitty.ears).toBe("cat")
    expect(kitty.antenna).toBeNull()
    expect(kitty.blush).toBe(true)

    const visor = designFor({ ...DEFAULT_BUDDY_LOOK, topper: "stubby", face: "visor", bolts: true })
    expect(visor.antenna).toBe("short")
    expect(visor.visor).toBe(true)
    expect(visor.mouth).toBe(false)
    expect(visor.bolts).toBe(true)
    expect(visor.blush).toBe(false)

    const terminal = designFor({ ...DEFAULT_BUDDY_LOOK, topper: "none", face: "screen" })
    expect(terminal.antenna).toBeNull()
    expect(terminal.ears).toBeNull()
    expect(terminal.screen).toBe(true)
  })

  test("fox ears, tail and ruff", () => {
    const fox = designFor({ ...DEFAULT_BUDDY_LOOK, topper: "fox", tail: "fox" })
    expect(fox.ears).toBe("fox")
    expect(fox.tail).toBe("fox")
    expect(fox.ruff).toBe(true)
    expect(fox.antenna).toBeNull()
    expect(designFor({ ...DEFAULT_BUDDY_LOOK, topper: "fox", face: "visor" }).ruff).toBe(false)
    expect(designFor({ ...DEFAULT_BUDDY_LOOK, tail: "fox" }).tail).toBe("fox")
  })

  test("sunglasses only on the classic face", () => {
    expect(designFor({ ...DEFAULT_BUDDY_LOOK, eyewear: "sunglasses" }).eyewear).toBe("sunglasses")
    expect(designFor({ ...DEFAULT_BUDDY_LOOK, eyewear: "sunglasses", face: "screen" }).eyewear).toBeNull()
  })
})
