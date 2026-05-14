// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CLI Cloud-Login Routes
 *
 * Cloud-side endpoints that back the `shogo login` device-code flow
 * (see `packages/shogo-worker/src/lib/cloud-login.ts`).
 *
 * Unlike the desktop sign-in (which receives the minted key via a
 * `shogo://auth-callback` deep link), the CLI cannot register protocol
 * handlers and does not run an inbound HTTP listener. So instead of
 * being pushed the key, the CLI:
 *
 *   1. POST /api/cli/login/start (no auth) — registers a pending state.
 *      Cloud returns { state, userCode, authUrl, expiresInMs, pollIntervalMs }.
 *   2. Opens authUrl in the browser. The bridge page is
 *      <cloudUrl>/auth/cli-link?state=...&userCode=... and lives in
 *      `apps/mobile/app/auth/cli-link.tsx`.
 *   3. User signs in (Better Auth), picks a workspace, clicks Approve.
 *      The bridge calls POST /api/cli/login/approve with cookie auth;
 *      we mint a device-tagged API key and pin it to `state`.
 *   4. CLI polls GET /api/cli/login/poll?state=... every pollIntervalMs.
 *      Once approved we hand the key over exactly once (single-use)
 *      and delete the entry.
 *
 * The minted key is identical to what the desktop flow produces — same
 * `apiKey.kind = 'device'` rows, same dedupe by (workspaceId, deviceId),
 * same revocation behavior. Anything that already understands desktop
 * device keys (Devices UI, AI proxy, instance tunnel) handles CLI
 * device keys with no changes.
 *
 * Pending state is in-memory only — small (<1KB per pending login),
 * short-lived (5-min TTL), and it would create more cleanup churn
 * persisted to Postgres than it saves. If we ever shard the API tier
 * we'll need to either move this to Redis or pin login-poll requests
 * to the start node via state-prefix routing.
 */

import { Hono } from 'hono'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'

const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'
const STATE_TTL_MS = 5 * 60 * 1000
const STATE_BYTE_LENGTH = 16
const POLL_INTERVAL_MS = 2_000
const KEY_PREFIX = 'shogo_sk_'
const KEY_RANDOM_BYTES = 32

type PendingStatus = 'pending' | 'approved' | 'denied' | 'expired'

interface PendingState {
  status: PendingStatus
  deviceId: string
  deviceName: string
  devicePlatform?: string
  deviceAppVersion?: string
  /** "desktop" | "cli" — hint for the bridge page UI only. */
  client: 'desktop' | 'cli'
  preselectedWorkspaceId?: string
  expiresAt: number

  // Populated on approval; cleared after the client polls for it once.
  mintedKey?: string
  email?: string | null
  workspace?: string | null
  approvedAt?: number
}

const pendingStates = new Map<string, PendingState>()

function purgeExpiredStates(): void {
  const now = Date.now()
  for (const [state, record] of pendingStates) {
    if (record.expiresAt <= now) {
      // We don't bump status to 'expired' first because there's no one
      // to read it once we've blown the TTL — the pending CLI process
      // would have given up via its own deadline by now.
      pendingStates.delete(state)
    }
  }
}

function generateState(): string {
  return crypto.randomBytes(STATE_BYTE_LENGTH).toString('hex')
}

function userCodeFor(state: string): string {
  return state.slice(-6).toUpperCase()
}

function getCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || SHOGO_CLOUD_URL_DEFAULT).replace(/\/$/, '')
}

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

export function cliAuthRoutes() {
  const router = new Hono()

  // POST /api/cli/login/start — kick off a CLI login flow. Public.
  router.post('/cli/login/start', async (c) => {
    purgeExpiredStates()

    const body = await c.req
      .json<{
        deviceId?: string
        deviceName?: string
        devicePlatform?: string
        deviceAppVersion?: string
        workspaceId?: string
        /** Hint for the bridge page UI ("desktop" | "cli"). Server-side
         * we only echo it back via /state — auth + minting are identical. */
        client?: 'desktop' | 'cli'
      }>()
      .catch(() => ({} as any))

    if (!body?.deviceId || typeof body.deviceId !== 'string' || body.deviceId.length < 8) {
      return c.json(
        { ok: false, error: 'deviceId is required (>=8 chars)' },
        400,
      )
    }

    const client: 'desktop' | 'cli' = body.client === 'desktop' ? 'desktop' : 'cli'
    const defaultDeviceName = client === 'desktop' ? 'Shogo Desktop' : 'Shogo CLI'

    const state = generateState()
    pendingStates.set(state, {
      status: 'pending',
      deviceId: body.deviceId,
      deviceName: (body.deviceName || defaultDeviceName).slice(0, 120),
      devicePlatform: body.devicePlatform?.slice(0, 32),
      deviceAppVersion: body.deviceAppVersion?.slice(0, 32),
      client,
      preselectedWorkspaceId:
        typeof body.workspaceId === 'string' && body.workspaceId
          ? body.workspaceId
          : undefined,
      expiresAt: Date.now() + STATE_TTL_MS,
    })

    const params = new URLSearchParams({
      state,
      userCode: userCodeFor(state),
      deviceId: body.deviceId,
      client,
    })
    if (body.deviceName) params.set('deviceName', body.deviceName)
    if (body.devicePlatform) params.set('devicePlatform', body.devicePlatform)
    if (body.deviceAppVersion) params.set('appVersion', body.deviceAppVersion)
    if (body.workspaceId) params.set('workspaceId', body.workspaceId)

    const cloudUrl = getCloudUrl()
    // Path stays /auth/cli-link for backward compat with worker clients
    // already in the wild — copy on the page is now neutral.
    const authUrl = `${cloudUrl}/auth/cli-link?${params.toString()}`

    return c.json({
      ok: true,
      state,
      userCode: userCodeFor(state),
      authUrl,
      expiresInMs: STATE_TTL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    })
  })

  // GET /api/cli/login/poll?state=... — CLI polls until approval. Public.
  router.get('/cli/login/poll', async (c) => {
    purgeExpiredStates()
    const state = c.req.query('state')
    if (!state) {
      return c.json({ ok: false, error: 'state query param required' }, 400)
    }
    const record = pendingStates.get(state)
    if (!record) {
      return c.json({ ok: true, status: 'expired' as PendingStatus })
    }
    if (record.expiresAt <= Date.now()) {
      pendingStates.delete(state)
      return c.json({ ok: true, status: 'expired' as PendingStatus })
    }
    if (record.status === 'denied') {
      pendingStates.delete(state)
      return c.json({ ok: true, status: 'denied' as PendingStatus })
    }
    if (record.status === 'approved' && record.mintedKey) {
      // Single-use: hand the key over and burn the entry.
      pendingStates.delete(state)
      return c.json({
        ok: true,
        status: 'approved' as PendingStatus,
        key: record.mintedKey,
        email: record.email ?? null,
        workspace: record.workspace ?? null,
        deviceId: record.deviceId,
      })
    }
    return c.json({ ok: true, status: 'pending' as PendingStatus })
  })

  // GET /api/cli/login/state?state=... — bridge page reads metadata so it
  // can render "Approve sign-in for <device> (<userCode>)". Public — the
  // state nonce itself is the secret.
  router.get('/cli/login/state', async (c) => {
    purgeExpiredStates()
    const state = c.req.query('state')
    if (!state) {
      return c.json({ ok: false, error: 'state required' }, 400)
    }
    const record = pendingStates.get(state)
    if (!record || record.expiresAt <= Date.now()) {
      return c.json({ ok: false, error: 'expired' }, 404)
    }
    return c.json({
      ok: true,
      status: record.status,
      userCode: userCodeFor(state),
      client: record.client,
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      devicePlatform: record.devicePlatform,
      deviceAppVersion: record.deviceAppVersion,
      preselectedWorkspaceId: record.preselectedWorkspaceId,
    })
  })

  // POST /api/cli/login/approve — bridge page calls this to mint the key.
  // Cookie-authed via Better Auth (apps/api authMiddleware sets c.auth).
  router.post('/cli/login/approve', async (c) => {
    purgeExpiredStates()

    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ ok: false, error: 'Authentication required' }, 401)
    }

    const body = await c.req
      .json<{ state?: string; workspaceId?: string }>()
      .catch(() => ({} as any))

    const state = typeof body?.state === 'string' ? body.state : ''
    if (!state) {
      return c.json({ ok: false, error: 'state required' }, 400)
    }

    const record = pendingStates.get(state)
    if (!record) {
      return c.json({ ok: false, error: 'Unknown or expired state' }, 404)
    }
    if (record.expiresAt <= Date.now()) {
      pendingStates.delete(state)
      return c.json({ ok: false, error: 'Sign-in request expired' }, 410)
    }
    if (record.status === 'approved') {
      // Idempotent re-approve from a refreshed bridge tab.
      return c.json({ ok: true, alreadyApproved: true })
    }
    if (record.status === 'denied') {
      return c.json({ ok: false, error: 'Sign-in request was already denied' }, 410)
    }

    // Resolve target workspace: prefer body.workspaceId, fall back to the
    // start-time preselection, fall back to the user's first membership.
    let workspaceId =
      (typeof body.workspaceId === 'string' && body.workspaceId) ||
      record.preselectedWorkspaceId ||
      undefined

    if (workspaceId) {
      const member = await prisma.member.findFirst({
        where: { userId: auth.userId, workspaceId },
      })
      if (!member) {
        return c.json(
          { ok: false, error: 'Not a member of the requested workspace' },
          403,
        )
      }
    } else {
      const member = await prisma.member.findFirst({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'asc' },
        select: { workspaceId: true },
      })
      if (!member) {
        return c.json({ ok: false, error: 'User has no workspace' }, 404)
      }
      workspaceId = member.workspaceId
    }

    // Mint the device key — same flow as POST /api-keys/device so the
    // resulting row is indistinguishable from the desktop flow's keys.
    const rawKey = generateRawKey()
    const fullKey = `${KEY_PREFIX}${rawKey}`
    const keyHash = await hashKey(fullKey)
    const keyPrefix = fullKey.slice(0, KEY_PREFIX.length + 8)

    const apiKey = await prisma.$transaction(async (tx) => {
      await tx.apiKey.updateMany({
        where: {
          workspaceId: workspaceId!,
          deviceId: record.deviceId,
          kind: 'device',
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      })
      return tx.apiKey.create({
        data: {
          name: record.deviceName || 'Shogo CLI',
          keyHash,
          keyPrefix,
          workspaceId: workspaceId!,
          userId: auth.userId,
          kind: 'device',
          deviceId: record.deviceId,
          deviceName: record.deviceName,
          devicePlatform: record.devicePlatform,
          deviceAppVersion: record.deviceAppVersion,
          lastSeenAt: new Date(),
        },
      })
    })

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId! },
      select: { name: true, slug: true },
    })
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { email: true },
    })

    record.status = 'approved'
    record.mintedKey = fullKey
    record.email = user?.email ?? null
    record.workspace = workspace?.name ?? null
    record.approvedAt = Date.now()
    // Keep the record around just long enough for the CLI's next poll
    // to grab the key; the poll handler deletes it on success.
    record.expiresAt = Math.min(record.expiresAt, Date.now() + 60_000)

    return c.json({
      ok: true,
      keyPrefix,
      apiKeyId: apiKey.id,
      workspace: workspace?.name ?? null,
      email: user?.email ?? null,
    })
  })

  // POST /api/cli/login/deny — user clicked "Cancel" on the bridge page.
  // Cookie-authed: only signed-in users should be able to deny (otherwise
  // anyone with a leaked state could grief a CLI mid-flow).
  router.post('/cli/login/deny', async (c) => {
    purgeExpiredStates()
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ ok: false, error: 'Authentication required' }, 401)
    }
    const body = await c.req.json<{ state?: string }>().catch(() => ({} as any))
    const state = typeof body?.state === 'string' ? body.state : ''
    if (!state) return c.json({ ok: false, error: 'state required' }, 400)
    const record = pendingStates.get(state)
    if (!record) return c.json({ ok: true })
    if (record.status === 'pending') {
      record.status = 'denied'
      record.expiresAt = Math.min(record.expiresAt, Date.now() + 30_000)
    }
    return c.json({ ok: true })
  })

  return router
}

/** Test seam — clears in-memory pending states between tests. */
export const _testing = {
  pendingStates,
  purgeExpiredStates,
}
