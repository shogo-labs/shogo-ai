// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { ERROR_CODE_MESSAGES, parseUsageLimitError } from "@shogo/shared-app/chat"

export interface UsageLimitNotice {
  /** `blocked`: the API refused the message (402). `stopped`: the runtime ended a turn partway. */
  variant: "blocked" | "stopped"
  title: string
  body: string
  /** Opens billing. */
  primaryLabel: "Upgrade" | "Open billing"
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

export function usageLimitNoticeFor(input: {
  /** Message of the chat request error, if any. */
  error: string | null | undefined
  errorDismissed: boolean
  /** Set by a `data-usage-limit` frame. */
  stoppedTurn: { sessionId: string | null; resetsAt?: string } | null
  currentSessionId: string | null | undefined
  formatResetsAt?: (d: Date) => string
}): UsageLimitNotice | null {
  const format = input.formatResetsAt ?? defaultFormatResetsAt

  const blocked = input.error && !input.errorDismissed ? parseUsageLimitError(input.error) : null
  if (blocked) {
    if (blocked.code === "usage_limit_reached") {
      return {
        variant: "blocked",
        title: "Usage limit reached",
        body: `Your message wasn't sent because this workspace is out of usage.${resetSentence(blocked.resetsAt, format)} Upgrade to keep going now, or tap Retry after it resets.`,
        primaryLabel: "Upgrade",
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
      body: `The agent stopped partway through; completed work is saved.${resetSentence(stopped.resetsAt, format)} Upgrade to keep going now — otherwise your work picks up exactly where it stopped once your usage resets.`,
      primaryLabel: "Upgrade",
      secondaryLabel: "Continue",
    }
  }
  return null
}
