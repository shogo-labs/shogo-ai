// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Device-Code Cloud-Login Routes
 *
 * Cloud-side endpoints that back the device-code sign-in flow used by
 * BOTH the `shogo login` CLI (see
 * `packages/shogo-worker/src/lib/cloud-login.ts`) and the Electron
 * desktop app (see `apps/desktop/src/main.ts` → `runCloudSignIn`).
 *
 * Both clients use the same poll-based handshake — neither relies on
 * inbound HTTP, deep links, or protocol handlers. The `client` field
 * (`'desktop' | 'cli'`) is just a hint that lets the browser bridge
 * page label the approval UI correctly.
 *
 *   1. POST /api/cli/login/start (no auth) — registers a pending state.
 *      Cloud returns { state, userCode, authUrl, expiresInMs, pollIntervalMs }.
 *   2. Client opens authUrl in the browser. The bridge page is
 *      <cloudUrl>/auth/cli-link?state=...&userCode=... and lives in
 *      `apps/mobile/app/auth/cli-link.tsx` (shared between desktop/CLI;
 *      the URL is historical — both clients use it).
 *   3. User signs in (Better Auth), picks a workspace, clicks Approve.
 *      The bridge calls POST /api/cli/login/approve with cookie auth;
 *      we mint a device-tagged API key and pin it to `state`.
 *   4. Client polls GET /api/cli/login/poll?state=... every pollIntervalMs.
 *      Once approved we hand the key over exactly once (single-use)
 *      and delete the entry. The desktop app then PUTs the key to its
 *      local API at /api/local/shogo-key for on-disk persistence; the
 *      CLI writes it directly to ~/.shogo/credentials.json.
 *
 * Minted keys are uniform across clients: same `apiKey.kind = 'device'`
 * rows, same dedupe by (workspaceId, deviceId), same revocation. The
 * only differentiator persisted is the device row's friendly name
 * (e.g. "Russell's MacBook Pro" vs "shogo CLI on …").
 *
 * Pending state lives in `../lib/pending-login-store.ts`. In cloud mode
 * the store writes to Redis (with a Redis-native TTL so we don't need
 * a cleanup job) so the four endpoints above can be served by any pod
 * in the multi-replica API tier; in local mode (Electron-bundled API)
 * it falls back to an in-process Map. The store's docstring covers
 * the regression history (cross-pod 404s on `/state` in v1.7.x).
 */

import { Hono } from 'hono'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'
import { getFrontendUrl } from '../lib/cloud-urls'
import { mintDeviceApiKey } from '../lib/api-keys-mint'
import {
  type PendingState,
  type PendingStatus,
  _testing as storeTesting,
  deletePendingState,
  getPendingState,
  purgeExpiredStates,
  setPendingState,
} from '../lib/pending-login-store'

const STATE_TTL_MS = 5 * 60 * 1000
const STATE_BYTE_LENGTH = 16
const POLL_INTERVAL_MS = 2_000

function generateState(): string {
  return crypto.randomBytes(STATE_BYTE_LENGTH).toString('hex')
}

function userCodeFor(state: string): string {
  return state.slice(-6).toUpperCase()
}

export function cliAuthRoutes() {
  const router = new Hono()

  // POST /api/cli/login/start — kick off a device-code login flow
  // (called by both Shogo Desktop and the CLI worker). Public.
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
    await setPendingState(state, {
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

    // The bridge page is part of this api node's own frontend, so use
    // the frontend URL (APP_URL / ALLOWED_ORIGINS) rather than the
    // upstream-cloud URL — they coincide on the production cloud node
    // but the frontend URL is the conceptually correct one for a
    // browser redirect target. Path stays /auth/cli-link for backward
    // compat with worker clients already in the wild — page copy is
    // now client-neutral.
    const frontendUrl = getFrontendUrl().replace(/\/$/, '')
    const authUrl = `${frontendUrl}/auth/cli-link?${params.toString()}`

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
    const record = await getPendingState(state)
    if (!record) {
      return c.json({ ok: true, status: 'expired' as PendingStatus })
    }
    if (record.expiresAt <= Date.now()) {
      await deletePendingState(state)
      return c.json({ ok: true, status: 'expired' as PendingStatus })
    }
    if (record.status === 'denied') {
      await deletePendingState(state)
      return c.json({ ok: true, status: 'denied' as PendingStatus })
    }
    if (record.status === 'approved' && record.mintedKey) {
      // Single-use: hand the key over and burn the entry.
      await deletePendingState(state)
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
    const record = await getPendingState(state)
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

    const record = await getPendingState(state)
    if (!record) {
      return c.json({ ok: false, error: 'Unknown or expired state' }, 404)
    }
    if (record.expiresAt <= Date.now()) {
      await deletePendingState(state)
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

    // Mint the device key via the shared helper so the resulting row is
    // byte-identical to what POST /api-keys/device produces — same
    // dedupe rules, same hash strategy, same key shape. The bridge page
    // for desktop sign-ins surfaces a different default name when the
    // user didn't already pass one.
    const { fullKey, apiKey, keyPrefix } = await mintDeviceApiKey({
      prisma,
      workspaceId: workspaceId!,
      userId: auth.userId,
      deviceId: record.deviceId,
      deviceName: record.deviceName,
      devicePlatform: record.devicePlatform,
      deviceAppVersion: record.deviceAppVersion,
      defaultDeviceName: record.client === 'desktop' ? 'Shogo Desktop' : 'Shogo CLI',
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
    // Persist the mutations back to the store. In local mode `record`
    // is the same Map-stored object reference and this is a no-op write,
    // but in cloud mode `getPendingState` handed back a JSON-parsed
    // copy and the changes above only live in this stack frame until we
    // write them through. Without this, the CLI's `/poll` lands on a
    // sibling pod, hits Redis directly, sees `status: 'pending'`, and
    // the user's browser shows "Sign-in approved" while the CLI hangs.
    await setPendingState(state, record)

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
    const record = await getPendingState(state)
    if (!record) return c.json({ ok: true })
    if (record.status === 'pending') {
      record.status = 'denied'
      record.expiresAt = Math.min(record.expiresAt, Date.now() + 30_000)
      // Same write-through reasoning as `/approve` above: in cloud mode
      // the in-stack mutations don't reach the next poller until we
      // persist back to Redis.
      await setPendingState(state, record)
    }
    return c.json({ ok: true })
  })

  return router
}

// Re-export the store's test seam under the historical `_testing` name
// from this module. The existing cli-auth-routes*.test.ts suites poke
// at `_testing.pendingStates` directly — keeping that surface intact
// here means the routes refactor is purely additive for tests, and
// they continue to seed / inspect the same in-memory Map that the
// store uses in local mode (which is the mode tests run in).
export const _testing = storeTesting
// Re-export internals used by tests that still type-import the route
// module (PendingState shape, etc.). Avoids forcing every test file to
// path-import from `lib/pending-login-store.ts`.
export type { PendingState, PendingStatus }
