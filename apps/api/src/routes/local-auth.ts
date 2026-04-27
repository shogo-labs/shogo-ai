// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local Mode Cloud Login Routes
 *
 * The desktop app uses these endpoints to replace the old "paste a shogo_sk_
 * key" flow with a proper system-browser OAuth-style handshake against Shogo
 * Cloud. The minted key still lands in `localConfig.SHOGO_API_KEY` so all
 * downstream code (ai-proxy forwarding, instance tunnel, runtime manager
 * env, etc.) keeps working unchanged.
 *
 * Flow:
 *   1. Desktop calls POST /api/local/cloud-login/start with device metadata.
 *      We generate a state nonce (single-use, 5-min TTL) and return an
 *      authUrl pointing at the cloud bridge page.
 *   2. User signs in on cloud (Better Auth), bridge page mints a device key
 *      via POST /api/api-keys/device, then redirects to
 *      shogo://auth-callback?state=...&key=...&...
 *   3. Electron main receives the deep link and calls
 *      POST /api/local/cloud-login/complete. We verify the state nonce,
 *      re-validate the key against cloud, and persist it.
 *
 * Keys stored in localConfig: SHOGO_API_KEY, SHOGO_CLOUD_URL, SHOGO_KEY_INFO
 * (same keys the legacy PUT /api/local/shogo-key handler uses, so either
 * entry path produces an identical runtime state).
 *
 * The legacy PUT /api/local/shogo-key endpoint is intentionally preserved as
 * a headless / CLI escape hatch — see apps/api/src/server.ts.
 */

import { Hono } from 'hono'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'

const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'
const STATE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const STATE_BYTE_LENGTH = 32

interface PendingState {
  deviceId: string
  deviceName?: string
  devicePlatform?: string
  deviceAppVersion?: string
  cloudUrl: string
  expiresAt: number
}

/** In-memory nonce store. Local-mode runs a single API process per machine,
 * so a Map is sufficient — we don't want to persist unused nonces to disk. */
const pendingStates = new Map<string, PendingState>()

function purgeExpiredStates(): void {
  const now = Date.now()
  for (const [state, record] of pendingStates) {
    if (record.expiresAt <= now) {
      pendingStates.delete(state)
    }
  }
}

function generateState(): string {
  return crypto.randomBytes(STATE_BYTE_LENGTH).toString('hex')
}

function resolveCloudUrl(override?: string | null): string {
  const raw = override || process.env.SHOGO_CLOUD_URL || SHOGO_CLOUD_URL_DEFAULT
  return raw.replace(/\/$/, '')
}

async function loadStoredCloudUrl(localDb: any): Promise<string> {
  const row = await localDb.localConfig.findUnique({ where: { key: 'SHOGO_CLOUD_URL' } }).catch(() => null)
  return resolveCloudUrl(row?.value)
}

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
 * Register local-mode cloud login routes. Only call when SHOGO_LOCAL_MODE=true.
 */
export function localAuthRoutes() {
  const router = new Hono()
  const localDb = prisma as any

  // POST /api/local/cloud-login/start — begin a login flow.
  router.post('/local/cloud-login/start', async (c) => {
    purgeExpiredStates()

    const body = await c.req.json<{
      deviceId: string
      deviceName?: string
      devicePlatform?: string
      deviceAppVersion?: string
      cloudUrl?: string
    }>().catch(() => ({} as any))

    if (!body?.deviceId || typeof body.deviceId !== 'string') {
      return c.json({ ok: false, error: 'deviceId is required' }, 400)
    }

    const cloudUrl = resolveCloudUrl(body.cloudUrl ?? await loadStoredCloudUrl(localDb))
    const state = generateState()
    pendingStates.set(state, {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      devicePlatform: body.devicePlatform,
      deviceAppVersion: body.deviceAppVersion,
      cloudUrl,
      expiresAt: Date.now() + STATE_TTL_MS,
    })

    const params = new URLSearchParams({
      state,
      callback: 'shogo://auth-callback',
      deviceId: body.deviceId,
    })
    if (body.deviceName) params.set('deviceName', body.deviceName)
    if (body.devicePlatform) params.set('devicePlatform', body.devicePlatform)
    if (body.deviceAppVersion) params.set('appVersion', body.deviceAppVersion)

    const authUrl = `${cloudUrl}/auth/local-link?${params.toString()}`
    return c.json({ ok: true, state, authUrl, cloudUrl, expiresInMs: STATE_TTL_MS })
  })

  // POST /api/local/cloud-login/complete — deep-link callback landing point.
  router.post('/local/cloud-login/complete', async (c) => {
    purgeExpiredStates()

    const body = await c.req.json<{
      state: string
      key: string
      cloudUrl?: string
      email?: string
      workspace?: string
    }>().catch(() => ({} as any))

    if (!body?.state || !body?.key) {
      return c.json({ ok: false, error: 'state and key are required' }, 400)
    }
    if (!body.key.startsWith('shogo_sk_')) {
      return c.json({ ok: false, error: 'Invalid key format. Keys start with shogo_sk_' }, 400)
    }

    const pending = pendingStates.get(body.state)
    if (!pending) {
      return c.json({ ok: false, error: 'Unknown or expired state. Please restart the sign-in flow.' }, 400)
    }
    // Single-use: consume the nonce immediately regardless of what follows.
    pendingStates.delete(body.state)
    if (pending.expiresAt <= Date.now()) {
      return c.json({ ok: false, error: 'Sign-in request expired. Please try again.' }, 400)
    }

    const cloudUrl = resolveCloudUrl(body.cloudUrl || pending.cloudUrl)
    const validateUrl = `${cloudUrl}/api/api-keys/validate`

    let validateData: { valid?: boolean; error?: string; workspace?: any; user?: any; kind?: string; deviceId?: string | null }
    try {
      const validateRes = await fetch(validateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: body.key }),
        signal: AbortSignal.timeout(10_000),
      })
      try {
        validateData = await validateRes.json()
      } catch {
        return c.json({ ok: false, error: `Shogo Cloud (${cloudUrl}) returned an unexpected response (HTTP ${validateRes.status})`, cloudUrl }, 502)
      }
    } catch (err: any) {
      return c.json({ ok: false, error: `Cannot reach Shogo Cloud at ${cloudUrl}: ${err?.message || err}`, cloudUrl }, 502)
    }

    if (!validateData?.valid) {
      return c.json({ ok: false, error: validateData?.error || 'Key validation failed', cloudUrl }, 400)
    }

    const email = body.email || validateData.user?.email || null
    const keyInfo = {
      workspace: validateData.workspace || null,
      email,
      deviceId: pending.deviceId,
      kind: validateData.kind || 'device',
      signedInAt: new Date().toISOString(),
    }

    await Promise.all([
      localDb.localConfig.upsert({
        where: { key: 'SHOGO_API_KEY' },
        update: { value: body.key },
        create: { key: 'SHOGO_API_KEY', value: body.key },
      }),
      localDb.localConfig.upsert({
        where: { key: 'SHOGO_CLOUD_URL' },
        update: { value: cloudUrl },
        create: { key: 'SHOGO_CLOUD_URL', value: cloudUrl },
      }),
      localDb.localConfig.upsert({
        where: { key: 'SHOGO_KEY_INFO' },
        update: { value: JSON.stringify(keyInfo) },
        create: { key: 'SHOGO_KEY_INFO', value: JSON.stringify(keyInfo) },
      }),
    ])

    process.env.SHOGO_API_KEY = body.key
    process.env.SHOGO_CLOUD_URL = cloudUrl

    // Restart the instance tunnel with the new key so inbound cloud-driven
    // remote control picks up fresh credentials immediately.
    import('../lib/instance-tunnel').then(({ stopInstanceTunnel, startInstanceTunnel }) => {
      stopInstanceTunnel()
      startInstanceTunnel()
    }).catch(() => {})

    return c.json({
      ok: true,
      cloudUrl,
      email,
      workspace: validateData.workspace || null,
      deviceId: pending.deviceId,
    })
  })

  // POST /api/local/cloud-login/signout — revoke key on cloud, wipe locally.
  router.post('/local/cloud-login/signout', async (c) => {
    const storedKey = await readStoredKey(localDb)
    const cloudUrl = await loadStoredCloudUrl(localDb)

    // Best-effort server-side revocation. If the network is down we still
    // wipe locally so the UI reflects sign-out; a stale cloud row just
    // becomes a dangling device entry the user can clean up from the
    // Devices UI.
    if (storedKey) {
      try {
        const validateRes = await fetch(`${cloudUrl}/api/api-keys/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: storedKey }),
          signal: AbortSignal.timeout(5_000),
        })
        const data = await validateRes.json().catch(() => null as any)
        // Validation doesn't return the key id — but revocation on cloud
        // requires a session. Since the local user doesn't have a cloud
        // session here, rely on the client-side Devices UI for explicit
        // revocation. We simply stop using the key locally.
        void data
      } catch {
        /* ignore */
      }
    }

    await Promise.all([
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_API_KEY' } }),
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_CLOUD_URL' } }),
      localDb.localConfig.deleteMany({ where: { key: 'SHOGO_KEY_INFO' } }),
    ])
    delete process.env.SHOGO_API_KEY
    delete process.env.SHOGO_CLOUD_URL

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
    const cloudUrl = await loadStoredCloudUrl(localDb)

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
        // A 401 from cloud means our key was revoked (probably via the cloud
        // Devices UI). Wipe locally so the UI flips to signed-out and the
        // user is prompted to re-login.
        if (res.status === 401) {
          await Promise.all([
            localDb.localConfig.deleteMany({ where: { key: 'SHOGO_API_KEY' } }),
            localDb.localConfig.deleteMany({ where: { key: 'SHOGO_KEY_INFO' } }),
          ])
          delete process.env.SHOGO_API_KEY
        }
        return c.json({ ok: false, error: data?.error || `HTTP ${res.status}`, revoked: res.status === 401 }, res.status as any)
      }
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || 'Heartbeat failed' }, 502)
    }
  })

  // GET /api/local/cloud-login/status — current local session state.
  router.get('/local/cloud-login/status', async (c) => {
    const storedKey = await readStoredKey(localDb)
    if (!storedKey) {
      return c.json({ signedIn: false })
    }
    const info = await readStoredKeyInfo(localDb)
    const cloudUrl = await loadStoredCloudUrl(localDb)
    return c.json({
      signedIn: true,
      cloudUrl,
      email: info?.email || null,
      workspace: info?.workspace || null,
      deviceId: info?.deviceId || null,
      keyPrefix: storedKey.slice(0, 16),
    })
  })

  return router
}
