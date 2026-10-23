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
  isStreamingRequest,
  normalizeTransparentProxyPath,
  sendTunnelRequest,
  sendTunnelStreamRequest,
} from './instances'
import { classifyAction, logRemoteAction } from './remote-audit'
import { groupMachinesByHostname, workspaceNamesById } from '../lib/machine-list'

/** How long a cold machine gets to open its tunnel before we call it offline. */
const DEFAULT_WAKE_DEADLINE_MS = 10_000
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
      // A dead tunnel is an offline machine, not a bad gateway: the client's
      // "connected to <machine>" banner keys off this code.
      return c.json(offline(), 503)
    }
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
