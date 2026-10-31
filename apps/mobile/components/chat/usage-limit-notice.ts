// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { ERROR_CODE_MESSAGES, parseUsageLimitError } from "@shogo/shared-app/chat"

export interface UsageLimitNotice {
  /** `blocked`: the API refused the message (402). `stopped`: the runtime ended a turn partway. */
  variant: "blocked" | "stopped"
  title: string
  body: string
  /** Opens billing. `Start free trial` opens Billing with the Business trial selected. */
  primaryLabel: "Upgrade" | "Open billing" | "Start free trial"
  /** `Retry` re-sends the refused message; `Continue` resumes the stopped turn. */
  secondaryLabel: "Retry" | "Continue"
}

const defaultFormatResetsAt = (d: Date) =>
  d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })

function resetSentence(resetsAt: string | undefined, format: (d: Date) => string): string {
  if (!resetsAt) return ""
  const d = new Date(resetsAt)
  return Number.isNaN(d.getTime()) ? "" : ` Your usage resets ${format(d)}.`
}

/**
 * The at-the-block copy: the exact reset time first, then the one way out.
 * A user who has never had a trial gets the trial (card required, $0 today);
 * everyone else gets Upgrade. Leading with the reset makes a hard limit read
 * as temporary instead of as an error.
 */
function capBody(
  resetsAt: string | undefined,
  format: (d: Date) => string,
  trialEligible: boolean,
  tail: string,
): string {
  const reset = resetSentence(resetsAt, format).trim()
  const cta = trialEligible
    ? "Start the 7-day free Business trial to keep going now."
    : "Upgrade to keep going now."
  return [reset, cta, tail].filter(Boolean).join(" ")
}

export function usageLimitNoticeFor(input: {
  /** Message of the chat request error, if any. */
  error: string | null | undefined
  errorDismissed: boolean
  /** Set by a `data-usage-limit` frame. */
  stoppedTurn: { sessionId: string | null; resetsAt?: string } | null
  currentSessionId: string | null | undefined
  /** From `GET /api/billing/workspace-plan`: the user can still start a trial. */
  trialEligible?: boolean
  formatResetsAt?: (d: Date) => string
}): UsageLimitNotice | null {
  const format = input.formatResetsAt ?? defaultFormatResetsAt
  const trialEligible = input.trialEligible === true
  const primaryLabel: UsageLimitNotice["primaryLabel"] = trialEligible ? "Start free trial" : "Upgrade"

  const blocked = input.error && !input.errorDismissed ? parseUsageLimitError(input.error) : null
  if (blocked) {
    if (blocked.code === "usage_limit_reached") {
      return {
        variant: "blocked",
        title: "Usage limit reached",
        body: capBody(
          blocked.resetsAt,
          format,
          trialEligible,
          "Your message wasn't sent; tap Retry after it resets.",
        ),
        primaryLabel,
        secondaryLabel: "Retry",
      }
    }
    return {
      variant: "blocked",
      title: "Billing needs attention",
      body: `${ERROR_CODE_MESSAGES[blocked.code]} Your message wasn't sent; tap Retry once that's sorted.`,
      primaryLabel: "Open billing",
      secondaryLabel: "Retry",
    }
  }

  const stopped = input.stoppedTurn
  if (stopped && stopped.sessionId === (input.currentSessionId ?? null)) {
    return {
      variant: "stopped",
      title: "Usage limit reached",
      // Lead with the way out. Telling people to "tap Continue" made a hard
      // limit look like a stalled turn (SHO-121); work resumes on its own once
      // the window resets, and upgrading is what continues it now.
      body: capBody(
        stopped.resetsAt,
        format,
        trialEligible,
        "The agent stopped partway through; completed work is saved and picks up exactly where it stopped once your usage resets.",
      ),
      primaryLabel,
      secondaryLabel: "Continue",
    }
  }
  return null
}
