// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloudflare Workers KV — published-site password gate (SITE_AUTH)
 *
 * The `*.shogo.one` subdomain-router Worker (terraform/modules/
 * publish-hosting-oci) gates every request for a subdomain that has an entry
 * in the `SITE_AUTH` KV namespace behind a shared password prompt. The value
 * stored is the SHA-256 hash (hex) of `${subdomain}:${password}` — the raw
 * password is never persisted anywhere. The publish flow writes this when a
 * project is published/updated with accessLevel == `password` and clears it
 * when the access level changes away from `password` or the project is
 * unpublished.
 *
 * Mirrors apps/api/src/lib/cloudflare-server-backed-kv.ts. All exports are
 * best-effort no-ops unless these are set (so a misconfigured env can't fail a
 * publish and static-only deployments are unaffected):
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) — `Workers KV Storage:Edit`
 *   CF_ACCOUNT_ID
 *   CF_SITE_AUTH_KV_NAMESPACE_ID — from the publish-hosting-oci output
 *                                  `site_auth_kv_namespace_id`.
 */

import { createHash } from "node:crypto"

const CF_API_BASE = "https://api.cloudflare.com/client/v4"

interface SiteAuthKvConfig {
  apiToken: string
  accountId: string
  kvNamespaceId: string
}

export function getSiteAuthKvConfig(): SiteAuthKvConfig | null {
  const apiToken = process.env.CF_API_TOKEN || process.env.CF_CUSTOM_HOSTNAMES_TOKEN
  const accountId = process.env.CF_ACCOUNT_ID
  const kvNamespaceId = process.env.CF_SITE_AUTH_KV_NAMESPACE_ID
  if (!apiToken || !accountId || !kvNamespaceId) return null
  return { apiToken, accountId, kvNamespaceId }
}

/**
 * Hash a site password the SAME way the edge Worker does:
 * lowercase-hex SHA-256 of `${subdomain}:${password}`. Salting by subdomain
 * means the same password on two different sites yields different hashes, so a
 * leaked KV/DB value can't be trivially rainbow-tabled across sites. This is a
 * lightweight shared-secret gate, not per-user credential storage.
 */
export function hashSitePassword(subdomain: string, password: string): string {
  return createHash("sha256").update(`${subdomain}:${password}`).digest("hex")
}

/**
 * Store the password hash for a subdomain so the Worker gates its traffic.
 * Best-effort; returns false when unconfigured.
 */
export async function setSitePassword(subdomain: string, hash: string): Promise<boolean> {
  const cfg = getSiteAuthKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          "Content-Type": "text/plain",
        },
        body: hash,
      },
    )
    if (!res.ok) throw new Error(`KV put ${res.status}`)
    return true
  } catch (err: any) {
    console.error(`[cf-site-auth] KV set ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}

/** Remove the password gate for a subdomain. Best-effort. */
export async function clearSitePassword(subdomain: string): Promise<boolean> {
  const cfg = getSiteAuthKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(
      `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(subdomain)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      },
    )
    if (!res.ok && res.status !== 404) throw new Error(`KV delete ${res.status}`)
    return true
  } catch (err: any) {
    console.error(`[cf-site-auth] KV clear ${subdomain} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}
