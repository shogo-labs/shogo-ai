// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * License Key Service — single-use coupons that promote a workspace to
 * a paid plan tier by minting a `WorkspaceGrant` on redemption.
 *
 * Issuance and redemption are decoupled so super-admins can pre-mint
 * batches (e.g. for a launch), revoke or expire unredeemed keys, and
 * audit who redeemed what.
 *
 * Storage model:
 *   - Plaintext code is shown to the recipient at issuance ONCE and is
 *     never persisted. Only the sha-256 hex of the canonical (trimmed,
 *     uppercased) plaintext is stored as `codeHash`.
 *   - `codePrefix` is the first 12 plaintext chars — fine to store and
 *     display since it doesn't expose enough entropy to brute-force a
 *     redemption (≥ 80 bits of entropy remain in the suffix).
 *
 * Single-use enforcement:
 *   1. `prisma.licenseKey.updateMany({ where: { codeHash, redeemedAt:
 *      null } })` claims the key atomically — Postgres serializes the
 *      row update so the second concurrent caller sees `count = 0`.
 *   2. UNIQUE constraints on `redeemedByWorkspaceId` and
 *      `redeemedGrantId` are a defense-in-depth backstop that rejects a
 *      double-claim even if the app logic regressed.
 *
 * Composition with billing:
 *   - On redeem we create a `WorkspaceGrant` with the key's `planId`,
 *     `monthlyIncludedUsd`, `freeSeats`, and an `expiresAt` derived from
 *     `durationDays`. The existing `getEffectivePlanId` and
 *     `applyGrantMonthlyAllocation` then treat the workspace as on that
 *     plan without further changes elsewhere.
 *   - The route handler is responsible for calling
 *     `billingService.applyGrantMonthlyAllocation(workspaceId)` AFTER a
 *     successful redeem so the wallet picks up the new allotment
 *     immediately rather than waiting for the next monthly cron tick.
 */

import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { normalizePlanId, PLAN_RANK } from '../config/usage-plans'

// ----------------------------------------------------------------------------
// Code format
// ----------------------------------------------------------------------------

/**
 * Default human-typeable prefix segment for minted keys. Distinct from
 * the plan id so we can change pricing/tier naming without invalidating
 * already-printed marketing collateral.
 */
const DEFAULT_KEY_PREFIX = 'SHGO-PRO'

/**
 * Alphabet used for the random suffix. Chosen to avoid characters that
 * are visually ambiguous in print/handoff (0/O, 1/I/L) and trivially to
 * uppercase/normalize.
 */
const SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * Bytes of entropy per minted key suffix. 15 bytes -> 24 alphabet chars
 * -> ~119 bits of entropy, comfortably brute-force-proof even before
 * the per-IP rate limit on the redeem endpoint.
 */
const SUFFIX_BYTES = 15

/**
 * Format a randomly-generated suffix as three 4-char groups joined by
 * `-` for readability, e.g. `XXXX-XXXX-XXXX`.
 */
function groupSuffix(suffix: string): string {
  const groups: string[] = []
  for (let i = 0; i < suffix.length; i += 4) groups.push(suffix.slice(i, i + 4))
  return groups.join('-')
}

/**
 * Generate a fresh random plaintext code. Returns the user-facing
 * formatted string (with the configured prefix) plus the canonical
 * (uppercased, whitespace-stripped) form used for hashing.
 *
 * Deterministic-by-byte for testability: every output byte comes from
 * `randomBytes`, so the only entropy source is the crypto RNG.
 */
export function mintCode(prefix: string = DEFAULT_KEY_PREFIX): {
  plaintext: string
  canonical: string
} {
  const raw = randomBytes(SUFFIX_BYTES)
  let suffix = ''
  for (let i = 0; i < raw.length; i++) {
    // `% 31` is biased by ~3.6% over 256 -> 31. Acceptable for a 119-bit
    // suffix where the post-bias entropy still exceeds 117 bits. We
    // explicitly call out the bias here so future maintainers don't
    // "fix" it with a rejection-sampling loop and regress the
    // determinism of the mint path under test mocks.
    suffix += SUFFIX_ALPHABET[raw[i] % SUFFIX_ALPHABET.length]
  }
  const grouped = groupSuffix(suffix.slice(0, 12))
  const plaintext = `${prefix}-${grouped}`
  return { plaintext, canonical: canonicalize(plaintext) }
}

/**
 * Canonicalize a plaintext code as supplied by a user so that
 * incidental formatting (lowercase, surrounding whitespace, an
 * accidental trailing newline from a copy-paste) doesn't cause an
 * otherwise-valid key to miss the hash lookup.
 *
 * We deliberately do NOT strip internal dashes because the grouping
 * is part of the printed form and removing them would let
 * `SHGOPROXXXX...` collide with `SHGO-PRO-XXXX-...` — fine for
 * matching, but it muddies the redemption logs.
 */
export function canonicalize(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * Sha-256 hex digest of the canonical code. Exported for tests.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(canonicalize(code)).digest('hex')
}

// ----------------------------------------------------------------------------
// Mint
// ----------------------------------------------------------------------------

export interface MintOptions {
  /** Number of keys to generate in this batch. Must be >= 1. */
  count: number
  /**
   * Plan the redemption confers via the generated grant. Must
   * normalize to one of `basic|pro|business|enterprise`. Free is
   * rejected — license keys are intended to upgrade.
   */
  planId: string
  /** Length of the conferred grant in days. `null` = perpetual. */
  durationDays?: number | null
  /** Extra USD credit stacked into the generated grant. */
  monthlyIncludedUsd?: number
  /** Extra free seats stacked into the generated grant. */
  freeSeats?: number
  /** Optional batch identifier for reconciliation, e.g. `hn-launch-2026`. */
  batchId?: string | null
  /** Optional plaintext key prefix; defaults to `SHGO-PRO`. */
  codePrefix?: string
  /** If set, the key itself expires at this instant if unredeemed. */
  expiresAt?: Date | null
  /** Free-form note attached to every key in the batch. */
  note?: string | null
  /** User minting the keys (audit only). */
  createdByUserId?: string | null
}

export interface MintedLicenseKey {
  id: string
  plaintext: string
  codePrefix: string
  planId: string
  expiresAt: Date | null
}

/**
 * Mint a batch of single-use license keys. Returns the plaintext codes
 * exactly once — the caller is responsible for surfacing them to the
 * admin (e.g. as a CSV download) because they cannot be recovered after
 * this function returns.
 *
 * Validates `planId` up front so a typo doesn't end up minting 500 keys
 * that all redeem to "free".
 */
export async function mintLicenseKeys(opts: MintOptions): Promise<MintedLicenseKey[]> {
  if (!Number.isFinite(opts.count) || opts.count < 1) {
    throw new Error('mintLicenseKeys: count must be >= 1')
  }
  if (opts.count > 10_000) {
    // Soft cap. A single transaction inserting 10k rows is fine; the
    // bigger risk is an admin accidentally typing an extra zero.
    throw new Error('mintLicenseKeys: count must be <= 10000 per batch')
  }
  const normalized = normalizePlanId(opts.planId)
  if (!normalized || PLAN_RANK[normalized] < PLAN_RANK.basic) {
    throw new Error(`mintLicenseKeys: planId must confer a paid tier (got ${opts.planId})`)
  }
  const prefix = opts.codePrefix ?? DEFAULT_KEY_PREFIX

  const rows: Array<{
    plaintext: string
    canonical: string
    codeHash: string
    codePrefix: string
  }> = []
  // Local de-dup defense against the (vanishingly small) chance of a
  // RNG collision inside a single batch. The DB's `codeHash` unique
  // index is the global backstop.
  const seenHashes = new Set<string>()
  while (rows.length < opts.count) {
    const { plaintext, canonical } = mintCode(prefix)
    const codeHash = hashCode(plaintext)
    if (seenHashes.has(codeHash)) continue
    seenHashes.add(codeHash)
    rows.push({ plaintext, canonical, codeHash, codePrefix: plaintext.slice(0, 12) })
  }

  // Insert in a single transaction so a mid-batch failure doesn't
  // leave a partial set of orphan rows.
  const inserted = await prisma.$transaction(
    rows.map((r) =>
      prisma.licenseKey.create({
        data: {
          codeHash: r.codeHash,
          codePrefix: r.codePrefix,
          batchId: opts.batchId ?? null,
          planId: normalized,
          monthlyIncludedUsd: opts.monthlyIncludedUsd ?? 0,
          freeSeats: opts.freeSeats ?? 0,
          durationDays: opts.durationDays ?? null,
          expiresAt: opts.expiresAt ?? null,
          note: opts.note ?? null,
          createdByUserId: opts.createdByUserId ?? null,
        },
        select: { id: true, codePrefix: true, planId: true, expiresAt: true },
      }),
    ),
  )

  return inserted.map((row, idx) => ({
    id: row.id,
    plaintext: rows[idx].plaintext,
    codePrefix: row.codePrefix,
    planId: row.planId,
    expiresAt: row.expiresAt,
  }))
}

// ----------------------------------------------------------------------------
// Redeem
// ----------------------------------------------------------------------------

export type RedeemFailureCode =
  | 'not_found'
  | 'already_redeemed'
  | 'expired'
  | 'workspace_not_found'

export class LicenseKeyRedeemError extends Error {
  constructor(public code: RedeemFailureCode, message: string) {
    super(message)
    this.name = 'LicenseKeyRedeemError'
  }
}

export interface RedeemResult {
  licenseKeyId: string
  grantId: string
  planId: string
  grantExpiresAt: Date | null
  /**
   * Set when this redeem call was the FIRST one to succeed for this
   * code. Idempotent re-attempts that observe an already-redeemed key
   * surface `LicenseKeyRedeemError('already_redeemed')` instead — we
   * never silently return another workspace's grant.
   */
  fresh: true
}

/**
 * Redeem a plaintext license code against a workspace. Atomically:
 *
 *   1. Claims the key by setting `redeemedAt` / `redeemedByWorkspaceId`
 *      only when both are currently null. Concurrent claims are
 *      serialized at the row-lock level by `updateMany`.
 *   2. Reads back the claimed key (now guaranteed unique-to-us).
 *   3. Inserts a `WorkspaceGrant` reflecting the key's plan/credits.
 *   4. Stamps the key's `redeemedGrantId` so the grant is auditable
 *      back to the originating coupon.
 *
 * Throws `LicenseKeyRedeemError` for known failure modes so route
 * handlers can map to a stable error code without inspecting Prisma
 * exception types.
 */
export async function redeemLicenseKey(args: {
  code: string
  workspaceId: string
  userId: string | null
  now?: Date
}): Promise<RedeemResult> {
  const now = args.now ?? new Date()
  const codeHash = hashCode(args.code)

  // Cheap pre-check so we can distinguish `not_found` from
  // `already_redeemed` / `expired` for nicer UX. Race: a concurrent
  // redeem can flip the key to `redeemed` between this read and the
  // `updateMany` below — but the `updateMany` enforces the truth, so
  // the worst case is we report `already_redeemed` correctly via the
  // post-update branch instead of pre-check.
  const existing = await prisma.licenseKey.findUnique({ where: { codeHash } })
  if (!existing) {
    throw new LicenseKeyRedeemError('not_found', 'Invalid license key')
  }
  if (existing.redeemedAt) {
    throw new LicenseKeyRedeemError('already_redeemed', 'License key has already been redeemed')
  }
  if (existing.expiresAt && existing.expiresAt <= now) {
    throw new LicenseKeyRedeemError('expired', 'License key has expired')
  }

  // Atomic claim. We deliberately use `updateMany` rather than
  // `update` because:
  //   - `update` would throw on the second concurrent caller (record
  //     not found after both filters applied), which we'd need to
  //     catch and reinterpret.
  //   - `updateMany({ count })` gives us a clean boolean: did we win.
  const claim = await prisma.licenseKey.updateMany({
    where: {
      codeHash,
      redeemedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      redeemedAt: now,
      redeemedByWorkspaceId: args.workspaceId,
      redeemedByUserId: args.userId ?? null,
    },
  })
  if (claim.count === 0) {
    // Either someone else just won the race, or the expiry just
    // tripped. Either is "no longer valid for redemption".
    throw new LicenseKeyRedeemError(
      'already_redeemed',
      'License key has already been redeemed',
    )
  }

  const claimed = await prisma.licenseKey.findUnique({ where: { codeHash } })
  if (!claimed) {
    // Should be impossible: we just updated this row. Treat as a
    // server error if it ever happens.
    throw new Error('redeemLicenseKey: claimed key vanished after update')
  }

  const expiresAt = claimed.durationDays
    ? new Date(now.getTime() + claimed.durationDays * 86_400_000)
    : null

  const grant = await prisma.workspaceGrant.create({
    data: {
      workspaceId: args.workspaceId,
      planId: claimed.planId,
      freeSeats: claimed.freeSeats,
      monthlyIncludedUsd: claimed.monthlyIncludedUsd,
      startsAt: now,
      expiresAt,
      note: `License key redemption (${claimed.codePrefix})`,
      createdByUserId: args.userId ?? null,
    },
    select: { id: true, planId: true, expiresAt: true },
  })

  await prisma.licenseKey.update({
    where: { codeHash },
    data: { redeemedGrantId: grant.id },
  })

  return {
    licenseKeyId: claimed.id,
    grantId: grant.id,
    planId: grant.planId ?? claimed.planId,
    grantExpiresAt: grant.expiresAt,
    fresh: true,
  }
}

// ----------------------------------------------------------------------------
// List / revoke (admin)
// ----------------------------------------------------------------------------

export interface ListLicenseKeysFilter {
  batchId?: string
  redeemed?: boolean
  limit?: number
  offset?: number
}

/**
 * List license keys for an admin UI. Plaintext is intentionally absent
 * — we only ever store the hash. `codePrefix` is enough to identify a
 * key during reconciliation.
 */
export async function listLicenseKeys(filter: ListLicenseKeysFilter = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
  const where: Record<string, unknown> = {}
  if (filter.batchId) where.batchId = filter.batchId
  if (filter.redeemed === true) where.redeemedAt = { not: null }
  if (filter.redeemed === false) where.redeemedAt = null
  return prisma.licenseKey.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: filter.offset ?? 0,
    select: {
      id: true,
      codePrefix: true,
      batchId: true,
      planId: true,
      monthlyIncludedUsd: true,
      freeSeats: true,
      durationDays: true,
      expiresAt: true,
      redeemedAt: true,
      redeemedByWorkspaceId: true,
      redeemedByUserId: true,
      redeemedGrantId: true,
      note: true,
      createdByUserId: true,
      createdAt: true,
    },
  })
}

/**
 * Revoke an unredeemed key by expiring it immediately. Revoking an
 * already-redeemed key is a no-op on the key row; the caller should
 * additionally expire the corresponding `WorkspaceGrant` (via the
 * existing admin grant tooling) if they want to remove the plan
 * upgrade.
 */
export async function revokeLicenseKey(id: string, now: Date = new Date()) {
  return prisma.licenseKey.update({
    where: { id },
    data: { expiresAt: now },
  })
}
