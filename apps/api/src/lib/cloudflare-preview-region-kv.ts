// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloudflare Workers KV — preview region map
 *
 * The `*.preview.shogo.ai` preview-router Worker (terraform/modules/
 * preview-router) routes each preview to the Knative (Kourier) ingress of the
 * region that actually hosts it. It learns the region from the `PREVIEW_REGIONS`
 * KV namespace: `projectId -> region code` (`us` | `eu` | `in`).
 *
 * This module is the write side of that map. Each region's API writes its OWN
 * region code when it creates a preview DomainMapping and clears it on
 * teardown, so the global namespace ends up holding the authoritative location
 * of every live preview.
 *
 * This REPLACES the per-preview Cloudflare DNS records (cloudflare-dns.ts) that
 * previously overrode the flat `*.shogo.ai` wildcard per region. Those records
 * scaled with active previews and hit the zone's 200-record quota (CF error
 * 81045). KV is effectively unlimited, so the ceiling no longer applies.
 *
 * All exports are best-effort no-ops unless these are set (so a misconfigured
 * env can never fail a DomainMapping create/delete — the `*.preview.shogo.ai`
 * wildcard still routes to the default region as a fallback):
 *   CF_CUSTOM_HOSTNAMES_TOKEN (or CF_API_TOKEN) — `Workers KV Storage:Edit`
 *   CF_ACCOUNT_ID
 *   CF_PREVIEW_REGIONS_KV_NAMESPACE_ID — from the preview-router output
 *                                        `preview_regions_kv_namespace_id`.
 *
 * The region code is derived from REGION_ID (the same env every regional api
 * pod already sets). When REGION_ID is unset or unrecognized (local/dev) the
 * helper is a no-op: there is no meaningful region to record, and the wildcard
 * fallback covers it.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * Map a cluster REGION_ID to the short code the preview-router Worker expects.
 * Keep in sync with `anchorFor()` in terraform/modules/preview-router/main.tf.
 */
const REGION_CODE_BY_ID: Record<string, string> = {
  'us-ashburn-1': 'us',
  'eu-frankfurt-1': 'eu',
  // Staging is single-region but sets REGION_ID=staging; its preview-router
  // instance uses a matching `staging` anchor (see terraform/environments/
  // staging). This lets the KV write path be exercised in staging.
  staging: 'staging',
}

/** Resolve this pod's preview region code (`us` | `eu` | `in`) or null. */
export function getPreviewRegionCode(): string | null {
  const regionId = process.env.REGION_ID
  if (!regionId) return null
  return REGION_CODE_BY_ID[regionId] ?? null
}

interface PreviewRegionKvConfig {
  apiToken: string
  accountId: string
  kvNamespaceId: string
}

export function getPreviewRegionKvConfig(): PreviewRegionKvConfig | null {
  // Prefer the KV-capable custom-hostnames token (the custom-domains-config
  // secret already pairs it with CF_ACCOUNT_ID in every region); fall back to
  // CF_API_TOKEN for envs that grant KV scope to the DNS token instead.
  const apiToken = process.env.CF_CUSTOM_HOSTNAMES_TOKEN || process.env.CF_API_TOKEN
  const accountId = process.env.CF_ACCOUNT_ID
  const kvNamespaceId = process.env.CF_PREVIEW_REGIONS_KV_NAMESPACE_ID
  if (!apiToken || !accountId || !kvNamespaceId) return null
  return { apiToken, accountId, kvNamespaceId }
}

function kvValueUrl(cfg: PreviewRegionKvConfig, projectId: string): string {
  return `${CF_API_BASE}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(projectId)}`
}

/**
 * Record that `projectId`'s preview is hosted in this pod's region so the
 * preview-router Worker sends `{projectId}.preview.shogo.ai` to the correct
 * regional Kourier LB. Best-effort and idempotent — safe to call on every
 * preview DomainMapping (re)assignment. Returns false when unconfigured or on
 * a non-mappable region (the wildcard US fallback still applies).
 */
export async function setPreviewRegion(projectId: string): Promise<boolean> {
  const region = getPreviewRegionCode()
  if (!region) return false
  const cfg = getPreviewRegionKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(kvValueUrl(cfg, projectId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: region,
    })
    if (!res.ok) throw new Error(`KV put ${res.status}`)
    console.log(`[cf-preview-region] Set ${projectId} -> ${region}`)
    return true
  } catch (err: any) {
    console.error(`[cf-preview-region] KV set ${projectId} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}

/**
 * Remove the region mapping for `projectId` when its preview is torn down.
 * Best-effort; a 404 (already gone) counts as success. Returns false only when
 * unconfigured or on a real error.
 */
export async function clearPreviewRegion(projectId: string): Promise<boolean> {
  const cfg = getPreviewRegionKvConfig()
  if (!cfg) return false
  try {
    const res = await fetch(kvValueUrl(cfg, projectId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfg.apiToken}` },
    })
    if (!res.ok && res.status !== 404) throw new Error(`KV delete ${res.status}`)
    console.log(`[cf-preview-region] Cleared ${projectId}`)
    return true
  } catch (err: any) {
    console.error(`[cf-preview-region] KV clear ${projectId} failed (non-fatal):`, err?.message ?? err)
    return false
  }
}
