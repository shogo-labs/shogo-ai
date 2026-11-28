// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { ERROR_CODE_MESSAGES, parseUsageLimitError } from "@shogo/shared-app/chat"

export interface UsageLimitNotice {
  /** `blocked`: the API refused the message (402). `stopped`: the runtime ended a turn partway. */
  variant: "blocked" | "stopped"
  title: string
  body: string
  /**
   * Opens billing. `Start free trial` opens Billing with the Business trial
   * selected. `Verify email` opens the verification screen; `Contact support`
   * opens the support mail link.
   */
  primaryLabel: "Upgrade" | "Open billing" | "Start free trial" | "Verify email" | "Contact support"
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
 * Free before paid (SHO-614): while the sign-up email is unverified and credit
 * is waiting behind it, verifying is the free fix, so it leads. A user who has
 * never had a trial gets the trial (card required, $0 today); everyone else
 * gets Upgrade. Leading with the reset makes a hard limit read as temporary
 * instead of as an error.
 */
function capBody(
  resetsAt: string | undefined,
  format: (d: Date) => string,
  trialEligible: boolean,
  tail: string,
  verifyForCredit: string | null,
): string {
  const reset = resetSentence(resetsAt, format).trim()
  const cta = trialEligible
    ? "Start the 7-day free Business trial to keep going now."
    : "Upgrade to keep going now."
  return [verifyForCredit, reset, cta, tail].filter(Boolean).join(" ")
}

/** `$8` for whole dollars, `$8.50` otherwise — the amount is never hardcoded. */
function formatUsd(usd: number): string {
  return `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`
}

/**
 * "Verify your email to unlock $8 more credit." — only when the account's
 * email is unverified and credit is actually waiting behind it. The dollar
 * figure comes from the plan (`promoCredit.pendingVerificationUsd`), never a
 * constant, so a pricing change can't leave the copy lying.
 */
function verifyForCreditSentence(input: {
  promoPendingUsd?: number
  emailVerified?: boolean
}): string | null {
  const pending = input.promoPendingUsd ?? 0
  if (!(pending > 0) || input.emailVerified !== false) return null
  return `Verify your email to unlock ${formatUsd(pending)} more credit.`
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
  /** `promoCredit.pendingVerificationUsd` — credit that unlocks on verification. */
  promoPendingUsd?: number
  /** `promoCredit.emailVerified`. */
  emailVerified?: boolean
  formatResetsAt?: (d: Date) => string
}): UsageLimitNotice | null {
  const format = input.formatResetsAt ?? defaultFormatResetsAt
  const trialEligible = input.trialEligible === true
  const verifyForCredit = verifyForCreditSentence(input)
  const primaryLabel: UsageLimitNotice["primaryLabel"] = verifyForCredit
    ? "Verify email"
    : trialEligible
      ? "Start free trial"
      : "Upgrade"

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
          verifyForCredit,
        ),
        primaryLabel,
        secondaryLabel: "Retry",
      }
    }
    // A held account (SHO-416): the way out is verifying the email, not paying.
    // Leading with billing here would send a real person to a checkout page
    // that cannot help them.
    if (blocked.code === "email_verification_required") {
      return {
        variant: "blocked",
        title: "Verify your email",
        body: `${ERROR_CODE_MESSAGES[blocked.code]} Your message wasn't sent; tap Retry once you've verified.`,
        primaryLabel: "Verify email",
        secondaryLabel: "Retry",
      }
    }
    if (blocked.code === "account_review_required") {
      return {
        variant: "blocked",
        title: "Account under review",
        body: `${ERROR_CODE_MESSAGES[blocked.code]} Your message wasn't sent; tap Retry once that's sorted.`,
        primaryLabel: "Contact support",
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
        verifyForCredit,
      ),
      primaryLabel,
      secondaryLabel: "Continue",
    }
  }
  return null
}
