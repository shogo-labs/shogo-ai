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

  test("a limit hit mid-turn keeps the Continue action", () => {
    const notice = usageLimitNoticeFor({
      error: null,
      errorDismissed: false,
      stoppedTurn: { sessionId: "s-1", resetsAt: "2099-01-01T00:00:00.000Z" },
      currentSessionId: "s-1",
      formatResetsAt,
    })
    expect(notice).toMatchObject({ variant: "stopped", primaryLabel: "Upgrade", secondaryLabel: "Continue" })
    expect(notice!.body).toContain("completed work is saved")
  })

  test("nothing for other errors, dismissed errors, or another session's limit", () => {
    const base = { stoppedTurn: null, currentSessionId: "s-1", formatResetsAt }
    expect(usageLimitNoticeFor({ ...base, error: '{"error":{"code":"pod_unavailable"}}', errorDismissed: false })).toBeNull()
    expect(usageLimitNoticeFor({ ...base, error: '{"error":{"code":"usage_limit_reached"}}', errorDismissed: true })).toBeNull()
    expect(
      usageLimitNoticeFor({ ...base, error: null, errorDismissed: false, stoppedTurn: { sessionId: "s-2" } }),
    ).toBeNull()
  })
})
