// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gmail-like sending limits, per workspace per rolling 24 hours. Free mirrors
 * a personal Gmail account (500 recipients a day, 100 per message); paid
 * mirrors Google Workspace (2,000 a day, 500 per message). Recipients count,
 * not messages: one email to 40 people uses 40.
 *
 * Bounce and complaint lines follow what mailbox providers enforce on bulk
 * senders: past 5% hard bounces or 0.3% complaints over the last 200 sends,
 * a domain stops sending until an admin looks.
 */

import { normalizePlanId } from '../../config/usage-plans'

export interface MailLimits {
  plan: 'free' | 'paid'
  /** Recipients per rolling 24 h, across the workspace. */
  dailySend: number
  recipientsPerMessage: number
  maxMailboxes: number
  maxCustomDomains: number
  attachmentBytes: number
}

export const FREE_MAIL_LIMITS: MailLimits = {
  plan: 'free',
  dailySend: 500,
  recipientsPerMessage: 100,
  maxMailboxes: 10,
  maxCustomDomains: 1,
  attachmentBytes: 25 * 1024 * 1024,
}

export const PAID_MAIL_LIMITS: MailLimits = {
  plan: 'paid',
  dailySend: 2000,
  recipientsPerMessage: 500,
  maxMailboxes: 200,
  maxCustomDomains: 10,
  attachmentBytes: 25 * 1024 * 1024,
}

export function mailLimitsForPlan(planId: string | null | undefined): MailLimits {
  const plan = normalizePlanId(planId) ?? 'free'
  return plan === 'free' ? FREE_MAIL_LIMITS : PAID_MAIL_LIMITS
}

/** Seconds a person has to undo a send. */
export const UNDO_SEND_SECONDS = Number(process.env.SHOGO_MAIL_UNDO_SECONDS ?? 10)

export const BOUNCE_WINDOW = 200
export const BOUNCE_RATE_LIMIT = 0.05
export const COMPLAINT_RATE_LIMIT = 0.003
/** Below this many recent sends, rates are too noisy to act on. */
export const MIN_SENDS_FOR_RATES = 20

export function reputationVerdict(counts: { sent: number; bounced: number; complained: number }): string | null {
  if (counts.sent < MIN_SENDS_FOR_RATES) return null
  if (counts.complained / counts.sent > COMPLAINT_RATE_LIMIT) {
    return `Spam complaints reached ${(100 * counts.complained / counts.sent).toFixed(1)}% of the last ${counts.sent} sends`
  }
  if (counts.bounced / counts.sent > BOUNCE_RATE_LIMIT) {
    return `Hard bounces reached ${(100 * counts.bounced / counts.sent).toFixed(1)}% of the last ${counts.sent} sends`
  }
  return null
}
