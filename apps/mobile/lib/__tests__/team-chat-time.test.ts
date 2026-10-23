// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { dayKey, formatDayDivider, formatFullTime, formatShortTime } from "../team-chat-time"

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

describe("dayKey", () => {
  test("grouping is by calendar day, not by elapsed hours", () => {
    // 23:50 and 00:10 are ten minutes apart but land on different days.
    const late = new Date(2026, 9, 5, 23, 50, 0).toISOString()
    const early = new Date(2026, 9, 6, 0, 10, 0).toISOString()
    expect(dayKey(late)).not.toBe(dayKey(early))

    const morning = new Date(2026, 9, 5, 1, 0, 0).toISOString()
    expect(dayKey(late)).toBe(dayKey(morning))
  })
})

describe("formatDayDivider", () => {
  const now = new Date(2026, 9, 5, 23, 0, 0)

  test("today and yesterday are named", () => {
    expect(formatDayDivider(new Date(2026, 9, 5, 0, 1, 0).toISOString(), now)).toBe("Today")
    expect(formatDayDivider(new Date(2026, 9, 4, 23, 59, 0).toISOString(), now)).toBe("Yesterday")
  })

  test("an earlier day this year is spelled out without the year", () => {
    const label = formatDayDivider(new Date(2026, 8, 1, 9, 0, 0).toISOString(), now)
    expect(label).toContain("September")
    expect(label).toContain("1")
    expect(label).not.toContain("2026")
  })

  test("a different year carries the year", () => {
    const label = formatDayDivider(new Date(2025, 11, 24, 9, 0, 0).toISOString(), now)
    expect(label).toContain("2025")
  })

  test("midnight belongs to the day that follows it, not the one before", () => {
    // A send at 00:00 reads as the new day, never as the 23:xx evening before.
    expect(formatDayDivider(new Date(2026, 9, 5, 0, 0, 0).toISOString(), now)).toBe("Today")
  })
})
