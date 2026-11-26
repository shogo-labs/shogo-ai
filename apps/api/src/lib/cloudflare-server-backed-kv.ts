// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloudflare Workers KV — server-backed publish flag
 *
 * The `*.shogo.one` subdomain-router Worker (terraform/modules/
 * publish-hosting-oci) proxies dynamic `/api/*` traffic to the project's
 * running `server.tsx` ONLY for subdomains flagged as server-backed in the
 * `SERVER_BACKED` KV namespace. The publish flow writes that flag when it
 * deploys a server-backed app and clears it on unpublish / static republish.
 *
 * All exports are best-effort no-ops unless these are set (so static-only
 * deployments are unaffected and a misconfigured env can't fail a publish):
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) — `Workers KV Storage:Edit`
 *   CF_ACCOUNT_ID
 *   CF_SERVER_BACKED_KV_NAMESPACE_ID — from the publish-hosting-oci output
 *                                      `server_backed_kv_namespace_id`.
 */

import { getRegionCode } from './region'

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

interface ServerBackedKvConfig {
  apiToken: string
  accountId: string
  kvNamespaceId: string
}

export function getServerBackedKvConfig(): ServerBackedKvConfig | null {
  const apiToken = process.env.CF_API_TOKEN || process.env.CF_CUSTOM_HOSTNAMES_TOKEN
  const accountId = process.env.CF_ACCOUNT_ID
  const kvNamespaceId = process.env.CF_SERVER_BACKED_KV_NAMESPACE_ID
  if (!apiToken || !accountId || !kvNamespaceId) return null
  return { apiToken, accountId, kvNamespaceId }
}

/**
 * The routing target for a server-backed subdomain, stored as the KV VALUE so
 * the Worker knows WHERE to send `/api/*`:
 *   - `knative` (legacy `1` also accepted) → proxy to Kourier, which routes the
 *     DomainMapping to `published-{id}`.
 *   - `metal` → proxy to the API published endpoint (`API_PUBLISHED_ORIGIN`),
 *     which resolves the metal placement and forwards to the published microVM.
 */
export type ServerBackedBackend = 'knative' | 'metal'

/**
 * The KV value written for a backend. A Knative app's ksvc lives in the cluster
 * of the region that created it, and the `*.shogo.one` Worker has one Kourier
 * per region, so the value carries that region's short code:
 * `knative:eu`. Without the code the Worker falls back to the single default
 * Kourier, which has no DomainMapping for another region's app and 404s every
 * `/api/*` call (SHO-588). Local/desktop has no region, so it writes the bare
 * `knative` the Worker still understands.
 */
export function serverBackedValue(backend: ServerBackedBackend, regionCode: string | null): string {
  if (backend === 'metal') return 'metal'
  return regionCode ? `${backend}:${regionCode}` : backend
}

/**
 * Flag a published subdomain as server-backed so the Worker proxies its
 * `/api/*` to the right backend (`knative` = Kourier, `metal` = API published
 * endpoint). Best-effort; returns false when unconfigured. Defaults to
 * `knative` for backward-compat with entries the Worker still reads as truthy.
 *
 * `regionCode` is the home region of the cluster that owns the Knative service
 * — always this pod's own region for a real publish (the ksvc is created here).
 * Pass it explicitly only from code running OUTSIDE a pod (the sweep script,
 * `migrate-publishing-to-metal.ts --region`); pod callers pass nothing.
 */
export async function setServerBackedFlag(
  subdomain: string,
  backend: ServerBackedBackend = 'knative',
  regionCode: string | null = getRegionCode(),
): Promise<boolean> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return false
  const value = serverBackedValue(backend, regionCode)
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: value,
      },
    )
    if (!res.ok) throw new Error(`KV put ${res.status}`)
    return true
  } catch (err: any) {
    console.error(`[cf-server-backed] KV set ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}

/**
 * Result of a RAW value read. `value: null` means "no entry" (404), which is a
 * normal answer (static app); `ok: false` means the read itself failed and the
 * caller must NOT read it as "not flagged".
 */
type ServerBackedRead = { ok: true; value: string | null } | { ok: false }

/** Read the RAW server-backed KV value (lowercased), distinguishing 404 from error. */
async function readServerBackedValue(subdomain: string): Promise<ServerBackedRead> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return { ok: false }
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      { headers: { Authorization: `Bearer ${cfg.apiToken}` } },
    )
    if (res.status === 404) return { ok: true, value: null }
    if (!res.ok) throw new Error(`KV get ${res.status}`)
    return { ok: true, value: (await res.text()).trim().toLowerCase() }
  } catch (err: any) {
    console.error(`[cf-server-backed] KV get ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return { ok: false }
  }
}

/**
 * Read whether a subdomain is currently flagged server-backed. Returns:
 *   - `true`/`false` when the KV is configured (the live edge signal),
 *   - `null` when unconfigured or on error (caller decides the fallback).
 * A single fast KV GET — does NOT touch the runtime pod, so it's safe to call
 * on read-heavy endpoints (e.g. GET publish state) without a cold start.
 */
export async function getServerBackedFlag(subdomain: string): Promise<boolean | null> {
  if (!getServerBackedKvConfig()) return null
  const read = await readServerBackedValue(subdomain)
  if (!read.ok) return null
  return !!read.value
}

/**
 * The region code carried by a server-backed KV value (`knative:eu` → `eu`),
 * or null for a bare `knative` / `1` / `metal` / absent entry. The sweep
 * script uses it to skip entries that are already stamped.
 */
export async function getServerBackedRegion(subdomain: string): Promise<string | null> {
  const read = await readServerBackedValue(subdomain)
  if (!read.ok) return null
  const { backend, region } = parseServerBackedValue(read.value)
  return backend === 'knative' ? region : null
}

/**
 * Parse a raw SERVER_BACKED value into the backend plus the home region the
 * Worker resolves a Kourier from:
 *   - `knative` / `knative:<code>` → knative, with the region code (null when
 *     not stamped, which the Worker routes to the default Kourier).
 *   - `metal` / `metal:<code>`     → metal; the code is ignored.
 *   - anything else truthy (the pre-cutover legacy `1`) → knative, matching
 *     `getServerBackedBackend` below and the Worker's own default. (The Worker
 *     also reads a legacy `1` as metal where it has API_PUBLISHED_ORIGIN bound;
 *     nothing here depends on that case.)
 */
export function parseServerBackedValue(raw: string | null): {
  backend: ServerBackedBackend | null
  region: string | null
} {
  const val = (raw ?? '').trim().toLowerCase()
  if (!val) return { backend: null, region: null }
  const colon = val.indexOf(':')
  const base = colon === -1 ? val : val.slice(0, colon)
  const region = colon === -1 ? null : val.slice(colon + 1).trim() || null
  if (base === 'metal') return { backend: 'metal', region: null }
  return { backend: 'knative', region }
}

/**
 * Read the RAW server-backed routing target for a subdomain (the KV value), not
 * just a boolean. Used by the publishing migration to decide idempotently what
 * (if anything) to flip:
 *   - `'metal'`   → already routed to the metal published proxy.
 *   - `'knative'` → routed to Kourier (legacy `'1'` normalizes to this).
 *   - `null`      → no flag (static, edge-only) OR the KV is unconfigured / a
 *                   read error occurred (indistinguishable — callers treat null
 *                   as "static / nothing to migrate").
 */
export async function getServerBackedBackend(
  subdomain: string,
): Promise<ServerBackedBackend | null> {
  if (!getServerBackedKvConfig()) return null
  const read = await readServerBackedValue(subdomain)
  if (!read.ok || read.value === null) return null
  // Anything other than `metal` is the Kourier/Knative path, including the
  // legacy `1` and a region-stamped `knative:<code>`.
  return read.value.startsWith('metal') ? 'metal' : 'knative'
}

/**
 * Every entry in the SERVER_BACKED namespace, as `{ subdomain, value }`. Used by
 * scripts/stamp-knative-region.ts to backfill the region code onto entries
 * written before the value carried one (SHO-588). Null when unconfigured or the
 * listing failed — a partial list must never be mistaken for "nothing to do".
 */
export async function listServerBackedEntries(): Promise<
  Array<{ subdomain: string; value: string }> | null
> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return null
  const entries: Array<{ subdomain: string; value: string }> = []
  let cursor: string | null = null
  try {
    do {
      const url = new URL(
        `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/keys`,
      )
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('cursor', cursor)
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      })
      if (!res.ok) throw new Error(`KV list ${res.status}`)
      const body = (await res.json()) as {
        result?: Array<{ name: string }>
        result_info?: { cursor?: string | null; count?: number }
      }
      for (const key of body.result ?? []) {
        const read = await readServerBackedValue(key.name)
        // A failed per-key read must fail the whole listing, not silently look
        // like an empty entry (the sweep would then "skip" a real app).
        if (!read.ok) throw new Error(`KV value ${key.name} unreadable`)
        entries.push({ subdomain: key.name, value: read.value ?? '' })
      }
      const next = body.result_info?.cursor ?? null
      // CF returns the same cursor on the last page; stop on it as well as on
      // an empty one so a stuck cursor can't loop forever.
      cursor = next && next !== cursor ? next : null
    } while (cursor)
    return entries
  } catch (err: any) {
    console.error('[cf-server-backed] KV list failed:', err?.message ?? err)
    return null
  }
}

/** Remove the server-backed flag for a subdomain. Best-effort. */
export async function clearServerBackedFlag(subdomain: string): Promise<boolean> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      },
    )
    if (!res.ok && res.status !== 404) throw new Error(`KV delete ${res.status}`)
    return true
  } catch (err: any) {
    console.error(`[cf-server-backed] KV clear ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}
