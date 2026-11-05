// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { isUrlOnOrigin } from "../same-origin-url"

describe("isUrlOnOrigin", () => {
  const base = "https://api.shogo.test"

  test("matches the origin itself and paths, queries and fragments under it", () => {
    expect(isUrlOnOrigin("https://api.shogo.test", base)).toBe(true)
    expect(isUrlOnOrigin("https://api.shogo.test/api/files/1?t=sig", base)).toBe(true)
    expect(isUrlOnOrigin("https://api.shogo.test?x=1", base)).toBe(true)
    expect(isUrlOnOrigin("https://API.shogo.test/a", base)).toBe(true)
  })

  test("ignores a trailing slash on the base", () => {
    expect(isUrlOnOrigin("https://api.shogo.test/a", "https://api.shogo.test/")).toBe(true)
  })

  test("rejects other hosts, lookalikes and userinfo tricks", () => {
    expect(isUrlOnOrigin("https://evil.test/a.mp4", base)).toBe(false)
    expect(isUrlOnOrigin("https://api.shogo.test.evil.test/a.mp4", base)).toBe(false)
    expect(isUrlOnOrigin("https://api.shogo.test@evil.test/a.mp4", base)).toBe(false)
    expect(isUrlOnOrigin("http://api.shogo.test/a.mp4", base)).toBe(false)
    expect(isUrlOnOrigin("https://api.shogo.test:8443/a.mp4", base)).toBe(false)
  })

  test("rejects everything without a base", () => {
    expect(isUrlOnOrigin("https://api.shogo.test/a", undefined)).toBe(false)
    expect(isUrlOnOrigin("https://api.shogo.test/a", "")).toBe(false)
  })
})
