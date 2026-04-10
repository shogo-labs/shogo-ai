// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control — QR Pairing
 *
 * Endpoints:
 * - POST /api/pairing/initiate   — Create a short-lived pairing code (session auth)
 * - POST /api/pairing/complete   — Complete pairing with code, create API key (code = auth)
 * - GET  /api/pairing/:code/status — Poll for pairing completion (session auth)
 *
 * /pairing/complete is intentionally semi-public: the 6-digit code (short-lived,
 * single-use) acts as the authentication token. This lets a mobile device complete
 * pairing without needing a pre-existing session — the code creator's identity is
 * used to mint the API key when the caller has no session.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import crypto from 'crypto'

const CODE_LENGTH = 6
const CODE_EXPIRY_MS = 5 * 60 * 1000
const KEY_PREFIX = 'shogo_sk_'

function generatePairingCode(): string {
  return Array.from(crypto.randomBytes(CODE_LENGTH))
    .map((b) => (b % 10).toString())
    .join('')
}

function generateApiKeyValue(): string {
  return KEY_PREFIX + crypto.randomBytes(24).toString('base64url')
}

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(hashBuffer).toString('hex')
}

export function pairingRoutes() {
  const router = new Hono()

  // POST /pairing/initiate — Desktop or mobile creates a pairing code
  router.post('/pairing/initiate', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const body = await c.req.json<{ workspaceId: string; publicKey?: string }>()
    if (!body.workspaceId) {
      return c.json({ error: { code: 'invalid_request', message: 'workspaceId required' } }, 400)
    }

    const member = await prisma.member.findFirst({
      where: { userId: auth.userId, workspaceId: body.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const code = generatePairingCode()
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS)

    const pairing = await prisma.pairingCode.create({
      data: {
        workspaceId: body.workspaceId,
        createdByUserId: auth.userId,
        code,
        expiresAt,
        publicKey: body.publicKey || null,
      },
    })

    return c.json({
      id: pairing.id,
      code: pairing.code,
      expiresAt: pairing.expiresAt.toISOString(),
    })
  })

  // POST /pairing/complete — Submit the code, get an API key.
  // The pairing code itself is the authentication — no session required.
  // If the caller IS authenticated, their userId is used; otherwise the
  // code creator's userId is used.
  router.post('/pairing/complete', async (c) => {
    const body = await c.req.json<{ code: string; publicKey?: string }>()
    if (!body.code) {
      return c.json({ error: { code: 'invalid_request', message: 'code required' } }, 400)
    }

    const pairing = await prisma.pairingCode.findUnique({ where: { code: body.code } })
    if (!pairing) {
      return c.json({ error: { code: 'invalid_code', message: 'Invalid pairing code' } }, 400)
    }
    if (pairing.usedAt) {
      return c.json({ error: { code: 'code_used', message: 'This code has already been used' } }, 400)
    }
    if (pairing.expiresAt < new Date()) {
      return c.json({ error: { code: 'code_expired', message: 'This code has expired' } }, 400)
    }

    // Determine the userId: prefer caller's session, fall back to code creator
    const auth = c.get('auth') as any
    const userId = auth?.userId || pairing.createdByUserId
    if (!userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Could not determine user — try signing in first' } },
        401,
      )
    }

    // Verify the user is a workspace member
    const member = await prisma.member.findFirst({
      where: { userId, workspaceId: pairing.workspaceId },
    })
    if (!member) {
      return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
    }

    const rawKey = generateApiKeyValue()
    const keyHash = await hashKey(rawKey)

    const apiKey = await prisma.apiKey.create({
      data: {
        name: `Paired device (${new Date().toLocaleDateString()})`,
        keyHash,
        keyPrefix: rawKey.slice(0, 12),
        workspaceId: pairing.workspaceId,
        userId,
      },
    })

    await prisma.pairingCode.update({
      where: { id: pairing.id },
      data: { usedAt: new Date(), apiKeyId: apiKey.id },
    })

    // In local mode, auto-store the API key so the desktop can use it for cloud tunneling
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      try {
        const db = prisma as any
        await db.localConfig.upsert({
          where: { key: 'SHOGO_API_KEY' },
          update: { value: rawKey },
          create: { key: 'SHOGO_API_KEY', value: rawKey },
        })
        process.env.SHOGO_API_KEY = rawKey
        if (process.env.SHOGO_CLOUD_URL) {
          import('../lib/instance-tunnel').then(({ stopInstanceTunnel, startInstanceTunnel }) => {
            stopInstanceTunnel()
            startInstanceTunnel()
          }).catch(() => {})
        }
      } catch {}
    }

    return c.json({
      apiKey: rawKey,
      apiKeyId: apiKey.id,
      workspaceId: pairing.workspaceId,
      peerPublicKey: pairing.publicKey || null,
    })
  })

  // GET /pairing/:code/status — Desktop polls to know when pairing completes
  router.get('/pairing/:code/status', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const pairing = await prisma.pairingCode.findUnique({ where: { code: c.req.param('code') } })
    if (!pairing) {
      return c.json({ error: { code: 'not_found', message: 'Pairing code not found' } }, 404)
    }

    if (pairing.expiresAt < new Date() && !pairing.usedAt) {
      return c.json({ status: 'expired' })
    }

    return c.json({
      status: pairing.usedAt ? 'completed' : 'pending',
      expiresAt: pairing.expiresAt.toISOString(),
    })
  })

  return router
}
