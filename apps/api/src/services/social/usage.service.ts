// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the social surface costs, and the three meters that charge it.
 *
 * Zernio bills on three axes and each one is recorded as its own
 * `UsageEvent.actionType` so a workspace can see exactly what it paid for:
 *
 *   `social_account_monthly`  per connected account, once a month, prorated by
 *                             the days it was active. Charged by the monthly
 *                             sweep (`jobs/social-account-monthly`), which is
 *                             the only writer of `SocialAccount.monthlyRateDebitedFor`.
 *   `social_dm`               one unit per outbound DM, 10k per workspace per
 *                             month free, then $0.0001.
 *   `social_x_api`            X passes its own charge through: $0.015 per post,
 *                             $0.20 when the post carries a link, $0.015 per DM.
 *
 * Two rules hold everywhere in here:
 *
 * 1. **Only the cloud charges.** The desktop relays every social call to the
 *    cloud, which holds the master key and the wallet; a BYOK workspace talks
 *    to Zernio directly and is billed by Zernio itself. So a meter checks
 *    `socialMode() === 'cloud'` and otherwise does nothing — the desktop must
 *    never write a `UsageEvent` for a call the cloud is already charging for.
 * 2. **The row is the receipt.** Each meter flips a column on the row it
 *    charges (`SocialMessage.metered`, `SocialPostTarget.meteredAt`) before it
 *    bills, so a redelivered webhook, an overlapping sweep and a retried
 *    dispatch all collapse onto one charge. If the charge itself fails the
 *    claim is reverted, so the next sweep picks the row up instead of losing it.
 *
 * The markup is `MARKUP_MULTIPLIER` from `lib/usage-cost` — the same 1.20 every
 * other provider cost uses. There is deliberately no social-specific constant.
 */

import { prisma } from '../../lib/prisma'
import { MARKUP_MULTIPLIER } from '../../lib/usage-cost'
import { checkUsageBalance, consumeUsage, usageLimitErrorPayload } from '../billing-runtime'
import { SocialError, socialMode } from './client'

const db = prisma as any

/**
 * The wallet functions this module bills through.
 *
 * A seam, not an indirection: the social meters are the only place that charges
 * on a *background* path (a webhook echo, a relayed broadcast, a monthly sweep),
 * and a test that had to stand up a real wallet to prove the 10k free allowance
 * would be testing Stripe. `setSocialUsageWallet` mirrors `setSocialClient`.
 */
export interface SocialUsageWallet {
  consume: typeof consumeUsage
  checkBalance: typeof checkUsageBalance
}

let walletOverride: SocialUsageWallet | null = null

export function setSocialUsageWallet(wallet: SocialUsageWallet | null): void {
  walletOverride = wallet
}

function wallet(): SocialUsageWallet {
  return walletOverride ?? { consume: consumeUsage, checkBalance: checkUsageBalance }
}

/**
 * The wallet seam itself, exported so the monthly job bills through the same
 * one the live meters do — a background cron must not have its own path to
 * Stripe, and a test must be able to stand in for both at once.
 */
export function socialWallet(): SocialUsageWallet {
  return wallet()
}

/** Free outbound DMs per workspace per calendar month. */
export const SOCIAL_DM_FREE_UNITS_PER_MONTH = 10_000
/** Provider cost per DM past the free allowance. */
export const SOCIAL_DM_PROVIDER_USD = 0.0001
/** X's own charge per published post. */
export const SOCIAL_X_POST_USD = 0.015
/** X charges 13× more for a post that carries a link. */
export const SOCIAL_X_POST_WITH_LINK_USD = 0.2
/** X's own charge per DM. */
export const SOCIAL_X_DM_USD = 0.015

export type SocialMeterAction = 'social_account_monthly' | 'social_dm' | 'social_x_api'

/**
 * Zernio's graduated per-account pricing, per account, per month. The 1–2 band
 * is "$12 credit" — two accounts at $6 are covered — which is why it carries a
 * monthly credit rather than a different rate.
 */
export interface SocialAccountBand {
  upTo: number
  perAccountUsd: number
  monthlyCreditUsd: number
}

export const SOCIAL_ACCOUNT_BANDS: readonly SocialAccountBand[] = [
  { upTo: 2, perAccountUsd: 6, monthlyCreditUsd: 12 },
  { upTo: 10, perAccountUsd: 6, monthlyCreditUsd: 0 },
  { upTo: 100, perAccountUsd: 3, monthlyCreditUsd: 0 },
  { upTo: 2000, perAccountUsd: 1, monthlyCreditUsd: 0 },
] as const

const LINK_PATTERN = /https?:\/\/\S+/i

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function startOfMonthUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0))
}

export function daysInMonthUtc(at: Date): number {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate()
}

/** The band a workspace's *total* connected accounts fall into. */
export function socialAccountBand(accounts: number): SocialAccountBand {
  const count = Math.max(0, Math.floor(accounts))
  return (
    SOCIAL_ACCOUNT_BANDS.find((band) => count <= band.upTo) ??
    SOCIAL_ACCOUNT_BANDS[SOCIAL_ACCOUNT_BANDS.length - 1]!
  )
}

/**
 * Raw provider cost of `accounts` connected accounts for one month.
 *
 * `activeFraction` is how much of the month they were connected (1 for a full
 * month), which is what makes a connect mid-month prorated rather than a full
 * month's charge. The band is chosen by the *count*, before proration, because
 * Zernio's price per account depends on how many you have.
 */
export function socialAccountMonthlyRawUsd(accounts: number, activeFraction = 1): number {
  if (accounts <= 0) return 0
  const band = socialAccountBand(accounts)
  const fraction = Math.min(1, Math.max(0, activeFraction))
  const gross = accounts * band.perAccountUsd * fraction
  return round6(Math.max(0, gross - band.monthlyCreditUsd * fraction))
}

/** What the workspace pays for a raw provider cost. */
export function socialBilledUsd(rawUsd: number): number {
  return round6(rawUsd * MARKUP_MULTIPLIER)
}

/** Whether this process is the one that bills. Only the cloud is. */
export function socialMeteringEnabled(): boolean {
  try {
    return socialMode() === 'cloud'
  } catch {
    // No key configured at all: nothing will be called, nothing to meter.
    return false
  }
}

/** X charges by whether the post a person is about to publish carries a link. */
export function contentHasLink(content: string | null | undefined): boolean {
  return typeof content === 'string' && LINK_PATTERN.test(content)
}

export interface SocialChargeResult {
  billed: boolean
  rawUsd: number
  billedUsd: number
}

const NOTHING: SocialChargeResult = { billed: false, rawUsd: 0, billedUsd: 0 }

async function recordCharge(args: {
  workspaceId: string
  actionType: SocialMeterAction
  rawUsd: number
  metadata: Record<string, unknown>
}): Promise<void> {
  const billedUsd = socialBilledUsd(args.rawUsd)
  const result = await wallet().consume({
    workspaceId: args.workspaceId,
    projectId: null,
    memberId: 'social',
    actionType: args.actionType,
    rawUsd: args.rawUsd,
    billedUsd,
    actionMetadata: { ...args.metadata, rawUsd: args.rawUsd, billedUsd },
  })
  if (!result.success) {
    throw new Error(`usage wallet refused ${args.actionType}: ${result.error ?? 'unknown'}`)
  }
}

/**
 * One outbound DM.
 *
 * The claim is the dedupe: `metered: false → true` is an atomic
 * compare-and-set, so the webhook that sees `message.sent` and the reply path
 * that wrote the row cannot both bill it. The free allowance is counted from
 * the workspace's own metered rows for the month, not from a provider counter —
 * the provider's number includes messages we never stored.
 */
export async function meterOutboundMessage(
  workspaceId: string,
  messageId: string,
): Promise<SocialChargeResult> {
  if (!socialMeteringEnabled()) return NOTHING

  const claim = await db.socialMessage.updateMany({
    where: { id: messageId, workspaceId, direction: 'outgoing', metered: false },
    data: { metered: true },
  })
  if (claim.count === 0) return NOTHING

  const monthStart = startOfMonthUtc(new Date())
  const used = await db.socialMessage.count({
    where: { workspaceId, direction: 'outgoing', metered: true, sentAt: { gte: monthStart } },
  })
  // This message is the marginal unit, so it costs one unit or nothing. Billing
  // `used - allowance` here would charge the month's running total again on every
  // message: the third DM past the allowance would take three units, and the
  // overcharge grows quadratically.
  if (used <= SOCIAL_DM_FREE_UNITS_PER_MONTH) return NOTHING

  const rawUsd = SOCIAL_DM_PROVIDER_USD
  try {
    await recordCharge({
      workspaceId,
      actionType: 'social_dm',
      rawUsd,
      metadata: {
        messageId,
        units: 1,
        usedThisMonth: used,
        freeUnitsThisMonth: SOCIAL_DM_FREE_UNITS_PER_MONTH,
      },
    })
  } catch (err) {
    // Give the claim back so the next sweep retries it rather than losing the
    // charge to a wallet hiccup.
    await db.socialMessage
      .updateMany({ where: { id: messageId, metered: true }, data: { metered: false } })
      .catch(() => {})
    console.error('[SocialUsage] social_dm charge failed; released the claim', {
      workspaceId,
      messageId,
      error: (err as any)?.message ?? err,
    })
    return NOTHING
  }
  return { billed: true, rawUsd, billedUsd: socialBilledUsd(rawUsd) }
}

/**
 * One leg of a published post on X. Every other platform is free per post, so
 * `meterXPost` is only ever called for `platform === 'x'`.
 *
 * Called once the provider has accepted the leg (published now, or accepted a
 * schedule — Zernio bills the post either way), which is why the claim lives on
 * the target and not on the post.
 */
export async function meterXPost(workspaceId: string, targetId: string): Promise<SocialChargeResult> {
  if (!socialMeteringEnabled()) return NOTHING

  const target = await db.socialPostTarget.findFirst({
    where: { id: targetId, post: { workspaceId } },
    select: {
      id: true,
      platform: true,
      status: true,
      customContent: true,
      post: { select: { id: true, content: true } },
    },
  })
  if (!target || target.platform !== 'x') return NOTHING
  if (target.status === 'failed' || target.status === 'skipped') return NOTHING

  const claim = await db.socialPostTarget.updateMany({
    where: { id: targetId, meteredAt: null },
    data: { meteredAt: new Date() },
  })
  if (claim.count === 0) return NOTHING

  const hasLink = contentHasLink(target.customContent ?? target.post?.content ?? '')
  const rawUsd = hasLink ? SOCIAL_X_POST_WITH_LINK_USD : SOCIAL_X_POST_USD
  try {
    await recordCharge({
      workspaceId,
      actionType: 'social_x_api',
      rawUsd,
      metadata: { targetId, postId: target.post?.id ?? null, withLink: hasLink },
    })
  } catch (err) {
    await db.socialPostTarget
      .updateMany({ where: { id: targetId }, data: { meteredAt: null } })
      .catch(() => {})
    console.error('[SocialUsage] social_x_api charge failed; released the claim', {
      workspaceId,
      targetId,
      error: (err as any)?.message ?? err,
    })
    return NOTHING
  }
  return { billed: true, rawUsd, billedUsd: socialBilledUsd(rawUsd) }
}

/**
 * Catch anything the live paths missed — a claim released by a wallet failure, a
 * desktop whose `message.sent` echo never arrived, a deploy mid-publish. Bounded
 * so one sweep cannot walk a workspace's whole history.
 */
export async function sweepPendingSocialUsage(
  workspaceId: string,
  opts: { limit?: number; olderThan?: Date } = {},
): Promise<{ dms: number; xPosts: number; rawUsd: number }> {
  if (!socialMeteringEnabled()) return { dms: 0, xPosts: 0, rawUsd: 0 }
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
  const olderThan = opts.olderThan ?? new Date(Date.now() - 10 * 60_000)

  const messages = await db.socialMessage.findMany({
    where: {
      workspaceId,
      direction: 'outgoing',
      metered: false,
      sentAt: { lt: olderThan },
    },
    orderBy: { sentAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  const targets = await db.socialPostTarget.findMany({
    where: {
      platform: 'x',
      meteredAt: null,
      status: 'published',
      post: { workspaceId },
      updatedAt: { lt: olderThan },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  let rawUsd = 0
  let dms = 0
  let xPosts = 0
  for (const message of messages) {
    const res = await meterOutboundMessage(workspaceId, message.id)
    if (res.billed) {
      dms += 1
      rawUsd += res.rawUsd
    }
  }
  for (const target of targets) {
    const res = await meterXPost(workspaceId, target.id)
    if (res.billed) {
      xPosts += 1
      rawUsd += res.rawUsd
    }
  }
  return { dms, xPosts, rawUsd: round6(rawUsd) }
}

/**
 * Refuse an operation the wallet cannot cover, before it reaches the provider.
 *
 * `projectedRawUsd` is the provider cost of what is about to happen; the caller
 * gets the standard usage-limit code so every surface (and the agent) sees the
 * same reason, plus the projection so the UI can name a number.
 */
export async function assertSocialBudget(
  workspaceId: string,
  projectedRawUsd: number,
): Promise<void> {
  if (!socialMeteringEnabled()) return
  const projectedBilledUsd = socialBilledUsd(Math.max(projectedRawUsd, 0))
  let check: { ok: boolean; reason?: Parameters<typeof usageLimitErrorPayload>[0] }
  try {
    check = await wallet().checkBalance(workspaceId, Math.max(projectedBilledUsd, 0.0001))
  } catch (err) {
    // A pre-flight we cannot complete must not block the publish the user asked
    // for: the call is metered anyway, so a billing-side blip costs us a little
    // revenue rather than costing the user their post.
    console.error('[SocialUsage] balance pre-flight failed; allowing the call', {
      workspaceId,
      projectedBilledUsd,
      error: (err as any)?.message ?? err,
    })
    return
  }
  if (check.ok) return
  const payload = usageLimitErrorPayload(check.reason)
  throw new SocialError(402, payload.code, payload.message, { projectedBilledUsd })
}

/** What a broadcast to these targets will cost on X (0 on every other platform). */
export function projectedPublishRawUsd(
  targets: Array<{ platform: string; content?: string | null }>,
): number {
  let raw = 0
  for (const target of targets) {
    if (target.platform !== 'x') continue
    raw += contentHasLink(target.content) ? SOCIAL_X_POST_WITH_LINK_USD : SOCIAL_X_POST_USD
  }
  return round6(raw)
}

/** What connecting one more account costs this month, prorated like the sweep. */
export function projectedConnectRawUsd(activeAccounts: number, at: Date = new Date()): number {
  const total = activeAccounts + 1
  const fraction = (daysInMonthUtc(at) - at.getUTCDate() + 1) / daysInMonthUtc(at)
  const without = socialAccountMonthlyRawUsd(activeAccounts, 1)
  const with_ = socialAccountMonthlyRawUsd(total, 1)
  // The marginal account's share of the month's bill, not the whole bill again.
  return round6(Math.max(0, (with_ - without) * fraction))
}

export interface SocialUsageSummary {
  /** Active connected accounts the workspace is billed for. */
  accounts: number
  band: { upTo: number; perAccountUsd: number; monthlyCreditUsd: number }
  estimatedMonthlyRawUsd: number
  estimatedMonthlyBilledUsd: number
  dms: {
    usedThisMonth: number
    freeUnitsPerMonth: number
    freeRemaining: number
    billableUnits: number
    providerUsdPerUnit: number
    rawUsd: number
    billedUsd: number
  }
  x: {
    postsThisMonth: number
    rawUsd: number
    billedUsd: number
    postUsd: number
    postWithLinkUsd: number
    dmUsd: number
  }
  chargedThisMonth: Array<{ actionType: string; rawUsd: number; billedUsd: number; events: number }>
}

function sumBy(rows: Array<{ actionType: string; rawUsd: number; billedUsd: number }>) {
  const out = new Map<string, { actionType: string; rawUsd: number; billedUsd: number; events: number }>()
  for (const row of rows) {
    const entry = out.get(row.actionType) ?? {
      actionType: row.actionType,
      rawUsd: 0,
      billedUsd: 0,
      events: 0,
    }
    entry.rawUsd = round6(entry.rawUsd + (row.rawUsd ?? 0))
    entry.billedUsd = round6(entry.billedUsd + (row.billedUsd ?? 0))
    entry.events += 1
    out.set(row.actionType, entry)
  }
  return [...out.values()].sort((a, b) => b.billedUsd - a.billedUsd)
}

/**
 * What the workspace is being charged this month, from our own rows.
 *
 * Read-only and provider-free: the account estimate is what the next sweep would
 * charge, and `chargedThisMonth` is what the wallet actually saw.
 */
export async function socialUsageSummary(
  workspaceId: string,
  at: Date = new Date(),
): Promise<SocialUsageSummary> {
  const monthStart = startOfMonthUtc(at)
  const accounts = await db.socialAccount.count({ where: { workspaceId, isActive: true } })
  const band = socialAccountBand(accounts)
  const estimatedMonthlyRawUsd = socialAccountMonthlyRawUsd(accounts)

  const dmsUsed = await db.socialMessage.count({
    where: { workspaceId, direction: 'outgoing', metered: true, sentAt: { gte: monthStart } },
  })
  const billableUnits = Math.max(0, dmsUsed - SOCIAL_DM_FREE_UNITS_PER_MONTH)
  const dmRawUsd = round6(billableUnits * SOCIAL_DM_PROVIDER_USD)

  const xPosts = await db.socialPostTarget.count({
    where: { platform: 'x', meteredAt: { gte: monthStart }, post: { workspaceId } },
  })

  const events = await db.usageEvent.findMany({
    where: {
      workspaceId,
      actionType: { in: ['social_account_monthly', 'social_dm', 'social_x_api'] },
      createdAt: { gte: monthStart },
    },
    select: { actionType: true, rawUsd: true, billedUsd: true },
  })
  const charged = sumBy(
    events.map((row: any) => ({
      actionType: row.actionType,
      rawUsd: row.rawUsd ?? 0,
      billedUsd: row.billedUsd ?? 0,
    })),
  )

  return {
    accounts,
    band: { upTo: band.upTo, perAccountUsd: band.perAccountUsd, monthlyCreditUsd: band.monthlyCreditUsd },
    estimatedMonthlyRawUsd,
    estimatedMonthlyBilledUsd: socialBilledUsd(estimatedMonthlyRawUsd),
    dms: {
      usedThisMonth: dmsUsed,
      freeUnitsPerMonth: SOCIAL_DM_FREE_UNITS_PER_MONTH,
      freeRemaining: Math.max(0, SOCIAL_DM_FREE_UNITS_PER_MONTH - dmsUsed),
      billableUnits,
      providerUsdPerUnit: SOCIAL_DM_PROVIDER_USD,
      rawUsd: dmRawUsd,
      billedUsd: socialBilledUsd(dmRawUsd),
    },
    x: {
      postsThisMonth: xPosts,
      rawUsd: round6(charged.find((row) => row.actionType === 'social_x_api')?.rawUsd ?? 0),
      billedUsd: round6(charged.find((row) => row.actionType === 'social_x_api')?.billedUsd ?? 0),
      postUsd: SOCIAL_X_POST_USD,
      postWithLinkUsd: SOCIAL_X_POST_WITH_LINK_USD,
      dmUsd: SOCIAL_X_DM_USD,
    },
    chargedThisMonth: charged,
  }
}
