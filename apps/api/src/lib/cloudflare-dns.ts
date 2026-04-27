// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloudflare DNS helper
 *
 * Maintains one proxied A record per preview subdomain so that
 * `preview--{projectId}.shogo.ai` resolves to the LB IP of whichever
 * cluster is actually hosting the pod.
 *
 * A single flat `*.shogo.ai` wildcard can only point at one region, so
 * for multi-region preview pods we override the wildcard with explicit
 * per-preview records at the moment a DomainMapping is created, and
 * remove them when the DomainMapping is deleted.
 *
 * Only active when all three env vars are set:
 *   CF_API_TOKEN   — Zone.DNS:Edit scope on the zone
 *   CF_ZONE_ID     — Cloudflare zone id for the preview base domain
 *   KOURIER_LB_IP  — this cluster's externally-routable Kourier IP
 *
 * If any is missing the helper is a no-op, which means local dev and
 * single-region deployments keep working unchanged.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareDnsConfig {
  apiToken: string
  zoneId: string
  lbIp: string
  /** Optional comment to attach to managed records (aids auditing). */
  comment?: string
  /** Override fetch for tests. */
  fetch?: typeof globalThis.fetch
}

let cachedConfig: CloudflareDnsConfig | null | undefined

/**
 * Resolve config from env once. Returns null when any required var is
 * missing, which disables the helper.
 */
export function getCloudflareDnsConfig(): CloudflareDnsConfig | null {
  if (cachedConfig !== undefined) return cachedConfig

  const apiToken = process.env.CF_API_TOKEN
  const zoneId = process.env.CF_ZONE_ID
  const lbIp = process.env.KOURIER_LB_IP

  if (!apiToken || !zoneId || !lbIp) {
    cachedConfig = null
    return null
  }

  cachedConfig = {
    apiToken,
    zoneId,
    lbIp,
    comment: process.env.CF_DNS_COMMENT || 'shogo-preview (managed by api)',
  }
  return cachedConfig
}

/** Reset cached config (for tests). */
export function _resetCloudflareDnsConfigForTest(): void {
  cachedConfig = undefined
}

interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T | null
}

interface CfRecord {
  id: string
  name: string
  type: string
  content: string
  proxied: boolean
}

async function cfFetch<T>(
  cfg: CloudflareDnsConfig,
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
  const body = (await res.json()) as CfEnvelope<T>
  return body
}

async function findRecord(
  cfg: CloudflareDnsConfig,
  hostname: string,
): Promise<CfRecord | null> {
  const env = await cfFetch<CfRecord[]>(
    cfg,
    `/zones/${cfg.zoneId}/dns_records?type=A&name=${encodeURIComponent(hostname)}`,
  )
  if (!env.success) {
    throw new Error(
      `Cloudflare list-records failed: ${env.errors.map(e => `${e.code} ${e.message}`).join(', ')}`,
    )
  }
  return env.result?.[0] ?? null
}

/**
 * Create or update a proxied A record for `hostname` pointing at this
 * cluster's LB. Idempotent — safe to call on every pod assignment.
 *
 * Non-fatal: failures are logged and swallowed so that DNS hiccups
 * cannot block DomainMapping / pod creation. The flat `*.shogo.ai`
 * wildcard still provides fallback routing.
 */
export async function upsertPreviewDnsRecord(hostname: string): Promise<void> {
  const cfg = getCloudflareDnsConfig()
  if (!cfg) return

  try {
    const existing = await findRecord(cfg, hostname)

    if (existing) {
      if (existing.content === cfg.lbIp && existing.proxied === true) {
        // Already correct — no write needed.
        return
      }
      const env = await cfFetch<CfRecord>(
        cfg,
        `/zones/${cfg.zoneId}/dns_records/${existing.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content: cfg.lbIp, proxied: true }),
        },
      )
      if (!env.success) {
        throw new Error(
          env.errors.map(e => `${e.code} ${e.message}`).join(', '),
        )
      }
      console.log(
        `[cloudflare-dns] Updated ${hostname} -> ${cfg.lbIp} (proxied)`,
      )
      return
    }

    const env = await cfFetch<CfRecord>(
      cfg,
      `/zones/${cfg.zoneId}/dns_records`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'A',
          name: hostname,
          content: cfg.lbIp,
          proxied: true,
          ttl: 1,
          comment: cfg.comment,
        }),
      },
    )
    if (!env.success) {
      throw new Error(env.errors.map(e => `${e.code} ${e.message}`).join(', '))
    }
    console.log(`[cloudflare-dns] Created ${hostname} -> ${cfg.lbIp} (proxied)`)
  } catch (err: any) {
    console.error(`[cloudflare-dns] upsert ${hostname} failed (non-fatal):`, err.message)
  }
}

/**
 * Delete the preview record for `hostname`. Non-fatal: any failure is
 * logged; a periodic reconciliation sweep (not implemented here) is a
 * reasonable safety net if deletion failures become common.
 */
export async function deletePreviewDnsRecord(hostname: string): Promise<void> {
  const cfg = getCloudflareDnsConfig()
  if (!cfg) return

  try {
    const existing = await findRecord(cfg, hostname)
    if (!existing) return

    const env = await cfFetch<{ id: string }>(
      cfg,
      `/zones/${cfg.zoneId}/dns_records/${existing.id}`,
      { method: 'DELETE' },
    )
    if (!env.success) {
      throw new Error(env.errors.map(e => `${e.code} ${e.message}`).join(', '))
    }
    console.log(`[cloudflare-dns] Deleted ${hostname}`)
  } catch (err: any) {
    console.error(`[cloudflare-dns] delete ${hostname} failed (non-fatal):`, err.message)
  }
}
