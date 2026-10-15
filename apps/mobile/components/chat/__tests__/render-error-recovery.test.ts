// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import type { ChatTurnStatus } from "../probe-turn-status"
import {
  decideRenderErrorRecovery,
  MAX_SNAPSHOT_REATTACHES,
  pollUntilTerminal,
} from "../render-error-recovery"

describe("decideRenderErrorRecovery", () => {
  test("active turn: re-attach through the snapshot once, then wait and reload", () => {
    expect(decideRenderErrorRecovery({ turnStatus: "active", reattachAttempts: 0 })).toBe("reattach-snapshot")
    expect(
      decideRenderErrorRecovery({ turnStatus: "active", reattachAttempts: MAX_SNAPSHOT_REATTACHES }),
    ).toBe("poll-then-reload")
  })

  test("finished turn reloads the persisted messages (never a new turn)", () => {
    for (const turnStatus of ["completed", "failed", "aborted"] as const) {
      expect(decideRenderErrorRecovery({ turnStatus, reattachAttempts: 0 })).toBe("reload")
    }
  })

  test("unknown status waits for the turn to settle", () => {
    expect(decideRenderErrorRecovery({ turnStatus: "unknown", reattachAttempts: 0 })).toBe("poll-then-reload")
  })
})

function scripted(statuses: ChatTurnStatus[]) {
  let i = 0
  const calls = { probes: 0, sleeps: [] as number[] }
  return {
    calls,
    probe: async () => {
      calls.probes++
      return statuses[Math.min(i++, statuses.length - 1)]
    },
    sleep: async (ms: number) => {
      calls.sleeps.push(ms)
    },
  }
}

describe("pollUntilTerminal", () => {
  test("polls an active turn with backoff until it completes", async () => {
    const s = scripted(["active", "active", "active", "completed"])
    const r = await pollUntilTerminal({ probe: s.probe, sleep: s.sleep, isCancelled: () => false })
    expect(r).toEqual({ outcome: "terminal", turnStatus: "completed" })
    expect(s.calls.probes).toBe(4)
    expect(s.calls.sleeps).toEqual([1_000, 2_000, 4_000])
  })

  test("a run of unknown (buffer evicted after the turn ended) counts as finished", async () => {
    const s = scripted(["active", "unknown", "unknown", "unknown", "unknown"])
    const r = await pollUntilTerminal({ probe: s.probe, sleep: s.sleep, isCancelled: () => false })
    expect(r).toEqual({ outcome: "terminal", turnStatus: "completed" })
    expect(s.calls.probes).toBe(5)
  })

  test("an active probe resets the unknown run", async () => {
    const s = scripted(["unknown", "unknown", "active", "unknown", "unknown", "unknown", "failed"])
    const r = await pollUntilTerminal({
      probe: s.probe,
      sleep: s.sleep,
      isCancelled: () => false,
      unknownIsTerminalAfter: 3,
    })
    expect(r).toEqual({ outcome: "terminal", turnStatus: "completed" })
    expect(s.calls.probes).toBe(6)
  })

  test("a throwing probe is treated as unknown", async () => {
    let n = 0
    const r = await pollUntilTerminal({
      probe: async () => {
        n++
        if (n === 1) throw new Error("network")
        return "aborted"
      },
      sleep: async () => {},
      isCancelled: () => false,
    })
    expect(r).toEqual({ outcome: "terminal", turnStatus: "aborted" })
  })

  test("cancellation stops polling", async () => {
    let cancelled = false
    const s = scripted(["active"])
    const r = await pollUntilTerminal({
      probe: async () => {
        cancelled = true
        return s.probe()
      },
      sleep: s.sleep,
      isCancelled: () => cancelled,
    })
    expect(r).toEqual({ outcome: "cancelled" })
  })

  test("aborting the signal ends a pending backoff sleep right away", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const poll = pollUntilTerminal({
      probe: async () => "active",
      isCancelled: () => false,
      signal: controller.signal,
    })
    // The first backoff sleep is 1s; abort well before it would end.
    setTimeout(() => controller.abort(), 20)
    expect(await poll).toEqual({ outcome: "cancelled" })
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("gives up after maxWaitMs while the turn stays active", async () => {
    let t = 0
    const s = scripted(["active"])
    const r = await pollUntilTerminal({
      probe: s.probe,
      sleep: async (ms) => {
        t += ms
      },
      now: () => t,
      maxWaitMs: 30_000,
      isCancelled: () => false,
    })
    expect(r).toEqual({ outcome: "timeout", turnStatus: "active" })
  })
})
