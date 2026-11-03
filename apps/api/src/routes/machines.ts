// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Machine workspaces — a paired desktop's *own* workspaces, reachable from
 * the cloud while that desktop is online.
 *
 * Everything here is owner-only: a machine belongs to the user whose device
 * key registered it (`Instance.userId`), not to a cloud workspace, so these
 * routes deliberately skip the workspace-membership check that `/instances`
 * uses and compare the caller against the machine's owner instead. Being in
 * the same cloud workspace as somebody is not permission to read their Mac.
 *
 * Machine workspaces are virtual: nothing about them is persisted in the
 * cloud DB beyond the cached heartbeat snapshot (`Instance.metadata.machine`),
 * which carries ids, names and counts — never transcripts. The desktop stays
 * the single source of truth.
 */

import { Hono } from 'hono'
import { prisma, InstanceKind } from '../lib/prisma'
import {
  ensureTunnelConnected,
  generateRequestId,
  getMachineGroupStatus,
  getMachineLiveStatus,
  hasLocalTunnel,
  isRecentlySeenViaHeartbeat,
  isStreamingRequest,
  markViewerActive,
  normalizeTransparentProxyPath,
  sendTunnelRequest,
  sendTunnelStreamRequest,
} from './instances'
import { isMachineTimeoutError } from '../lib/tunnel-errors'
import { isTunnelConnectedAnywhere } from '../lib/tunnel-redis'
import { classifyAction, logRemoteAction } from './remote-audit'
import { groupMachinesByHostname, workspaceNamesById } from '../lib/machine-list'
import { applyBatch, ownershipFailure, releaseHostedWorkspaces } from '../lib/machine-sync/ingest'
import { withoutHostChangeLog } from '../lib/machine-sync/host-change-log'
import { pruneHostFeed, readHostFeed } from '../lib/machine-sync/feed'
import { hostingInstanceIds, invalidateHostedWorkspaceIds } from '../lib/hosted-workspace'
import { PRIMARY_REGION, RAW_REGION_ID } from '../lib/region'
import { resolveApiKey } from './api-keys'

/**
 * How long one request waits for a cold machine's tunnel before answering.
 * Deliberately short: a desktop that is not connected takes up to a full idle
 * poll (60 s) to come back, and holding the HTTP request open for that is what
 * made every panel hang. A request now waits long enough to catch a tunnel that
 * is already connecting, then answers `waking` and the client retries (SHO-185).
 */
const DEFAULT_WAKE_DEADLINE_MS = 5_000
let wakeDeadlineMs = DEFAULT_WAKE_DEADLINE_MS

/** Headers we must not copy back through the proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
])

function offline() {
  return { error: { code: 'offline', message: 'Machine is offline' } }
}

/**
 * The machine is offline and this is a write (SHO-185).
 *
 * The workspace is read-only until it comes back — its rows are on the desktop,
 * so a write has nowhere to land. Nothing is queued: a send that surfaced
 * minutes later, after the machine returned, would be a surprise nobody asked
 * for. `lastSyncedAt` is what the banner shows.
 */
function offlineReadOnly(instance: { name: string | null }, lastSyncedAt: string | null) {
  return {
    error: {
      code: 'machine_offline_readonly',
      message: `${instance.name || 'The machine'} is offline — this workspace is read-only until it is back`,
      lastSyncedAt,
    },
  }
}

/** Methods that change something on the machine. Reads are served by the copy. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * A machine we have heard from recently but whose tunnel is not up yet: the wake
 * is in flight, so the client should retry, not tell the user it is offline.
 * Before this, a machine that heartbeated 20 s ago was reported offline for the
 * whole 60 s idle-poll window and the workspace looked broken (SHO-185).
 */
function waking(instance: { name: string | null }, retryAfterSeconds = 3) {
  return {
    error: {
      code: 'waking',
      message: `${instance.name || 'The machine'} is waking up`,
      retryAfterSeconds,
    },
  }
}

function machineTimeout(instance: { name: string | null }, err: Error) {
  return {
    error: {
      code: 'machine_timeout',
      message: `${instance.name || 'The machine'} is connected but did not answer in time`,
      detail: err.message,
    },
  }
}

function forbidden() {
  return { error: { code: 'forbidden', message: 'Not your machine' } }
}

/**
 * A `shogo worker` VM is an execution target, not a computer (SHO-120): its
 * tunnel serves `/agent/*` and answers every other path with a structured 502.
 * Machine workspaces only exist on a paired desktop, so the relay refuses a
 * cli-worker up front instead of forwarding a request it can only fail.
 */
function notAMachine() {
  return {
    error: {
      code: 'not_a_machine',
      message: 'A shogo worker is an execution target; reach it through /api/instances/:id/p',
    },
  }
}

/** `kind` arrives as the enum value; tolerate the wire spelling too. */
function isCliWorker(kind: string | null | undefined): boolean {
  return (kind ?? '').toLowerCase().replace(/[-\s]/g, '_') === InstanceKind.cli_worker
}

/**
 * A mutation from Studio is applied on the desktop and then pushed back over
 * HTTPS. Until that push lands, a read of the copy would still show the old
 * value — so the mutation waits here, briefly, for the desktop's change to
 * arrive. The desktop sends `x-shogo-sync-seq` (the change-log position after its
 * own write) and the copy's cursor catches up within a tick (SHO-185).
 */
const SYNC_CATCH_UP_DEADLINE_MS = 2_000
const SYNC_CATCH_UP_POLL_MS = 100

/** One machine's copy state, as the read paths need it. */
type MachineSyncStateRow = {
  instanceId: string
  enabled: boolean
  cursor: number
  lastIngestAt: Date | null
}

/**
 * The `MachineSyncState` delegate, or null when the client has no such model.
 *
 * The copy state is a convenience — "Last synced", the Sync to cloud switch, and
 * how far the push has got — never the machine itself. A Prisma client generated
 * before those tables exist throws on the property access, which is before any
 * `.catch()` attached to the call can see it, so `GET /machines` (the list
 * Studio's switcher polls) turned into a 500 with no machine data at all. Missing
 * means "no copy state", not "the machine list is broken".
 */
function machineSyncState() {
  return (prisma as any).machineSyncState ?? null
}

/** One machine's copy state, or null when it has none (or cannot be read). */
async function readMachineSyncState(instanceId: string): Promise<MachineSyncStateRow | null> {
  const table = machineSyncState()
  if (!table?.findUnique) return null
  try {
    return (await table.findUnique({
      where: { instanceId },
      select: { enabled: true, cursor: true, lastIngestAt: true },
    })) ?? null
  } catch {
    return null
  }
}

/** Copy state for many machines at once, for the Settings → Remote control list. */
async function readMachineSyncStates(instanceIds: string[]): Promise<Map<string, MachineSyncStateRow>> {
  const table = machineSyncState()
  if (!table?.findMany) return new Map()
  try {
    const rows = (await table.findMany({
      where: { instanceId: { in: instanceIds } },
    })) as MachineSyncStateRow[]
    return new Map(rows.map((row) => [row.instanceId, row]))
  } catch {
    return new Map()
  }
}

/**
 * Every refused push is logged, once a minute per machine and code.
 *
 * A desktop retries on a short timer, so a broken copy produced 526 identical
 * 409s in two hours and **not one line** in the cloud logs: the API never logged
 * a non-2xx from `/sync`, and the desktop's own log was a no-op. That silence is
 * why nobody noticed a machine had no copy for four days (SHO-241). Rate-limited
 * rather than sampled, so the *first* refusal of every new code is always there.
 */
const SYNC_REFUSAL_LOG_INTERVAL_MS = 60_000
const lastSyncRefusal = new Map<string, { at: number; code: string }>()

function logSyncRefusal(instanceId: string, status: number, code: string, message: string): void {
  const now = Date.now()
  const previous = lastSyncRefusal.get(instanceId)
  if (previous && previous.code === code && now - previous.at < SYNC_REFUSAL_LOG_INTERVAL_MS) return
  lastSyncRefusal.set(instanceId, { at: now, code })
  console.warn(`[MachineSync] refused ${instanceId} ${status} ${code}: ${message}`)
}

async function awaitSyncCatchUp(instanceId: string, seq: number): Promise<void> {
  if (!Number.isFinite(seq) || seq <= 0) return
  const deadline = Date.now() + SYNC_CATCH_UP_DEADLINE_MS
  for (;;) {
    const state = await readMachineSyncState(instanceId)
    if ((state?.cursor ?? 0) >= seq) return
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, SYNC_CATCH_UP_POLL_MS))
  }
}

type MachineRow = {
  id: string
  userId: string | null
  workspaceId: string
  name: string
  hostname: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  metadata: unknown
}

/** Resolve `:id` to a machine the caller owns, or the response to send. */
async function loadOwnedMachine(
  c: any,
): Promise<{ instance: MachineRow } | { response: Response }> {
  const auth = c.get('auth') as any
  if (!auth?.userId) {
    return {
      response: c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401),
    }
  }
  const instance = (await prisma.instance.findUnique({
    where: { id: c.req.param('id') },
  })) as MachineRow | null
  if (!instance) {
    return {
      response: c.json({ error: { code: 'not_found', message: 'Machine not found' } }, 404),
    }
  }
  if (instance.userId !== auth.userId) {
    return { response: c.json(forbidden(), 403) }
  }
  return { instance }
}

function cachedSnapshot(instance: MachineRow): Record<string, any> | null {
  const meta = instance.metadata as Record<string, any> | null | undefined
  const machine = meta?.machine
  return machine && typeof machine === 'object' ? (machine as Record<string, any>) : null
}

/**
 * A machine's rows, the one that can serve a request first.
 *
 * The representative `id` from `GET /machines` is stable by design (the row that
 * owns the copy, else the oldest), and the desktop opens one tunnel per device
 * key — so the row the client holds is not necessarily the row whose tunnel is
 * up. Trying the others costs a Redis lookup only on the path that was about to
 * answer "offline" anyway (SHO-241).
 */
async function findRelayTarget(instance: MachineRow): Promise<MachineRow | null> {
  if (await ensureTunnelConnected(instance.id, wakeDeadlineMs)) return instance
  const siblings = (await prisma.instance.findMany({
    where: {
      hostname: instance.hostname,
      ...(instance.userId ? { userId: instance.userId } : {}),
      kind: { not: InstanceKind.cli_worker },
    },
  })) as MachineRow[]
  for (const sibling of siblings) {
    if (sibling.id === instance.id) continue
    // A pure check, not `ensureTunnelConnected`: waking every sibling would send
    // a push notification per device key on one request.
    if (hasLocalTunnel(sibling.id) || (await isTunnelConnectedAnywhere(sibling.id, { retry: false }))) {
      return sibling
    }
  }
  return null
}

/**
 * The paired desktop calling one of its own sync routes, by device key. A
 * device key resolves to a principal scoped to the workspace it was issued in;
 * only that machine may push or pull, and only for itself.
 */
async function authenticateDevice(
  c: any,
): Promise<{ auth: { userId: string; workspaceId: string }; instanceId: string; instance: MachineRow } | { response: Response }> {
  let auth = c.get('auth') as any
  // Desktops up to the PERF-9 fix send the key as `x-api-key`, which the auth
  // middleware does not read. Accept it here so those builds sync unchanged.
  if (auth?.via !== 'apiKey') {
    const legacyKey = c.req.header('x-api-key')
    if (legacyKey?.startsWith('shogo_sk_')) {
      const deviceAppVersion = c.req.header('X-Shogo-Device-App-Version')
      const resolved = await resolveApiKey(legacyKey, deviceAppVersion ? { deviceAppVersion } : undefined).catch(() => null)
      if (resolved) {
        auth = { userId: resolved.userId, workspaceId: resolved.workspaceId, isAuthenticated: true, via: 'apiKey' }
      }
    }
  }
  const instanceId = c.req.param('id')
  if (!auth?.userId || !auth?.workspaceId || !auth?.via || auth.via !== 'apiKey') {
    logSyncRefusal(instanceId, 401, 'unauthorized', 'a device key is required')
    return { response: c.json({ error: { code: 'unauthorized', message: 'A device key is required' } }, 401) }
  }
  const instance = (await prisma.instance.findUnique({ where: { id: instanceId } })) as MachineRow | null
  if (!instance || instance.userId !== auth.userId || instance.workspaceId !== auth.workspaceId) {
    logSyncRefusal(instanceId, 403, 'forbidden', 'not this machine')
    return { response: c.json({ error: { code: 'forbidden', message: 'Not this machine' } }, 403) }
  }
  if (isCliWorker(instance.kind)) return { response: c.json(notAMachine(), 409) }
  return { auth, instanceId, instance }
}

export function machineRoutes() {
  const router = new Hono()

  // GET /machines — every machine this user owns, across cloud workspaces.
  // The workspace switcher groups them under "This Mac"; a second member of
  // any of those workspaces sees an empty list.
  //
  // A `shogo worker` VM is not a machine: it serves `/agent/*` and no data API,
  // so it has no workspaces to open (SHO-120). It stays visible in
  // `GET /instances?scope=owner` (Settings → Remote control), where it belongs.
  router.get('/machines', async (c) => {
    const auth = c.get('auth') as any
    if (!auth?.userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const rows = (await prisma.instance.findMany({
      where: { userId: auth.userId, kind: { not: InstanceKind.cli_worker } },
      orderBy: { lastSeenAt: 'desc' },
    })) as MachineRow[]

    // One machine per hostname, not one per workspace it registered in: the
    // desktop opens a tunnel per stored device key, so a machine signed into
    // three workspaces has three rows here.
    const names = await workspaceNamesById(rows.map((row) => row.workspaceId))
    // One read for every machine's copy state, so the Settings → Remote control
    // switch can show "Last synced" without a second round trip, and so the
    // machine's `id` can be the row that owns the copy instead of whichever row
    // happened to heartbeat last (SHO-185, SHO-241).
    const syncByInstance = await readMachineSyncStates(rows.map((row) => row.id))
    const copyOwners = await hostingInstanceIds(rows.map((row) => row.id))
    const grouped = groupMachinesByHostname(rows, {
      nameFor: (id) => names.get(id),
      copyOwners,
    })

    // No viewer marking here: every open Studio tab polls this list, and
    // marking all of the caller's machines from it put every desktop on the
    // 5 s poll for as long as any tab was open (PERF-6). The relay below marks
    // the one machine whose workspace is actually in use.

    const machines = await Promise.all(
      grouped.map(async ({ row, workspaces, rows: machineRows }) => {
        // The copy belongs to one row of the group (the key the desktop pushes
        // under), which is not necessarily the representative one.
        const copyRow = machineRows.find((candidate) => {
          const state = syncByInstance.get(candidate.id)
          return Boolean(state?.lastIngestAt)
        })
        const ownState = syncByInstance.get(row.id)
        const copyState = copyRow ? syncByInstance.get(copyRow.id) : undefined
        const snapshot =
          cachedSnapshot(row) ??
          (machineRows.map((candidate) => cachedSnapshot(candidate)).find(Boolean) ?? null)
        return {
          id: row.id,
          name: row.name,
          hostname: row.hostname,
          os: row.os,
          arch: row.arch,
          kind: row.kind,
          workspaceId: row.workspaceId,
          workspaces,
          /** Every instance row this machine has: one per device key. */
          instanceIds: machineRows.map((candidate) => candidate.id),
          status: await getMachineGroupStatus(machineRows),
          lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
          snapshot,
          syncEnabled: (copyState ?? ownState)?.enabled ?? true,
          lastSyncedAt: copyState?.lastIngestAt?.toISOString() ?? null,
          /**
           * A completed snapshot exists, so reads can come from the copy. Until
           * it does, the client reads this machine's workspace through the relay
           * — which is what makes the workspace usable before (and without) a
           * copy, instead of answering "No access to this workspace" (SHO-241).
           */
          copyReady: Boolean(copyRow),
          /** Why the copy is not moving, as the desktop last reported it. */
          lastSyncError: snapshot?.sync?.lastError ?? null,
          pendingChanges: snapshot?.sync?.pendingChanges ?? null,
        }
      }),
    )

    return c.json({ machines })
  })

  // GET /machines/:id/workspaces — one relay of the desktop's
  // `/api/local/machine`. A sleeping machine gets one wake and a short
  // deadline; after that we serve its cached heartbeat snapshot flagged
  // `stale`, and only 503 when we have never heard from it at all.
  router.get('/machines/:id/workspaces', async (c) => {
    const resolved = await loadOwnedMachine(c)
    if ('response' in resolved) return resolved.response
    const { instance } = resolved
    if (isCliWorker(instance.kind)) return c.json(notAMachine(), 409)

    const forwardHeaders: Record<string, string> = {
      accept: 'application/json',
    }
    const auth = c.get('auth') as any
    forwardHeaders['x-tunnel-auth-user-id'] = auth.userId
    if (auth.email) forwardHeaders['x-tunnel-auth-email'] = auth.email
    if (auth.name) forwardHeaders['x-tunnel-auth-name'] = auth.name

    const online = await ensureTunnelConnected(instance.id, wakeDeadlineMs)
    if (online) {
      try {
        const resp = await sendTunnelRequest(instance.id, {
          type: 'request',
          requestId: generateRequestId(),
          method: 'GET',
          path: '/api/local/machine',
          headers: forwardHeaders,
        })
        if (resp.status === 200 && resp.body) {
          const snapshot = JSON.parse(resp.body) as Record<string, any>
          return c.json({
            machine: {
              name: instance.name,
              hostname: instance.hostname,
              os: instance.os,
              ...(snapshot.machine ?? {}),
              id: instance.id,
              kind: instance.kind,
            },
            workspaces: snapshot.workspaces ?? [],
            activity: snapshot.activity ?? null,
            status: 'online',
            stale: false,
            lastSeenAt: instance.lastSeenAt ? instance.lastSeenAt.toISOString() : null,
          })
        }
        if (resp.status === 403) {
          return c.json(
            { error: { code: 'forbidden', message: 'Machine rejected the request' } },
            403,
          )
        }
      } catch (err: any) {
        console.warn(`[Machines] snapshot relay failed for ${instance.id}: ${err?.message ?? err}`)
      }
    }

    const cached = cachedSnapshot(instance)
    if (cached) {
      return c.json({
        machine: {
          name: instance.name,
          hostname: instance.hostname,
          os: instance.os,
          ...(cached.machine ?? {}),
          id: instance.id,
          kind: instance.kind,
        },
        workspaces: cached.workspaces ?? [],
        activity: cached.activity ?? null,
        status: await getMachineLiveStatus(instance.id, instance.lastSeenAt),
        stale: true,
        lastSeenAt: instance.lastSeenAt ? instance.lastSeenAt.toISOString() : null,
      })
    }

    return c.json(offline(), 503)
  })

  // ─── The machine copy (SHO-185) ─────────────────────────────────────────
  //
  // POST /machines/:id/sync — the desktop pushes its rows here over HTTPS, with
  // its device key. Deliberately *not* through the tunnel: bulk data must never
  // queue behind a live request or a relay PUBLISH. The rows land in the normal
  // cloud tables with the desktop's ids and the workspace tagged with
  // `hostInstanceId` (SHO-285), so every route reads and writes it normally.
  router.post('/machines/:id/sync', async (c) => {
    const device = await authenticateDevice(c)
    if ('response' in device) return device.response
    const { auth, instanceId } = device

    // Sync off is answered as a normal ack with `disabled: true`: the desktop
    // stops pushing, and nothing it was about to send recreates the copy the
    // switch deleted (SHO-185).
    const syncState = await prisma.machineSyncState.findUnique({
      where: { instanceId },
      select: { enabled: true, cursor: true },
    })
    if (syncState && syncState.enabled === false) {
      return c.json({ ok: true, disabled: true, cursor: syncState.cursor ?? 0, applied: 0, skipped: 0 })
    }

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_request', message: 'A JSON body is required' } }, 400)
    }

    try {
      const pageBytes = Math.max(0, Number(c.req.header('content-length') ?? 0) || 0)
      const startedApply = Date.now()
      // Rows that came from the desktop are not fed back to it.
      const result = await withoutHostChangeLog(() =>
        applyBatch(
          {
            prisma,
            instanceId,
            ownerUserId: auth.userId,
            homeRegion: RAW_REGION_ID ?? PRIMARY_REGION,
          },
          body,
        ),
      )
      // A page's size and the time it took to apply are the two numbers that
      // explain a copy that never finishes (SHO-276): a 21 MB page against a
      // 125 s proxy window reads as a plain timeout in the logs otherwise.
      if (!('code' in result)) {
        const models = Array.isArray(body.models) ? body.models.length : 0
        console.log(
          `[MachineSync] ${instanceId}: applied ${result.applied} row(s) from ${models} model(s) in ${
            Date.now() - startedApply
          } ms (${(pageBytes / 1_048_576).toFixed(1)} MB${body.mode === 'snapshot' ? ', snapshot' : ''})`,
        )
      }
      if ('code' in result) {
        // `epoch_mismatch` is a normal step in a desktop's life (its database
        // was recreated, or it has never completed a snapshot): 409 tells it to
        // send a snapshot, not that it broke.
        const detail = 'detail' in result ? result.detail : undefined
        logSyncRefusal(instanceId, 409, result.code, result.message)
        return c.json({ error: { code: result.code, message: result.message, ...(detail ?? {}) } }, 409)
      }
      // A batch can tag a new machine workspace; background workers on this pod
      // must skip it from the next tick, not after the id cache expires.
      if (!result.disabled && result.newWorkspaces) {
        invalidateHostedWorkspaceIds()
      }
      return c.json(result)
    } catch (err: any) {
      const failure = ownershipFailure(err)
      if (failure) {
        logSyncRefusal(instanceId, 409, failure.code, failure.message)
        return c.json({ error: { code: failure.code, message: failure.message } }, 409)
      }
      logSyncRefusal(instanceId, 500, 'ingest_failed', err?.message ?? 'sync failed')
      console.warn(`[Machines] sync ingest failed for ${instanceId}: ${err?.message ?? err}`)
      return c.json({ error: { code: 'ingest_failed', message: err?.message ?? 'sync failed' } }, 500)
    }
  })

  // GET /machines/:id/identity — who the desktop's user is (SHO-285). Pairing
  // makes the desktop's single local user this cloud account: the desktop
  // rewrites its local user id to this one before its first push, so both
  // databases name the same person by the same id and nothing translates ids.
  router.get('/machines/:id/identity', async (c) => {
    const device = await authenticateDevice(c)
    if ('response' in device) return device.response
    const user = await prisma.user.findUnique({
      where: { id: device.auth.userId },
      select: { id: true, name: true, email: true, image: true },
    })
    if (!user) return c.json({ error: { code: 'not_found', message: 'Account not found' } }, 404)
    return c.json({ user, instanceId: device.instanceId })
  })

  // GET /machines/:id/changes?cursor=N — the cloud → desktop half of a hosted
  // workspace's sync (SHO-285): what the cloud wrote to the workspaces this
  // machine hosts since `cursor`, rows in their current state. The desktop
  // applies them last-writer-wins and asks again with the returned cursor.
  router.get('/machines/:id/changes', async (c) => {
    const device = await authenticateDevice(c)
    if ('response' in device) return device.response
    const cursor = Math.max(0, Number(c.req.query('cursor') ?? 0) || 0)
    const limit = Number(c.req.query('limit') ?? 0) || undefined
    try {
      const page = await readHostFeed(prisma, {
        instanceId: device.instanceId,
        ownerUserId: device.auth.userId,
        cursor,
        limit,
      })
      if (Math.random() < 0.01) void pruneHostFeed(prisma).catch(() => {})
      return c.json(page)
    } catch (err: any) {
      console.warn(`[Machines] change feed failed for ${device.instanceId}: ${err?.message ?? err}`)
      return c.json({ error: { code: 'feed_failed', message: err?.message ?? 'feed failed' } }, 500)
    }
  })

  // PATCH /machines/:id/sync-settings — the per-machine "Sync to cloud" switch.
  // Turning it off deletes the copy: the workspace falls back to live relay
  // reads, and nothing of the machine stays behind in the cloud.
  router.patch('/machines/:id/sync-settings', async (c) => {
    const resolved = await loadOwnedMachine(c)
    if ('response' in resolved) return resolved.response
    const { instance } = resolved
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
    if (!body || typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'invalid_request', message: 'enabled (boolean) is required' } }, 400)
    }

    if (body.enabled) {
      const state = await prisma.machineSyncState.upsert({
        where: { instanceId: instance.id },
        create: { instanceId: instance.id, enabled: true },
        // A copy that was deleted has no epoch to continue: clearing it makes
        // the desktop send a fresh snapshot rather than deltas for rows the
        // cloud no longer owns.
        update: { enabled: true, cursor: 0, epoch: '' },
      })
      return c.json({ ok: true, enabled: true, lastSyncedAt: state.lastIngestAt?.toISOString() ?? null })
    }

    // Off: stop accepting pushes, and hand the machine's workspaces back to
    // cloud compute. Nothing is deleted — a hosted workspace is a real
    // workspace, and what either side wrote to it is the person's (SHO-285).
    await prisma.machineSyncState.upsert({
      where: { instanceId: instance.id },
      create: { instanceId: instance.id, enabled: false },
      update: { enabled: false },
    })
    const removed = await releaseHostedWorkspaces(prisma, instance.id)
    invalidateHostedWorkspaceIds()
    console.log(`[Machines] Sync off for ${instance.id}: released ${removed.workspaces} hosted workspace(s)`)
    return c.json({ ok: true, enabled: false, released: removed })
  })

  return router
}

export const _testing = {
  DEFAULT_WAKE_DEADLINE_MS,
  setWakeDeadlineMs(ms: number) {
    wakeDeadlineMs = ms
  },
  resetWakeDeadlineMs() {
    wakeDeadlineMs = DEFAULT_WAKE_DEADLINE_MS
  },
}
