// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  CHAT_IMAGE_MAX_HEIGHT,
  CHAT_IMAGE_MAX_WIDTH,
  CHAT_IMAGE_MIN_WIDTH,
  clampAspectRatio,
  DEFAULT_IMAGE_ASPECT,
  fitChatImage,
  getChatImageWidth,
  parseImageSize,
  UNMEASURED_IMAGE_WIDTH,
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

describe("parseImageSize", () => {
  test("parses common generation size strings", () => {
    expect(parseImageSize("1024x1024")).toBe(1)
    expect(parseImageSize("1792×1024")).toBeCloseTo(1.75)
  })

  test("falls back for invalid sizes", () => {
    expect(parseImageSize()).toBe(DEFAULT_IMAGE_ASPECT)
    expect(parseImageSize("square")).toBe(DEFAULT_IMAGE_ASPECT)
  })
})

describe("getChatImageWidth", () => {
  test("keeps image widths within the configured bounds", () => {
    expect(getChatImageWidth(200)).toBe(220)
    expect(getChatImageWidth(500)).toBe(320)
    expect(getChatImageWidth(600, 96, 144)).toBe(144)
  })
})

describe("fitChatImage", () => {
  test("a 16:9 screenshot fills a wide pane up to the max height", () => {
    const box = fitChatImage({
      naturalWidth: 1600,
      naturalHeight: 900,
      containerWidth: 900,
    })
    expect(box).toEqual({ width: 462, height: CHAT_IMAGE_MAX_HEIGHT, cropped: false })
    expect(box.width).toBeGreaterThan(220)
  })

  test("a 3:1 panorama is shown whole at the max width, not cropped to 2:1", () => {
    const box = fitChatImage({
      naturalWidth: 2400,
      naturalHeight: 800,
      containerWidth: 900,
    })
    expect(box).toEqual({ width: CHAT_IMAGE_MAX_WIDTH, height: 213, cropped: false })
  })

  test("a tall portrait stops at the max height and keeps its aspect", () => {
    const box = fitChatImage({
      naturalWidth: 900,
      naturalHeight: 1600,
      containerWidth: 900,
    })
    expect(box.height).toBe(CHAT_IMAGE_MAX_HEIGHT)
    expect(box.width).toBeCloseTo(146, 0)
    expect(box.cropped).toBe(false)
  })

  test("a very tall image is widened to the min width and cropped instead of becoming a sliver", () => {
    const box = fitChatImage({
      naturalWidth: 300,
      naturalHeight: 2400,
      containerWidth: 900,
    })
    expect(box).toEqual({ width: CHAT_IMAGE_MIN_WIDTH, height: CHAT_IMAGE_MAX_HEIGHT, cropped: true })
  })

  test("a narrow pane wins over the max width", () => {
    const box = fitChatImage({
      naturalWidth: 1600,
      naturalHeight: 900,
      containerWidth: 200,
    })
    expect(box).toEqual({ width: 200, height: 113, cropped: false })
  })

  test("a small image is not upscaled past its natural size", () => {
    const box = fitChatImage({
      naturalWidth: 120,
      naturalHeight: 80,
      containerWidth: 900,
    })
    expect(box).toEqual({ width: 120, height: 80, cropped: false })
  })

  test("unknown dimensions use the fallback aspect", () => {
    const box = fitChatImage({ containerWidth: 300 })
    expect(box.height).toBe(Math.round(300 / DEFAULT_IMAGE_ASPECT))
    expect(box.width).toBe(300)
  })

  test("an unmeasured pane keeps the old width so there is no jump to zero", () => {
    expect(fitChatImage({ naturalWidth: 1600, naturalHeight: 900 }).width).toBe(
      UNMEASURED_IMAGE_WIDTH,
    )
    expect(fitChatImage({ naturalWidth: 1600, naturalHeight: 900, containerWidth: 0 }).width).toBe(
      UNMEASURED_IMAGE_WIDTH,
    )
  })

  test("zero and negative dimensions fall back instead of producing a broken box", () => {
    const box = fitChatImage({
      naturalWidth: 0,
      naturalHeight: -10,
      containerWidth: -5,
    })
    expect(box.width).toBe(UNMEASURED_IMAGE_WIDTH)
    expect(box.height).toBe(
      Math.round(UNMEASURED_IMAGE_WIDTH / DEFAULT_IMAGE_ASPECT),
    )
    expect(Number.isFinite(box.width) && Number.isFinite(box.height)).toBe(true)
  })

  test("a caller can cap width and height for its own surface", () => {
    const box = fitChatImage({
      naturalWidth: 1920,
      naturalHeight: 1080,
      containerWidth: 900,
      maxWidth: 320,
      maxHeight: 360,
    })
    expect(box).toEqual({ width: 320, height: 180, cropped: false })
  })
})
