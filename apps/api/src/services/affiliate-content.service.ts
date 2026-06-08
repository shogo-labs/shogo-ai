// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate Content-CPM Service.
 *
 * Lets affiliates connect Instagram / TikTok handles whose posts are
 * polled hourly for view counts. Positive view deltas accrue CPM
 * commissions that ride the EXISTING affiliate machinery: they are
 * written as `AffiliateCommission` rows with `source = 'content'`, so
 * the unchanged `approveEligibleCommissions` (hold → approved) and
 * `runAffiliatePayouts` (approved → Stripe Connect) crons pay them out
 * with no special-casing.
 *
 * Lifecycle:
 *   connect  → AffiliateSocialAccount (verificationStatus = pending,
 *              one-time verificationCode minted)
 *   verify   → affiliate puts the code in their bio; verifyAccount fetches
 *              the public profile via the content provider and flips to
 *              `verified` (anti-fraud gate — a public-data provider can
 *              read any handle's views but can't prove ownership)
 *   poll     → pollAccount lists recent posts, upserts AffiliatePost,
 *              writes an AffiliatePostSnapshot, and on
 *              `max(0, views - paidViews)` mints a `content` commission
 *   hold     → approveEligibleCommissions flips pending→approved
 *   payout   → runAffiliatePayouts batches approved → Stripe Connect
 *
 * Fraud / correctness invariants:
 *   - Only `verified` accounts are polled and earn.
 *   - We pay on the INCREMENTAL view delta vs a per-post `paidViews`
 *     high-water mark; counts revised downward never claw back and
 *     re-polls never double-pay.
 *   - A per-post-per-run view cap bounds a single viral spike (and a
 *     compromised provider) — the remainder is simply paid over
 *     subsequent runs as `paidViews` catches up.
 *   - A refund/fraud hold (`eligibleAt`) defers approval, same as
 *     referral commissions.
 *
 * Master flags: `SHOGO_AFFILIATES_NATIVE` AND `SHOGO_AFFILIATE_CONTENT_CPM`
 * must both be 'true'. Callers check `isContentCpmEnabled()`.
 */

import { randomBytes } from 'node:crypto'

import { prisma } from '../lib/prisma'
import { getRefundHoldDays } from './affiliate.service'
import {
  getSocialContentProvider,
  type SocialPlatform,
  SocialProviderError,
} from './social-content'

// ============================================================================
// Config
// ============================================================================

export const DEFAULT_CONTENT_CPM_CENTS = 100 // $1.00 per 1,000 views
export const DEFAULT_CONTENT_HOLD_DAYS = 7
export const DEFAULT_POSTS_PER_ACCOUNT = 30
export const DEFAULT_MAX_VIEWS_PER_POST_PER_RUN = 5_000_000

const SUPPORTED_PLATFORMS: readonly SocialPlatform[] = ['instagram', 'tiktok']
// Handles: letters/digits/dot/underscore, 1-30 chars (covers IG + TikTok).
const HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/

/** Both the affiliate master flag and the content sub-flag must be on. */
export function isContentCpmEnabled(): boolean {
  return (
    process.env.SHOGO_AFFILIATES_NATIVE === 'true' &&
    process.env.SHOGO_AFFILIATE_CONTENT_CPM === 'true'
  )
}

function intFromEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  const n = raw ? parseInt(raw, 10) : fallback
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function getContentHoldDays(): number {
  return intFromEnv('SHOGO_AFFILIATE_CONTENT_HOLD_DAYS', DEFAULT_CONTENT_HOLD_DAYS)
}

export function getPostsPerAccount(): number {
  return intFromEnv('SHOGO_AFFILIATE_CONTENT_POSTS_PER_ACCOUNT', DEFAULT_POSTS_PER_ACCOUNT, 1)
}

export function getMaxViewsPerPostPerRun(): number {
  return intFromEnv(
    'SHOGO_AFFILIATE_CONTENT_MAX_VIEWS_PER_POST_PER_RUN',
    DEFAULT_MAX_VIEWS_PER_POST_PER_RUN,
    1,
  )
}

/**
 * Resolve the CPM rate (cents per 1,000 views) for a platform. Precedence:
 *   1. PlatformSetting `affiliate.content.<platform>.cpmCents` (per-platform)
 *   2. PlatformSetting `affiliate.content.cpmCents` (global)
 *   3. env `SHOGO_AFFILIATE_CONTENT_CPM_CENTS`
 *   4. DEFAULT_CONTENT_CPM_CENTS
 */
export async function getContentCpmCents(platform: SocialPlatform): Promise<number> {
  const keys = [`affiliate.content.${platform}.cpmCents`, 'affiliate.content.cpmCents']
  try {
    const rows = (await prisma.platformSetting.findMany({
      where: { key: { in: keys } },
    })) as Array<{ key: string; value: string }>
    const byKey = new Map(rows.map((r) => [r.key, r.value]))
    for (const k of keys) {
      const v = byKey.get(k)
      if (v != null) {
        const n = parseInt(v, 10)
        if (Number.isFinite(n) && n >= 0) return n
      }
    }
  } catch (err) {
    console.error('[affiliate-content] cpm setting lookup failed; using env/default:', (err as Error).message)
  }
  return intFromEnv('SHOGO_AFFILIATE_CONTENT_CPM_CENTS', DEFAULT_CONTENT_CPM_CENTS)
}

// ============================================================================
// Errors
// ============================================================================

export class ContentAffiliateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ContentAffiliateError'
  }
}

export function contentErrorStatus(code: string): number {
  switch (code) {
    case 'invalid_platform':
    case 'invalid_handle':
      return 400
    case 'handle_taken':
      return 409
    case 'account_not_found':
    case 'affiliate_not_found':
      return 404
    case 'provider_not_configured':
      return 503
    case 'provider_error':
      return 502
    default:
      return 500
  }
}

// ============================================================================
// Connect / list / remove handles
// ============================================================================

export function normalizeHandleInput(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

function mintVerificationCode(): string {
  return `shogo-${randomBytes(4).toString('hex')}`
}

export async function addSocialAccount(
  affiliateId: string,
  platformRaw: string,
  handleRaw: string,
): Promise<any> {
  const platform = platformRaw as SocialPlatform
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new ContentAffiliateError('invalid_platform', `Unsupported platform "${platformRaw}"`)
  }
  const handle = normalizeHandleInput(handleRaw)
  if (!HANDLE_PATTERN.test(handle)) {
    throw new ContentAffiliateError(
      'invalid_handle',
      'Handle must be 1-30 chars: letters, digits, dot, or underscore (no @).',
    )
  }

  // Idempotent per affiliate: re-connecting a handle they already own
  // returns the existing row instead of erroring.
  const existing = await prisma.affiliateSocialAccount.findUnique({
    where: { platform_handle: { platform, handle } },
  })
  if (existing) {
    if (existing.affiliateId === affiliateId) return existing
    throw new ContentAffiliateError(
      'handle_taken',
      `@${handle} on ${platform} is already connected by another affiliate.`,
    )
  }

  try {
    return await prisma.affiliateSocialAccount.create({
      data: {
        affiliateId,
        platform,
        handle,
        verificationStatus: 'pending',
        verificationCode: mintVerificationCode(),
      },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      throw new ContentAffiliateError('handle_taken', `@${handle} on ${platform} is already connected.`)
    }
    throw err
  }
}

export async function listSocialAccounts(affiliateId: string): Promise<any[]> {
  return prisma.affiliateSocialAccount.findMany({
    where: { affiliateId },
    orderBy: { createdAt: 'asc' },
  })
}

export async function removeSocialAccount(affiliateId: string, accountId: string): Promise<void> {
  const account = await prisma.affiliateSocialAccount.findUnique({ where: { id: accountId } })
  if (!account || account.affiliateId !== affiliateId) {
    throw new ContentAffiliateError('account_not_found', 'Social account not found')
  }
  await prisma.affiliateSocialAccount.delete({ where: { id: accountId } })
}

// ============================================================================
// Ownership verification
// ============================================================================

/**
 * Confirm the affiliate controls `accountId` by fetching its public
 * profile and checking the one-time `verificationCode` appears in the
 * bio or display name. On success: `verified`, `verifiedAt`,
 * `providerUserId` captured. On failure: stays `pending` (so the
 * affiliate can edit their bio and retry) and `lastError` is set.
 */
export async function verifyAccount(
  affiliateId: string,
  accountId: string,
  now: Date = new Date(),
): Promise<{ verified: boolean; account: any }> {
  const account = await prisma.affiliateSocialAccount.findUnique({ where: { id: accountId } })
  if (!account || account.affiliateId !== affiliateId) {
    throw new ContentAffiliateError('account_not_found', 'Social account not found')
  }
  if (account.verificationStatus === 'verified') {
    return { verified: true, account }
  }

  let provider
  try {
    provider = await getSocialContentProvider()
  } catch (err) {
    if (err instanceof SocialProviderError && err.code === 'not_configured') {
      throw new ContentAffiliateError('provider_not_configured', err.message)
    }
    throw err
  }

  let profile
  try {
    profile = await provider.getProfile(account.platform as SocialPlatform, account.handle)
  } catch (err) {
    const msg = err instanceof SocialProviderError ? err.message : String(err)
    await prisma.affiliateSocialAccount.update({
      where: { id: accountId },
      data: { lastError: msg },
    })
    if (err instanceof SocialProviderError && err.code === 'not_found') {
      throw new ContentAffiliateError('account_not_found', `@${account.handle} not found on ${account.platform}`)
    }
    throw new ContentAffiliateError('provider_error', msg)
  }

  const haystack = `${profile.bio}\n${profile.displayName ?? ''}`.toLowerCase()
  const found = haystack.includes(account.verificationCode.toLowerCase())

  const updated = await prisma.affiliateSocialAccount.update({
    where: { id: accountId },
    data: found
      ? {
          verificationStatus: 'verified',
          verifiedAt: now,
          providerUserId: profile.providerUserId,
          lastError: null,
        }
      : {
          lastError: `Verification code not found in @${account.handle}'s bio yet.`,
        },
  })
  return { verified: found, account: updated }
}

// ============================================================================
// Polling + CPM accrual
// ============================================================================

export interface PollAccountResult {
  accountId: string
  platform: SocialPlatform
  handle: string
  postsSeen: number
  newSnapshots: number
  paidViews: number
  newCommissionCents: number
  error?: string
}

/**
 * Poll one verified account: refresh each recent post's metrics, write a
 * snapshot, and mint a `content` commission for the incremental views.
 * Per-post work is transactional so a crash can't snapshot-without-paying
 * or pay-without-advancing the high-water mark.
 *
 * Provider failures are isolated: they set `lastError` and return with an
 * `error` field rather than throwing, so one bad handle never aborts the
 * batch.
 */
export async function pollAccount(account: any, now: Date = new Date()): Promise<PollAccountResult> {
  const platform = account.platform as SocialPlatform
  const result: PollAccountResult = {
    accountId: account.id,
    platform,
    handle: account.handle,
    postsSeen: 0,
    newSnapshots: 0,
    paidViews: 0,
    newCommissionCents: 0,
  }

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: account.affiliateId },
    select: { id: true, userId: true },
  })
  if (!affiliate) {
    result.error = 'affiliate_not_found'
    return result
  }

  let provider
  try {
    provider = await getSocialContentProvider()
  } catch (err) {
    result.error = err instanceof SocialProviderError ? err.message : String(err)
    return result
  }

  let posts
  try {
    posts = await provider.listRecentPosts(platform, account.handle, getPostsPerAccount())
  } catch (err) {
    const msg = err instanceof SocialProviderError ? err.message : String(err)
    result.error = msg
    await prisma.affiliateSocialAccount.update({
      where: { id: account.id },
      data: { lastPolledAt: now, lastError: msg },
    })
    return result
  }

  const cpmCents = await getContentCpmCents(platform)
  const maxViewsPerRun = getMaxViewsPerPostPerRun()
  const holdDays = getContentHoldDays()
  const eligibleAt = new Date(now.getTime() + holdDays * 24 * 60 * 60 * 1000)

  for (const np of posts) {
    if (!np.providerPostId) continue
    result.postsSeen++
    try {
      const perPost = await accruePost({
        affiliateId: affiliate.id,
        affiliateUserId: affiliate.userId,
        socialAccountId: account.id,
        platform,
        np,
        cpmCents,
        maxViewsPerRun,
        eligibleAt,
        now,
      })
      result.newSnapshots++
      result.paidViews += perPost.paidViews
      result.newCommissionCents += perPost.commissionCents
    } catch (err) {
      console.error('[affiliate-content] accruePost failed', {
        accountId: account.id,
        providerPostId: np.providerPostId,
        err: (err as Error)?.message ?? err,
      })
    }
  }

  await prisma.affiliateSocialAccount.update({
    where: { id: account.id },
    data: { lastPolledAt: now, lastError: result.error ?? null },
  })
  return result
}

interface AccrueArgs {
  affiliateId: string
  affiliateUserId: string
  socialAccountId: string
  platform: SocialPlatform
  np: { providerPostId: string; url: string | null; caption: string | null; postedAt: Date | null; views: number; likes: number; comments: number; shares: number }
  cpmCents: number
  maxViewsPerRun: number
  eligibleAt: Date
  now: Date
}

/**
 * Upsert one post, snapshot it, and (if there are new views) mint a
 * content commission — all in a single transaction. Returns the views
 * paid on and the commission cents minted this run.
 */
async function accruePost(args: AccrueArgs): Promise<{ paidViews: number; commissionCents: number }> {
  const { np, platform } = args
  return prisma.$transaction(async (tx) => {
    const existing = await tx.affiliatePost.findUnique({
      where: { platform_providerPostId: { platform, providerPostId: np.providerPostId } },
    })

    let post = existing
    if (!post) {
      post = await tx.affiliatePost.create({
        data: {
          socialAccountId: args.socialAccountId,
          platform,
          providerPostId: np.providerPostId,
          url: np.url,
          caption: np.caption,
          postedAt: np.postedAt,
          lastViews: np.views,
          paidViews: 0,
          lastLikes: np.likes,
          lastComments: np.comments,
          lastShares: np.shares,
          lastPolledAt: args.now,
        },
      })
    } else {
      post = await tx.affiliatePost.update({
        where: { id: post.id },
        data: {
          url: np.url ?? post.url,
          caption: np.caption ?? post.caption,
          postedAt: np.postedAt ?? post.postedAt,
          lastViews: np.views,
          lastLikes: np.likes,
          lastComments: np.comments,
          lastShares: np.shares,
          lastPolledAt: args.now,
        },
      })
    }

    const snapshot = await tx.affiliatePostSnapshot.create({
      data: {
        postId: post.id,
        views: np.views,
        likes: np.likes,
        comments: np.comments,
        shares: np.shares,
        capturedAt: args.now,
      },
    })

    // Incremental, capped, never negative.
    let delta = Math.max(0, np.views - post.paidViews)
    if (delta > args.maxViewsPerRun) delta = args.maxViewsPerRun
    if (delta <= 0 || args.cpmCents <= 0) {
      return { paidViews: 0, commissionCents: 0 }
    }

    const amountCents = Math.floor((delta * args.cpmCents) / 1000)
    if (amountCents <= 0) {
      // Delta too small to clear a cent — leave paidViews untouched so the
      // residual views roll into the next run instead of being lost.
      return { paidViews: 0, commissionCents: 0 }
    }

    try {
      await tx.affiliateCommission.create({
        data: {
          affiliateId: args.affiliateId,
          // No referred user for content earnings; attribute to the
          // affiliate's own user id (referredUserId is NOT NULL and has
          // no FK relation — it's an audit pointer).
          referredUserId: args.affiliateUserId,
          referredWorkspaceId: null,
          level: 1,
          basisCents: delta,
          // For content rows, rateBps carries the CPM cents-per-1k rate in
          // effect at accrual time (audit trail if the rate later changes).
          rateBps: args.cpmCents,
          amountCents,
          status: 'pending',
          source: 'content',
          contentRunId: snapshot.id,
          eligibleAt: args.eligibleAt,
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Idempotency guard tripped (same snapshot re-processed) — don't
        // double-pay or advance paidViews.
        return { paidViews: 0, commissionCents: 0 }
      }
      throw err
    }

    await tx.affiliatePost.update({
      where: { id: post.id },
      data: { paidViews: post.paidViews + delta },
    })
    await tx.affiliate.update({
      where: { id: args.affiliateId },
      data: { pendingPayoutCents: { increment: amountCents } },
    })

    return { paidViews: delta, commissionCents: amountCents }
  })
}

export interface PollAllSummary {
  accountsPolled: number
  postsSeen: number
  snapshots: number
  paidViews: number
  newCommissionCents: number
  errors: number
}

/**
 * Poll every verified account. Called by the hourly cron (under a global
 * job lock). Accounts are processed sequentially to keep provider unit
 * spend predictable and avoid hammering the API.
 */
export async function pollAllVerifiedAccounts(now: Date = new Date()): Promise<PollAllSummary> {
  const summary: PollAllSummary = {
    accountsPolled: 0,
    postsSeen: 0,
    snapshots: 0,
    paidViews: 0,
    newCommissionCents: 0,
    errors: 0,
  }

  // Oldest-connected first. (Kept portable across PG/SQLite — no
  // nulls-ordering clause, which SQLite rejects.)
  const accounts: any[] = await prisma.affiliateSocialAccount.findMany({
    where: { verificationStatus: 'verified' },
    orderBy: { createdAt: 'asc' },
  })

  for (const account of accounts) {
    const res = await pollAccount(account, now)
    summary.accountsPolled++
    summary.postsSeen += res.postsSeen
    summary.snapshots += res.newSnapshots
    summary.paidViews += res.paidViews
    summary.newCommissionCents += res.newCommissionCents
    if (res.error) summary.errors++
  }
  return summary
}

// ============================================================================
// Dashboard summary
// ============================================================================

export interface ContentSummary {
  accounts: any[]
  posts: any[]
  totals: {
    posts: number
    lifetimeViews: number
    paidViews: number
    pendingCents: number
    approvedCents: number
    paidCents: number
  }
  cpmCents: { instagram: number; tiktok: number }
}

export async function getContentSummary(affiliateId: string): Promise<ContentSummary> {
  const accounts = await prisma.affiliateSocialAccount.findMany({
    where: { affiliateId },
    orderBy: { createdAt: 'asc' },
  })
  const accountIds = accounts.map((a) => a.id)

  const posts = accountIds.length
    ? await prisma.affiliatePost.findMany({
        where: { socialAccountId: { in: accountIds } },
        orderBy: { lastViews: 'desc' },
        take: 100,
      })
    : []

  const [contentStats, igCpm, ttCpm] = await Promise.all([
    prisma.affiliateCommission.groupBy({
      by: ['status'],
      where: { affiliateId, source: 'content' },
      _sum: { amountCents: true },
    }),
    getContentCpmCents('instagram'),
    getContentCpmCents('tiktok'),
  ])

  const byStatus: Record<string, number> = {}
  for (const row of contentStats as any[]) byStatus[row.status] = row._sum?.amountCents ?? 0

  const lifetimeViews = posts.reduce((acc, p) => acc + (p.lastViews ?? 0), 0)
  const paidViews = posts.reduce((acc, p) => acc + (p.paidViews ?? 0), 0)

  return {
    accounts,
    posts,
    totals: {
      posts: posts.length,
      lifetimeViews,
      paidViews,
      pendingCents: byStatus.pending ?? 0,
      approvedCents: byStatus.approved ?? 0,
      paidCents: byStatus.paid ?? 0,
    },
    cpmCents: { instagram: igCpm, tiktok: ttCpm },
  }
}
