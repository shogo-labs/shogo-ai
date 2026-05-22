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
 * Active when both of these are set:
 *   CF_API_TOKEN   — Zone.DNS:Edit scope on the zone
 *   CF_ZONE_ID     — Cloudflare zone id for the preview base domain
 *
 * The cluster's Kourier LB IP is resolved in this order:
 *   1. `KOURIER_LB_IP` env var, if set (operator override / single source of truth)
 *   2. Auto-discovery from `Service kourier/kourier-system` in this cluster
 *      (see `kourier-lb-discovery.ts`) — this is the recommended path so
 *      that adding a new region only requires the two CF env vars above
 *      and never a region-specific IP literal in the kustomize overlay.
 *
 * If any required piece is missing (e.g. local dev, or kourier RBAC not
 * yet granted), the helper is a complete no-op which leaves the flat
 * `*.shogo.ai` wildcard as the fallback.
 */

import { discoverKourierLbIp as defaultDiscoverer } from './kourier-lb-discovery'

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

let cachedConfigPromise: Promise<CloudflareDnsConfig | null> | undefined
let kourierDiscoverer: () => Promise<string | null> = defaultDiscoverer

/**
 * Resolve config from env once. Returns null when any required piece is
 * missing, which disables the helper.
 *
 * Async because the cluster Kourier LB IP may need to be discovered from
 * the K8s API on first call (when `KOURIER_LB_IP` env is not set).
 * Subsequent calls return the cached result.
 */
export async function getCloudflareDnsConfig(): Promise<CloudflareDnsConfig | null> {
  if (cachedConfigPromise !== undefined) return cachedConfigPromise
  cachedConfigPromise = resolveConfig()
  return cachedConfigPromise
}

async function resolveConfig(): Promise<CloudflareDnsConfig | null> {
  const apiToken = process.env.CF_API_TOKEN
  const zoneId = process.env.CF_ZONE_ID

  if (!apiToken || !zoneId) return null

  let lbIp = process.env.KOURIER_LB_IP
  if (!lbIp) {
    try {
      lbIp = (await kourierDiscoverer()) ?? undefined
    } catch (err: any) {
      console.error(
        `[cloudflare-dns] Kourier LB discovery failed (non-fatal, helper disabled):`,
        err?.message ?? err,
      )
      return null
    }
    if (!lbIp) {
      // Discovery succeeded but the service has no LB ingress yet. This is
      // a "not ready" state — we log once and stay disabled. The negative
      // cache will be flushed on next pod restart, which is the right
      // window to retry (LB IP allocation is a one-time per-cluster event).
      console.error(
        `[cloudflare-dns] Kourier service has no loadBalancer.ingress[].ip — helper disabled. Set KOURIER_LB_IP env or check kourier-system/kourier Service.`,
      )
      return null
    }
    console.log(`[cloudflare-dns] Discovered Kourier LB IP: ${lbIp}`)
  }

  return {
    apiToken,
    zoneId,
    lbIp,
    comment: process.env.CF_DNS_COMMENT || 'shogo-preview (managed by api)',
  }
}

/** Reset cached config (for tests). */
export function _resetCloudflareDnsConfigForTest(): void {
  cachedConfigPromise = undefined
}

/**
 * Inject a custom Kourier LB discoverer for tests. Pass `null` to restore
 * the default (which reads the K8s API). Always call
 * `_resetCloudflareDnsConfigForTest()` after swapping discoverers so the
 * next config resolution actually uses the new one.
 */
export function _setKourierDiscovererForTest(
  fn: (() => Promise<string | null>) | null,
): void {
  kourierDiscoverer = fn ?? defaultDiscoverer
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
  const cfg = await getCloudflareDnsConfig()
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
  const cfg = await getCloudflareDnsConfig()
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
