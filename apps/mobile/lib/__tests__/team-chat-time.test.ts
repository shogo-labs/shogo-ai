// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { formatFullTime, formatShortTime } from "../team-chat-time"

describe("formatShortTime", () => {
  test("has no AM/PM marker", () => {
    const iso = new Date(2026, 9, 5, 22, 13, 22).toISOString()
    const short = formatShortTime(iso)
    expect(short).not.toMatch(/[AaPp]\.?[Mm]/)
    expect(short).toMatch(/^\d{1,2}[:.]13$/)
  })
})

describe("formatFullTime", () => {
  const now = new Date(2026, 9, 5, 23, 0, 0)

  test("today includes seconds", () => {
    const iso = new Date(2026, 9, 5, 22, 13, 22).toISOString()
    const full = formatFullTime(iso, now)
    expect(full.startsWith("Today at ")).toBe(true)
    expect(full).toContain("22")
  })

  test("yesterday", () => {
    const iso = new Date(2026, 9, 4, 9, 0, 5).toISOString()
    expect(formatFullTime(iso, now).startsWith("Yesterday at ")).toBe(true)
  })

  test("older dates show the day", () => {
    const iso = new Date(2026, 8, 1, 9, 0, 5).toISOString()
    const full = formatFullTime(iso, now)
    expect(full).toContain(" at ")
    expect(full.startsWith("Today") || full.startsWith("Yesterday")).toBe(false)
  })
})
