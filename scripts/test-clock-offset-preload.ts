// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shift the test process's clock forward by `SHOGO_TEST_CLOCK_OFFSET_DAYS`.
 *
 * `bun test --preload` this file to run a suite as if it were N days in the
 * future. A test that passes today and fails here is a time bomb: nothing in
 * the code changed, the calendar did. `.github/workflows/future-clock.yml` runs
 * the unit suites at +7/+30/+90 with this preload when the runner's
 * libfaketime-backed clock is not honoured by Bun (a vDSO-backed `Date` ignores
 * `LD_PRELOAD`), so both paths have to shift the same things:
 *
 *   - `Date.now()`
 *   - `new Date()` with no arguments
 *   - `performance.timeOrigin`-relative time is NOT shifted (it is a duration)
 *
 * Everything else must keep working, and in particular a test that pins the
 * clock itself must still win:
 *
 *   - `new Date('2026-11-18T00:00:00Z')` / `Date.UTC(…)` / `Date.parse(…)` are
 *     untouched — an explicit argument is never shifted.
 *   - a tick count, not a frozen instant: the offset tracks elapsed real time,
 *     so `setTimeout`, backoff and duration assertions behave as they do today.
 *   - `setSystemTime(…)` from `bun:test` REPLACES the underlying clock, so while
 *     the real clock disagrees with `performance.now()` we stop adding the
 *     offset and call straight through. Without this, a properly pinned test
 *     would read pinned+offset and the nightly would report it as a bomb. The
 *     disagreement is re-checked on every read, so `setSystemTime()` with no
 *     argument — the documented way to restore the real clock — hands the clock
 *     back to the preload and later tests are shifted again.
 *
 * Unset (or `0`) `SHOGO_TEST_CLOCK_OFFSET_DAYS` makes this a no-op, so the
 * preload can be wired into the runner unconditionally.
 */

const OFFSET_DAYS = Number(process.env.SHOGO_TEST_CLOCK_OFFSET_DAYS ?? '0')

/** How far the real clock may drift from monotonic time before we call it pinned. */
const PIN_TOLERANCE_MS = 2000

if (Number.isFinite(OFFSET_DAYS) && OFFSET_DAYS !== 0) {
  const RealDate = globalThis.Date
  const offsetMs = OFFSET_DAYS * 24 * 60 * 60 * 1000
  const realStart = RealDate.now()
  const perfStart = performance.now()

  const shiftedNow = (): number => {
    const real = RealDate.now()
    const expected = realStart + (performance.now() - perfStart)
    // `setSystemTime` moved the clock under us: the test owns it now. This is
    // re-checked on every read rather than latched, so `setSystemTime()` with
    // no argument (the documented way to restore the real clock) hands the
    // clock back to the preload. A latch would leave every later test in the
    // process reading real time while its fixtures were stamped shifted, which
    // is how a pinned clock in one test poisons the whole file.
    if (Math.abs(real - expected) > PIN_TOLERANCE_MS) return real
    return real + offsetMs
  }

  const OffsetDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(shiftedNow())
      } else {
        // An explicit argument (a literal, a timestamp, a Date) is never shifted.
        super(...(args as [number]))
      }
    }

    static now(): number {
      return shiftedNow()
    }
  } as unknown as DateConstructor

  Object.defineProperty(OffsetDate, 'name', { value: 'Date' })
  Object.defineProperty(globalThis, 'Date', { value: OffsetDate, writable: true, configurable: true })

  if (process.env.SHOGO_TEST_CLOCK_VERBOSE === '1') {
    console.log(
      `[test-clock] clock shifted +${OFFSET_DAYS}d (now ${new RealDate(shiftedNow()).toISOString()}, real ${new RealDate(realStart).toISOString()})`,
    )
  }
}
