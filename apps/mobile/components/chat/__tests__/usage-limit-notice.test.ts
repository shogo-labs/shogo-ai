// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The usage-limit dock in ChatPanel. A 402 that refuses a message before the
 * turn starts used to fall through to the generic "Error" dock with only a
 * Retry button; it now gets the same Upgrade dock as a limit hit mid-turn.
 *
 * Run: bun test apps/mobile/components/chat/__tests__/usage-limit-notice.test.ts
 */
// @ts-ignore Bun resolves this module at test runtime; app tsconfig does not include Bun ambient types.
import { describe, expect, test } from "bun:test"
import { usageLimitNoticeFor } from "../usage-limit-notice"

const formatResetsAt = (d: Date) => d.toISOString()

describe("usageLimitNoticeFor", () => {
  test("a refused message shows Upgrade and Retry, with the reset time", () => {
    const notice = usageLimitNoticeFor({
      error: JSON.stringify({
        error: {
          code: "usage_limit_reached",
          message: "You've reached your usage limit.",
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      }),
      errorDismissed: false,
      stoppedTurn: null,
      currentSessionId: "s-1",
      formatResetsAt,
    })
    expect(notice).toMatchObject({
      variant: "blocked",
      title: "Usage limit reached",
      primaryLabel: "Upgrade",
      secondaryLabel: "Retry",
    })
    expect(notice!.body).toContain("wasn't sent")
    expect(notice!.body).toContain("2099-01-01T00:00:00.000Z")
    // The reset time leads, so a hard limit reads as temporary.
    expect(notice!.body.indexOf("resets")).toBeLessThan(notice!.body.indexOf("Upgrade"))
  })

  test("offers the free Business trial at the block when the user is still eligible", () => {
    const notice = usageLimitNoticeFor({
      error: JSON.stringify({
        error: {
          code: "usage_limit_reached",
          message: "You've reached your usage limit.",
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      }),
      errorDismissed: false,
      stoppedTurn: null,
      currentSessionId: "s-1",
      trialEligible: true,
      formatResetsAt,
    })
    expect(notice).toMatchObject({ primaryLabel: "Start free trial", secondaryLabel: "Retry" })
    expect(notice!.body).toContain("7-day free Business trial")
    expect(notice!.body).not.toContain("Upgrade to keep going")
  })

  test("an ineligible user keeps the Upgrade CTA", () => {
    const notice = usageLimitNoticeFor({
      error: JSON.stringify({ error: { code: "usage_limit_reached" } }),
      errorDismissed: false,
      stoppedTurn: null,
      currentSessionId: "s-1",
      trialEligible: false,
      formatResetsAt,
    })
    expect(notice!.primaryLabel).toBe("Upgrade")
  })

  test("billing problems point at Billing rather than an upgrade", () => {
    for (const code of ["entitlement_expired", "overage_cap_reached", "overage_payment_pending"]) {
      const notice = usageLimitNoticeFor({
        error: JSON.stringify({ error: { code } }),
        errorDismissed: false,
        stoppedTurn: null,
        currentSessionId: "s-1",
        formatResetsAt,
      })
      expect(notice).toMatchObject({ variant: "blocked", primaryLabel: "Open billing", secondaryLabel: "Retry" })
    }
  })

  test("a limit hit mid-turn leads with billing, not with Continue", () => {
    const notice = usageLimitNoticeFor({
      error: null,
      errorDismissed: false,
      stoppedTurn: { sessionId: "s-1", resetsAt: "2099-01-01T00:00:00.000Z" },
      currentSessionId: "s-1",
      formatResetsAt,
    })
    expect(notice).toMatchObject({ variant: "stopped", primaryLabel: "Upgrade", secondaryLabel: "Continue" })
    expect(notice!.body).toContain("completed work is saved")
    expect(notice!.body).toContain("2099-01-01T00:00:00.000Z")
    // No copy anywhere may tell the user to type "continue" (SHO-121).
    expect(notice!.body.toLowerCase()).not.toContain("tap continue")
    expect(notice!.body.toLowerCase()).not.toContain('type "continue"')
  })

  test("nothing for other errors, dismissed errors, or another session's limit", () => {
    const base = { stoppedTurn: null, currentSessionId: "s-1", formatResetsAt }
    expect(usageLimitNoticeFor({ ...base, error: '{"error":{"code":"pod_unavailable"}}', errorDismissed: false })).toBeNull()
    expect(usageLimitNoticeFor({ ...base, error: '{"error":{"code":"usage_limit_reached"}}', errorDismissed: true })).toBeNull()
    expect(
      usageLimitNoticeFor({ ...base, error: null, errorDismissed: false, stoppedTurn: { sessionId: "s-2" } }),
    ).toBeNull()
  })

  // SHO-614: a first build can hit the cap before it finishes, and the free way
  // out for a brand-new account is verifying the email, not paying.
  describe("verify for credit (SHO-614)", () => {
    const unverified = { promoPendingUsd: 8, emailVerified: false }

    test("leads the blocked copy with verify-for-$8 and its own CTA", () => {
      const notice = usageLimitNoticeFor({
        error: JSON.stringify({
          error: {
            code: "usage_limit_reached",
            message: "You've reached your usage limit.",
            resetsAt: "2099-01-01T00:00:00.000Z",
          },
        }),
        errorDismissed: false,
        stoppedTurn: null,
        currentSessionId: "s-1",
        trialEligible: true,
        ...unverified,
        formatResetsAt,
      })
      expect(notice).toMatchObject({
        variant: "blocked",
        primaryLabel: "Verify email",
        secondaryLabel: "Retry",
      })
      expect(notice!.body.startsWith("Verify your email to unlock $8 more credit.")).toBe(true)
      // The reset time and retry still explain what happened.
      expect(notice!.body).toContain("resets")
      expect(notice!.body).toContain("wasn't sent")
    })

    test("leads the stopped copy the same way", () => {
      const notice = usageLimitNoticeFor({
        error: null,
        errorDismissed: false,
        stoppedTurn: { sessionId: "s-1", resetsAt: "2099-01-01T00:00:00.000Z" },
        currentSessionId: "s-1",
        ...unverified,
        formatResetsAt,
      })
      expect(notice).toMatchObject({ variant: "stopped", primaryLabel: "Verify email" })
      expect(notice!.body.startsWith("Verify your email to unlock $8 more credit.")).toBe(true)
      expect(notice!.body).toContain("completed work is saved")
    })

    test("uses the amount from the plan, not a hardcoded 8", () => {
      const notice = usageLimitNoticeFor({
        error: JSON.stringify({ error: { code: "usage_limit_reached" } }),
        errorDismissed: false,
        stoppedTurn: null,
        currentSessionId: "s-1",
        promoPendingUsd: 12.5,
        emailVerified: false,
        formatResetsAt,
      })
      expect(notice!.body).toContain("unlock $12.50 more credit")
    })

    test("a verified email keeps the trial/upgrade copy unchanged", () => {
      const notice = usageLimitNoticeFor({
        error: JSON.stringify({ error: { code: "usage_limit_reached" } }),
        errorDismissed: false,
        stoppedTurn: null,
        currentSessionId: "s-1",
        trialEligible: true,
        promoPendingUsd: 8,
        emailVerified: true,
        formatResetsAt,
      })
      expect(notice).toMatchObject({ primaryLabel: "Start free trial" })
      expect(notice!.body).not.toContain("Verify your email")
    })

    test("no pending credit means no verify copy, even when unverified", () => {
      const notice = usageLimitNoticeFor({
        error: JSON.stringify({ error: { code: "usage_limit_reached" } }),
        errorDismissed: false,
        stoppedTurn: null,
        currentSessionId: "s-1",
        promoPendingUsd: 0,
        emailVerified: false,
        formatResetsAt,
      })
      expect(notice).toMatchObject({ primaryLabel: "Upgrade" })
      expect(notice!.body).not.toContain("Verify your email")
    })
  })
})
