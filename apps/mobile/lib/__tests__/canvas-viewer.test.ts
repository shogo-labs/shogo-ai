// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { canvasViewerPayload } from "../canvas-viewer"

describe("canvasViewerPayload", () => {
  test("marks native phone and narrow web as phone", () => {
    expect(canvasViewerPayload({ isPhoneViewport: true, platform: "ios", width: 390 })).toEqual({
      formFactor: "phone",
      platform: "ios",
      width: 390,
    })
  })

  test("marks desktop studio as desktop", () => {
    expect(canvasViewerPayload({ isPhoneViewport: false, platform: "web", width: 1440 })).toEqual({
      formFactor: "desktop",
      platform: "web",
      width: 1440,
    })
  })

  test("rounds and clamps unusable widths", () => {
    expect(canvasViewerPayload({ isPhoneViewport: true, platform: "ios", width: 389.6 }).width).toBe(390)
    expect(canvasViewerPayload({ isPhoneViewport: true, platform: "ios", width: 0 }).width).toBe(1)
    expect(canvasViewerPayload({ isPhoneViewport: false, platform: "web", width: Number.NaN }).width).toBe(1)
  })
})
