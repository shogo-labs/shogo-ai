// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pure half of the invite dialog (SHO-454): email chips, which addresses a
 * send should attempt, and the one-line summary of a batch result.
 *
 * Kept free of React Native imports so it can be unit-tested directly; the
 * dialog re-exports these for its callers.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface InviteChip {
  value: string
  valid: boolean
}

/**
 * Split a pasted or typed string into chips. Addresses separate on comma,
 * semicolon, whitespace or a newline; anything that is not an address becomes
 * an invalid chip so the person can see and fix it instead of it vanishing.
 * Duplicates collapse to the first occurrence.
 */
export function parseInviteChips(input: string): InviteChip[] {
  const seen = new Set<string>()
  const chips: InviteChip[] = []
  for (const raw of input.split(/[,;\s]+/)) {
    const value = raw.trim().toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    chips.push({ value, valid: EMAIL_RE.test(value) })
  }
  return chips
}

/** The addresses a send should actually attempt: valid, not already a member, not already invited. */
export function sendableEmails(
  chips: InviteChip[],
  memberEmails: ReadonlySet<string>,
  pendingEmails: ReadonlySet<string>,
): string[] {
  return chips
    .filter((c) => c.valid && !memberEmails.has(c.value) && !pendingEmails.has(c.value))
    .map((c) => c.value)
}

export type InviteOutcome = 'sent' | 'resent' | 'invited' | 'member' | 'failed'

export interface InviteResultLine {
  email: string
  outcome: InviteOutcome
  message?: string
}

/**
 * Turn `Promise.allSettled` results into the one line the dialog shows, e.g.
 * "3 sent · 1 already invited (Resend) · 1 failed: <API message>".
 */
export function summarizeInviteResults(results: InviteResultLine[]): string {
  const count = (outcome: InviteOutcome) => results.filter((r) => r.outcome === outcome).length
  const parts: string[] = []
  const sent = count('sent')
  const resent = count('resent')
  const invited = count('invited')
  const member = count('member')
  const failed = results.filter((r) => r.outcome === 'failed')
  if (sent) parts.push(`${sent} sent`)
  if (resent) parts.push(`${resent} resent`)
  if (invited) parts.push(`${invited} already invited (Resend)`)
  if (member) parts.push(`${member} already a member`)
  if (failed.length) {
    const first = failed[0]?.message
    parts.push(
      failed.length === 1
        ? `1 failed${first ? `: ${first}` : ''}`
        : `${failed.length} failed${first ? `: ${first}` : ''}`,
    )
  }
  return parts.join(' · ')
}

/** "expires in 7 days" / "expires today" / "never expires". */
export function describeExpiry(expiresAt: string | null | undefined, now = Date.now()): string {
  if (!expiresAt) return 'never expires'
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return 'expired'
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  return days <= 1 ? 'expires today' : `expires in ${days} days`
}
