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
 * - GET  /api/api-keys            - List keys for workspace (authed, ?kind=)
 * - DELETE /api/api-keys/:id      - Revoke a key (authed)
 * - POST /api/api-keys/validate   - Validate a key (public, key is credential)
 * - POST /api/api-keys/heartbeat  - Refresh lastSeenAt for a device key
 *                                    (public, key is credential)
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

const KEY_PREFIX = 'shogo_sk_'
const KEY_RANDOM_BYTES = 32

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function generateRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_RANDOM_BYTES))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

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

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: body.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const rawKey = generateRawKey()
    const fullKey = `${KEY_PREFIX}${rawKey}`
    const keyHash = await hashKey(fullKey)
    const keyPrefix = fullKey.slice(0, KEY_PREFIX.length + 8)

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
      const member = await prisma.member.findFirst({
        where: { userId: auth.userId, workspaceId },
      })
      if (!member) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
    } else {
      const member = await prisma.member.findFirst({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'asc' },
        select: { workspaceId: true },
      })
      if (!member) {
        return c.json({ error: { code: 'no_workspace', message: 'User has no workspace' } }, 404)
      }
      workspaceId = member.workspaceId
    }

    const rawKey = generateRawKey()
    const fullKey = `${KEY_PREFIX}${rawKey}`
    const keyHash = await hashKey(fullKey)
    const keyPrefix = fullKey.slice(0, KEY_PREFIX.length + 8)

    const deviceName = body.deviceName?.slice(0, 120) || 'Shogo Desktop'
    const devicePlatform = body.devicePlatform?.slice(0, 32)
    const deviceAppVersion = body.deviceAppVersion?.slice(0, 32)

    const apiKey = await prisma.$transaction(async (tx) => {
      // Revoke any prior device key for this (workspaceId, deviceId).
      // We don't hard-delete so audit/billing history stays intact.
      await tx.apiKey.updateMany({
        where: {
          workspaceId: workspaceId!,
          deviceId: body.deviceId,
          kind: 'device',
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      })

      return tx.apiKey.create({
        data: {
          name: deviceName,
          keyHash,
          keyPrefix,
          workspaceId: workspaceId!,
          userId: auth.userId,
          kind: 'device',
          deviceId: body.deviceId,
          deviceName,
          devicePlatform,
          deviceAppVersion,
          lastSeenAt: new Date(),
        },
      })
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

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const keys = await prisma.apiKey.findMany({
      where: {
        workspaceId,
        revokedAt: null,
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

    return c.json({ keys })
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

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: apiKey.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
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
    if (!body.key || !body.key.startsWith(KEY_PREFIX)) {
      return c.json({ valid: false, error: 'Invalid key format' }, 400)
    }

    const keyHash = await hashKey(body.key)
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
    if (!body?.key || !body.key.startsWith(KEY_PREFIX)) {
      return c.json({ ok: false, error: 'Invalid key format' }, 400)
    }
    const keyHash = await hashKey(body.key)
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      select: { id: true, revokedAt: true, expiresAt: true, kind: true },
    })
    if (!apiKey || apiKey.revokedAt) {
      return c.json({ ok: false, error: 'Key not found or revoked' }, 401)
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return c.json({ ok: false, error: 'Key expired' }, 401)
    }

    const data: Record<string, unknown> = { lastSeenAt: new Date() }
    if (apiKey.kind === 'device' && typeof body.deviceAppVersion === 'string') {
      data.deviceAppVersion = body.deviceAppVersion.slice(0, 32)
    }

    await prisma.apiKey.update({ where: { id: apiKey.id }, data }).catch(() => {})
    return c.json({ ok: true })
  })

  return router
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
  opts?: { deviceAppVersion?: string },
): Promise<{
  workspaceId: string
  userId: string
  kind: string
  deviceId: string | null
} | null> {
  if (!key.startsWith(KEY_PREFIX)) return null

  const keyHash = await hashKey(key)
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      kind: true,
      deviceId: true,
    },
  })

  if (!apiKey || apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  const now = new Date()
  const data: Record<string, unknown> = { lastUsedAt: now }
  if (apiKey.kind === 'device') {
    data.lastSeenAt = now
    if (opts?.deviceAppVersion && typeof opts.deviceAppVersion === 'string') {
      data.deviceAppVersion = opts.deviceAppVersion.slice(0, 32)
    }
  }

  prisma.apiKey.update({
    where: { id: apiKey.id },
    data,
  }).catch(() => {})

  return {
    workspaceId: apiKey.workspaceId,
    userId: apiKey.userId,
    kind: apiKey.kind,
    deviceId: apiKey.deviceId,
  }
}
