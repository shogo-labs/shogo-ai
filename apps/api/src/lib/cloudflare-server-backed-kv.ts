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
 * Flag a published subdomain as server-backed so the Worker proxies its
 * `/api/*` to the Knative ingress. Best-effort; returns false when unconfigured.
 */
export async function setServerBackedFlag(subdomain: string): Promise<boolean> {
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
        body: '1',
      },
    )
    if (!res.ok) throw new Error(`KV put ${res.status}`)
    return true
  } catch (err: any) {
    console.error(`[cf-server-backed] KV set ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return false
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
