// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { isInQuietHours } from '../quiet-hours'

/**
 * Pin the clock so tests are deterministic regardless of when they run.
 * We use setSystemTime (bun:test built-in) to freeze Date at a known instant.
 *
 * Reference point: 2026-04-07 14:30 UTC  (which is 07:30 PDT / 23:30 JST)
 */
const FIXED_DATE = new Date('2026-04-07T14:30:00Z')

beforeEach(() => {
  setSystemTime(FIXED_DATE)
})

afterEach(() => {
  setSystemTime()
})

// ─── Null / missing inputs ──────────────────────────────────────────────────

describe('isInQuietHours — null / missing inputs', () => {
  test('returns false when both start and end are null', () => {
    expect(isInQuietHours(null, null, null)).toBe(false)
  })

  test('returns false when start is null', () => {
    expect(isInQuietHours(null, '06:00', 'UTC')).toBe(false)
  })

  test('returns false when end is null', () => {
    expect(isInQuietHours('22:00', null, 'UTC')).toBe(false)
  })
})

// ─── Same-day windows (startTime <= endTime) ────────────────────────────────
// Clock is frozen at 14:30 UTC

describe('isInQuietHours — same-day window', () => {
  test('returns true when current time is inside window', () => {
    // 14:00–15:00 UTC, clock is 14:30 → inside
    expect(isInQuietHours('14:00', '15:00', 'UTC')).toBe(true)
  })

  test('returns true when current time equals start (inclusive)', () => {
    // 14:30–16:00 UTC, clock is exactly 14:30 → inside (>=)
    expect(isInQuietHours('14:30', '16:00', 'UTC')).toBe(true)
  })

  test('returns false when current time equals end (exclusive)', () => {
    // 13:00–14:30 UTC, clock is exactly 14:30 → outside (<)
    expect(isInQuietHours('13:00', '14:30', 'UTC')).toBe(false)
  })

  test('returns false when current time is before window', () => {
    // 16:00–18:00 UTC, clock is 14:30 → outside
    expect(isInQuietHours('16:00', '18:00', 'UTC')).toBe(false)
  })

  test('returns false when current time is after window', () => {
    // 08:00–12:00 UTC, clock is 14:30 → outside
    expect(isInQuietHours('08:00', '12:00', 'UTC')).toBe(false)
  })
})

// ─── Overnight windows (startTime > endTime, wraps past midnight) ───────────
// Clock is frozen at 14:30 UTC

describe('isInQuietHours — overnight window', () => {
  test('returns true when current time is after start (before midnight)', () => {
    // 13:00–06:00 wraps overnight, clock is 14:30 → inside (>=13:00)
    expect(isInQuietHours('13:00', '06:00', 'UTC')).toBe(true)
  })

  test('returns false when current time is between end and start', () => {
    // 22:00–06:00 wraps overnight, clock is 14:30 → outside (between 06:00–22:00)
    expect(isInQuietHours('22:00', '06:00', 'UTC')).toBe(false)
  })

  test('returns true for early morning inside overnight window', () => {
    // Set clock to 03:00 UTC
    setSystemTime(new Date('2026-04-07T03:00:00Z'))
    // 22:00–06:00 wraps overnight, clock is 03:00 → inside (<06:00)
    expect(isInQuietHours('22:00', '06:00', 'UTC')).toBe(true)
  })

  test('returns true when time equals start of overnight window', () => {
    setSystemTime(new Date('2026-04-07T22:00:00Z'))
    // 22:00–06:00, clock is exactly 22:00 → inside (>=)
    expect(isInQuietHours('22:00', '06:00', 'UTC')).toBe(true)
  })

  test('returns false when time equals end of overnight window', () => {
    setSystemTime(new Date('2026-04-07T06:00:00Z'))
    // 22:00–06:00, clock is exactly 06:00 → outside (<)
    expect(isInQuietHours('22:00', '06:00', 'UTC')).toBe(false)
  })
})

// ─── Timezone handling ──────────────────────────────────────────────────────
// Clock is frozen at 14:30 UTC = 07:30 America/Los_Angeles (PDT)

describe('isInQuietHours — timezone handling', () => {
  test('uses timezone to compute local time', () => {
    // Clock is 14:30 UTC = 07:30 PDT
    // Window 07:00–08:00 in LA → 07:30 is inside
    expect(isInQuietHours('07:00', '08:00', 'America/Los_Angeles')).toBe(true)
  })

  test('respects timezone even when UTC would be different', () => {
    // Clock is 14:30 UTC = 07:30 PDT
    // Window 14:00–15:00 in LA → 07:30 is outside (that window is 14:00–15:00 local)
    expect(isInQuietHours('14:00', '15:00', 'America/Los_Angeles')).toBe(false)
  })

  test('defaults to UTC when timezone is null', () => {
    // Clock is 14:30 UTC, window 14:00–15:00 → inside (UTC used)
    expect(isInQuietHours('14:00', '15:00', null)).toBe(true)
  })

  test('falls back to UTC on invalid timezone string', () => {
    // Invalid tz triggers catch block → uses getUTCHours/getUTCMinutes
    // Clock is 14:30 UTC, window 14:00–15:00 → inside
    expect(isInQuietHours('14:00', '15:00', 'Invalid/Timezone_XYZ')).toBe(true)
  })

  test('falls back to UTC on invalid timezone — outside window', () => {
    // Clock is 14:30 UTC, window 16:00–18:00 → outside
    expect(isInQuietHours('16:00', '18:00', 'Invalid/Timezone_XYZ')).toBe(false)
  })
})

// ─── Malformed time strings ─────────────────────────────────────────────────

describe('isInQuietHours — malformed time strings', () => {
  test('missing minutes (e.g. "22") produces NaN — does not crash', () => {
    // "22".split(':') → ["22"], map(Number) → [22], destructure → startH=22, startM=undefined → NaN
    // startTime = 22*60 + NaN = NaN → comparisons with NaN are always false
    const result = isInQuietHours('22', '06:00', 'UTC')
    expect(typeof result).toBe('boolean')
  })

  test('non-numeric string (e.g. "foo:bar") produces NaN — does not crash', () => {
    const result = isInQuietHours('foo:bar', '06:00', 'UTC')
    expect(typeof result).toBe('boolean')
  })

  test('empty strings are treated as falsy — returns false', () => {
    // Empty string is falsy, so the early guard (!quietStart || !quietEnd) triggers
    expect(isInQuietHours('', '06:00', 'UTC')).toBe(false)
    expect(isInQuietHours('22:00', '', 'UTC')).toBe(false)
  })
})

// ─── Edge: start equals end ─────────────────────────────────────────────────

describe('isInQuietHours — start equals end', () => {
  test('start == end and current matches: treated as same-day, zero-width window → false', () => {
    // startTime == endTime → same-day branch → currentTime >= start && currentTime < end
    // since start == end, no value satisfies >= start && < end simultaneously UNLESS
    // currentTime == start (but then currentTime < end is false because start == end)
    setSystemTime(new Date('2026-04-07T14:00:00Z'))
    expect(isInQuietHours('14:00', '14:00', 'UTC')).toBe(false)
  })

  test('start == end and current does not match → false', () => {
    expect(isInQuietHours('10:00', '10:00', 'UTC')).toBe(false)
  })
})

// ─── Edge: midnight boundaries ──────────────────────────────────────────────

describe('isInQuietHours — midnight boundaries', () => {
  test('window 00:00–06:00, clock at 03:00 → inside', () => {
    setSystemTime(new Date('2026-04-07T03:00:00Z'))
    expect(isInQuietHours('00:00', '06:00', 'UTC')).toBe(true)
  })

  test('window 00:00–06:00, clock at 00:00 → inside', () => {
    setSystemTime(new Date('2026-04-07T00:00:00Z'))
    expect(isInQuietHours('00:00', '06:00', 'UTC')).toBe(true)
  })

  test('window 00:00–06:00, clock at 06:00 → outside', () => {
    setSystemTime(new Date('2026-04-07T06:00:00Z'))
    expect(isInQuietHours('00:00', '06:00', 'UTC')).toBe(false)
  })

  test('window 23:00–23:59, clock at 23:30 → inside', () => {
    setSystemTime(new Date('2026-04-07T23:30:00Z'))
    expect(isInQuietHours('23:00', '23:59', 'UTC')).toBe(true)
  })
})
