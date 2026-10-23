// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * API Key Management Routes
 *
 * Allows cloud users to create, list, and revoke API keys for use
 * with Shogo Local instances. Keys authenticate LLM proxy requests
 * so local installations can use Shogo Cloud models billed to the
 * user's workspace.
 *
 * Two key kinds exist:
 * - "user" keys: created manually via the Keys UI, typed into a CI env var
 *   or the SHOGO_API_KEY escape hatch. Long-lived. No device metadata.
 * - "device" keys: minted automatically by the desktop "Sign in to Shogo
 *   Cloud" flow (see POST /api-keys/device). Carry a deviceId so the same
 *   machine dedupes across re-logins, plus metadata we surface in the cloud
 *   Devices UI. Revoking one = signing that device out.
 *
 * Endpoints:
 * - POST /api/api-keys            - Create a new "user" API key (authed)
 * - POST /api/api-keys/device     - Mint a "device" key for the caller's
 *                                    device; dedupes by deviceId (authed)
 * - GET  /api/api-keys            - List keys for workspace (authed, ?kind=);
 *                                    only the caller's own unless they hold
 *                                    workspace.api_keys:manage
 * - DELETE /api/api-keys/:id      - Revoke own key, or any with
 *                                    workspace.api_keys:manage (authed)
 * - POST /api/api-keys/validate   - Validate a key (public, key is credential)
 * - POST /api/api-keys/heartbeat  - Refresh lastSeenAt for a device key
 *                                    (public, key is credential)
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  SHOGO_API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  mintDeviceApiKey,
} from '../lib/api-keys-mint'
import { recordDeviceVersionEvent } from '../lib/device-version-events'
import { getAccess } from '../lib/authz'

export function apiKeyRoutes() {
  const router = new Hono()

  // POST /api-keys — Create a new "user" API key (manual, long-lived)
  router.post('/api-keys', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{ name?: string; workspaceId: string; expiresInDays?: number }>()
    if (!body.workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId is required' } }, 400)
    }

    const access = await getAccess(c, { workspaceId: body.workspaceId })
    if (!access.permissions.has('workspace:read')) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const { fullKey, keyHash, keyPrefix } = await generateApiKey()

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const apiKey = await prisma.apiKey.create({
      data: {
        name: body.name || 'Shogo Local',
        keyHash,
        keyPrefix,
        workspaceId: body.workspaceId,
        userId: auth.userId,
        expiresAt,
        kind: 'user',
      },
    })

    return c.json({
      id: apiKey.id,
      name: apiKey.name,
      key: fullKey,
      keyPrefix,
      workspaceId: apiKey.workspaceId,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      kind: apiKey.kind,
    })
  })

  // POST /api-keys/device — Mint a device-session key for the caller's machine.
  //
  // Behavior: within a transaction, revoke any existing un-revoked "device"
  // key for (workspaceId, deviceId) so re-logins don't accumulate stale
  // credentials, then create a fresh one with the supplied device metadata.
  // If the caller doesn't pass workspaceId we default to the user's personal
  // workspace (first membership ordered by createdAt).
  router.post('/api-keys/device', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{
      workspaceId?: string
      deviceId: string
      deviceName?: string
      devicePlatform?: string
      deviceAppVersion?: string
    }>().catch(() => ({} as any))

    if (!body?.deviceId || typeof body.deviceId !== 'string' || body.deviceId.length < 8) {
      return c.json({ error: { code: 'invalid_request', message: 'deviceId is required' } }, 400)
    }

    let workspaceId = body.workspaceId
    if (workspaceId) {
      const access = await getAccess(c, { workspaceId })
      if (!access.permissions.has('workspace:read')) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
    } else {
      const member = await prisma.member.findFirst({
        where: { userId: auth.userId, projectId: null },
        orderBy: { createdAt: 'asc' },
        select: { workspaceId: true },
      })
      if (!member) {
        return c.json({ error: { code: 'no_workspace', message: 'User has no workspace' } }, 404)
      }
      workspaceId = member.workspaceId
    }

    const { fullKey, apiKey, keyPrefix } = await mintDeviceApiKey({
      prisma,
      workspaceId: workspaceId!,
      userId: auth.userId,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      devicePlatform: body.devicePlatform,
      deviceAppVersion: body.deviceAppVersion,
      defaultDeviceName: 'Shogo Desktop',
    })

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId! },
      select: { id: true, name: true, slug: true },
    })

    return c.json({
      id: apiKey.id,
      name: apiKey.name,
      key: fullKey,
      keyPrefix,
      workspaceId: apiKey.workspaceId,
      createdAt: apiKey.createdAt,
      kind: apiKey.kind,
      deviceId: apiKey.deviceId,
      deviceName: apiKey.deviceName,
      devicePlatform: apiKey.devicePlatform,
      deviceAppVersion: apiKey.deviceAppVersion,
      workspace,
    })
  })

  // GET /api-keys — List API keys for a workspace (optional ?kind= filter)
  router.get('/api-keys', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const workspaceId = c.req.query('workspaceId')
    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId query param required' } }, 400)
    }
    const kindFilter = c.req.query('kind')

    const access = await getAccess(c, { workspaceId })
    if (!access.permissions.has('workspace:read')) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }
    const canManageAll = access.permissions.has('workspace.api_keys:manage')

    const keys = await prisma.apiKey.findMany({
      where: {
        workspaceId,
        revokedAt: null,
        ...(canManageAll ? {} : { userId: auth.userId }),
        ...(kindFilter === 'device' || kindFilter === 'user' ? { kind: kindFilter } : {}),
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        userId: true,
        kind: true,
        deviceId: true,
        deviceName: true,
        devicePlatform: true,
        deviceAppVersion: true,
        lastSeenAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [
        { lastSeenAt: 'desc' },
        { createdAt: 'desc' },
      ],
    })

    // App install tokens are managed through their install (Settings → Automations).
    return c.json({ keys: keys.filter((k: { kind: string }) => k.kind !== 'app') })
  })

  // DELETE /api-keys/:id — Revoke an API key
  router.delete('/api-keys/:id', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const id = c.req.param('id')
    const apiKey = await prisma.apiKey.findUnique({ where: { id } })
    if (!apiKey) {
      return c.json({ error: { code: 'not_found', message: 'API key not found' } }, 404)
    }

    const access = await getAccess(c, { workspaceId: apiKey.workspaceId })
    if (!access.permissions.has('workspace:read')) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }
    if (apiKey.userId !== auth.userId && !access.permissions.has('workspace.api_keys:manage')) {
      return c.json({ error: { code: 'forbidden', message: "Only workspace admins can revoke other members' keys" } }, 403)
    }

    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    })

    return c.json({ ok: true })
  })

  // POST /api-keys/validate — Validate an API key (public endpoint)
  router.post('/api-keys/validate', async (c) => {
    const body = await c.req.json<{ key: string }>()
    if (!body.key || !body.key.startsWith(SHOGO_API_KEY_PREFIX)) {
      return c.json({ valid: false, error: 'Invalid key format' }, 400)
    }

    const keyHash = await hashApiKey(body.key)
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    })

    if (!apiKey) {
      return c.json({ valid: false, error: 'Key not found' })
    }

    if (apiKey.revokedAt) {
      return c.json({ valid: false, error: 'Key has been revoked' })
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return c.json({ valid: false, error: 'Key has expired' })
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {})

    return c.json({
      valid: true,
      workspace: apiKey.workspace,
      user: { id: apiKey.user.id, name: apiKey.user.name, email: apiKey.user.email },
      kind: apiKey.kind,
      deviceId: apiKey.deviceId,
      deviceName: apiKey.deviceName,
    })
  })

  // POST /api-keys/heartbeat — Refresh lastSeenAt (+ optional deviceAppVersion)
  // for a device key. Cheap write so the cloud Devices UI reflects "active now"
  // even when no ai-proxy traffic is flowing. The key is the credential here,
  // so this is a public endpoint.
  router.post('/api-keys/heartbeat', async (c) => {
    const body = await c.req.json<{ key: string; deviceAppVersion?: string }>().catch(() => ({} as any))
    if (!body?.key || !body.key.startsWith(SHOGO_API_KEY_PREFIX)) {
      return c.json({ ok: false, error: 'Invalid key format' }, 400)
    }
    const keyHash = await hashApiKey(body.key)
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        kind: true,
        deviceId: true,
        devicePlatform: true,
        deviceAppVersion: true,
        lastSeenAt: true,
      },
    })
    if (!apiKey || apiKey.revokedAt) {
      return c.json({ ok: false, error: 'Key not found or revoked' }, 401)
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return c.json({ ok: false, error: 'Key expired' }, 401)
    }

    const now = new Date()
    // Non-device keys keep their old behaviour here: the heartbeat always
    // refreshed `lastSeenAt`, throttled like every other touch.
    const touch = planApiKeyTouch(
      { ...apiKey, lastUsedAt: null },
      {
        now,
        reportedVersion: typeof body.deviceAppVersion === 'string' ? body.deviceAppVersion : null,
        touchLastUsed: false,
        alwaysTouchLastSeen: true,
      },
    )

    if (touch.data) {
      await prisma.apiKey.update({ where: { id: apiKey.id }, data: touch.data }).catch(() => {})
    }

    if (touch.recordVersion) {
      await recordDeviceVersionEvent({
        deviceId: apiKey.deviceId,
        version: touch.version,
        platform: apiKey.devicePlatform,
        seenAt: now,
      })
    }

    return c.json({ ok: true })
  })

  return router
}

/** Minimum gap between `lastUsedAt` / `lastSeenAt` writes for one key (SHO-160). */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000
/** Minimum gap between `device_version_events` upserts for an unchanged version (SHO-160). */
export const DEVICE_VERSION_EVENT_INTERVAL_MS = 5 * 60_000

/**
 * Decide what an authenticated call should write back for its key.
 *
 * Every request used to rewrite `api_keys` and upsert `device_version_events`
 * (~364k writes/day in prod, mostly the same few keys). Timestamps are now
 * refreshed at most once per {@link API_KEY_TOUCH_INTERVAL_MS}, a changed app
 * version is written immediately, and a version event is recorded when the
 * version changes or once per {@link DEVICE_VERSION_EVENT_INTERVAL_MS} window.
 * The stored timestamps are the throttle, so it holds across replicas.
 */
export function planApiKeyTouch(
  stored: {
    kind: string
    deviceAppVersion: string | null
    lastUsedAt?: Date | null
    lastSeenAt?: Date | null
  },
  opts: {
    now: Date
    reportedVersion?: string | null
    /** `resolveApiKey` tracks `lastUsedAt`; the heartbeat only tracks `lastSeenAt`. */
    touchLastUsed: boolean
    /** Refresh `lastSeenAt` for any key kind (the heartbeat's historical behaviour). */
    alwaysTouchLastSeen?: boolean
  },
): { data: Record<string, unknown> | null; recordVersion: boolean; version: string | null } {
  const now = opts.now.getTime()
  const stale = (at: Date | null | undefined, interval: number) => at == null || now - at.getTime() >= interval
  const isDevice = stored.kind === 'device'

  const data: Record<string, unknown> = {}
  if (opts.touchLastUsed && stale(stored.lastUsedAt, API_KEY_TOUCH_INTERVAL_MS)) {
    data.lastUsedAt = opts.now
  }

  const reported = opts.reportedVersion ? opts.reportedVersion.slice(0, 32) : null
  const versionChanged = isDevice && reported !== null && reported !== stored.deviceAppVersion
  if (versionChanged) data.deviceAppVersion = reported

  if ((isDevice || opts.alwaysTouchLastSeen) && (versionChanged || stale(stored.lastSeenAt, API_KEY_TOUCH_INTERVAL_MS))) {
    data.lastSeenAt = opts.now
  }

  // `lastSeenAt` advances every minute on an active device, so "older than 5
  // min" would never fire again; record when this write enters a new window.
  const windowOf = (t: number) => Math.floor(t / DEVICE_VERSION_EVENT_INTERVAL_MS)
  const recordVersion = isDevice && (
    versionChanged ||
    stored.lastSeenAt == null ||
    ('lastSeenAt' in data && windowOf(stored.lastSeenAt.getTime()) !== windowOf(now))
  )

  return {
    data: Object.keys(data).length > 0 ? data : null,
    recordVersion,
    version: versionChanged ? reported : (reported ?? stored.deviceAppVersion),
  }
}

/**
 * Resolve a Shogo API key to workspace/user context.
 * Used by the AI proxy to authenticate requests from Shogo Local instances.
 * Returns null if the key is invalid, revoked, or expired.
 *
 * Side effects: fire-and-forget updates `lastUsedAt` and, for device keys,
 * `lastSeenAt` — so the Devices UI reflects activity without a separate
 * heartbeat on every proxy call. The optional `deviceAppVersion` parameter
 * opportunistically refreshes the stored app version when the local client
 * sends its `X-Shogo-Device-App-Version` header.
 */
export async function resolveApiKey(
  key: string,
  opts?: {
    deviceAppVersion?: string
    /** App install tokens (`kind: 'app'`) only authenticate where their scopes are enforced. */
    allowAppTokens?: boolean
  },
): Promise<{
  workspaceId: string
  userId: string
  kind: string
  deviceId: string | null
  /** Set for app install tokens only. */
  installId?: string | null
} | null> {
  if (!key.startsWith(SHOGO_API_KEY_PREFIX)) return null

  const keyHash = await hashApiKey(key)
  const apiKey = await (prisma as any).apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      kind: true,
      deviceId: true,
      devicePlatform: true,
      deviceAppVersion: true,
      installId: true,
      lastUsedAt: true,
      lastSeenAt: true,
    },
  })

  if (!apiKey || apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null
  if (apiKey.kind === 'app' && !opts?.allowAppTokens) return null

  const now = new Date()
  const touch = planApiKeyTouch(apiKey, {
    now,
    reportedVersion: typeof opts?.deviceAppVersion === 'string' ? opts.deviceAppVersion : null,
    touchLastUsed: true,
  })

  if (touch.data) {
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: touch.data,
    }).catch(() => {})
  }

  if (touch.recordVersion) {
    recordDeviceVersionEvent({
      deviceId: apiKey.deviceId,
      version: touch.version,
      platform: apiKey.devicePlatform,
      seenAt: now,
    }).catch(() => {})
  }

  return {
    workspaceId: apiKey.workspaceId,
    userId: apiKey.userId,
    kind: apiKey.kind,
    deviceId: apiKey.deviceId,
    ...(apiKey.kind === 'app' ? { installId: apiKey.installId ?? null } : {}),
  }
}
