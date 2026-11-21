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
import {
  computeRecoveryBackoff,
  decideStallRecovery,
  decideStallGiveUp,
  MAX_RECOVERIES_PER_TURN,
  decideStallTrip,
  DEFAULT_STALL_KEEP_ALIVES,
  getStallRecoveryEffects,
  markStuckToolsInterrupted,
  shouldAutoRecoverStalledTurn,
  turnEndedOnServer,
} from "../stall-recovery"

describe("decideStallRecovery", () => {
  test("does not replay a turn that already failed with React update-depth", () => {
    expect(
      shouldAutoRecoverStalledTurn({
        stalledTurnId: "turn-185",
        recoveredTurnId: null,
        renderDepthErrorTurnId: "turn-185",
        userInitiatedStop: false,
      }),
    ).toBe(false)
  })

  test("still auto-recovers an ordinary transport stall once", () => {
    expect(
      shouldAutoRecoverStalledTurn({
        stalledTurnId: "turn-network",
        recoveredTurnId: null,
        renderDepthErrorTurnId: null,
        userInitiatedStop: false,
      }),
    ).toBe(true)
  })

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

  test("give-up interrupts stuck tools and exposes the retry banner", () => {
    expect(
      getStallRecoveryEffects({
        turnStatus: "unknown",
        attempt: 5,
        maxAttempts: 5,
      }),
    ).toEqual({
      action: "give-up",
      interruptStuckTools: true,
      showRetryBanner: true,
    })
  })

  test("active recovery keeps tool parts live", () => {
    expect(
      getStallRecoveryEffects({
        turnStatus: "active",
        attempt: 1,
        maxAttempts: 5,
      }),
    ).toMatchObject({
      action: "reconnect",
      interruptStuckTools: false,
      showRetryBanner: false,
    })
  })

  test("stuck input-available tools become terminal errors", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "call-1",
          },
        ],
      },
    ]
    expect(markStuckToolsInterrupted(messages, "Connection interrupted")[0]?.parts?.[0])
      .toMatchObject({
        state: "error",
        output: { error: "Connection interrupted" },
      })
  })
})

describe("decideStallTrip", () => {
  // The watchdog used to call stop() the moment client-side time crossed the
  // threshold. Every recorded trip sat at ~133 s against the 120 s `submitted`
  // threshold — exactly a healthy turn that had not written a byte yet — and
  // stop() on a live turn is what the person saw as "Runtime unreachable".
  test("a turn the runtime still runs is never aborted", () => {
    expect(decideStallTrip({ turnStatus: "active", answered: true })).toBe(
      "stay-attached",
    )
    // Budget is configurable; the default is one fresh window.
    expect(
      decideStallTrip({ turnStatus: "active", answered: true, keptAlive: 3, maxKeptAlive: 5 }),
    ).toBe("stay-attached")
  })

  test("a live turn whose body delivers nothing for a second window is reattached, not killed", () => {
    const decision = decideStallTrip({
      turnStatus: "active",
      answered: true,
      keptAlive: DEFAULT_STALL_KEEP_ALIVES,
    })
    expect(decision).toBe("stop-and-reattach")
    // Reattaching is the recovery path, so it must not sound like a give-up.
    expect(decision).not.toBe("stop")
  })

  test("a turn that already ended server-side reloads history instead of stopping with a banner", () => {
    for (const turnStatus of ["completed", "failed", "aborted"] as const) {
      expect(decideStallTrip({ turnStatus, answered: true })).toBe(
        "stop-and-reload",
      )
    }
  })

  test("a terminal status the probe could not actually read is not evidence the turn ended", () => {
    // A failed probe collapses to `unknown`; even if something claims a
    // terminal status without an answer, the panel must not pretend the reply
    // is on its way to the screen.
    expect(decideStallTrip({ turnStatus: "unknown", answered: false })).toBe("stop")
    expect(decideStallTrip({ turnStatus: "completed", answered: false })).toBe(
      "stop",
    )
  })

  test("a runtime that answers 'no turn here' paints saved history instead of the banner (SHO-483)", () => {
    expect(decideStallTrip({ turnStatus: "unknown", answered: true })).toBe("stop-and-verify")
  })

  test("turnEndedOnServer only covers the statuses the runtime reports for a finished turn", () => {
    for (const turnStatus of ["completed", "failed", "aborted"] as const) {
      expect(turnEndedOnServer(turnStatus)).toBe(true)
    }
    for (const turnStatus of ["active", "unknown"] as const) {
      expect(turnEndedOnServer(turnStatus)).toBe(false)
    }
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

describe("decideStallGiveUp (SHO-483)", () => {
  test("an unanswered poll still offers Retry: the runtime may be running the turn", () => {
    expect(decideStallGiveUp({ turnStatus: "unknown", answered: false })).toBe("show-retry")
  })

  test("a terminal answer reloads history", () => {
    for (const turnStatus of ["completed", "failed", "aborted"] as const) {
      expect(decideStallGiveUp({ turnStatus, answered: true })).toBe("reload-history")
    }
  })

  test("an answered 'no turn here' reloads and only then decides on Retry", () => {
    // Sentry chat_stall_recovery_gave_up with probeAnswered=true: the runtime
    // answered all 12 probes with 404/204 and the banner went up anyway.
    expect(decideStallGiveUp({ turnStatus: "unknown", answered: true })).toBe(
      "reload-then-check-reply",
    )
  })
})

describe("shouldAutoRecoverStalledTurn — a second drop in the same turn (SHO-483)", () => {
  const base = {
    stalledTurnId: "turn-1",
    recoveredTurnId: "turn-1",
    renderDepthErrorTurnId: null,
    userInitiatedStop: false,
  }

  test("recovers again when the last recovery delivered frames", () => {
    expect(
      shouldAutoRecoverStalledTurn({ ...base, recoveriesThisTurn: 1, seqAtLastRecovery: 1200, lastSeq: 3343 }),
    ).toBe(true)
  })

  test("does not loop on a turn the last recovery could not move", () => {
    expect(
      shouldAutoRecoverStalledTurn({ ...base, recoveriesThisTurn: 1, seqAtLastRecovery: 3343, lastSeq: 3343 }),
    ).toBe(false)
  })

  test("stops at the per-turn budget", () => {
    expect(
      shouldAutoRecoverStalledTurn({
        ...base,
        recoveriesThisTurn: MAX_RECOVERIES_PER_TURN,
        seqAtLastRecovery: 1,
        lastSeq: 9999,
      }),
    ).toBe(false)
  })

  test("without progress data it keeps the old once-per-turn rule", () => {
    expect(shouldAutoRecoverStalledTurn(base)).toBe(false)
  })
})
