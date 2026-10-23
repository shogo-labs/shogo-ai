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
  isRecentlySeenViaHeartbeat,
  isStreamingRequest,
  markViewerActive,
  normalizeTransparentProxyPath,
  sendTunnelRequest,
  sendTunnelStreamRequest,
} from './instances'
import { isMachineTimeoutError } from '../lib/tunnel-errors'
import { classifyAction, logRemoteAction } from './remote-audit'
import { groupMachinesByHostname, workspaceNamesById } from '../lib/machine-list'
import { applyBatch, deleteMachineCopy, ownershipFailure } from '../lib/machine-sync/ingest'
import { PRIMARY_REGION, RAW_REGION_ID } from '../lib/region'

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
    const grouped = groupMachinesByHostname(rows, { nameFor: (id) => names.get(id) })

    // The workspace switcher polls this list, so it is the one place we know
    // Studio has a machine in view. Marking the viewer active makes that
    // desktop's heartbeat run at 5 s (POLL_INTERVAL_VIEWER_S) instead of 60 s,
    // so a sleeping machine is reachable in seconds (SHO-185).
    await Promise.all(
      rows
        .filter((row) => row.lastSeenAt)
        .map((row) => markViewerActive(row.workspaceId).catch(() => {})),
    )

    // One read for every machine's copy state, so the Settings → Remote control
    // switch can show "Last synced" without a second round trip (SHO-185).
    const syncByInstance = await readMachineSyncStates(rows.map((row) => row.id))

    const machines = await Promise.all(
      grouped.map(async ({ row, workspaces, rows: machineRows }) => ({
        id: row.id,
        name: row.name,
        hostname: row.hostname,
        os: row.os,
        arch: row.arch,
        kind: row.kind,
        workspaceId: row.workspaceId,
        workspaces,
        status: await getMachineGroupStatus(machineRows),
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        snapshot: cachedSnapshot(row),
        syncEnabled: syncByInstance.get(row.id)?.enabled ?? true,
        lastSyncedAt: syncByInstance.get(row.id)?.lastIngestAt?.toISOString() ?? null,
      })),
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

  // ALL /machines/:id/w/:localWorkspaceId/* — relay into that desktop's own
  // `/api/*`, scoped to one of its workspaces. Identity is translated
  // cloud → local by stamping `x-tunnel-auth-*`, and every call is written to
  // the remote audit trail with the local workspace id so the machine's owner
  // can see what was driven from the cloud.
  router.all('/machines/:id/w/:localWorkspaceId/:rest{.+}', async (c) => {
    const resolved = await loadOwnedMachine(c)
    if ('response' in resolved) return resolved.response
    const { instance } = resolved
    if (isCliWorker(instance.kind)) return c.json(notAMachine(), 409)
    const auth = c.get('auth') as any

    const localWorkspaceId = c.req.param('localWorkspaceId')
    const rest = c.req.param('rest') || ''
    const search = new URL(c.req.url).search
    // `rest` is the client's full path behind the relay prefix
    // (`/api/projects`, `/api/workspaces/<ws>/agent-proxy/agent/chat`), so the
    // tunnel path is `/<rest>` — never `/api/<rest>`, which double-prefixed
    // every machine call as `/api/api/...` (SHO-120). Same join as
    // `/instances/:id/p/*`.
    const path = rest ? `/${rest}${search}` : `/api${search}`
    const method = c.req.method

    if (!(await ensureTunnelConnected(instance.id, wakeDeadlineMs))) {
      // Recently heartbeated means "not connected right now, but alive": say so
      // and let the client retry instead of claiming the machine is offline.
      if (isRecentlySeenViaHeartbeat(instance.lastSeenAt)) {
        c.header('Retry-After', '3')
        return c.json(waking(instance), 503)
      }
      // Offline for real. A write has nowhere to land — the rows are on the
      // desktop — so the workspace is read-only, with no queue behind it
      // (SHO-185). A live read (preview, agent stream) just says offline.
      if (MUTATING_METHODS.has(method)) {
        // `lastSyncedAt` is what the read-only banner shows, so this read has to
        // answer even when the copy state is unavailable — the machine being
        // offline is the fact the client needs, not the timestamp's absence.
        const state = await readMachineSyncState(instance.id)
        return c.json(offlineReadOnly(instance, state?.lastIngestAt?.toISOString() ?? null), 409)
      }
      return c.json(offline(), 503)
    }

    const forwardHeaders: Record<string, string> = {
      'x-tunnel-auth-user-id': auth.userId,
    }
    if (auth.email) forwardHeaders['x-tunnel-auth-email'] = auth.email
    if (auth.name) forwardHeaders['x-tunnel-auth-name'] = auth.name
    const contentType = c.req.header('content-type')
    if (contentType) forwardHeaders['content-type'] = contentType
    const accept = c.req.header('accept')
    if (accept) forwardHeaders['accept'] = accept
    const chatSessionId = c.req.header('x-chat-session-id')
    if (chatSessionId) forwardHeaders['x-chat-session-id'] = chatSessionId

    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
    const body = hasBody ? await c.req.text() : undefined
    const auditPath = `${localWorkspaceId}:${path}`

    const streaming = isStreamingRequest(method, normalizeTransparentProxyPath(path.split('?')[0] || path))
    if (streaming) {
      void logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action: classifyAction(method, path),
        path: auditPath,
        method,
        summary: 'streaming',
      })

      const requestId = generateRequestId()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const { cancel } = sendTunnelStreamRequest(
            instance.id,
            { type: 'request', requestId, method, path, headers: forwardHeaders, body },
            (chunk) => {
              if (chunk.type === 'stream-chunk' && chunk.data) {
                controller.enqueue(new TextEncoder().encode(chunk.data))
              } else if (chunk.type === 'stream-end') {
                try { controller.close() } catch { /* already closed */ }
              } else if (chunk.type === 'stream-error') {
                controller.error(new Error(chunk.error || 'Stream error'))
              }
            },
          )
          const signal = c.req.raw.signal
          signal?.addEventListener(
            'abort',
            () => {
              cancel()
              try { controller.close() } catch { /* already closed */ }
            },
            { once: true },
          )
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    try {
      const resp = await sendTunnelRequest(instance.id, {
        type: 'request',
        requestId: generateRequestId(),
        method,
        path,
        headers: forwardHeaders,
        body,
      })

      void logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action: classifyAction(method, path),
        path: auditPath,
        method,
        result: `HTTP ${resp.status}`,
      })

      const responseHeaders: Record<string, string> = {}
      for (const [key, value] of Object.entries(resp.headers ?? {})) {
        if (!value) continue
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        responseHeaders[lower] = value
      }
      if (!responseHeaders['content-type']) responseHeaders['content-type'] = 'application/json'

      // Read-your-writes: the desktop stamps the change-log position it reached
      // with this write, so wait for the copy to catch up before answering.
      const syncSeq = Number(resp.headers?.['x-shogo-sync-seq'] ?? 0)
      if (syncSeq > 0) await awaitSyncCatchUp(instance.id, syncSeq).catch(() => {})

      // A cold runtime on the desktop is a "retry in a moment", not an error:
      // the desktop starts it in the background and answers RUNTIME_STARTING.
      if (resp.status === 502 && resp.body && resp.body.includes('RUNTIME_STARTING')) {
        c.header('Retry-After', '3')
        return c.json({ error: { code: 'runtime_starting', message: 'Starting the machine runtime', retryAfterSeconds: 3 } }, 503)
      }

      return new Response(resp.body || '', {
        status: resp.status,
        headers: responseHeaders,
      })
    } catch (err: any) {
      void logRemoteAction({
        instanceId: instance.id,
        userId: auth.userId,
        action: classifyAction(method, path),
        path: auditPath,
        method,
        result: `error: ${err?.message ?? err}`,
      })
      // A machine that answered our probe but not the request is slow, not
      // offline: say which, and keep its tunnel ownership intact (SHO-185).
      if (isMachineTimeoutError(err)) {
        return c.json(machineTimeout(instance, err), 504)
      }
      // A dead tunnel is an offline machine, not a bad gateway: the client's
      // "connected to <machine>" banner keys off this code.
      if (isRecentlySeenViaHeartbeat(instance.lastSeenAt)) {
        c.header('Retry-After', '3')
        return c.json(waking(instance), 503)
      }
      return c.json(offline(), 503)
    }
  })

  // ─── The machine copy (SHO-185) ─────────────────────────────────────────
  //
  // POST /machines/:id/sync — the desktop pushes its rows here over HTTPS, with
  // its device key. Deliberately *not* through the tunnel: bulk data must never
  // queue behind a live request or a relay PUBLISH. The rows land in the normal
  // cloud tables with the desktop's ids and the workspace tagged with
  // `machineInstanceId`, so every read panel is served by the normal routes.
  router.post('/machines/:id/sync', async (c) => {
    const auth = c.get('auth') as any
    // A device key resolves to a principal scoped to the workspace its key was
    // issued in. Only that machine may push, and only for itself.
    const instanceId = c.req.param('id')
    if (!auth?.userId || !auth?.workspaceId || !auth?.via || auth.via !== 'apiKey') {
      return c.json({ error: { code: 'unauthorized', message: 'A device key is required' } }, 401)
    }
    const instance = (await prisma.instance.findUnique({ where: { id: instanceId } })) as MachineRow | null
    if (!instance || instance.userId !== auth.userId || instance.workspaceId !== auth.workspaceId) {
      return c.json({ error: { code: 'forbidden', message: 'Not this machine' } }, 403)
    }
    if (isCliWorker(instance.kind)) return c.json(notAMachine(), 409)

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
      const result = await applyBatch(
        {
          prisma,
          instanceId,
          ownerUserId: auth.userId,
          homeRegion: RAW_REGION_ID ?? PRIMARY_REGION,
        },
        body,
      )
      if ('code' in result) {
        // `epoch_mismatch` is a normal step in a desktop's life (its database
        // was recreated): 409 tells it to send a snapshot, not that it broke.
        const detail = 'detail' in result ? result.detail : undefined
        return c.json({ error: { code: result.code, message: result.message, ...(detail ?? {}) } }, 409)
      }
      return c.json(result)
    } catch (err: any) {
      const failure = ownershipFailure(err)
      if (failure) {
        return c.json({ error: { code: failure.code, message: failure.message } }, 409)
      }
      console.warn(`[Machines] sync ingest failed for ${instanceId}: ${err?.message ?? err}`)
      return c.json({ error: { code: 'ingest_failed', message: err?.message ?? 'sync failed' } }, 500)
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

    // Off: stop accepting pushes first, so a batch in flight cannot recreate
    // rows under the copy we are about to delete.
    await prisma.machineSyncState.upsert({
      where: { instanceId: instance.id },
      create: { instanceId: instance.id, enabled: false },
      update: { enabled: false },
    })
    const removed = await deleteMachineCopy(prisma, instance.id)
    console.log(
      `[Machines] Sync off for ${instance.id}: deleted ${removed.rows} row(s) across ${removed.workspaces} workspace(s)`,
    )
    return c.json({ ok: true, enabled: false, deleted: removed })
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
