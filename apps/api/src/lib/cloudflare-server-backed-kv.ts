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
 *   - `knative` (legacy `1` also accepted) → proxy to the Kourier ingress
 *     (`KOURIER_ORIGIN`), which routes the DomainMapping to `published-{id}`.
 *   - `metal` → proxy to the API published endpoint (`API_PUBLISHED_ORIGIN`),
 *     which resolves the metal placement and forwards to the published microVM.
 */
export type ServerBackedBackend = 'knative' | 'metal'

/**
 * Flag a published subdomain as server-backed so the Worker proxies its
 * `/api/*` to the right backend (`knative` = Kourier, `metal` = API published
 * endpoint). Best-effort; returns false when unconfigured. Defaults to
 * `knative` for backward-compat with entries the Worker still reads as truthy.
 */
export async function setServerBackedFlag(
  subdomain: string,
  backend: ServerBackedBackend = 'knative',
): Promise<boolean> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: backend,
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
 * Read whether a subdomain is currently flagged server-backed. Returns:
 *   - `true`/`false` when the KV is configured (the live edge signal),
 *   - `null` when unconfigured or on error (caller decides the fallback).
 * A single fast KV GET — does NOT touch the runtime pod, so it's safe to call
 * on read-heavy endpoints (e.g. GET publish state) without a cold start.
 */
export async function getServerBackedFlag(subdomain: string): Promise<boolean | null> {
  const cfg = getServerBackedKvConfig()
  if (!cfg) return null
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      { headers: { Authorization: `Bearer ${cfg.apiToken}` } },
    )
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`KV get ${res.status}`)
    const val = (await res.text()).trim()
    return val.length > 0
  } catch (err: any) {
    console.error(`[cf-server-backed] KV get ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return null
  }
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
  const cfg = getServerBackedKvConfig()
  if (!cfg) return null
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      { headers: { Authorization: `Bearer ${cfg.apiToken}` } },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`KV get ${res.status}`)
    const val = (await res.text()).trim().toLowerCase()
    if (!val) return null
    if (val === 'metal') return 'metal'
    // Anything else truthy (incl. the legacy `1`) is the Kourier/Knative path.
    return 'knative'
  } catch (err: any) {
    console.error(`[cf-server-backed] KV get(raw) ${subdomain} failed (non-fatal):`, err?.message ?? err)
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
