// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-Mode Cloud Session Routes
 *
 * Status / signout / heartbeat for the cloud sign-in stored in
 * `localConfig.SHOGO_API_KEY`. The key itself is minted by the cloud's
 * `/api/cli/login/{start,poll,approve}` device flow and persisted via
 * `PUT /api/local/shogo-key` (apps/api/src/server.ts) — that handler
 * validates against cloud, writes localConfig, and restarts the
 * instance tunnel. The Electron main process drives the same poll-based
 * flow the CLI worker uses (apps/desktop/src/main.ts → runCloudSignIn,
 * mirrors packages/shogo-worker/src/lib/cloud-login.ts).
 *
 * Historically these routes also held start/complete handlers backing a
 * `shogo://auth-callback` deep link. Both are gone now: the desktop polls
 * the cloud directly so the cloud only has to understand one device flow,
 * and the OS doesn't need a custom protocol handler.
 *
 * Cloud endpoint selection: the cloud URL is sourced ONLY from
 * `process.env.SHOGO_CLOUD_URL` (defaulting to https://studio.shogo.ai).
 * It is never accepted from request bodies, persisted in localConfig, or
 * configurable through the UI. To target staging or a self-hosted cloud,
 * set `SHOGO_CLOUD_URL` in the API process environment.
 *
 * Keys stored in localConfig: SHOGO_API_KEY, SHOGO_KEY_INFO.
 *
 * The legacy PUT /api/local/shogo-key endpoint is intentionally preserved as
 * a headless / CLI escape hatch — see apps/api/src/server.ts.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getShogoCloudUrl } from '../lib/cloud-urls'

/** Tracks whether the cloud has rejected our key so the UI can show a
 * degraded-connection banner without wiping credentials. Only an explicit
 * user-initiated sign-out deletes the stored key. */
let cloudKeyRejected = false

async function readStoredKey(localDb: any): Promise<string | null> {
  const row = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_API_KEY' } }).catch(() => null)
  return row?.value || null
}

async function readStoredKeyInfo(localDb: any): Promise<{ workspace?: { id?: string; name?: string; slug?: string }; email?: string; deviceId?: string } | null> {
  const row = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_KEY_INFO' } }).catch(() => null)
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

/**
 * Register local-mode cloud session routes. Only call when SHOGO_LOCAL_MODE=true.
 */
export function localAuthRoutes() {
  const router = new Hono()
  const localDb = prisma as any

  // POST /api/local/cloud-login/signout — wipe local credentials. Cloud-side
  // revocation requires a Better Auth session, which the local API doesn't
  // hold; the user revokes from the Devices UI. We just stop using the key.
  router.post('/local/cloud-login/signout', async (c) => {
    await Promise.all([
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_API_KEY' } }),
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_KEY_INFO' } }),
    ])
    delete process.env.SHOGO_API_KEY
    cloudKeyRejected = false

    import('../lib/instance-tunnel').then(({ stopInstanceTunnel }) => {
      stopInstanceTunnel()
    }).catch(() => {})

    return c.json({ ok: true })
  })

  // POST /api/local/cloud-login/heartbeat — ping cloud to keep lastSeenAt fresh.
  router.post('/local/cloud-login/heartbeat', async (c) => {
    const storedKey = await readStoredKey(localDb)
    if (!storedKey) {
      return c.json({ ok: false, error: 'Not signed in' }, 401)
    }
    const cloudUrl = getShogoCloudUrl()

    const body = await c.req.json<{ deviceAppVersion?: string }>().catch(() => ({} as any))

    try {
      const res = await fetch(`${cloudUrl}/api/api-keys/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: storedKey,
          deviceAppVersion: body?.deviceAppVersion,
        }),
        signal: AbortSignal.timeout(5_000),
      })
      const data = await res.json().catch(() => ({} as any))
      if (!res.ok || data?.ok === false) {
        // 401 ⇒ key revoked or superseded; surface so the UI can prompt
        // the user to re-sign-in. We never wipe credentials automatically.
        if (res.status === 401) {
          cloudKeyRejected = true
          console.warn('[CloudLogin] Cloud rejected API key (401) — key may be revoked or expired. User must re-sign-in.')
        }
        return c.json({
          ok: false,
          error: data?.error || `HTTP ${res.status}`,
          cloudKeyRejected: res.status === 401,
        }, res.status as any)
      }
      cloudKeyRejected = false
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'Heartbeat failed' }, 502)
    }
  })

  // GET /api/local/cloud-login/status — current local session state.
  router.get('/local/cloud-login/status', async (c) => {
    const storedKey = await readStoredKey(localDb)
    if (!storedKey) {
      return c.json({ signedIn: false, cloudUrl: getShogoCloudUrl() })
    }
    const info = await readStoredKeyInfo(localDb)
    return c.json({
      signedIn: true,
      cloudUrl: getShogoCloudUrl(),
      email: info?.email || null,
      workspace: info?.workspace || null,
      deviceId: info?.deviceId || null,
      keyPrefix: storedKey.slice(0, 16),
      cloudKeyRejected,
    })
  })

  return router
}
