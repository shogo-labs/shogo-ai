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
 * Endpoints:
 * - POST /api/api-keys           - Create a new API key (authed)
 * - GET  /api/api-keys           - List keys for workspace (authed)
 * - DELETE /api/api-keys/:id     - Revoke a key (authed)
 * - POST /api/api-keys/validate  - Validate a key (public, key is credential)
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

  // POST /api-keys — Create a new API key
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
    })
  })

  // GET /api-keys — List API keys for a workspace
  router.get('/api-keys', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const workspaceId = c.req.query('workspaceId')
    if (!workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId query param required' } }, 400)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const keys = await prisma.apiKey.findMany({
      where: { workspaceId, revokedAt: null },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
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
      user: { id: apiKey.user.id, name: apiKey.user.name },
    })
  })

  return router
}

/**
 * Resolve a Shogo API key to workspace/user context.
 * Used by the AI proxy to authenticate requests from Shogo Local instances.
 * Returns null if the key is invalid, revoked, or expired.
 */
export async function resolveApiKey(key: string): Promise<{
  workspaceId: string
  userId: string
} | null> {
  if (!key.startsWith(KEY_PREFIX)) return null

  const keyHash = await hashKey(key)
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, workspaceId: true, userId: true, revokedAt: true, expiresAt: true },
  })

  if (!apiKey || apiKey.revokedAt) return null
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

  prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {})

  return { workspaceId: apiKey.workspaceId, userId: apiKey.userId }
}
