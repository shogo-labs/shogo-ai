// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate Service — native multi-level marketing (MLM) program.
 *
 * Replaces Rewardful with an in-house opt-in affiliate system where
 * commissions walk a configurable upline (default depth 3). Per-level
 * commission rate and recurring window live in `affiliate_commission_tiers`
 * (one row per level; row count defines max depth used at payout time).
 *
 * Lifecycle:
 *   click  → AffiliateClick (Cloudflare Pages Function via internal API)
 *   signup → AffiliateAttribution locked to userId (better-auth hook)
 *   pay    → AffiliateCommission rows per upline level (Stripe webhook)
 *   hold   → approveEligibleCommissions flips pending→approved after refund hold
 *   payout → runAffiliatePayouts batches approved → Stripe Connect transfer + payout
 *   refund → handleClawback flips back to refunded/clawed_back
 *
 * iOS App Store IAP customers are intentionally EXCLUDED from earning
 * commissions: `recordCommissionsForInvoice` early-returns when the
 * subscription metadata `source === 'ios_iap'`. Attribution is still
 * recorded so we can audit later; only the payout walk is skipped.
 *
 * Overage trust blocks (the $100→$500 ladder in billing.service.ts) are
 * EXCLUDED from the commission basis. They represent provider-cost
 * passthrough, not plan revenue.
 *
 * Master flag: `SHOGO_AFFILIATES_NATIVE` must be 'true' for the webhook
 * path to record commissions. Service functions themselves don't read
 * the flag — callers decide.
 */

import Stripe from 'stripe'
import { createHash, randomUUID } from 'node:crypto'

import { prisma } from '../lib/prisma'
import { withGlobalJobLock } from '../lib/global-job-lock'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

export const DEFAULT_MAX_DEPTH = 3
// Levels actually PAID commissions. Default 1 = direct referrer only (MLM
// payouts off). This is decoupled from DEFAULT_MAX_DEPTH so deep enrollment
// trees still form; we just don't pay the upline beyond this depth. Set
// SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH=3 to re-enable full multi-level payouts.
export const DEFAULT_PAYOUT_MAX_DEPTH = 1
export const DEFAULT_REFUND_HOLD_DAYS = 30
export const DEFAULT_MIN_PAYOUT_CENTS = 5000
export const DEFAULT_COOKIE_DAYS = 60

/** Max enrollment depth: how deep a `parentCode` chain may grow. */
export function getMaxDepth(): number {
  const raw = process.env.SHOGO_AFFILIATE_MAX_DEPTH
  const n = raw ? parseInt(raw, 10) : DEFAULT_MAX_DEPTH
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DEPTH
}

/**
 * Max PAYOUT depth: how many upline levels actually earn a commission on an
 * invoice. Defaults to 1 (direct referrer only). Independent from
 * getMaxDepth() so the enrollment tree can be deeper than what we pay.
 */
export function getPayoutMaxDepth(): number {
  const raw = process.env.SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH
  const n = raw ? parseInt(raw, 10) : DEFAULT_PAYOUT_MAX_DEPTH
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAYOUT_MAX_DEPTH
}

export function getRefundHoldDays(): number {
  const raw = process.env.SHOGO_AFFILIATE_REFUND_HOLD_DAYS
  const n = raw ? parseInt(raw, 10) : DEFAULT_REFUND_HOLD_DAYS
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REFUND_HOLD_DAYS
}

export function getMinPayoutCents(): number {
  const raw = process.env.SHOGO_AFFILIATE_MIN_PAYOUT_CENTS
  const n = raw ? parseInt(raw, 10) : DEFAULT_MIN_PAYOUT_CENTS
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_PAYOUT_CENTS
}

export function getCookieDays(): number {
  const raw = process.env.SHOGO_AFFILIATE_COOKIE_DAYS
  const n = raw ? parseInt(raw, 10) : DEFAULT_COOKIE_DAYS
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOKIE_DAYS
}

/** Strongly typed Affiliate error with a stable machine `code`. */
export class AffiliateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AffiliateError'
  }
}

// ============================================================================
// Enrollment
// ============================================================================

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,38}[a-z0-9])?$/

/** Slug-safe transform of a name or email-local-part. */
function deriveSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40) || 'user'
}

/**
 * Opt-in enrollment. The user explicitly clicks "Join the affiliate
 * program" — we never auto-enroll. Generates a slug from the user's
 * email if none provided, retries on uniqueness collision.
 *
 * `parentCode` ties this affiliate into someone else's downline (the
 * upline goes through that affiliate at level 1, this affiliate at
 * the new bottom). Rejects:
 *   - self_referral: a user can't list their own future code as parent
 *   - parent_not_found: bad code
 *   - parent_too_deep: would push depth past SHOGO_AFFILIATE_MAX_DEPTH
 *   - cycle: parent is already a descendant of `userId` (paranoid; the
 *     `userId @unique` constraint should already prevent this, but
 *     we keep the explicit guard so future schema changes can't
 *     silently regress)
 */
export async function enrollAffiliate(
  userId: string,
  opts: {
    parentCode?: string | null
    code?: string | null
    termsAccepted: boolean
    /** For tests: skip uniqueness retries (sync DBs). */
    maxSlugAttempts?: number
  },
): Promise<any> {
  if (!opts.termsAccepted) {
    throw new AffiliateError('terms_required', 'Affiliate terms must be accepted to enroll')
  }

  // Existing enrollment is idempotent; return it instead of duplicating.
  const existing = await prisma.affiliate.findUnique({ where: { userId } })
  if (existing) return existing

  // Resolve parent if provided.
  let parentAffiliate: any = null
  let depth = 1
  if (opts.parentCode) {
    parentAffiliate = await prisma.affiliate.findUnique({
      where: { code: opts.parentCode.toLowerCase().trim() },
    })
    if (!parentAffiliate) {
      throw new AffiliateError('parent_not_found', `No affiliate found for code "${opts.parentCode}"`)
    }
    if (parentAffiliate.userId === userId) {
      throw new AffiliateError('self_referral', 'You cannot enroll under your own affiliate code')
    }
    if (parentAffiliate.status !== 'active') {
      throw new AffiliateError('parent_inactive', 'Parent affiliate is not active')
    }
    depth = parentAffiliate.depth + 1
    if (depth > getMaxDepth()) {
      throw new AffiliateError(
        'parent_too_deep',
        `Enrolling under ${opts.parentCode} would exceed max depth ${getMaxDepth()}`,
      )
    }
    // Cycle guard: walk up `parentAffiliate.parentAffiliateId` and bail
    // if we ever encounter `userId`. The new affiliate hasn't been
    // created yet, so a cycle here can only happen if `userId` is
    // already an Affiliate sitting upstream — which `userId @unique`
    // on Affiliate makes impossible — but the guard is cheap and the
    // failure mode (infinite walk + double-pay loop) is catastrophic.
    let cursor: any = parentAffiliate
    const seen = new Set<string>()
    while (cursor?.parentAffiliateId) {
      if (seen.has(cursor.parentAffiliateId)) break
      seen.add(cursor.parentAffiliateId)
      const next = await prisma.affiliate.findUnique({
        where: { id: cursor.parentAffiliateId },
      })
      if (!next) break
      if (next.userId === userId) {
        throw new AffiliateError('cycle', 'Cycle detected in affiliate upline chain')
      }
      cursor = next
    }
  }

  // Slug picker. Try caller-supplied first, then derive from email.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  })
  if (!user) {
    throw new AffiliateError('user_not_found', 'User does not exist')
  }
  const requested = opts.code ? opts.code.toLowerCase().trim() : null
  if (requested && !SLUG_PATTERN.test(requested)) {
    throw new AffiliateError(
      'invalid_code',
      'Affiliate code must be 2-40 chars, lowercase letters/digits/hyphen/underscore, no leading/trailing hyphen',
    )
  }
  const baseSlug = requested ?? deriveSlug(user.name || user.email.split('@')[0] || 'user')
  const maxAttempts = opts.maxSlugAttempts ?? 16

  let lastErr: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Caller-supplied codes never get a suffix — collision is a hard error.
    // Auto-derived codes append a short random suffix on each retry.
    const candidate =
      attempt === 0
        ? baseSlug
        : requested
          ? baseSlug // pointless retry — break out below
          : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`

    try {
      const created = await prisma.affiliate.create({
        data: {
          userId,
          code: candidate,
          parentAffiliateId: parentAffiliate?.id ?? null,
          depth,
          status: 'active',
          payoutStatus: 'not_setup',
          termsAcceptedAt: new Date(),
        },
      })
      return created
    } catch (err: any) {
      lastErr = err
      // Prisma unique constraint code. If the caller supplied an
      // explicit code, surface the conflict immediately — don't pick
      // a different slug behind their back.
      if (err?.code === 'P2002' && requested) {
        throw new AffiliateError('code_taken', `Affiliate code "${candidate}" is already in use`)
      }
      if (err?.code !== 'P2002') {
        throw err
      }
      // else: try next derived candidate.
    }
  }
  throw new AffiliateError(
    'slug_exhausted',
    `Could not assign a unique affiliate code after ${maxAttempts} attempts (last error: ${(lastErr as any)?.message})`,
  )
}

// ============================================================================
// Click tracking
// ============================================================================

/** Sha-256 hex of an IP for fraud signals. Never store the raw IP. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

export interface RecordClickInput {
  code: string
  visitorId: string
  ip?: string | null
  userAgent?: string | null
  landingPage?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  referrer?: string | null
  country?: string | null
  now?: Date
}

/**
 * Insert an `AffiliateClick`. Returns the click row. Throws an
 * `AffiliateError` with code `affiliate_not_found` when the slug is
 * unknown, `affiliate_inactive` when suspended/banned.
 */
export async function recordClick(input: RecordClickInput): Promise<any> {
  const now = input.now ?? new Date()
  const code = input.code.toLowerCase().trim()
  const affiliate = await prisma.affiliate.findUnique({ where: { code } })
  if (!affiliate) {
    throw new AffiliateError('affiliate_not_found', `No affiliate found for code "${code}"`)
  }
  if (affiliate.status !== 'active') {
    throw new AffiliateError('affiliate_inactive', `Affiliate "${code}" is ${affiliate.status}`)
  }

  const cookieDays = getCookieDays()
  const expiresAt = new Date(now.getTime() + cookieDays * 24 * 60 * 60 * 1000)

  return prisma.affiliateClick.create({
    data: {
      affiliateId: affiliate.id,
      visitorId: input.visitorId,
      landingPage: input.landingPage ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      referrer: input.referrer ?? null,
      ipHash: input.ip ? hashIp(input.ip) : null,
      userAgent: input.userAgent ?? null,
      country: input.country ?? null,
      createdAt: now,
      expiresAt,
    },
  })
}

// ============================================================================
// Attribution
// ============================================================================

/**
 * Lock the affiliate attribution for `userId` based on the most-recent
 * non-expired click for `visitorId`. Last-click wins.
 *
 * Idempotent on the `userId` unique constraint — re-calling never
 * moves an attribution. Returns `null` when nothing matches or when
 * the click would be a self-referral.
 *
 * `code` is an optional hint (the value of `__shogo_ref` cookie) used
 * to disambiguate when several affiliates have clicks for the same
 * visitor in the cookie window; it picks the matching one before
 * falling back to "most recent".
 */
export async function resolveAttributionForUser(
  userId: string,
  visitorId: string | null,
  code: string | null = null,
  now: Date = new Date(),
): Promise<any | null> {
  if (!visitorId) return null

  // Existing attribution wins — never overwrite.
  const existing = await prisma.affiliateAttribution.findUnique({ where: { userId } })
  if (existing) return existing

  // Find the most recent non-expired click for this visitor. If `code`
  // is supplied, prefer a click for that affiliate.
  const clicks: any[] = await prisma.affiliateClick.findMany({
    where: {
      visitorId,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: { affiliate: true },
  })
  if (clicks.length === 0) return null

  let chosen = clicks[0]
  if (code) {
    const target = code.toLowerCase().trim()
    const match = clicks.find((c) => c.affiliate?.code === target)
    if (match) chosen = match
  }

  // Self-referral guard: a user cannot attribute to their own affiliate.
  if (chosen.affiliate?.userId === userId) return null
  if (chosen.affiliate?.status !== 'active') return null

  try {
    return await prisma.affiliateAttribution.create({
      data: {
        userId,
        affiliateId: chosen.affiliateId,
        visitorId,
        clickId: chosen.id,
      },
    })
  } catch (err: any) {
    // Race with a concurrent attribution write — the unique constraint
    // resolves the winner, return whichever row exists now.
    if (err?.code === 'P2002') {
      return prisma.affiliateAttribution.findUnique({ where: { userId } })
    }
    throw err
  }
}

// ============================================================================
// Upline walk
// ============================================================================

/**
 * Walk the upline from `affiliateId` toward the root, returning at most
 * `maxDepth` entries (level 1 = the affiliate itself, level 2 = parent…).
 * Terminates early on a broken chain (missing parent row).
 *
 * Implemented as an iterative findUnique loop instead of a recursive
 * CTE: depth is bounded by `SHOGO_AFFILIATE_MAX_DEPTH` (typically 3),
 * so the per-row cost is negligible and we keep portable SQL/SQLite
 * compatibility for desktop mode.
 */
export async function getUpline(
  affiliateId: string,
  maxDepth: number = getMaxDepth(),
): Promise<{ affiliateId: string; level: number }[]> {
  const out: { affiliateId: string; level: number }[] = []
  let currentId: string | null = affiliateId
  const seen = new Set<string>()
  for (let level = 1; level <= maxDepth && currentId; level++) {
    if (seen.has(currentId)) break
    const row = await prisma.affiliate.findUnique({
      where: { id: currentId },
      select: { parentAffiliateId: true, status: true },
    })
    if (!row) break
    seen.add(currentId)
    out.push({ affiliateId: currentId, level })
    currentId = row.parentAffiliateId
  }
  return out
}

// ============================================================================
// Commission recording (webhook + reconciliation cron)
// ============================================================================

/** Subset of Stripe.Invoice fields the commission engine actually reads. */
type InvoiceForCommission = {
  id: string
  customer: string | { id: string }
  subscription?: string | { id: string } | null
  subtotal?: number | null
  total?: number | null
  amount_paid?: number | null
  charge?: string | { id: string } | null
  lines?: { data: Array<{ amount: number; metadata?: Record<string, string> | null }> }
}

/**
 * Idempotently record commissions for one Stripe invoice. Walks the
 * upline through the seeded `affiliate_commission_tiers` (which both
 * defines the depth limit and supplies per-level rate + recurring
 * window). Returns the number of commission rows actually created.
 *
 * Behavior:
 *   - early-return when feature flag off
 *   - early-return when `customer.metadata.affiliateId` missing
 *   - early-return when subscription `metadata.source === 'ios_iap'`
 *   - excludes overage trust-block line items from the commission basis
 *   - per-level `durationDays` window: skips a level if the attribution
 *     is older than that window
 *   - upsert keyed on (invoice, affiliate, level) — webhook replays
 *     never produce duplicate rows
 */
export async function recordCommissionsForInvoice(
  invoice: InvoiceForCommission,
  stripe: Stripe,
  now: Date = new Date(),
): Promise<number> {
  if (process.env.SHOGO_AFFILIATES_NATIVE !== 'true') return 0

  // 1. Resolve the customer's affiliateId from Stripe customer metadata.
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!customerId) return 0

  let customer: Stripe.Customer | Stripe.DeletedCustomer
  try {
    customer = await stripe.customers.retrieve(customerId)
  } catch (err: any) {
    console.warn('[Affiliate] failed to retrieve customer for commission:', err?.message ?? err)
    return 0
  }
  if (customer.deleted) return 0
  const affiliateId = (customer as Stripe.Customer).metadata?.affiliateId
  if (!affiliateId) return 0

  // 2. Resolve the subscription's `source` for the iOS-IAP exclusion.
  let source: string | undefined
  let subscriptionId: string | null = null
  const sub = invoice.subscription
  if (sub) {
    subscriptionId = typeof sub === 'string' ? sub : sub.id
    try {
      const full = await stripe.subscriptions.retrieve(subscriptionId)
      source = full.metadata?.source
    } catch (err: any) {
      console.warn('[Affiliate] failed to retrieve subscription for commission:', err?.message ?? err)
      // Fall through with `source = undefined`; we treat that as web_stripe
      // (the iOS path always sets `source: 'ios_iap'` explicitly).
    }
  }
  if (source === 'ios_iap') {
    return 0
  }

  // 3. Find the attribution record (which `referredUserId` to attach).
  const attribution = await prisma.affiliateAttribution.findFirst({
    where: { affiliateId },
    orderBy: { attributedAt: 'desc' },
  })
  if (!attribution) {
    // Customer metadata says affiliateId=X but we have no AffiliateAttribution
    // for any of this affiliate's referrals tied to this user. This can
    // happen during the Rewardful backfill window — we just no-op, the
    // metadata was the only signal and we don't have an authoritative
    // referredUserId to write.
    return 0
  }

  // 4. Compute commission basis. We pay on `subtotal` minus any overage
  // trust-block line items (which are infra cost passthrough — see
  // billing.service.ts:chargeOverageBlocks). Stripe tax/discounts already
  // sit outside subtotal in Stripe's data model, so subtracting overage
  // is the only adjustment needed.
  let basisCents = invoice.subtotal ?? invoice.total ?? invoice.amount_paid ?? 0
  const lines = invoice.lines?.data ?? []
  for (const line of lines) {
    if (line.metadata?.kind === 'overage_block') {
      basisCents -= line.amount
    }
  }
  if (basisCents <= 0) return 0

  // 5. Walk upline through the tier rows. Number of tier rows defines
  // max depth (capped by SHOGO_AFFILIATE_MAX_DEPTH). Per-level
  // `durationDays` decides if THIS level still earns on this invoice.
  const tiers: any[] = await prisma.affiliateCommissionTier.findMany({
    orderBy: { level: 'asc' },
  })
  if (tiers.length === 0) return 0
  // Payout depth is capped independently of enrollment depth: by default
  // only the direct referrer (level 1) earns, even when the enrollment
  // upline is deeper. Bump SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH to pay deeper.
  const cap = Math.min(tiers.length, getPayoutMaxDepth())
  const upline = await getUpline(affiliateId, cap)

  const refundHoldDays = getRefundHoldDays()
  const eligibleAt = new Date(now.getTime() + refundHoldDays * 24 * 60 * 60 * 1000)

  const attrAgeMs = now.getTime() - new Date(attribution.attributedAt).getTime()
  const attrAgeDays = attrAgeMs / (24 * 60 * 60 * 1000)

  const invoiceId = invoice.id
  const chargeId = typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id ?? null

  let created = 0
  for (const tier of tiers) {
    const level = tier.level as number
    if (level > cap) break
    const uplineEntry = upline.find((u) => u.level === level)
    if (!uplineEntry) continue
    let rateBps = tier.rateBps as number
    if (tier.durationDays != null && attrAgeDays > tier.durationDays) {
      // This level's primary window has expired. If a step-down rate is
      // configured (e.g. 20% for year one -> 10% forever), keep paying at
      // that reduced rate; otherwise the level stops earning (legacy
      // behavior — and callers may set a longer window on a deeper level).
      if (tier.secondaryRateBps != null) {
        rateBps = tier.secondaryRateBps as number
      } else {
        continue
      }
    }
    const amountCents = Math.floor((basisCents * rateBps) / 10_000)
    if (amountCents <= 0) continue

    try {
      // create-with-catch is the idempotency primitive: the unique
      // (stripeInvoiceId, affiliateId, level) index throws P2002 on
      // webhook replay, which we swallow without touching counters.
      // This is cleaner than upsert + timestamp comparison because we
      // get an unambiguous "was this an insert?" signal from Prisma.
      await prisma.affiliateCommission.create({
        data: {
          affiliateId: uplineEntry.affiliateId,
          referredUserId: attribution.userId,
          referredWorkspaceId: null,
          stripeInvoiceId: invoiceId,
          stripeChargeId: chargeId,
          level,
          basisCents,
          rateBps,
          amountCents,
          status: 'pending',
          eligibleAt,
        },
      })
      created++
      await prisma.affiliate.update({
        where: { id: uplineEntry.affiliateId },
        data: { pendingPayoutCents: { increment: amountCents } },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Webhook replay — row already exists. Counters were already
        // bumped on the first insert. No-op.
        continue
      }
      console.error('[Affiliate] commission create failed', {
        invoiceId,
        affiliateId: uplineEntry.affiliateId,
        level,
        err: err?.message ?? err,
      })
    }
  }
  return created
}

// ============================================================================
// Clawback (refund / dispute)
// ============================================================================

/**
 * Flip commissions tied to `stripeChargeId` to `refunded` (if not yet
 * paid) or `clawed_back` (if already paid). Updates the affiliate's
 * counters accordingly. Idempotent on re-run.
 *
 * For `clawed_back` rows we DON'T retroactively reverse the Stripe
 * payout (you can't pull money back from a connected account without
 * the affiliate's cooperation). Instead the `pendingPayoutCents`
 * counter goes negative; the next payout batch nets it out before
 * cutting a new transfer.
 */
export async function handleClawback(
  stripeChargeId: string,
  reason: 'refund' | 'dispute' = 'refund',
): Promise<{ refunded: number; clawedBack: number }> {
  const rows: any[] = await prisma.affiliateCommission.findMany({
    where: { stripeChargeId, status: { in: ['pending', 'approved', 'paid'] } },
  })

  let refunded = 0
  let clawedBack = 0
  for (const row of rows) {
    const wasPaid = row.status === 'paid'
    const newStatus = wasPaid ? 'clawed_back' : 'refunded'
    const updated = await prisma.affiliateCommission.update({
      where: { id: row.id },
      data: { status: newStatus },
    })
    if (wasPaid) {
      clawedBack++
      // Don't touch totalPaidOutCents — historical Stripe payouts
      // really happened. The negative pendingPayoutCents nets out on
      // the next batch.
      await prisma.affiliate.update({
        where: { id: row.affiliateId },
        data: {
          pendingPayoutCents: { decrement: row.amountCents },
        },
      })
    } else {
      refunded++
      await prisma.affiliate.update({
        where: { id: row.affiliateId },
        data: { pendingPayoutCents: { decrement: row.amountCents } },
      })
    }
    void updated
    void reason
  }
  return { refunded, clawedBack }
}

// ============================================================================
// Approval (nightly)
// ============================================================================

/**
 * Flip all `pending` rows whose `eligibleAt <= now` to `approved`.
 * Approved rows are eligible to be batched into a payout. Doesn't
 * touch `refunded` / `clawed_back` rows.
 *
 * Returns the number of rows updated.
 */
export async function approveEligibleCommissions(
  now: Date = new Date(),
): Promise<{ approved: number }> {
  const res = await prisma.affiliateCommission.updateMany({
    where: { status: 'pending', eligibleAt: { lte: now } },
    data: { status: 'approved' },
  })
  return { approved: res.count ?? 0 }
}

// ============================================================================
// Payouts (daily; wrapped in global lock by the cron entry point)
// ============================================================================

export interface PayoutSummary {
  candidates: number
  paid: number
  skippedBelowMinimum: number
  skippedUnverifiedPayout: number
  failed: number
  totalCentsPaid: number
}

/**
 * Group approved commissions per affiliate and pay out via Stripe
 * Connect. Skips affiliates below `SHOGO_AFFILIATE_MIN_PAYOUT_CENTS`
 * or without `payoutStatus === 'verified'`.
 *
 * Sequence per affiliate:
 *   1. Create `AffiliatePayout` row (pending).
 *   2. `stripe.transfers.create` — platform balance → connected account.
 *   3. `stripe.payouts.create` (via stripeConnect.triggerPayout) —
 *      connected account → bank.
 *   4. Mark commissions as `paid`, point them at the payout row.
 *   5. Update affiliate counters.
 *
 * Both Stripe writes use `idempotencyKey: payout.id` so transient
 * failures + retries can never double-pay.
 *
 * Failure isolation: a single affiliate's transfer/payout error
 * leaves the row in `failed` with `failureReason` set, but does NOT
 * abort the batch — other affiliates still get paid.
 */
export async function runAffiliatePayouts(
  now: Date = new Date(),
  options: {
    minPayoutCents?: number
    stripeFactory?: () => Stripe | null
  } = {},
): Promise<PayoutSummary> {
  const summary: PayoutSummary = {
    candidates: 0,
    paid: 0,
    skippedBelowMinimum: 0,
    skippedUnverifiedPayout: 0,
    failed: 0,
    totalCentsPaid: 0,
  }
  if (isLocalMode) return summary

  const minPayoutCents = options.minPayoutCents ?? getMinPayoutCents()

  // Group approved commissions by affiliateId in DB (avoids loading every row).
  const groups: any[] = await prisma.affiliateCommission.groupBy({
    by: ['affiliateId'],
    where: { status: 'approved', payoutId: null },
    _sum: { amountCents: true },
  })
  summary.candidates = groups.length
  if (groups.length === 0) return summary

  const stripeFactory = options.stripeFactory ?? (() => {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    return new Stripe(key, { apiVersion: '2025-04-30.basil' as any })
  })
  const stripe = stripeFactory()
  if (!stripe) {
    console.warn('[Affiliate] STRIPE_SECRET_KEY unset; skipping payouts')
    return summary
  }

  for (const g of groups) {
    const affiliateId = g.affiliateId
    const sum = g._sum?.amountCents ?? 0
    if (sum < minPayoutCents) {
      summary.skippedBelowMinimum++
      continue
    }

    const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId } })
    if (!affiliate?.stripeCustomAccountId || affiliate.payoutStatus !== 'verified') {
      summary.skippedUnverifiedPayout++
      continue
    }

    // Period covers oldest unpaid commission → now.
    const oldest = await prisma.affiliateCommission.findFirst({
      where: { affiliateId, status: 'approved', payoutId: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })
    const periodStart = oldest?.createdAt ?? now
    const periodEnd = now

    // 1. Create the payout row first so we have an idempotency key.
    const payout = await prisma.affiliatePayout.create({
      data: {
        affiliateId,
        amountCents: sum,
        status: 'pending',
        periodStart,
        periodEnd,
      },
    })

    try {
      // 2. Platform balance → connected account.
      const transfer = await stripe.transfers.create(
        {
          amount: sum,
          currency: 'usd',
          destination: affiliate.stripeCustomAccountId,
          transfer_group: payout.id,
          metadata: {
            affiliateId,
            payoutId: payout.id,
            kind: 'affiliate_commission',
          },
        },
        { idempotencyKey: `${payout.id}:transfer` },
      )

      // 3. Connected account → bank. stripeConnect.triggerPayout is keyed
      //    on CreatorProfile id (marketplace shape) so we can't reuse it
      //    directly for affiliates; instead we call stripe.payouts.create
      //    against the affiliate's Connect account id with the same
      //    `stripeAccount` + `idempotencyKey` invariants triggerPayout uses.
      const directPayout = await stripe.payouts.create(
        {
          amount: sum,
          currency: 'usd',
          metadata: {
            affiliateId,
            payoutId: payout.id,
            kind: 'affiliate_commission',
          },
        },
        {
          stripeAccount: affiliate.stripeCustomAccountId,
          idempotencyKey: `${payout.id}:payout`,
        },
      )
      const stripePayoutId = directPayout.id

      // 4. Mark commissions paid + point at the payout row.
      await prisma.$transaction(async (tx) => {
        await tx.affiliateCommission.updateMany({
          where: { affiliateId, status: 'approved', payoutId: null },
          data: { status: 'paid', payoutId: payout.id },
        })
        await tx.affiliatePayout.update({
          where: { id: payout.id },
          data: {
            status: 'paid',
            stripeTransferId: transfer.id,
            stripePayoutId,
            paidAt: now,
          },
        })
        await tx.affiliate.update({
          where: { id: affiliateId },
          data: {
            totalEarningsCents: { increment: sum },
            totalPaidOutCents: { increment: sum },
            pendingPayoutCents: { decrement: sum },
          },
        })
      })

      summary.paid++
      summary.totalCentsPaid += sum
    } catch (err: any) {
      summary.failed++
      console.error('[Affiliate] payout failed for', affiliateId, err?.message ?? err)
      await prisma.affiliatePayout
        .update({
          where: { id: payout.id },
          data: { status: 'failed', failureReason: err?.message ?? String(err) },
        })
        .catch(() => undefined)
    }
  }

  return summary
}

/**
 * Lock-wrapped wrapper for the cron entry point. Keep all "global"
 * commission/payout writers behind `withGlobalJobLock` to satisfy the
 * multiregion CI guard.
 */
export async function runAffiliatePayoutsLocked(
  now: Date = new Date(),
): Promise<PayoutSummary | { lockSkipped: true }> {
  const res = await withGlobalJobLock('affiliate-payouts', () => runAffiliatePayouts(now))
  if (!res.acquired) return { lockSkipped: true }
  return res.result
}

export async function approveEligibleCommissionsLocked(
  now: Date = new Date(),
): Promise<{ approved: number } | { lockSkipped: true }> {
  const res = await withGlobalJobLock('approve-commissions', () => approveEligibleCommissions(now))
  if (!res.acquired) return { lockSkipped: true }
  return res.result
}

// ============================================================================
// Dashboard summary helpers
// ============================================================================

export interface AffiliateSummary {
  affiliate: any
  clicks30d: number
  signups30d: number
  commissions30d: number
  pendingCents: number
  approvedCents: number
  paidCents: number
  downlineCounts: Record<number, number>
  cookieDays: number
}

export async function getAffiliateSummary(userId: string, now: Date = new Date()): Promise<AffiliateSummary | null> {
  const affiliate = await prisma.affiliate.findUnique({ where: { userId } })
  if (!affiliate) return null

  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [clicks30d, signups30d, commissions30d, commissionStats, downline] = await Promise.all([
    prisma.affiliateClick.count({
      where: { affiliateId: affiliate.id, createdAt: { gte: since } },
    }),
    prisma.affiliateAttribution.count({
      where: { affiliateId: affiliate.id, attributedAt: { gte: since } },
    }),
    prisma.affiliateCommission.count({
      where: { affiliateId: affiliate.id, createdAt: { gte: since } },
    }),
    prisma.affiliateCommission.groupBy({
      by: ['status'],
      where: { affiliateId: affiliate.id },
      _sum: { amountCents: true },
    }),
    prisma.affiliate.findMany({
      where: { parentAffiliateId: affiliate.id },
      select: { id: true, depth: true },
    }),
  ])

  const byStatus: Record<string, number> = {}
  for (const row of commissionStats as any[]) {
    byStatus[row.status] = row._sum?.amountCents ?? 0
  }

  // L1 = direct children of this affiliate. L2/L3 require walking
  // each child's subtree; we cap at SHOGO_AFFILIATE_MAX_DEPTH levels
  // total so the dashboard query stays bounded.
  const downlineCounts: Record<number, number> = { 1: downline.length }
  const maxDepth = getMaxDepth()
  let frontier = (downline as any[]).map((d) => d.id)
  for (let level = 2; level <= maxDepth && frontier.length > 0; level++) {
    const nextLevel: any[] = await prisma.affiliate.findMany({
      where: { parentAffiliateId: { in: frontier } },
      select: { id: true },
    })
    downlineCounts[level] = nextLevel.length
    frontier = nextLevel.map((n) => n.id)
  }

  return {
    affiliate,
    clicks30d,
    signups30d,
    commissions30d,
    pendingCents: byStatus.pending ?? 0,
    approvedCents: byStatus.approved ?? 0,
    paidCents: byStatus.paid ?? 0,
    downlineCounts,
    cookieDays: getCookieDays(),
  }
}

// Re-export for routes / tests that need a fresh visitor cookie value.
export function newVisitorId(): string {
  return randomUUID()
}
