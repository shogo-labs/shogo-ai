// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate content-CPM settings — DB-backed, super-admin controlled.
 *
 * The content-CPM feature (Instagram / TikTok view tracking) is OPTIONAL and
 * primarily for first-party Shogo use. Rather than baking its knobs into env
 * vars on every deployment, the whole config lives in `PlatformSetting` rows
 * under the `affiliate.content.*` namespace and is edited by a super admin via
 * `PUT /api/admin/affiliate-content/settings`. Most deployments never seed
 * these rows, so the feature stays fully off (master toggle defaults to
 * `false`, fail-closed).
 *
 * Keys (all optional; defaults below apply when absent):
 *   affiliate.content.enabled                 'true' | 'false'  (master toggle)
 *   affiliate.content.provider                'ensembledata' | 'official'
 *   affiliate.content.cpmCents                int   (global CPM, cents / 1k views)
 *   affiliate.content.instagram.cpmCents      int   (per-platform override)
 *   affiliate.content.tiktok.cpmCents         int   (per-platform override)
 *   affiliate.content.holdDays                int   (hold before payable)
 *   affiliate.content.postsPerAccount         int   (recent posts fetched per poll; default 20, capped at POSTS_PER_ACCOUNT_MAX)
 *   affiliate.content.maxViewsPerPostPerRun   int   (anti-abuse per-run cap)
 *   affiliate.content.perVideoCapCents        int   (default per-video $ cap)
 *   affiliate.content.minPollIntervalMinutes  int   (min minutes between provider
 *                                                    polls of the same account —
 *                                                    throttles EnsembleData spend)
 *
 * Per-CREATOR CPM overrides live on `Affiliate.contentCpmCents` (the content
 * analogue of `commissionRateBps`) and take precedence over everything here;
 * see `resolveCpmCents`. Likewise, per-creator per-video earnings caps live on
 * `Affiliate.contentPerVideoCapCents` and take precedence over the
 * platform-wide `perVideoCapCents` default; see `resolvePerVideoCapCents`.
 *
 * The EnsembleData API token is NOT here — it is a secret stored encrypted
 * under `provider-key.ensembledata` (see social-content/index.ts). The admin
 * settings route writes it through `setEnsembleDataToken` below.
 *
 * Caching mirrors marketplace-feature / provider-credentials: a short in-memory
 * TTL snapshot, dropped explicitly on write via `invalidateContentSettings`.
 */

import { prisma } from '../lib/prisma'
import { encryptSecret, isSecretCryptoConfigured, maskSecret } from '../lib/secret-crypto'
import {
  ENSEMBLEDATA_SETTING_KEY,
  invalidateSocialContentProvider,
} from './social-content'

export type ContentProviderName = 'ensembledata' | 'official'

export interface ContentSettings {
  enabled: boolean
  provider: ContentProviderName
  /** Global CPM, cents paid per 1,000 NEW views. */
  cpmCents: number
  /** Per-platform CPM overrides; null = fall back to the global `cpmCents`. */
  cpmCentsByPlatform: { instagram: number | null; tiktok: number | null }
  holdDays: number
  postsPerAccount: number
  maxViewsPerPostPerRun: number
  /** Platform-wide per-video lifetime earnings cap (cents); null = no cap. */
  perVideoCapCents: number | null
  /**
   * Minimum minutes that must elapse before the SAME account is polled again.
   * The cron fires every 4h, but every API pod in every region runs its own
   * timer; without this throttle the staggered ticks would each re-sweep every
   * account (the global job lock only prevents *concurrent* runs, not
   * frequency), multiplying EnsembleData unit spend by the pod count.
   * `pollAllVerifiedAccounts` only polls accounts whose `lastPolledAt` is older
   * than this, so a handle is hit at most once per interval cluster-wide.
   */
  minPollIntervalMinutes: number
}

export const CONTENT_SETTING_DEFAULTS: ContentSettings = {
  enabled: false,
  provider: 'ensembledata',
  cpmCents: 100, // $1.00 per 1,000 views
  cpmCentsByPlatform: { instagram: null, tiktok: null },
  holdDays: 7,
  // Only the most-recent N posts per account are polled each sweep. Views (and
  // therefore CPM) accrue on recent content; re-fetching a creator's entire
  // back catalogue every cycle just burns EnsembleData paging units for deltas
  // that never come. `depth` in the provider is derived as ceil(N / 10), so 20
  // = 2 pages/call. See POSTS_PER_ACCOUNT_MAX for the hard ceiling.
  postsPerAccount: 20,
  maxViewsPerPostPerRun: 5_000_000,
  perVideoCapCents: null, // uncapped unless an operator sets a default
  minPollIntervalMinutes: 240, // 4h — matches the cron cadence
}

export const CONTENT_SETTING_KEYS = {
  enabled: 'affiliate.content.enabled',
  provider: 'affiliate.content.provider',
  cpmCents: 'affiliate.content.cpmCents',
  cpmInstagram: 'affiliate.content.instagram.cpmCents',
  cpmTiktok: 'affiliate.content.tiktok.cpmCents',
  holdDays: 'affiliate.content.holdDays',
  postsPerAccount: 'affiliate.content.postsPerAccount',
  maxViewsPerPostPerRun: 'affiliate.content.maxViewsPerPostPerRun',
  perVideoCapCents: 'affiliate.content.perVideoCapCents',
  minPollIntervalMinutes: 'affiliate.content.minPollIntervalMinutes',
} as const

const SETTING_PREFIX = 'affiliate.content.'
const CACHE_TTL_MS = 30_000

/**
 * Hard ceiling on `postsPerAccount`. Each sweep pages EnsembleData
 * `ceil(postsPerAccount / 10)` times PER account PER platform (Instagram does
 * it twice — posts + reels), so an unbounded value silently multiplies unit
 * spend. A prod misconfiguration of `1000` (depth 100) re-fetched whole back
 * catalogues every 4h — the 2026-06 over-gather incident. Views accrue on
 * recent posts, so 100 is plenty of headroom above the 20 default. Enforced on
 * read so even an already-persisted runaway value is clamped without a write.
 */
export const POSTS_PER_ACCOUNT_MAX = 100

let cache: { settings: ContentSettings; loadedAt: number } | null = null

function parseIntOr(
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  if (raw == null) return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < min) return fallback
  return max != null ? Math.min(n, max) : n
}

function parseOptionalInt(raw: string | undefined, min: number): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= min ? n : null
}

function buildSettings(byKey: Map<string, string>): ContentSettings {
  const d = CONTENT_SETTING_DEFAULTS
  const providerRaw = (byKey.get(CONTENT_SETTING_KEYS.provider) || '').trim().toLowerCase()
  const provider: ContentProviderName = providerRaw === 'official' ? 'official' : 'ensembledata'
  return {
    enabled: byKey.get(CONTENT_SETTING_KEYS.enabled) === 'true',
    provider,
    cpmCents: parseIntOr(byKey.get(CONTENT_SETTING_KEYS.cpmCents), d.cpmCents, 0),
    cpmCentsByPlatform: {
      instagram: parseOptionalInt(byKey.get(CONTENT_SETTING_KEYS.cpmInstagram), 0),
      tiktok: parseOptionalInt(byKey.get(CONTENT_SETTING_KEYS.cpmTiktok), 0),
    },
    holdDays: parseIntOr(byKey.get(CONTENT_SETTING_KEYS.holdDays), d.holdDays, 0),
    postsPerAccount: parseIntOr(
      byKey.get(CONTENT_SETTING_KEYS.postsPerAccount),
      d.postsPerAccount,
      1,
      POSTS_PER_ACCOUNT_MAX,
    ),
    maxViewsPerPostPerRun: parseIntOr(
      byKey.get(CONTENT_SETTING_KEYS.maxViewsPerPostPerRun),
      d.maxViewsPerPostPerRun,
      1,
    ),
    // A cap of 0 would zero out all earnings, so the floor is 1; absent = no cap.
    perVideoCapCents: parseOptionalInt(byKey.get(CONTENT_SETTING_KEYS.perVideoCapCents), 1),
    // Floor of 1 minute: 0 would disable the throttle and let every staggered
    // pod tick re-poll, which is exactly the regression this guards against.
    minPollIntervalMinutes: parseIntOr(
      byKey.get(CONTENT_SETTING_KEYS.minPollIntervalMinutes),
      d.minPollIntervalMinutes,
      1,
    ),
  }
}

/**
 * Resolved content settings, honoring the in-memory cache. On any DB error we
 * fall back to defaults (master toggle off) — fail-closed, like the
 * marketplace gate.
 */
export async function getContentSettings(opts: { force?: boolean } = {}): Promise<ContentSettings> {
  const now = Date.now()
  if (!opts.force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.settings

  let settings: ContentSettings = { ...CONTENT_SETTING_DEFAULTS }
  try {
    const rows = (await prisma.platformSetting.findMany({
      where: { key: { startsWith: SETTING_PREFIX } },
      select: { key: true, value: true },
    })) as Array<{ key: string; value: string }>
    settings = buildSettings(new Map(rows.map((r) => [r.key, r.value])))
  } catch (err) {
    console.error('[affiliate-content-settings] read failed; using defaults:', (err as Error).message)
  }

  cache = { settings, loadedAt: now }
  return settings
}

/** Drop the cached snapshot (called after a write). */
export function invalidateContentSettings(): void {
  cache = null
}

/**
 * Resolve the CPM (cents per 1,000 views) for one platform. Precedence:
 *   1. per-creator override (`Affiliate.contentCpmCents`)
 *   2. per-platform PlatformSetting (`affiliate.content.<platform>.cpmCents`)
 *   3. global PlatformSetting (`affiliate.content.cpmCents`)
 *   4. built-in default
 */
export function resolveCpmCents(
  settings: ContentSettings,
  platform: 'instagram' | 'tiktok',
  creatorOverrideCents?: number | null,
): number {
  if (creatorOverrideCents != null && Number.isFinite(creatorOverrideCents) && creatorOverrideCents >= 0) {
    return creatorOverrideCents
  }
  const perPlatform = settings.cpmCentsByPlatform[platform]
  if (perPlatform != null) return perPlatform
  return settings.cpmCents
}

/**
 * Resolve the per-video lifetime earnings cap (cents) for one creator.
 * Precedence:
 *   1. per-creator override (`Affiliate.contentPerVideoCapCents`)
 *   2. platform default (`affiliate.content.perVideoCapCents`)
 *   3. no cap (null)
 *
 * Returns null when uncapped. A non-positive value is treated as "no cap"
 * defensively (a 0 cap would silently zero out earnings).
 */
export function resolvePerVideoCapCents(
  settings: ContentSettings,
  creatorOverrideCents?: number | null,
): number | null {
  if (creatorOverrideCents != null && Number.isFinite(creatorOverrideCents) && creatorOverrideCents > 0) {
    return creatorOverrideCents
  }
  const platform = settings.perVideoCapCents
  if (platform != null && platform > 0) return platform
  return null
}

// ============================================================================
// Writes (super-admin)
// ============================================================================

export interface ContentSettingsPatch {
  enabled?: boolean
  provider?: ContentProviderName
  cpmCents?: number | null
  cpmCentsInstagram?: number | null
  cpmCentsTiktok?: number | null
  holdDays?: number | null
  postsPerAccount?: number | null
  maxViewsPerPostPerRun?: number | null
  perVideoCapCents?: number | null
  minPollIntervalMinutes?: number | null
}

async function upsertSetting(key: string, value: string, userId: string): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: userId },
    update: { value, updatedBy: userId },
  })
}

async function deleteSetting(key: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key } })
}

/**
 * Persist a partial settings update. For numeric fields, `null` deletes the
 * row (reverting to the built-in default); a number stores it. Booleans/strings
 * are always stored. Invalidates the cache before returning.
 */
export async function setContentSettings(patch: ContentSettingsPatch, userId: string): Promise<ContentSettings> {
  const numeric: Array<[keyof ContentSettingsPatch, string, number, number?]> = [
    ['cpmCents', CONTENT_SETTING_KEYS.cpmCents, 0],
    ['cpmCentsInstagram', CONTENT_SETTING_KEYS.cpmInstagram, 0],
    ['cpmCentsTiktok', CONTENT_SETTING_KEYS.cpmTiktok, 0],
    ['holdDays', CONTENT_SETTING_KEYS.holdDays, 0],
    ['postsPerAccount', CONTENT_SETTING_KEYS.postsPerAccount, 1, POSTS_PER_ACCOUNT_MAX],
    ['maxViewsPerPostPerRun', CONTENT_SETTING_KEYS.maxViewsPerPostPerRun, 1],
    ['perVideoCapCents', CONTENT_SETTING_KEYS.perVideoCapCents, 1],
    ['minPollIntervalMinutes', CONTENT_SETTING_KEYS.minPollIntervalMinutes, 1],
  ]

  if (patch.enabled !== undefined) {
    await upsertSetting(CONTENT_SETTING_KEYS.enabled, patch.enabled ? 'true' : 'false', userId)
  }
  if (patch.provider !== undefined) {
    const provider: ContentProviderName = patch.provider === 'official' ? 'official' : 'ensembledata'
    await upsertSetting(CONTENT_SETTING_KEYS.provider, provider, userId)
  }
  for (const [field, key, min, max] of numeric) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) {
      await deleteSetting(key)
    } else if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= min &&
      (max == null || value <= max)
    ) {
      await upsertSetting(key, String(value), userId)
    } else {
      const range = max == null ? `>= ${min}` : `between ${min} and ${max}`
      throw new Error(`${String(field)} must be null or an integer ${range}`)
    }
  }

  invalidateContentSettings()
  // Provider change can swap ensembledata <-> official; drop the memoized
  // provider so the next poll rebuilds it.
  invalidateSocialContentProvider()
  return getContentSettings({ force: true })
}

// ============================================================================
// EnsembleData token (encrypted secret — separate namespace)
// ============================================================================

export interface EnsembleDataTokenInfo {
  configured: boolean
  mask: string
  source: 'db' | 'env' | null
}

/** Describe how the EnsembleData token is configured, without leaking it. */
export async function getEnsembleDataTokenInfo(): Promise<EnsembleDataTokenInfo> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: ENSEMBLEDATA_SETTING_KEY },
      select: { value: true },
    })) as { value: string } | null
    if (row?.value) {
      // The stored value is ciphertext; mask the ciphertext (never decrypt for
      // a read-only info call) so we don't surface plaintext.
      return { configured: true, mask: 'ensembledata-token-set', source: 'db' }
    }
  } catch (err) {
    console.error('[affiliate-content-settings] token info read failed:', (err as Error).message)
  }
  const envToken = process.env.ENSEMBLEDATA_API_TOKEN
  if (envToken && envToken.trim()) {
    return { configured: true, mask: maskSecret(envToken.trim()), source: 'env' }
  }
  return { configured: false, mask: '', source: null }
}

/**
 * Store (or clear) the EnsembleData API token. Encrypts the plaintext and
 * upserts `provider-key.ensembledata`; null/empty deletes the stored override
 * (the `ENSEMBLEDATA_API_TOKEN` env fallback then applies). Invalidates the
 * memoized provider so the rotation takes effect within the cache window.
 */
export async function setEnsembleDataToken(plaintext: string | null, userId: string): Promise<void> {
  if (!plaintext || !plaintext.trim()) {
    await prisma.platformSetting.deleteMany({ where: { key: ENSEMBLEDATA_SETTING_KEY } })
    invalidateSocialContentProvider()
    return
  }
  if (!isSecretCryptoConfigured()) {
    throw new Error('SECRETS_ENCRYPTION_KEY is not configured on this server; cannot store the EnsembleData token.')
  }
  const value = encryptSecret(plaintext.trim())
  await prisma.platformSetting.upsert({
    where: { key: ENSEMBLEDATA_SETTING_KEY },
    create: { key: ENSEMBLEDATA_SETTING_KEY, value, updatedBy: userId },
    update: { value, updatedBy: userId },
  })
  invalidateSocialContentProvider()
}
