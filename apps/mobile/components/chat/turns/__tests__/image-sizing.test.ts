// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  clampAspectRatio,
  DEFAULT_IMAGE_ASPECT,
  getChatImageWidth,
} from "../image-sizing"

describe("clampAspectRatio", () => {
  test("uses the fallback when dimensions are missing or invalid", () => {
    expect(clampAspectRatio()).toBe(DEFAULT_IMAGE_ASPECT)
    expect(clampAspectRatio(0, 100)).toBe(DEFAULT_IMAGE_ASPECT)
    expect(clampAspectRatio(100, -1)).toBe(DEFAULT_IMAGE_ASPECT)
  })

  test("clamps very tall images", () => {
    expect(clampAspectRatio(100, 1000)).toBe(0.5)
  })

  test("clamps very wide images", () => {
    expect(clampAspectRatio(1000, 100)).toBe(2)
  })

  test("preserves a normal aspect ratio", () => {
    expect(clampAspectRatio(1600, 900)).toBeCloseTo(16 / 9)
  })
})

describe("getChatImageWidth", () => {
  test("keeps image widths within the configured bounds", () => {
    expect(getChatImageWidth(200)).toBe(220)
    expect(getChatImageWidth(500)).toBe(320)
    expect(getChatImageWidth(600, 96, 144)).toBe(144)
  })
})
