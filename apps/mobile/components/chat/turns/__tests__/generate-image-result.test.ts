// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import {
  getGenerateImagePaths,
  parseGenerateImageResult,
} from "../generate-image-result"

describe("generate image result", () => {
  test("prefers all returned paths for multi-option generation", () => {
    const result = parseGenerateImageResult({
      path: "images/generated-1.png",
      paths: ["images/generated-1.png", "images/generated-2.png"],
    })
    expect(getGenerateImagePaths(result)).toEqual([
      "images/generated-1.png",
      "images/generated-2.png",
    ])
  })

  test("keeps compatibility with single-image results", () => {
    const result = parseGenerateImageResult('{"path":"images/one.png"}')
    expect(getGenerateImagePaths(result)).toEqual(["images/one.png"])
  })
})
