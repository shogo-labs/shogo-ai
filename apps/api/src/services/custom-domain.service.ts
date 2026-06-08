// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Custom-domain shared logic — apex<->www pairing, canonical resolution, and
 * the poll-and-activate routine used by BOTH the user-initiated verify route
 * (apps/api/src/routes/publish.ts) and the background reconciler cron
 * (apps/api/src/jobs/poll-custom-domains.ts).
 *
 * Keeping this in one place means the "poll Cloudflare -> persist status ->
 * write the Worker KV route once active" sequence can't drift between the
 * two callers.
 */

import { prisma } from '../lib/prisma'
import {
  getCustomHostname,
  getCustomHostnamesConfig,
  putHostnameMapping,
  type CustomHostnameState,
  type DnsInstruction,
  type ValidationRecordState,
} from '../lib/cloudflare-custom-hostnames'
import {
  checkCustomDomainDns,
  type CustomDomainDnsCheck,
} from '../lib/custom-domain-dns-check'

export type CustomDomainStatusValue = 'pending' | 'verifying' | 'active' | 'failed'

/**
 * Provisioning lifecycle stage we surface to the user (a coarser, friendlier
 * view than the raw CF `status`/`sslStatus`). `stalled` is `pending`/
 * `verifying` with correct DNS but past the stall threshold — the only state
 * where a re-trigger is offered.
 */
export type CustomDomainStage =
  | 'awaiting_dns'
  | 'validating'
  | 'issuing'
  | 'active'
  | 'failed'
  | 'stalled'

/** Minimal shape we need from a `CustomDomain` row for canonical/KV work. */
export interface CustomDomainRowLike {
  id: string
  projectId: string
  hostname: string
  status: string
  cfCustomHostnameId: string | null
  sslStatus: string | null
  lastError: string | null
  groupId: string | null
  primary: boolean
  verifiedAt: Date | null
  certAuthority: string | null
  lastCheckedAt: Date | null
  lastRetriggerAt: Date | null
  retriggerCount: number
  dnsOk: boolean | null
  diagnostics: string | null
  createdAt: Date
}

/** Positive number from env, else the default. */
function envMs(name: string, dflt: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/**
 * A domain is "stalled" once it's been past this long without going active
 * (with correct DNS). The window where we offer a re-trigger / auto-heal.
 * 30m by default — comfortably beyond normal DV issuance (seconds-minutes).
 */
export const STALL_THRESHOLD_MS = envMs('CUSTOM_DOMAIN_STALL_THRESHOLD_MS', 30 * 60_000)
/** Minimum gap between MANUAL re-triggers (button), to avoid hammering CF. */
export const MANUAL_COOLDOWN_MS = envMs('CUSTOM_DOMAIN_RETRIGGER_COOLDOWN_MS', 5 * 60_000)
/** Minimum gap between AUTO re-triggers in the reconciler (backoff). */
export const AUTO_RETRIGGER_INTERVAL_MS = envMs('CUSTOM_DOMAIN_AUTO_RETRIGGER_INTERVAL_MS', 30 * 60_000)
/** Hard cap on auto re-triggers per domain (stops a wedged CA looping forever). */
export const MAX_RETRIGGERS = Math.max(0, Math.round(envMs('CUSTOM_DOMAIN_MAX_RETRIGGERS', 6)))
/** A persisted status is "stale" (worth an opportunistic refresh on read). */
export const STALE_READ_MS = envMs('CUSTOM_DOMAIN_STALE_READ_MS', 20_000)
/**
 * After a domain has been polled at the fast (per-tick, ~60s) cadence for
 * this long — roughly 30 checks at the 60s cron interval — the reconciler
 * backs off to the slow cadence below. Domains rarely take this long, so once
 * they do it's almost always a slow CA we're already auto-retriggering; there
 * is no value in a CF GET every minute, so we ease off to keep API usage low.
 */
export const SLOW_POLL_AFTER_MS = envMs('CUSTOM_DOMAIN_SLOW_POLL_AFTER_MS', 30 * 60_000)
/** Slow-cadence poll interval once a domain is past `SLOW_POLL_AFTER_MS`. */
export const SLOW_POLL_INTERVAL_MS = envMs('CUSTOM_DOMAIN_SLOW_POLL_INTERVAL_MS', 10 * 60_000)

/** Human-friendly name for Cloudflare's CA slug, for the UI copy. */
export function prettyCertAuthority(ca: string | null | undefined): string | null {
  if (!ca) return null
  const map: Record<string, string> = {
    google: 'Google Trust Services',
    lets_encrypt: "Let's Encrypt",
    ssl_com: 'SSL.com',
  }
  return map[ca] ?? ca
}

/**
 * Compact, DB-persisted snapshot of the latest status detail so reads are
 * DB-only and still fully informative (DNS records to add, per-record
 * validation, the server-side DNS verdict) without re-hitting Cloudflare.
 * Serialised to the `diagnostics` JSON-string column.
 */
export interface CustomDomainDiagnostics {
  instructions?: DnsInstruction[]
  validation?: ValidationRecordState[]
  dns?: CustomDomainDnsCheck
  certAuthority?: string | null
  checkedAt?: number
}

/** Parse the `diagnostics` JSON-string column; null on absent/garbage. */
export function parseDiagnostics(
  raw: string | null | undefined,
): CustomDomainDiagnostics | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as CustomDomainDiagnostics
  } catch {
    return null
  }
}

/**
 * Map a Cloudflare custom-hostname state to our DB status enum value.
 * CF reports `pending` until the CNAME/DV records are seen, then moves the
 * cert through `pending_validation` -> `pending_issuance` -> `active`.
 */
export function cfStateToStatus(state: CustomHostnameState): CustomDomainStatusValue {
  if (state.active) return 'active'
  if (state.errors.length > 0) return 'failed'
  if (state.sslStatus && state.sslStatus !== 'pending_validation') {
    return 'verifying'
  }
  return 'pending'
}

/** Age (ms) of a row from its creation, clamped at 0. */
function ageMs(row: Pick<CustomDomainRowLike, 'createdAt'>, now: number): number {
  return Math.max(0, now - new Date(row.createdAt).getTime())
}

/** True once this row is past the stall threshold WITH correct DNS. */
function isStalled(
  row: Pick<CustomDomainRowLike, 'createdAt' | 'dnsOk'>,
  now: number,
): boolean {
  return !!row.dnsOk && ageMs(row, now) >= STALL_THRESHOLD_MS
}

/**
 * Derive the coarse lifecycle stage + a human-readable message from a row's
 * persisted status. Pure (DB-only) so both the read path and the cron share
 * exactly one definition of "what's happening".
 */
export function deriveStage(
  row: Pick<
    CustomDomainRowLike,
    'status' | 'sslStatus' | 'lastError' | 'dnsOk' | 'certAuthority' | 'createdAt'
  >,
  now: number = Date.now(),
): { stage: CustomDomainStage; message: string } {
  if (row.status === 'active') {
    return { stage: 'active', message: 'Your domain is live and serving over HTTPS.' }
  }
  if (row.status === 'failed') {
    return {
      stage: 'failed',
      message:
        row.lastError ??
        "We couldn't validate your DNS records. Double-check them against the list below and retry.",
    }
  }

  const ca = prettyCertAuthority(row.certAuthority)
  const viaCa = ca ? ` (via ${ca})` : ''
  const stalled = isStalled(row, now)

  if (row.status === 'verifying') {
    if (stalled) {
      return {
        stage: 'stalled',
        message: `Certificate issuance${viaCa} is taking longer than usual. Your DNS looks correct — you can retry issuance below.`,
      }
    }
    return {
      stage: 'issuing',
      message: `Issuing your SSL certificate${viaCa}. This is automatic and usually takes a few minutes.`,
    }
  }

  // pending
  if (row.dnsOk) {
    if (stalled) {
      return {
        stage: 'stalled',
        message:
          'Your DNS records look correct, but validation is taking longer than usual. You can retry below.',
      }
    }
    return {
      stage: 'validating',
      message: 'Your DNS records were found — validating them with the certificate authority.',
    }
  }
  return {
    stage: 'awaiting_dns',
    message: 'Add the DNS records below at your domain provider. We check for them automatically.',
  }
}

/** Why a re-trigger is (not) currently allowed for a row. */
export type RetriggerBlockReason =
  | 'not_enabled'
  | 'active'
  | 'dns_not_ready'
  | 'too_early'
  | 'cooldown'

export interface RetriggerGate {
  allowed: boolean
  reason?: RetriggerBlockReason
  /** ms left on the manual cooldown (reason === 'cooldown'). */
  cooldownRemainingMs?: number
  /** ms until the row is old enough to retrigger (reason === 'too_early'). */
  waitMs?: number
}

/**
 * Gate a MANUAL re-trigger: enabled, not already live, DNS verified correct,
 * past the stall threshold, and outside the manual cooldown. Pure so the
 * route and `serializeDomain` (the button's enabled state) agree exactly.
 */
export function evaluateRetrigger(
  row: Pick<
    CustomDomainRowLike,
    'status' | 'dnsOk' | 'createdAt' | 'lastRetriggerAt'
  >,
  enabled: boolean,
  now: number = Date.now(),
): RetriggerGate {
  if (!enabled) return { allowed: false, reason: 'not_enabled' }
  if (row.status === 'active') return { allowed: false, reason: 'active' }
  if (!row.dnsOk) return { allowed: false, reason: 'dns_not_ready' }
  const age = ageMs(row, now)
  if (age < STALL_THRESHOLD_MS) {
    return { allowed: false, reason: 'too_early', waitMs: STALL_THRESHOLD_MS - age }
  }
  if (row.lastRetriggerAt) {
    const since = now - new Date(row.lastRetriggerAt).getTime()
    if (since < MANUAL_COOLDOWN_MS) {
      return { allowed: false, reason: 'cooldown', cooldownRemainingMs: MANUAL_COOLDOWN_MS - since }
    }
  }
  return { allowed: true }
}

/**
 * Gate an AUTO re-trigger from the reconciler: still working toward active
 * (pending/verifying), DNS correct, past the stall threshold, under the cap,
 * and beyond the auto-retrigger backoff interval. Leader-only is enforced by
 * the caller's advisory lock.
 */
export function shouldAutoRetrigger(
  row: Pick<
    CustomDomainRowLike,
    'status' | 'dnsOk' | 'createdAt' | 'lastRetriggerAt' | 'retriggerCount'
  >,
  now: number = Date.now(),
): boolean {
  if (row.status !== 'pending' && row.status !== 'verifying') return false
  if (!row.dnsOk) return false
  if (row.retriggerCount >= MAX_RETRIGGERS) return false
  if (ageMs(row, now) < STALL_THRESHOLD_MS) return false
  if (
    row.lastRetriggerAt &&
    now - new Date(row.lastRetriggerAt).getTime() < AUTO_RETRIGGER_INTERVAL_MS
  ) {
    return false
  }
  return true
}

/**
 * Whether the reconciler should poll this non-active row on the current tick.
 * Young domains (< SLOW_POLL_AFTER_MS, ~first 30 checks) are polled every
 * tick; older ones back off to one poll per SLOW_POLL_INTERVAL_MS (default
 * 10m), gated on `lastCheckedAt`. Keeps the fast feedback loop for the common
 * case while bounding CF calls for the long tail.
 */
export function isDueForPoll(
  row: Pick<CustomDomainRowLike, 'createdAt' | 'lastCheckedAt'>,
  now: number = Date.now(),
): boolean {
  if (ageMs(row, now) < SLOW_POLL_AFTER_MS) return true
  if (!row.lastCheckedAt) return true
  return now - new Date(row.lastCheckedAt).getTime() >= SLOW_POLL_INTERVAL_MS
}

/** DCV TXT tokens Cloudflare expects, from live state (falls back to instructions). */
export function expectedTxtTokens(state: CustomHostnameState): string[] {
  const fromValidation = state.validation.map((v) => v.value).filter(Boolean)
  if (fromValidation.length > 0) return fromValidation
  return state.instructions
    .filter((i) => i.type === 'TXT' && i.purpose === 'ssl-validation')
    .map((i) => i.value)
    .filter(Boolean)
}

/**
 * For a pairable hostname, return its apex<->www companion and which of the
 * two should be the canonical (primary) one. We always make the `www`
 * variant canonical (matches Vercel's recommendation — DNS reliability at
 * the edge, and the apex CNAME caveat). Returns null for hostnames we don't
 * auto-pair: deeper subdomains like `app.acme.com` (and multi-label apexes
 * like `acme.co.uk` that aren't `www.`-prefixed), which stay standalone.
 */
export function domainCompanion(
  hostname: string,
): { companion: string; primaryHostname: string } | null {
  if (hostname.startsWith('www.')) {
    const apex = hostname.slice(4)
    if (apex.split('.').length !== 2) return null
    return { companion: apex, primaryHostname: hostname }
  }
  if (hostname.split('.').length === 2) {
    const www = `www.${hostname}`
    return { companion: www, primaryHostname: www }
  }
  return null
}

/**
 * Canonical (primary) hostname for a row given its sibling rows: the row in
 * the same group flagged `primary`. Falls back to the row's own hostname
 * (standalone, or a group missing its primary flag).
 */
export function canonicalForRow(
  row: { hostname: string; groupId: string | null },
  siblings: Array<{ hostname: string; groupId: string | null; primary: boolean }>,
): string {
  if (!row.groupId) return row.hostname
  const primary = siblings.find((s) => s.groupId === row.groupId && s.primary)
  return primary?.hostname ?? row.hostname
}

/**
 * Poll Cloudflare for a single custom-hostname row, persist its latest
 * status, and (once active and the project has a published subdomain) write
 * the Worker KV `hostname -> {subdomain, canonical}` route so it serves.
 *
 * `siblings` is the full set of rows in the project (used to resolve the
 * canonical/redirect target); `publishedSubdomain` is passed in so callers
 * that already loaded the project don't re-query.
 *
 * Returns the updated row, the live CF state (null if it couldn't be read),
 * and whether this call flipped the row to active for the first time.
 */
export async function refreshCustomDomain(opts: {
  row: CustomDomainRowLike
  siblings: CustomDomainRowLike[]
  publishedSubdomain: string | null
}): Promise<{
  row: CustomDomainRowLike
  state: CustomHostnameState | null
  dns: CustomDomainDnsCheck | null
  becameActive: boolean
}> {
  const { row, siblings, publishedSubdomain } = opts
  if (!row.cfCustomHostnameId) {
    return { row, state: null, dns: null, becameActive: false }
  }

  const state = await getCustomHostname(row.cfCustomHostnameId)
  if (!state) {
    return { row, state: null, dns: null, becameActive: false }
  }

  const status = cfStateToStatus(state)
  const becameActive = status === 'active' && row.status !== 'active'

  if (status === 'active' && publishedSubdomain) {
    await putHostnameMapping(
      row.hostname,
      publishedSubdomain,
      canonicalForRow(row, siblings),
    )
  }

  // Independent, authoritative DNS verdict: is the CUSTOMER's CNAME + DCV TXT
  // actually correct? Drives the "stalled" stage + gates re-trigger so we
  // never re-trigger against records that were never added. Best-effort — a
  // resolver hiccup must not block status persistence.
  const cfg = getCustomHostnamesConfig()
  let dns: CustomDomainDnsCheck | null = null
  if (cfg) {
    try {
      dns = await checkCustomDomainDns(
        row.hostname,
        cfg.fallbackOrigin,
        expectedTxtTokens(state),
      )
    } catch (err: any) {
      console.warn(
        `[custom-domain] DNS check for ${row.hostname} failed (non-fatal):`,
        err?.message ?? err,
      )
    }
  }

  const diagnostics: CustomDomainDiagnostics = {
    instructions: state.instructions,
    validation: state.validation,
    dns: dns ?? undefined,
    certAuthority: state.certAuthority,
    checkedAt: Date.now(),
  }

  const updated = await prisma.customDomain.update({
    where: { id: row.id },
    data: {
      status,
      sslStatus: state.sslStatus,
      lastError: state.errors[0] ?? null,
      certAuthority: state.certAuthority,
      lastCheckedAt: new Date(),
      dnsOk: dns ? dns.ok : row.dnsOk,
      diagnostics: JSON.stringify(diagnostics),
      ...(becameActive ? { verifiedAt: new Date() } : {}),
    },
  })

  return { row: updated as CustomDomainRowLike, state, dns, becameActive }
}
