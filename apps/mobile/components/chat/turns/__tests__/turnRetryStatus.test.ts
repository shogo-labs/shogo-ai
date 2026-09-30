// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import {
  describeRetryStatus,
  formatRetryElapsed,
  resolveTurnRetryStatus,
  retryStage,
} from "../turnRetryStatus"

describe("resolveTurnRetryStatus", () => {
  test("nothing retrying → null", () => {
    expect(resolveTurnRetryStatus(null, null)).toBeNull()
  })

  test("a client-side failure wins over a stale runtime heartbeat", () => {
    const status = resolveTurnRetryStatus(
      { cause: "provider", reason: "overloaded", startedAt: 1 },
      { offline: true, startedAt: 2 },
    )
    expect(status).toEqual({ cause: "offline", startedAt: 2 })
  })

  test("client can't reach the server while online → server", () => {
    expect(resolveTurnRetryStatus(null, { offline: false, startedAt: 5 })?.cause).toBe("server")
  })

  test("runtime connectivity park → server; provider backoff → provider", () => {
    expect(resolveTurnRetryStatus({ cause: "offline", startedAt: 1 }, null)?.cause).toBe("server")
    expect(
      resolveTurnRetryStatus({ cause: "provider", reason: "overloaded", startedAt: 1, suspectedDeterministic: true }, null),
    ).toEqual({ cause: "provider", reason: "overloaded", startedAt: 1, suspectedDeterministic: true })
  })
})

describe("retry staging", () => {
  test("stage boundaries", () => {
    expect(retryStage(0)).toBe("silent")
    expect(retryStage(4_999)).toBe("silent")
    expect(retryStage(5_000)).toBe("reconnecting")
    expect(retryStage(29_999)).toBe("reconnecting")
    expect(retryStage(30_000)).toBe("detailed")
    expect(retryStage(120_000)).toBe("long")
  })

  test("5–30s: a plain Reconnecting…, no actions", () => {
    const view = describeRetryStatus({ cause: "server", startedAt: 0 }, 10_000)
    expect(view).toEqual({
      stage: "reconnecting",
      headline: "Reconnecting\u2026",
      showRetryNow: false,
      suggestSwitchModel: false,
    })
  })

  test("30s+: cause-specific headline, elapsed time and Retry now", () => {
    const view = describeRetryStatus({ cause: "offline", startedAt: 0 }, 65_000)
    expect(view.headline).toBe("You're offline")
    expect(view.trailing).toBe("\u2014 will resume when you're back online \u00B7 1m 5s")
    expect(view.showRetryNow).toBe(true)
    expect(view.suggestSwitchModel).toBe(false)
  })

  test("2m+ on overload suggests switching models", () => {
    const view = describeRetryStatus({ cause: "provider", reason: "overloaded", startedAt: 0 }, 130_000)
    expect(view.headline).toBe("The model is overloaded")
    expect(view.suggestSwitchModel).toBe(true)
  })

  test("2m+ offline adds a connection hint instead", () => {
    const view = describeRetryStatus({ cause: "offline", startedAt: 0 }, 130_000)
    expect(view.suggestSwitchModel).toBe(false)
    expect(view.detail).toContain("connection")
  })

  test("repeated identical failures say so", () => {
    const view = describeRetryStatus({ cause: "provider", startedAt: 0, suspectedDeterministic: true }, 40_000)
    expect(view.detail).toContain("keeps failing the same way")
  })

  test("formatRetryElapsed", () => {
    expect(formatRetryElapsed(0)).toBe("0s")
    expect(formatRetryElapsed(59_999)).toBe("59s")
    expect(formatRetryElapsed(61_000)).toBe("1m 1s")
  })
})
