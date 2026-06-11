// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloudflare for SaaS — Custom Hostnames helper
 *
 * Lets a user bring their own domain (e.g. `app.acme.com`) for a published
 * project. Published apps normally live at `{subdomain}.shogo.one` and are
 * served by the `shogo-subdomain-router` Worker reading static files from
 * OCI Object Storage (see terraform/modules/publish-hosting-oci). Cloudflare
 * for SaaS extends that path to arbitrary customer hostnames:
 *
 *   1. The user CNAMEs their hostname at our fallback origin
 *      (CUSTOM_DOMAIN_FALLBACK_ORIGIN, e.g. `cname.<custom-domains-zone>`).
 *   2. We register a Cloudflare `custom_hostname` on the dedicated
 *      custom-domains zone (see below). Cloudflare issues + auto-renews a
 *      per-hostname DV TLS cert.
 *   3. We poll the custom hostname until both it and its SSL cert are
 *      `active`, then write a `hostname -> subdomain` entry into the
 *      Worker's KV namespace so the router can map the custom hostname to
 *      the right object-storage prefix.
 *
 * Active when these are set (otherwise every export is a safe no-op / the
 * config getter returns null so callers can surface "not enabled"):
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN)
 *       — needs `SSL and Certificates:Edit` on the custom-domains zone, plus
 *         `Workers KV Storage:Edit` on the account for the KV map.
 *   CF_CUSTOM_DOMAIN_ZONE_ID
 *       — Cloudflare zone id of the DEDICATED custom-domains zone (the zone
 *         that holds the Cloudflare for SaaS fallback origin + the wildcard
 *         worker route). This is intentionally NOT the publish zone
 *         (`shogo.one`):
 *         that zone is shared between staging (`*.staging.shogo.one`) and
 *         production (`*.shogo.one`), and SaaS's fallback origin + wildcard
 *         route are per-zone singletons, so each env uses its own dedicated
 *         zone.
 *         It is also a DIFFERENT zone from CF_ZONE_ID (shogo.ai) used by the
 *         per-preview A-record helper in cloudflare-dns.ts.
 *
 * KV mapping additionally requires (separately gated, best-effort):
 *   CF_ACCOUNT_ID, CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID
 *
 * Optional:
 *   CUSTOM_DOMAIN_FALLBACK_ORIGIN  — CNAME target shown to the user. Should
 *                                    be the fallback origin in the dedicated
 *                                    custom-domains zone (the terraform module
 *                                    output). Falls back to
 *                                    `cname.${PUBLISH_DOMAIN}` only as a
 *                                    last resort.
 *   CF_CUSTOM_HOSTNAME_SSL_METHOD  — `txt` (default) | `http`.
 *       TXT is the default because the subdomain-router Worker runs on a
 *       wildcard route (required for SaaS custom hostnames — see
 *       docs/custom-domains.md), which would intercept the `.well-known`
 *       path that HTTP DV validation relies on. TXT validates purely over
 *       DNS and is unaffected by the Worker.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CustomHostnamesConfig {
  apiToken: string
  zoneId: string
  /** CNAME target the user must point their hostname at. */
  fallbackOrigin: string
  /** DV validation method requested from Cloudflare. */
  sslMethod: 'http' | 'txt'
  /** Cloudflare account id — required for the KV hostname map. */
  accountId?: string
  /** KV namespace id holding `hostname -> subdomain`. */
  kvNamespaceId?: string
  /** Override fetch for tests. */
  fetch?: typeof globalThis.fetch
}

/** A single DNS record the user must create, surfaced to the publish panel. */
export interface DnsInstruction {
  type: 'CNAME' | 'TXT'
  name: string
  value: string
  /** Why this record is needed, for the UI copy. */
  purpose: 'routing' | 'ssl-validation' | 'ownership-verification'
}

/** One SSL DV validation record, with its current per-record CF status. */
export interface ValidationRecordState {
  /** TXT record name Cloudflare polls (e.g. `_acme-challenge.www.acme.com`). */
  name: string
  /** Expected TXT value (the DCV token). */
  value: string
  /** Per-record CF status: `pending` | `processing` | `active` | ... */
  status: string
}

/** Normalised view of a Cloudflare custom hostname for our DB + UI. */
export interface CustomHostnameState {
  id: string
  hostname: string
  /** Custom hostname provisioning status (`pending` | `active` | ...). */
  status: string
  /** SSL certificate status (`pending_validation` | `active` | ...). */
  sslStatus: string | null
  /** True once both the hostname and its cert are fully active. */
  active: boolean
  /** DNS records the user still needs to add (CNAME + any validation TXT). */
  instructions: DnsInstruction[]
  /** Combined validation / verification errors, if any. */
  errors: string[]
  /**
   * Issuing certificate authority Cloudflare assigned (`google` |
   * `lets_encrypt` | `ssl_com`). Surfaced so the panel can explain who is
   * issuing the cert and operators can spot a slow CA (SSL.com has wedged
   * `processing` for >30m in the wild — the re-trigger path exists for
   * exactly that).
   */
  certAuthority: string | null
  /** Per-record SSL DV validation status (so the UI can show ✓/… per TXT). */
  validation: ValidationRecordState[]
}

let cachedConfig: CustomHostnamesConfig | null | undefined

/**
 * Resolve config from env once. Returns null when the required pieces are
 * missing, which disables the feature (the route surfaces a clear
 * "custom domains not enabled" error rather than silently succeeding).
 */
export function getCustomHostnamesConfig(): CustomHostnamesConfig | null {
  if (cachedConfig !== undefined) return cachedConfig
  cachedConfig = resolveConfig()
  return cachedConfig
}

function resolveConfig(): CustomHostnamesConfig | null {
  const apiToken =
    process.env.CF_CUSTOM_HOSTNAMES_TOKEN || process.env.CF_API_TOKEN
  const zoneId = process.env.CF_CUSTOM_DOMAIN_ZONE_ID

  if (!apiToken || !zoneId) return null

  const publishDomain = process.env.PUBLISH_DOMAIN || 'shogo.one'
  const fallbackOrigin =
    process.env.CUSTOM_DOMAIN_FALLBACK_ORIGIN || `cname.${publishDomain}`
  const sslMethod =
    process.env.CF_CUSTOM_HOSTNAME_SSL_METHOD === 'http' ? 'http' : 'txt'

  return {
    apiToken,
    zoneId,
    fallbackOrigin,
    sslMethod,
    accountId: process.env.CF_ACCOUNT_ID || undefined,
    kvNamespaceId: process.env.CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID || undefined,
  }
}

/** Reset cached config (for tests). */
export function _resetCustomHostnamesConfigForTest(): void {
  cachedConfig = undefined
}

interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T | null
}

interface CfValidationRecord {
  txt_name?: string
  txt_value?: string
  http_url?: string
  http_body?: string
  /** Per-record DV status: `pending` | `processing` | `active` | ... */
  status?: string
}

interface CfCustomHostname {
  id: string
  hostname: string
  status: string
  ssl?: {
    status?: string
    method?: string
    certificate_authority?: string
    validation_records?: CfValidationRecord[]
    validation_errors?: Array<{ message: string }>
  }
  ownership_verification?: { type?: string; name?: string; value?: string }
  verification_errors?: string[]
}

async function cfFetch<T>(
  cfg: CustomHostnamesConfig,
  path: string,
  init?: RequestInit,
): Promise<CfEnvelope<T>> {
  const fetchImpl = cfg.fetch ?? globalThis.fetch
  const res = await fetchImpl(`${CF_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  return (await res.json()) as CfEnvelope<T>
}

function envelopeError(env: CfEnvelope<unknown>): string {
  return env.errors?.map(e => `${e.code} ${e.message}`).join(', ') || 'unknown error'
}

/**
 * Build the list of DNS records the user must add for a given custom
 * hostname response. Always includes the routing CNAME; appends any SSL
 * DV validation TXT records and the ownership-verification TXT when
 * Cloudflare returns them (it does for `txt` method / pre-validation, and
 * may omit them for `http` validation once the CNAME is live).
 */
function buildInstructions(
  cfg: CustomHostnamesConfig,
  rec: CfCustomHostname,
): DnsInstruction[] {
  const out: DnsInstruction[] = [
    {
      type: 'CNAME',
      name: rec.hostname,
      value: cfg.fallbackOrigin,
      purpose: 'routing',
    },
  ]
  for (const v of rec.ssl?.validation_records ?? []) {
    if (v.txt_name && v.txt_value) {
      out.push({
        type: 'TXT',
        name: v.txt_name,
        value: v.txt_value,
        purpose: 'ssl-validation',
      })
    }
  }
  const ov = rec.ownership_verification
  if (ov?.type === 'txt' && ov.name && ov.value) {
    out.push({
      type: 'TXT',
      name: ov.name,
      value: ov.value,
      purpose: 'ownership-verification',
    })
  }
  return out
}

function normalize(
  cfg: CustomHostnamesConfig,
  rec: CfCustomHostname,
): CustomHostnameState {
  const sslStatus = rec.ssl?.status ?? null
  const errors = [
    ...(rec.verification_errors ?? []),
    ...((rec.ssl?.validation_errors ?? []).map(e => e.message)),
  ].filter(Boolean)
  const validation: ValidationRecordState[] = (rec.ssl?.validation_records ?? [])
    .filter((v): v is CfValidationRecord & { txt_name: string } => Boolean(v.txt_name))
    .map(v => ({
      name: v.txt_name!,
      value: v.txt_value ?? '',
      status: v.status ?? 'pending',
    }))
  return {
    id: rec.id,
    hostname: rec.hostname,
    status: rec.status,
    sslStatus,
    active: rec.status === 'active' && sslStatus === 'active',
    instructions: buildInstructions(cfg, rec),
    errors,
    certAuthority: rec.ssl?.certificate_authority ?? null,
    validation,
  }
}

/**
 * Register a custom hostname on the dedicated custom-domains zone. Cloudflare
 * returns the validation records the user must add. Throws on API failure so the route
 * can surface a structured error (unlike the preview DNS helper, custom
 * domains are user-initiated and must report failures).
 */
export async function createCustomHostname(
  hostname: string,
): Promise<CustomHostnameState> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg) throw new Error('custom domains not enabled')

  const env = await cfFetch<CfCustomHostname>(
    cfg,
    `/zones/${cfg.zoneId}/custom_hostnames`,
    {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        ssl: {
          method: cfg.sslMethod,
          type: 'dv',
          settings: { min_tls_version: '1.2' },
          bundle_method: 'ubiquitous',
        },
      }),
    },
  )
  if (!env.success || !env.result) {
    throw new Error(`Cloudflare create custom hostname failed: ${envelopeError(env)}`)
  }
  return normalize(cfg, env.result)
}

/** Fetch the current state of a custom hostname by its Cloudflare id. */
export async function getCustomHostname(
  id: string,
): Promise<CustomHostnameState | null> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg) return null

  const env = await cfFetch<CfCustomHostname>(
    cfg,
    `/zones/${cfg.zoneId}/custom_hostnames/${id}`,
  )
  if (!env.success || !env.result) return null
  return normalize(cfg, env.result)
}

/**
 * Re-trigger DV validation / certificate issuance for an existing custom
 * hostname WITHOUT regenerating the validation tokens. This PATCHes the SSL
 * config with the SAME method + DV type + CA, which re-queues Cloudflare's
 * validation + issuance against the customer's existing `_acme-challenge`
 * records (verified empirically: the TXT tokens are preserved, so the
 * customer never has to touch DNS again).
 *
 * Used by the manual "Retrigger" button and the reconciler's auto-heal for
 * the case where a domain's DNS is correct but the CA (e.g. SSL.com) wedges
 * in `processing` past the normal issuance window. Throws on API failure so
 * the route can surface a structured error; the cron wraps it in try/catch.
 */
export async function retriggerCustomHostname(
  id: string,
): Promise<CustomHostnameState | null> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg) return null

  const env = await cfFetch<CfCustomHostname>(
    cfg,
    `/zones/${cfg.zoneId}/custom_hostnames/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ssl: {
          method: cfg.sslMethod,
          type: 'dv',
          settings: { min_tls_version: '1.2' },
          bundle_method: 'ubiquitous',
        },
      }),
    },
  )
  if (!env.success || !env.result) {
    throw new Error(`Cloudflare re-trigger failed: ${envelopeError(env)}`)
  }
  return normalize(cfg, env.result)
}

/** Find an existing custom hostname by name (idempotency / reconciliation). */
export async function findCustomHostnameByName(
  hostname: string,
): Promise<CustomHostnameState | null> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg) return null

  const env = await cfFetch<CfCustomHostname[]>(
    cfg,
    `/zones/${cfg.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
  )
  if (!env.success || !env.result?.[0]) return null
  return normalize(cfg, env.result[0])
}

/**
 * Delete a custom hostname (and its managed cert) by Cloudflare id.
 * Best-effort: logs and swallows so unpublish/delete never wedges on a CF
 * hiccup. Returns true when the record was deleted or already gone.
 */
export async function deleteCustomHostname(id: string): Promise<boolean> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg) return false

  try {
    const env = await cfFetch<{ id: string }>(
      cfg,
      `/zones/${cfg.zoneId}/custom_hostnames/${id}`,
      { method: 'DELETE' },
    )
    if (!env.success) {
      throw new Error(envelopeError(env))
    }
    return true
  } catch (err: any) {
    console.error(
      `[cf-custom-hostnames] delete ${id} failed (non-fatal):`,
      err?.message ?? err,
    )
    return false
  }
}

/**
 * Write the `hostname -> {subdomain, canonical}` mapping the Worker reads to
 * route a custom domain to its object-storage prefix. The value is JSON:
 *
 *   { "s": "<publishedSubdomain>", "c": "<canonicalHostname>" }
 *
 * `c` is the primary hostname of the apex/www pair; when a visitor's host
 * differs from `c` the Worker 308-redirects to it (so `acme.com` ->
 * `www.acme.com`, or vice versa). For a standalone domain `c` equals the
 * hostname itself, so no redirect fires. `canonicalHostname` defaults to
 * `hostname` for that self-canonical case.
 *
 * Best-effort + separately gated on KV config: a missing namespace just
 * means the Worker can't resolve the hostname yet (surfaced as a 404 to the
 * visitor), which is preferable to failing the whole verify flow.
 */
export async function putHostnameMapping(
  hostname: string,
  subdomain: string,
  canonicalHostname: string = hostname,
): Promise<boolean> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg?.accountId || !cfg.kvNamespaceId) return false

  try {
    const fetchImpl = cfg.fetch ?? globalThis.fetch
    const res = await fetchImpl(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(hostname)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({ s: subdomain, c: canonicalHostname }),
      },
    )
    if (!res.ok) {
      throw new Error(`KV put ${res.status}`)
    }
    return true
  } catch (err: any) {
    console.error(
      `[cf-custom-hostnames] KV put ${hostname} -> ${subdomain} failed (non-fatal):`,
      err?.message ?? err,
    )
    return false
  }
}

/** Remove a `hostname -> subdomain` mapping from KV. Best-effort. */
export async function deleteHostnameMapping(hostname: string): Promise<boolean> {
  const cfg = getCustomHostnamesConfig()
  if (!cfg?.accountId || !cfg.kvNamespaceId) return false

  try {
    const fetchImpl = cfg.fetch ?? globalThis.fetch
    const res = await fetchImpl(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(hostname)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      },
    )
    // 404 = already gone, treat as success.
    if (!res.ok && res.status !== 404) {
      throw new Error(`KV delete ${res.status}`)
    }
    return true
  } catch (err: any) {
    console.error(
      `[cf-custom-hostnames] KV delete ${hostname} failed (non-fatal):`,
      err?.message ?? err,
    )
    return false
  }
}
