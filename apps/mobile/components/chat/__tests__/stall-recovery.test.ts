// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the pure auto-recovery decision behind ChatPanel's stall handler.
 *
 * Headline behavior locked down here (the reported bug — must not come back):
 *
 *   A turn that ends WITHOUT `data-turn-complete` while the server is still
 *   streaming used to strand the user on a static "tap Retry" banner. The fix
 *   auto-probes `/turn` and, when the runtime reports the turn is still
 *   `active`, automatically reconnects to the live buffer (no re-send, no
 *   truncation). Only genuinely-terminal / persistently-unknown turns fall
 *   through to the manual banner.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/stall-recovery.test.ts
 */
import { describe, expect, test } from "bun:test"
import { computeRecoveryBackoff, decideStallRecovery, decideStallGiveUpAction } from "../stall-recovery"

describe("decideStallRecovery", () => {
  test("active turn -> reconnect (agent still running, transport drop)", () => {
    // Regardless of which attempt we're on, an active server turn always
    // reconnects — that's the whole point of auto-recovery.
    expect(decideStallRecovery({ turnStatus: "active", attempt: 1, maxAttempts: 5 })).toBe("reconnect")
    expect(decideStallRecovery({ turnStatus: "active", attempt: 5, maxAttempts: 5 })).toBe("reconnect")
  })

  test("unknown with attempts remaining -> retry-later (buffer may not be published yet)", () => {
    expect(decideStallRecovery({ turnStatus: "unknown", attempt: 1, maxAttempts: 5 })).toBe("retry-later")
    expect(decideStallRecovery({ turnStatus: "unknown", attempt: 4, maxAttempts: 5 })).toBe("retry-later")
  })

  test("unknown on the final attempt -> give-up (fall through to manual banner)", () => {
    expect(decideStallRecovery({ turnStatus: "unknown", attempt: 5, maxAttempts: 5 })).toBe("give-up")
    // Defensive: an attempt past the budget also gives up.
    expect(decideStallRecovery({ turnStatus: "unknown", attempt: 6, maxAttempts: 5 })).toBe("give-up")
  })

  test("terminal statuses -> give-up immediately (history already reflects them)", () => {
    for (const turnStatus of ["completed", "failed", "aborted"] as const) {
      // Terminal turns never retry — even on the first attempt.
      expect(decideStallRecovery({ turnStatus, attempt: 1, maxAttempts: 5 })).toBe("give-up")
    }
  })

  test("never re-sends or truncates: the only non-give-up branches are reconnect/retry-later", () => {
    const actions = (["active", "completed", "failed", "aborted", "unknown"] as const).map((turnStatus) =>
      decideStallRecovery({ turnStatus, attempt: 1, maxAttempts: 3 }),
    )
    // 'resend'/'continue' belong to MANUAL retry only — auto-recovery must
    // never silently restart a turn behind the user's back.
    expect(actions).not.toContain("resend" as never)
    expect(actions).not.toContain("continue" as never)
  })
})

describe("decideStallGiveUpAction", () => {
  test("non-user-initiated unknown/terminal turn -> fail-closed", () => {
    for (const turnStatus of ["unknown", "completed", "failed", "aborted"] as const) {
      expect(decideStallGiveUpAction({ turnStatus, userInitiatedStop: false })).toBe("fail-closed")
    }
  })

  test("active or user-stopped turn -> ignore", () => {
    expect(decideStallGiveUpAction({ turnStatus: "active", userInitiatedStop: false })).toBe("ignore")
    expect(decideStallGiveUpAction({ turnStatus: "unknown", userInitiatedStop: true })).toBe("ignore")
  })
})

describe("computeRecoveryBackoff", () => {
  test("first attempt returns the initial delay", () => {
    expect(computeRecoveryBackoff(1, { initialMs: 600, maxMs: 5_000 })).toBe(600)
  })

  test("grows exponentially and caps at maxMs", () => {
    expect(computeRecoveryBackoff(2, { initialMs: 600, maxMs: 5_000 })).toBe(1_200)
    expect(computeRecoveryBackoff(3, { initialMs: 600, maxMs: 5_000 })).toBe(2_400)
    expect(computeRecoveryBackoff(4, { initialMs: 600, maxMs: 5_000 })).toBe(4_800)
    // Attempt 5 would be 9_600 -> capped at 5_000.
    expect(computeRecoveryBackoff(5, { initialMs: 600, maxMs: 5_000 })).toBe(5_000)
  })

  test("uses sane defaults and never returns a negative/zero-attempt delay", () => {
    expect(computeRecoveryBackoff(1)).toBe(600)
    // Defensive: attempt <= 0 is clamped to attempt 1.
    expect(computeRecoveryBackoff(0)).toBe(600)
    expect(computeRecoveryBackoff(-3)).toBe(600)
  })
})
