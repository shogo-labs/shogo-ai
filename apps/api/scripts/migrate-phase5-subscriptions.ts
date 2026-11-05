// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-phase5-subscriptions.ts
 *
 * Move every live Shogo subscription onto the v2.5.0 prices **at its next
 * billing cycle** (SHO-339 / SHO-312 Phase 5), and backfill the Stripe
 * metadata the webhook needs.
 *
 * Why a schedule instead of an immediate price swap: customers were sold an
 * allowance at the old price. Dropping them onto the new price mid-period would
 * charge for a period they already consumed at the old allowance. A
 * Subscription Schedule keeps phase 1 (old price + old allowance) until the
 * switch date and starts phase 2 (new price + new allowance) at that renewal,
 * with `proration_behavior: 'none'` so no customer sees a proration line.
 *
 * What it does per subscription (`active | trialing | past_due`):
 *
 *   1. **Metadata backfill** — `workspaceId`, `planId`, `billingInterval` from
 *      the DB row. 27 of 36 live subs had none, which is what made a renewal
 *      price flip invisible to our DB.
 *   2. **Trial** — swap the item to the new price *now* (no proration, same
 *      quantity, trial end untouched) so it converts at $16, not $40.
 *   3. **Paid, on a legacy price** — one Subscription Schedule: phase 1 until
 *      the switch date, phase 2 from it.
 *   4. **Pro → Business** at $16 / $156 when `--pro-to-business` (default on).
 *   5. **Basic monthly** — metadata only (same $8 price, same allowance).
 *      Basic annual → $78 at renewal.
 *   6. **Idempotent** — a sub that already has a schedule, already sits on the
 *      target price, or carries `phase5MigratedAt` is skipped.
 *
 * `--dry-run` is the DEFAULT; pass `--apply` to write. Every run writes a JSON
 * report to `.tmp/` and prints one row per subscription.
 *
 * Usage:
 *   bun apps/api/scripts/migrate-phase5-subscriptions.ts --env staging \
 *     [--notice-sent-at 2026-11-05T00:00:00Z] [--min-notice-days 7] \
 *     [--pro-to-business|--no-pro-to-business] [--workspace-id <uuid>] \
 *     [--send-notice] [--apply]
 */

import Stripe from 'stripe'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../src/lib/prisma'
import {
  LEGACY_PLAN_PRICES,
  STRIPE_PRICES_PRODUCTION,
  STRIPE_PRICES_STAGING,
  getOveragePriceConfig,
  planFromPriceId,
  type BillingInterval,
  type PlanType,
  type StripePriceConfig,
} from '../src/config/stripe-prices'
import { selectPlanItem, type StripeSubscriptionLike } from '../src/services/stripe-subscription-sync.service'
import { renderPriceChangeEmail } from '../src/services/email-templates/price-change'

const DAY_MS = 24 * 60 * 60 * 1000

export type Phase5Action =
  | 'swap-now'
  | 'schedule'
  | 'metadata-only'
  | 'skip-already-on-target'
  | 'skip-has-schedule'
  | 'skip-already-migrated'
  | 'skip-no-db-row'
  | 'skip-unresolved'

export interface Phase5Candidate {
  /** From the DB `Subscription` row; `null` means there is no row. */
  workspaceId: string | null
  dbPlanId: string | null
  dbBillingInterval: string | null
  stripeSub: StripeSubscriptionLike & {
    status?: string
    current_period_end?: number | null
    default_payment_method?: string | { id?: string | null } | null
    metadata?: Record<string, string> | null
  }
  /** Id of a Subscription Schedule already attached, if any. */
  existingScheduleId: string | null
}

export interface Phase5Options {
  /** The v2.5.0 prices for this environment. */
  prices: StripePriceConfig
  proToBusiness: boolean
  minNoticeDays: number
  noticeSentAt: Date
  now: Date
}

export interface Phase5Row {
  workspaceId: string
  planId: PlanType | null
  seats: number
  interval: BillingInterval
  fromPriceId: string | null
  toPriceId: string | null
  switchDate: Date | null
  action: Phase5Action
  reason?: string
}

function planItemOf(sub: Phase5Candidate['stripeSub']) {
  return selectPlanItem(sub as any)
}

type ScheduleItemLike = {
  id?: string
  quantity?: number | null
  tax_rates?: unknown
  discounts?: unknown
  metadata?: Record<string, string> | null
  price?:
    | string
    | { id?: string | null; recurring?: { usage_type?: string | null } | null }
    | null
}

type SchedulePhaseParam = {
  price: string
  quantity?: number
  tax_rates?: string[]
  discounts?: Array<Record<string, string>>
  metadata?: Record<string, string>
}

/**
 * Per-item settings that `phases[].items` also resets when omitted. Only
 * included when the item actually has them, so an empty list never becomes an
 * invalid parameter.
 */
function carriedItemFields(item: ScheduleItemLike): Partial<SchedulePhaseParam> {
  const carried: Partial<SchedulePhaseParam> = {}
  const taxRates = normalizeTaxRates(item.tax_rates)
  if (taxRates) carried.tax_rates = taxRates
  const discounts = normalizeDiscounts(item.discounts)
  if (discounts) carried.discounts = discounts
  if (item.metadata && Object.keys(item.metadata).length > 0) carried.metadata = item.metadata
  return carried
}

function priceIdOfItem(item: ScheduleItemLike): string | null {
  const price = item.price
  if (!price) return null
  return typeof price === 'string' ? price : (price.id ?? null)
}

function isMeteredItem(item: ScheduleItemLike): boolean {
  const price = item.price
  if (price && typeof price === 'object' && price.recurring?.usage_type === 'metered') return true
  const priceId = priceIdOfItem(item)
  const overagePriceId = getOveragePriceConfig().priceId
  return !!overagePriceId && priceId === overagePriceId
}

/**
 * The item list for one schedule phase.
 *
 * `phases[].items` REPLACES the subscription's items, so a phase that lists
 * only the plan item deletes the metered overage item (and any licensed
 * add-on) the moment the schedule is applied. Every current item is carried
 * into both phases; only the plan item's price changes, and only in phase 2.
 * Metered items take no `quantity` — Stripe rejects one on a usage-priced item.
 */
export function phaseItems(
  sub: Phase5Candidate['stripeSub'],
  phase: { priceId: string; seats: number },
): SchedulePhaseParam[] {
  const planItem = planItemOf(sub) as ScheduleItemLike | null
  const allItems = (sub.items?.data ?? []) as ScheduleItemLike[]
  const items: SchedulePhaseParam[] = []
  let planIncluded = false

  for (const item of allItems) {
    const priceId = priceIdOfItem(item)
    if (!priceId) continue
    const carriedItem = carriedItemFields(item)
    if (planItem && item === (planItem as ScheduleItemLike)) {
      planIncluded = true
      items.push({ ...carriedItem, price: phase.priceId, quantity: phase.seats })
      continue
    }
    if (isMeteredItem(item)) items.push({ ...carriedItem, price: priceId })
    else items.push({ ...carriedItem, price: priceId, quantity: Math.max(1, Math.floor(item.quantity ?? 1)) })
  }

  if (!planIncluded) items.unshift({ price: phase.priceId, quantity: phase.seats })
  return items
}

function idOfRef(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  const id = (value as { id?: string | null }).id
  return id ?? null
}

/** `discounts` back into the shape the schedule update accepts. */
function normalizeDiscounts(discounts: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(discounts) || discounts.length === 0) return undefined
  const out: Array<Record<string, string>> = []
  for (const entry of discounts) {
    const d = entry as { coupon?: unknown; promotion_code?: unknown } | string | null
    if (typeof d === 'string') {
      out.push({ coupon: d })
      continue
    }
    const promotionCode = idOfRef(d?.promotion_code)
    if (promotionCode) {
      out.push({ promotion_code: promotionCode })
      continue
    }
    const coupon = idOfRef(d?.coupon)
    if (coupon) out.push({ coupon })
  }
  return out.length > 0 ? out : undefined
}

function normalizeTaxRates(rates: unknown): string[] | undefined {
  if (!Array.isArray(rates) || rates.length === 0) return undefined
  const out = rates.map(idOfRef).filter((id): id is string => !!id)
  return out.length > 0 ? out : undefined
}

/**
 * Phase-level settings that a schedule update must restate, because omitting
 * them is not "leave unchanged" — it resets them. Taken from the phase that
 * `from_subscription` created, i.e. the subscription's real configuration.
 */
function carriedPhaseFields(phase: Record<string, unknown> | null): Record<string, unknown> {
  if (!phase) return {}
  const carried: Record<string, unknown> = {}
  const discounts = normalizeDiscounts(phase.discounts)
  if (discounts) carried.discounts = discounts
  const taxRates = normalizeTaxRates(phase.default_tax_rates)
  if (taxRates) carried.default_tax_rates = taxRates
  if (typeof phase.collection_method === 'string') carried.collection_method = phase.collection_method
  // `default_payment_method` is phase-level. Every live Shogo subscription
  // pins its card on the subscription and leaves the customer's own default
  // empty, so a phase that omits it has no payment method at all and the
  // renewal invoice cannot be charged.
  const paymentMethod = idOfRef(phase.default_payment_method)
  if (paymentMethod) carried.default_payment_method = paymentMethod
  return carried
}

function priceIdOfSub(sub: Phase5Candidate['stripeSub']): string | null {
  const item = planItemOf(sub)
  const price = (item as any)?.price
  if (!price) return null
  return typeof price === 'string' ? price : (price.id ?? null)
}

/** The plan item's price in USD per billing interval, when Stripe expands it. */
function currentAmountUsd(sub: Phase5Candidate['stripeSub']): number | null {
  const price = (planItemOf(sub) as any)?.price
  const amount = typeof price === 'object' ? price?.unit_amount : null
  return typeof amount === 'number' ? amount / 100 : null
}

/**
 * The end of the current billing period, in seconds.
 *
 * Stripe moved `current_period_end` off the subscription and onto its items in
 * API version 2025-03-31.basil — the version this script pins
 * (`2025-09-30.clover`), so the top-level field is always absent on a real
 * response. Reading only the top level made every paid subscription look like
 * it had no renewal date and the whole run planned zero schedules.
 */
function periodEndSecondsOf(sub: Phase5Candidate['stripeSub']): number | null {
  if (typeof sub.current_period_end === 'number') return sub.current_period_end
  const planItem = planItemOf(sub) as any
  if (typeof planItem?.current_period_end === 'number') return planItem.current_period_end
  for (const item of ((sub as any)?.items?.data ?? []) as any[]) {
    if (typeof item?.current_period_end === 'number') return item.current_period_end
  }
  return null
}

function intervalOf(
  sub: Phase5Candidate['stripeSub'],
  dbInterval: string | null,
): BillingInterval {
  const price = (planItemOf(sub) as any)?.price
  const recurring = typeof price === 'object' ? price?.recurring?.interval : null
  if (recurring === 'year') return 'annual'
  if (recurring === 'month') return 'monthly'
  return dbInterval === 'annual' ? 'annual' : 'monthly'
}

/**
 * Add whole billing periods to `from` until the result is at least
 * `minNoticeDays` after the notice. The first `current_period_end` is normally
 * too close to the notice (a renewal 3 days after the email is not 7 days'
 * notice), so that renewal is skipped and the following one is used.
 */
export function nextEligiblePeriodEnd(
  currentPeriodEnd: Date,
  interval: BillingInterval,
  noticeSentAt: Date,
  minNoticeDays: number,
): Date {
  const earliest = new Date(noticeSentAt.getTime() + minNoticeDays * DAY_MS)
  const result = new Date(currentPeriodEnd)
  let guard = 0
  while (result.getTime() < earliest.getTime() && guard++ < 240) {
    if (interval === 'annual') result.setUTCFullYear(result.getUTCFullYear() + 1)
    else result.setUTCMonth(result.getUTCMonth() + 1)
  }
  return result
}

function resolveTargetPlan(
  currentPlan: PlanType | null,
  opts: Phase5Options,
): PlanType | null {
  if (!currentPlan) return null
  if (currentPlan === 'pro' && opts.proToBusiness) return 'business'
  return currentPlan
}

/** Decide what to do with one subscription. Pure — no Stripe or DB calls. */
export function planPhase5Row(candidate: Phase5Candidate, opts: Phase5Options): Phase5Row {
  const sub = candidate.stripeSub
  const interval = intervalOf(sub, candidate.dbBillingInterval)
  const fromPriceId = priceIdOfSub(sub)
  const seats = Math.max(1, Math.floor((planItemOf(sub) as any)?.quantity ?? 1))
  const currentPlan =
    planFromPriceId(fromPriceId) ?? (candidate.dbPlanId as PlanType | null) ?? null
  const targetPlan = resolveTargetPlan(currentPlan, opts)
  const toPriceId = targetPlan ? (opts.prices[targetPlan]?.[interval] || null) : null

  const base: Omit<Phase5Row, 'action'> = {
    workspaceId: candidate.workspaceId ?? '',
    planId: targetPlan,
    seats,
    interval,
    fromPriceId,
    toPriceId,
    switchDate: null,
  }

  if (!candidate.workspaceId) {
    return { ...base, action: 'skip-no-db-row', reason: 'no DB Subscription row for this Stripe subscription' }
  }
  if (!targetPlan || !toPriceId) {
    return {
      ...base,
      action: 'skip-unresolved',
      reason: targetPlan ? `no ${targetPlan} ${interval} price configured` : 'could not resolve a plan',
    }
  }
  if (sub.metadata?.phase5MigratedAt) {
    return { ...base, action: 'skip-already-migrated', reason: `migrated ${sub.metadata.phase5MigratedAt}` }
  }
  if (candidate.existingScheduleId) {
    // Nothing stamps `phase5MigratedAt` before an existing schedule is checked,
    // so a schedule here means either a run already migrated it and the stamp
    // was lost, or a previous run created the schedule and then failed before
    // the phase update — leaving an empty one-phase schedule that sweeps this
    // sub into a "healthy" skip on every future run. Say which, so the report
    // does not read like success.
    return {
      ...base,
      action: 'skip-has-schedule',
      reason:
        `schedule ${candidate.existingScheduleId} exists but the subscription is not marked ` +
        'phase5MigratedAt — check its phases in Stripe before trusting it',
    }
  }

  // Trial: swap now. A trial has no consumed paid period to protect, and it
  // should convert at the new price rather than at $40 for one cycle.
  if (sub.status === 'trialing' && fromPriceId !== toPriceId) {
    return { ...base, action: 'swap-now' }
  }

  // The price is already right (Basic monthly is $8 before and after, and a
  // re-run after a flip lands here too). The only remaining work is the
  // metadata backfill — 27 of the 36 live subs had none.
  if (fromPriceId === toPriceId) {
    const needsMetadata = !sub.metadata?.workspaceId || !sub.metadata?.planId
    if (!needsMetadata) return { ...base, action: 'skip-already-on-target' }
    return { ...base, action: 'metadata-only', reason: 'price already correct; metadata backfill' }
  }

  // Basic monthly is the same $8 price before and after v2.5.0, so there is
  // nothing to move — only the metadata backfill matters.
  if (targetPlan === 'basic' && interval === 'monthly' && isBasicMonthlyPrice(fromPriceId)) {
    return { ...base, action: 'metadata-only', reason: 'Basic monthly is unchanged' }
  }

  const periodEndSeconds = periodEndSecondsOf(sub)
  const currentPeriodEnd = periodEndSeconds ? new Date(periodEndSeconds * 1000) : null
  if (!currentPeriodEnd) {
    return { ...base, action: 'skip-unresolved', reason: 'subscription has no current_period_end' }
  }

  return {
    ...base,
    action: 'schedule',
    switchDate: nextEligiblePeriodEnd(currentPeriodEnd, interval, opts.noticeSentAt, opts.minNoticeDays),
  }
}

function isBasicMonthlyPrice(priceId: string | null): boolean {
  if (!priceId) return false
  for (const env of ['staging', 'production'] as const) {
    const basic = LEGACY_PLAN_PRICES[env].basic
    if (priceId === basic.monthly) return true
  }
  return false
}

// =============================================================================
// Stripe writes
// =============================================================================

export interface Phase5Stripe {
  subscriptions: {
    update(id: string, params: Record<string, unknown>): Promise<unknown>
  }
  subscriptionSchedules: {
    create(params: Record<string, unknown>): Promise<{
      id: string
      current_phase?: { start_date?: number } | null
      /** `from_subscription` copies the sub's real phase settings here. */
      phases?: Array<Record<string, unknown>> | null
    }>
    update(id: string, params: Record<string, unknown>): Promise<unknown>
  }
}

/**
 * Apply a planned row. `metadata-only` still writes metadata (that IS its
 * purpose); skips write nothing.
 */
export async function applyPhase5Row(
  stripe: Phase5Stripe,
  candidate: Phase5Candidate,
  row: Phase5Row,
  opts: { noticeSentAt?: Date; now: Date },
): Promise<void> {
  const sub = candidate.stripeSub
  if (row.action.startsWith('skip-')) return

  const planItem = planItemOf(sub) as any
  const itemId: string | undefined = planItem?.id
  const metadata: Record<string, string> = {
    ...(sub.metadata ?? {}),
    workspaceId: row.workspaceId,
    planId: row.planId ?? '',
    billingInterval: row.interval,
    seats: String(row.seats),
    ...(opts.noticeSentAt ? { priceChangeNoticeAt: opts.noticeSentAt.toISOString() } : {}),
  }

  if (row.action === 'metadata-only') {
    // Stamp the migration so a second run reports it as done rather than
    // rewriting the same metadata, but only when the metadata is what changed.
    const stamped = sub.metadata?.workspaceId && sub.metadata?.planId
      ? metadata
      : { ...metadata, phase5MigratedAt: opts.now.toISOString() }
    await stripe.subscriptions.update(sub.id, { metadata: stamped })
    return
  }

  const targetPriceId = row.toPriceId!
  const migratedMetadata = { ...metadata, phase5MigratedAt: opts.now.toISOString() }

  if (row.action === 'swap-now') {
    // Trial: same quantity, trial end untouched, no proration.
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: itemId, price: targetPriceId, quantity: row.seats }],
      proration_behavior: 'none',
      metadata: migratedMetadata,
    })
    return
  }

  // schedule
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id })
  const phaseStart = schedule.current_phase?.start_date ?? Math.floor(opts.now.getTime() / 1000)
  // `from_subscription` copies the subscription's real phase settings into the
  // schedule's first phase — including discounts, tax rates and the collection
  // method. A schedule update that omits them resets them, so a customer with a
  // coupon would silently lose it at the next invoice.
  const sourcePhase = (schedule.phases?.[0] ?? schedule.current_phase ?? null) as Record<string, unknown> | null
  const carried = carriedPhaseFields(sourcePhase)
  if (!carried.default_payment_method) {
    const pinnedPaymentMethod = idOfRef((sub as any).default_payment_method)
    if (pinnedPaymentMethod) carried.default_payment_method = pinnedPaymentMethod
  }
  const currentPlanPrice = priceIdOfSub(sub) ?? targetPriceId
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'release',
    metadata: migratedMetadata,
    phases: [
      {
        start_date: phaseStart,
        end_date: Math.floor(row.switchDate!.getTime() / 1000),
        items: phaseItems(sub, { priceId: currentPlanPrice, seats: row.seats }),
        proration_behavior: 'none',
        metadata: { ...metadata, phase: 'legacy-price' },
        ...carried,
      },
      {
        items: phaseItems(sub, { priceId: targetPriceId, seats: row.seats }),
        proration_behavior: 'none',
        metadata: { ...migratedMetadata, phase: 'v2.5.0' },
        ...carried,
      },
    ],
  })
  // The subscription's own metadata carries the audit trail too, so a later
  // `customer.subscription.updated` can see it without reading the schedule.
  await stripe.subscriptions.update(sub.id, { metadata: migratedMetadata })
}

// =============================================================================
// CLI
// =============================================================================

interface Cli {
  env: 'staging' | 'production'
  apply: boolean
  sendNotice: boolean
  workspaceId?: string
  noticeSentAt: Date
  minNoticeDays: number
  proToBusiness: boolean
}

export function parseArgs(argv: string[], now: Date = new Date()): Cli {
  const cli: Cli = {
    env: 'staging',
    apply: false,
    sendNotice: false,
    noticeSentAt: now,
    minNoticeDays: 7,
    proToBusiness: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env') {
      const next = argv[++i]
      if (next !== 'staging' && next !== 'production') throw new Error('--env must be staging|production')
      cli.env = next
    } else if (a === '--apply') {
      cli.apply = true
    } else if (a === '--dry-run') {
      cli.apply = false
    } else if (a === '--send-notice') {
      cli.sendNotice = true
    } else if (a === '--workspace-id') {
      cli.workspaceId = argv[++i]
    } else if (a === '--notice-sent-at') {
      const raw = argv[++i]
      const parsed = new Date(raw)
      if (Number.isNaN(parsed.getTime())) throw new Error(`--notice-sent-at: invalid date "${raw}"`)
      cli.noticeSentAt = parsed
    } else if (a === '--min-notice-days') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0) throw new Error('--min-notice-days must be a non-negative number')
      cli.minNoticeDays = n
    } else if (a === '--pro-to-business') {
      cli.proToBusiness = true
    } else if (a === '--no-pro-to-business') {
      cli.proToBusiness = false
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: migrate-phase5-subscriptions.ts --env staging|production [--dry-run|--apply] ' +
          '[--send-notice] [--workspace-id <uuid>] [--notice-sent-at <iso>] [--min-notice-days 7] ' +
          '[--pro-to-business|--no-pro-to-business]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  return cli
}

function formatRow(r: Phase5Row): string {
  const when = r.switchDate ? r.switchDate.toISOString().slice(0, 10) : '—'
  return [
    r.workspaceId.slice(0, 8).padEnd(8),
    (r.planId ?? '?').padEnd(8),
    String(r.seats).padStart(2),
    r.interval.padEnd(7),
    (r.fromPriceId ?? '—').padEnd(30),
    (r.toPriceId ?? '—').padEnd(30),
    when.padEnd(10),
    r.action,
    r.reason ?? '',
  ].join('  ')
}

async function main() {
  const now = new Date()
  const cli = parseArgs(process.argv.slice(2), now)
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (!apiKey) {
    console.error('STRIPE_SECRET_KEY not set in environment.')
    process.exit(1)
  }
  if (cli.env === 'staging' && !apiKey.startsWith('sk_test_')) {
    console.error(`Refusing to run --env staging with a non-test key (${apiKey.slice(0, 8)}...).`)
    process.exit(1)
  }
  if (cli.env === 'production' && !apiKey.startsWith('sk_live_')) {
    console.error('Refusing to run --env production without a live key.')
    process.exit(1)
  }
  if (cli.env === 'production' && cli.apply && !cli.sendNotice) {
    console.error(
      'Refusing to apply on production without --send-notice: customers must be told about a\n' +
        'price change before it is scheduled. Run with --send-notice (and --notice-sent-at).',
    )
    process.exit(1)
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2025-09-30.clover' as Stripe.LatestApiVersion })
  const prices = cli.env === 'production' ? STRIPE_PRICES_PRODUCTION : STRIPE_PRICES_STAGING

  const where: any = { status: { in: ['active', 'trialing', 'past_due'] } }
  if (cli.workspaceId) where.workspaceId = cli.workspaceId
  const rows = await prisma.subscription.findMany({ where })

  const candidates: Phase5Candidate[] = []
  const orphans: string[] = []
  for (const row of rows) {
    let sub: any
    try {
      sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId, { expand: ['schedule'] })
    } catch (err: any) {
      console.error(`  ✗ ${row.workspaceId}: cannot read Stripe sub ${row.stripeSubscriptionId}: ${err.message}`)
      orphans.push(row.workspaceId)
      continue
    }
    candidates.push({
      workspaceId: row.workspaceId,
      dbPlanId: row.planId,
      dbBillingInterval: row.billingInterval as string,
      stripeSub: sub,
      existingScheduleId: (sub as any).schedule?.id ?? null,
    })
  }

  // Stripe subscriptions that have no DB row: report, never touch.
  const stripeSubs = await stripe.subscriptions.list({ status: 'all', limit: 100 })
  const known = new Set(rows.map((r: any) => r.stripeSubscriptionId))
  const missingRows: string[] = []
  for (const s of stripeSubs.data) {
    const plan = planFromPriceId(
      (selectPlanItem(s as any) as any)?.price?.id ?? null,
    )
    if (plan && !known.has(s.id)) missingRows.push(s.id)
  }

  console.log(
    `\n[phase5] ${cli.env}${cli.apply ? '' : ' (dry-run)'} — ${candidates.length} subscription(s), ` +
      `notice ${cli.noticeSentAt.toISOString().slice(0, 10)}, min ${cli.minNoticeDays}d, ` +
      `pro→business ${cli.proToBusiness ? 'on' : 'off'}\n`,
  )
  console.log(
    ['workspace', 'plan    ', 'se', 'interval', 'from'.padEnd(30), 'to'.padEnd(30), 'switch    ', 'action', 'reason'].join('  '),
  )
  const plans = candidates.map((c) => ({ candidate: c, row: planPhase5Row(c, {
    prices,
    proToBusiness: cli.proToBusiness,
    minNoticeDays: cli.minNoticeDays,
    noticeSentAt: cli.noticeSentAt,
    now,
  }) }))
  for (const p of plans) console.log('  ' + formatRow(p.row))

  if (missingRows.length) {
    console.log(`\n[phase5] ${missingRows.length} Stripe subscription(s) have no DB row (left untouched):`)
    for (const id of missingRows) console.log(`  - ${id}`)
  }
  if (orphans.length) {
    console.log(`\n[phase5] ${orphans.length} DB row(s) could not be read from Stripe: ${orphans.join(', ')}`)
  }

  // Email notice: render + (on --apply --send-notice) send, once per workspace.
  const notices: Array<{ to: string; subject: string; html: string }> = []
  const targetAmountCache = new Map<string, number | null>()
  const targetAmountUsd = async (priceId: string | null): Promise<number | null> => {
    if (!priceId) return null
    if (targetAmountCache.has(priceId)) return targetAmountCache.get(priceId) ?? null
    let amount: number | null = null
    try {
      const price = await stripe.prices.retrieve(priceId)
      amount = typeof price.unit_amount === 'number' ? price.unit_amount / 100 : null
    } catch (err: any) {
      console.error(`  ✗ cannot read price ${priceId} for the notice email: ${err.message}`)
    }
    targetAmountCache.set(priceId, amount)
    return amount
  }
  if (cli.sendNotice) {
    for (const p of plans) {
      if (p.row.action.startsWith('skip-')) continue
      if (p.candidate.stripeSub.metadata?.priceChangeNoticeAt) continue
      // Amounts come from the real prices, never a default: the notice must say
      // $40 → $16 for a Business seat, $20 → $16 for Pro, and "same price" for
      // Basic monthly ($8 both sides). A hardcoded 40/16 wrote all three wrong.
      const fromPriceUsd =
        currentAmountUsd(p.candidate.stripeSub) ?? 40
      const toPriceUsd =
        (await targetAmountUsd(p.row.toPriceId)) ??
        (p.row.toPriceId === p.row.fromPriceId ? fromPriceUsd : null) ??
        16
      const contacts = await loadBillingContacts(p.row.workspaceId)
      for (const contact of contacts) {
        const rendered = renderPriceChangeEmail({
          workspaceName: contact.workspaceName,
          planName: (p.row.planId ?? 'business').replace(/^./, (c) => c.toUpperCase()),
          fromPriceUsd,
          toPriceUsd,
          interval: p.row.interval === 'annual' ? 'year' : 'month',
          switchDate: (p.row.switchDate ?? cli.noticeSentAt).toISOString().slice(0, 10),
          weeklyAllowanceUsd: p.row.planId === 'basic' ? 2.3 : 4.6,
          trial: p.row.action === 'swap-now',
          billingUrl: contact.billingUrl,
        })
        notices.push({ to: contact.email, ...rendered })
      }
    }
    const dir = join(process.cwd(), '.tmp')
    mkdirSync(dir, { recursive: true })
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const emailPath = join(dir, `phase5-price-change-${stamp}.json`)
    writeFileSync(
      emailPath,
      JSON.stringify(
        notices.map((n) => ({ to: cli.apply ? n.to : '(dry-run)', subject: n.subject, html: n.html })),
        null,
        2,
      ),
    )
    console.log(`\n[phase5] ${notices.length} notice email(s) rendered → ${emailPath}`)
    if (cli.apply) {
      const { sendEmailNotice } = await import('../src/services/email.service')
      for (const n of notices) {
        await sendEmailNotice({ to: n.to, subject: n.subject, html: n.html })
      }
      console.log(`[phase5] ${notices.length} notice email(s) sent`)
    }
  }

  if (cli.apply) {
    for (const p of plans) {
      try {
        await applyPhase5Row(stripe as unknown as Phase5Stripe, p.candidate, p.row, {
          noticeSentAt: cli.sendNotice ? cli.noticeSentAt : undefined,
          now,
        })
        console.log(`  ✓ ${p.row.workspaceId.slice(0, 8)} ${p.row.action}`)
      } catch (err: any) {
        console.error(`  ✗ ${p.row.workspaceId.slice(0, 8)} ${p.row.action} failed: ${err.message}`)
      }
    }
  }

  const dir = join(process.cwd(), '.tmp')
  mkdirSync(dir, { recursive: true })
  const reportPath = join(dir, `phase5-migration-${now.toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        env: cli.env,
        applied: cli.apply,
        noticeSentAt: cli.noticeSentAt.toISOString(),
        minNoticeDays: cli.minNoticeDays,
        proToBusiness: cli.proToBusiness,
        rows: plans.map((p) => ({
          ...p.row,
          switchDate: p.row.switchDate?.toISOString() ?? null,
          seats: p.row.seats,
        })),
        missingDbRows: missingRows,
        unreadableDbRows: orphans,
      },
      null,
      2,
    ),
  )
  console.log(`\n[phase5] report → ${reportPath}\n`)
  await prisma.$disconnect()
}

interface BillingContact {
  email: string
  workspaceName: string
  billingUrl: string
  fromPriceUsd?: number
  toPriceUsd?: number
}

async function loadBillingContacts(workspaceId: string): Promise<BillingContact[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      members: {
        where: { projectId: null, role: { in: ['owner', 'admin'] } },
        select: { user: { select: { email: true } } },
      },
    },
  })
  if (!workspace) return []
  const base = process.env.FRONTEND_URL || 'https://studio.shogo.ai'
  return workspace.members
    .map((m) => m.user?.email)
    .filter((e): e is string => !!e)
    .map((email) => ({
      email,
      workspaceName: workspace.name,
      billingUrl: `${base}/billing`,
    }))
}

if (import.meta.main) {
  main().catch(async (err) => {
    console.error(err)
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
  })
}
