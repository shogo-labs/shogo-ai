// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Billing Alerts Service — fans billing/usage events out to the user across
 * both channels (in-app inbox + email) from one place.
 *
 * Two kinds of alerts:
 *   - Event alerts (`notifyOverageCharged`, `notifyPaymentReceipt`,
 *     `notifyPaymentFailed`): fired by `chargeOverageBlocks` and the Stripe
 *     webhook when something concrete happens to a charge.
 *   - Proactive threshold alerts (`evaluateUsageAlerts`): fired off the usage
 *     path as a workspace approaches included exhaustion / its spend cap, so a
 *     big on-demand bill never arrives by surprise. These are deduped per
 *     allocation period via `usage_wallets.alertsSentThisPeriod` so the user
 *     isn't spammed; the ledger is reset on the monthly allocation reset.
 *
 * Everything here is best-effort and never throws into the caller: a failed
 * notification must never break usage recording or a Stripe webhook.
 */

// `prisma` is the only runtime export needed here. The `NotificationType` enum
// has no runtime value under the SQLite/local client (enums are stored as
// strings), so we pass string-literal members below; they are type-checked
// against the `NotificationType` union at the `notifyWorkspaceBillingAdmins`
// (createNotification) call boundary.
import { prisma } from '../lib/prisma'
import { notifyWorkspaceBillingAdmins } from './notification.service'
import {
  sendOverageChargedEmail,
  sendApproachingLimitEmail,
  sendPaymentReceiptEmail,
  sendPaymentFailedEmail,
} from './email.service'
import { getFrontendUrl } from '../lib/cloud-urls'

/** Fraction of the included pool / spend cap at which we warn the user. */
const APPROACHING_THRESHOLD = 0.8

/** Per-period dedupe ledger persisted in `usage_wallets.alertsSentThisPeriod`. */
interface AlertLedger {
  approachingIncluded?: boolean
  approachingCap?: boolean
  capReached?: boolean
}

function usd(n: number): string {
  return (n || 0).toFixed(2)
}

/** Billing dashboard deep link used in emails + in-app notification actionUrl. */
function billingUrl(workspaceId: string): string {
  return `${getFrontendUrl()}/billing?workspace=${encodeURIComponent(workspaceId)}`
}

/**
 * Resolve the workspace display name and billing-admin email addresses (owner
 * + any `isBillingAdmin` members). Returns empty `emails` if none resolve.
 */
async function resolveBillingContacts(
  workspaceId: string,
): Promise<{ workspaceName: string; emails: string[] }> {
  const [workspace, members] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    prisma.member.findMany({
      where: { workspaceId, OR: [{ role: 'owner' }, { isBillingAdmin: true }] },
      select: { user: { select: { email: true } } },
    }),
  ])
  const emails = Array.from(
    new Set(members.map((m) => m.user?.email).filter((e): e is string => !!e)),
  )
  return { workspaceName: workspace?.name ?? 'your workspace', emails }
}

/**
 * Notify billing admins that a mid-cycle on-demand usage block was charged.
 * In-app (`overage_charged`, deduped on the invoice id) + email to each
 * billing-admin address.
 */
export async function notifyOverageCharged(
  workspaceId: string,
  params: { blockAmountUsd: number; periodOverageUsd: number; invoiceId?: string; invoiceUrl?: string },
): Promise<void> {
  try {
    const { workspaceName, emails } = await resolveBillingContacts(workspaceId)
    const amount = usd(params.blockAmountUsd)
    const periodOverageUsd = usd(params.periodOverageUsd)
    const manageUrl = billingUrl(workspaceId)

    await notifyWorkspaceBillingAdmins(workspaceId, {
      type: 'overage_charged',
      title: `On-demand usage charged: $${amount}`,
      message: `${workspaceName} was charged $${amount} for usage beyond its included plan. Overage this period: $${periodOverageUsd}.`,
      actionUrl: '/billing',
      metadata: { workspaceId, blockAmountUsd: params.blockAmountUsd, periodOverageUsd: params.periodOverageUsd, invoiceUrl: params.invoiceUrl },
      ...(params.invoiceId ? { dedupeKey: `overage_charged:${params.invoiceId}` } : {}),
    })

    await Promise.all(
      emails.map((to) =>
        sendOverageChargedEmail({
          to,
          workspaceName,
          amount,
          periodOverageUsd,
          manageUrl,
          ...(params.invoiceUrl ? { invoiceUrl: params.invoiceUrl } : {}),
        }).catch((err) => console.error('[billing-alerts] overage email failed:', err?.message ?? err)),
      ),
    )
  } catch (err) {
    console.error('[billing-alerts] notifyOverageCharged failed:', (err as Error)?.message ?? err)
  }
}

/**
 * Notify billing admins of a successful subscription/usage payment. In-app
 * (`payment_succeeded`, deduped on invoice id) + receipt email. Used by the
 * Stripe `invoice.payment_succeeded` webhook.
 */
export async function notifyPaymentReceipt(
  workspaceId: string,
  params: { planName: string; amountUsd: number; invoiceDate: string; invoiceId?: string; invoiceUrl?: string },
): Promise<void> {
  try {
    const { workspaceName, emails } = await resolveBillingContacts(workspaceId)
    const amount = usd(params.amountUsd)

    await notifyWorkspaceBillingAdmins(workspaceId, {
      type: 'payment_succeeded',
      title: `Payment received: $${amount}`,
      message: `Your payment of $${amount} for ${workspaceName} (${params.planName}) was successful.`,
      actionUrl: '/billing',
      metadata: { workspaceId, amountUsd: params.amountUsd, invoiceUrl: params.invoiceUrl },
      ...(params.invoiceId ? { dedupeKey: `payment_succeeded:${params.invoiceId}` } : {}),
    })

    await Promise.all(
      emails.map((to) =>
        sendPaymentReceiptEmail({
          to,
          workspaceName,
          planName: params.planName,
          amount,
          invoiceDate: params.invoiceDate,
          ...(params.invoiceUrl ? { invoiceUrl: params.invoiceUrl } : {}),
        }).catch((err) => console.error('[billing-alerts] receipt email failed:', err?.message ?? err)),
      ),
    )
  } catch (err) {
    console.error('[billing-alerts] notifyPaymentReceipt failed:', (err as Error)?.message ?? err)
  }
}

/**
 * Notify billing admins of a failed subscription/usage payment. In-app
 * (`payment_failed`, deduped on invoice id) + the existing payment-failed
 * email. Used by the Stripe `invoice.payment_failed` webhook.
 */
export async function notifyPaymentFailed(
  workspaceId: string,
  params: { planName: string; amountUsd: number; invoiceId?: string },
): Promise<void> {
  try {
    const { workspaceName, emails } = await resolveBillingContacts(workspaceId)
    const amount = usd(params.amountUsd)
    const retryUrl = billingUrl(workspaceId)

    await notifyWorkspaceBillingAdmins(workspaceId, {
      type: 'payment_failed',
      title: `Payment failed for ${workspaceName}`,
      message: `We couldn't process your payment of $${amount} for ${workspaceName} (${params.planName}). Update your payment method to avoid interruption.`,
      actionUrl: '/billing',
      metadata: { workspaceId, amountUsd: params.amountUsd },
      ...(params.invoiceId ? { dedupeKey: `payment_failed:${params.invoiceId}` } : {}),
    })

    await Promise.all(
      emails.map((to) =>
        sendPaymentFailedEmail({
          to,
          workspaceName,
          planName: params.planName,
          amount,
          retryUrl,
        }).catch((err) => console.error('[billing-alerts] payment-failed email failed:', err?.message ?? err)),
      ),
    )
  } catch (err) {
    console.error('[billing-alerts] notifyPaymentFailed failed:', (err as Error)?.message ?? err)
  }
}

/**
 * Proactively evaluate a workspace's usage against its included pool and spend
 * cap, firing at most one notification per threshold per allocation period.
 * Best-effort and self-contained (reads + persists the dedupe ledger). Safe to
 * call fire-and-forget after every metered usage event.
 */
export async function evaluateUsageAlerts(workspaceId: string): Promise<void> {
  try {
    const wallet = await prisma.usageWallet.findUnique({
      where: { workspaceId },
      select: {
        monthlyIncludedAllocationUsd: true,
        monthlyIncludedUsd: true,
        overageAccumulatedUsd: true,
        overageHardLimitUsd: true,
        alertsSentThisPeriod: true,
      },
    })
    if (!wallet) return

    const ledger = ((wallet.alertsSentThisPeriod as AlertLedger | null) ?? {})
    const allocation = wallet.monthlyIncludedAllocationUsd ?? 0
    const includedUsed = Math.max(0, allocation - (wallet.monthlyIncludedUsd ?? 0))
    const overage = wallet.overageAccumulatedUsd ?? 0
    const cap = wallet.overageHardLimitUsd

    const next: AlertLedger = { ...ledger }
    type Pending = { limitLabel: string; usedUsd: number; limitUsd: number; percentUsed: number; capReached: boolean }
    let pending: Pending | null = null

    // Hard spend cap takes priority — it's the alert with real consequences.
    if (cap != null && cap > 0) {
      if (overage >= cap && !ledger.capReached) {
        next.capReached = true
        pending = { limitLabel: 'spending cap', usedUsd: overage, limitUsd: cap, percentUsed: 100, capReached: true }
      } else if (overage >= cap * APPROACHING_THRESHOLD && overage < cap && !ledger.approachingCap) {
        next.approachingCap = true
        pending = { limitLabel: 'spending cap', usedUsd: overage, limitUsd: cap, percentUsed: Math.round((overage / cap) * 100), capReached: false }
      }
    }

    // Otherwise warn as the included pool nears exhaustion (overage about to start).
    if (!pending && allocation > 0 && overage <= 0 && includedUsed >= allocation * APPROACHING_THRESHOLD && !ledger.approachingIncluded) {
      next.approachingIncluded = true
      pending = { limitLabel: 'included usage', usedUsd: includedUsed, limitUsd: allocation, percentUsed: Math.round((includedUsed / allocation) * 100), capReached: false }
    }

    if (!pending) return

    // Persist the dedupe ledger before sending so a retry can't double-fire.
    await prisma.usageWallet.update({
      where: { workspaceId },
      data: { alertsSentThisPeriod: next as object },
    })

    const { workspaceName, emails } = await resolveBillingContacts(workspaceId)
    const percentUsed = String(pending.percentUsed)
    const usedUsd = usd(pending.usedUsd)
    const limitUsd = usd(pending.limitUsd)

    await notifyWorkspaceBillingAdmins(workspaceId, {
      type: pending.capReached ? 'spend_limit_reached' : 'usage_threshold',
      title: pending.capReached
        ? `Spending limit reached for ${workspaceName}`
        : `${workspaceName} is at ${percentUsed}% of its ${pending.limitLabel}`,
      message: pending.capReached
        ? `${workspaceName} hit its $${limitUsd} monthly spending cap. Further usage is paused until the cap is raised or the period resets.`
        : `${workspaceName} has used $${usedUsd} of its $${limitUsd} ${pending.limitLabel} this period (${percentUsed}%).`,
      actionUrl: '/billing',
      metadata: { workspaceId, limitLabel: pending.limitLabel, usedUsd: pending.usedUsd, limitUsd: pending.limitUsd, percentUsed: pending.percentUsed },
    })

    const manageUrl = billingUrl(workspaceId)
    await Promise.all(
      emails.map((to) =>
        sendApproachingLimitEmail({
          to,
          workspaceName,
          usedUsd,
          limitUsd,
          limitLabel: pending!.limitLabel,
          percentUsed,
          manageUrl,
        }).catch((err) => console.error('[billing-alerts] threshold email failed:', err?.message ?? err)),
      ),
    )
  } catch (err) {
    console.error('[billing-alerts] evaluateUsageAlerts failed:', (err as Error)?.message ?? err)
  }
}
