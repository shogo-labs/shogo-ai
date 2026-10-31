// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Moving a workspace between desktop and cloud, in either direction.
 *
 * Three groups of endpoints, mounted at `/api/workspace-moves` on **both**
 * composers (cloud `server.ts` and the desktop's `create-local-app.ts`), because
 * a route that exists on one surface only is exactly the divergence the channel
 * rules forbid:
 *
 *   /            the driver's own endpoints (plan, start, status, control,
 *                switch over / back) — the desktop calls these
 *   /serve/*     the reading side, called by the other side of the link
 *   /receive/*   the writing side, called by the other side of the link
 *
 * Auth is the ordinary one: a session cookie or `Authorization: Bearer
 * shogo_sk_*`. The middleware resolves both, so the same call works from the
 * desktop and from a browser.
 */

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { decide, denialResponse, loadAccess, principalOf } from '../lib/authz'
import { pinWorkspaceToHomeRegion } from '../lib/chat-region-pin'
import { prisma, InstanceKind } from '../lib/prisma'
import {
  createMove,
  endpointsFor,
  kickMove,
  planMove,
  setMoveStatus,
  switchBackMove,
  switchOverMove,
} from '../services/workspace-move'
import { buildHandover } from '../services/workspace-move/handover'
import {
  flushTargetProject,
  initTargetWorkspace,
  receiveFile,
  relinkTargetProject,
  setEnabledAtTarget,
  targetFileManifest,
  writeMoveRecordChunk,
} from '../services/workspace-move/receive'
import {
  markSourceMoved,
  readSourceFile,
  setEnabledAtSource,
  sourceFileManifest,
  streamSourceRecords,
} from '../services/workspace-move/serve'
import { collectMoveRows, normaliseSelection } from '../services/workspace-move/plan'
import { shouldMoveModel } from '../services/workspace-move/records'
import { requireMoveProject } from '../services/workspace-move/scope'
import { WorkspaceMoveError } from '../services/workspace-move/types'
import type { HandoverKind } from '../services/workspace-move/handover'
import type { MoveDirection } from '../services/workspace-move/types'

function errorResponse(c: any, status: number, code: string, message: string, extra: object = {}) {
  return c.json({ error: { code, message, ...extra } }, status as any)
}

function failure(c: any, err: unknown) {
  if (err instanceof WorkspaceMoveError) {
    return errorResponse(c, err.status, err.code, err.message)
  }
  // Anything else is a bug on this side: log it where an operator can see it and
  // tell the caller only that it failed. Echoing `err.message` leaked absolute
  // paths, SQL and driver text to whoever could reach the route (SEC-18).
  console.error('[workspace-move] unhandled failure:', err)
  return errorResponse(c, 500, 'workspace_move_failed', 'The move failed on this side. Check the server logs.')
}

/**
 * Answer a move request in the workspace's home region.
 *
 * A move reads a project's files from the runtime pod that holds them and hands
 * them to the store that pod reads (S3), so it has to be answered where the
 * workspace lives — the same pin export uses (`routes/workspace-export.ts`).
 * These routes take `workspaceId` from the body or query rather than the path,
 * so the middleware form does not apply.
 *
 * `body` is the JSON the route already parsed to find that id: a consumed
 * request stream cannot be re-sent to the peer, so it is forwarded explicitly.
 */
async function pinMoveToHomeRegion(c: any, workspaceId: string, body?: unknown) {
  if (!workspaceId) return null
  return pinWorkspaceToHomeRegion(
    c,
    workspaceId,
    body === undefined ? {} : { proxyBody: JSON.stringify(body) },
  )
}

export function workspaceMoveRoutes(): Hono {
  const app = new Hono()

  const authorize = async (c: any, workspaceId: string) => {
    if (!workspaceId) return { ok: false as const, response: errorResponse(c, 400, 'workspace_required', 'A workspace id is required.') }
    const principal = principalOf(c)
    const access = await loadAccess(principal, { workspaceId })
    const decision = await decide(access, 'workspace:move', principal, `${c.req.method} ${c.req.path}`)
    if (!decision.ok) return { ok: false as const, response: denialResponse(c, decision) }
    return { ok: true as const, access: decision.access, principal }
  }

  // ─── Driver ─────────────────────────────────────────────────────────

  /** The picker's list: channels and projects, without walking any files. */
  app.get('/options', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? ''
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const [conversations, projects, desktops] = await Promise.all([
      prisma.conversation.findMany({
        where: { workspaceId },
        select: { id: true, name: true, kind: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.project.findMany({
        where: { workspaceId },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Cloud -> desktop needs a desktop to drive it: the cloud cannot reach a
      // laptop. Same rows Settings -> My Machines lists (SHO-185), so the two
      // screens cannot disagree about whether a machine is linked. Deliberately
      // *not* the live status: that reads Redis (`tunnel-redis`), which the
      // desktop bundle must not contain — this route is mounted there too.
      prisma.instance.findMany({
        where: { userId: String(auth.principal.userId ?? ''), kind: InstanceKind.desktop },
        select: { id: true, name: true, lastSeenAt: true },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ])
    const desktop = desktops.length
      ? { linked: true, name: desktops[0]!.name, lastSeenAt: desktops[0]!.lastSeenAt?.toISOString() ?? null }
      : { linked: false, name: null, lastSeenAt: null }
    return c.json({ conversations, projects, desktop })
  })

  app.post('/plan', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const pinned = await pinMoveToHomeRegion(c, workspaceId, body)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    try {
      const plan = await planMove({
        workspaceId,
        requesterId: String(auth.principal.userId ?? ''),
        isOwner: auth.access.workspaceRole === 'owner',
        direction: (body.direction ?? 'desktop_to_cloud') as MoveDirection,
        selection: body.selection,
        targetKind: body.targetKind === 'desktop' ? 'desktop' : 'cloud',
        targetName: typeof body.targetName === 'string' ? body.targetName : undefined,
      })
      return c.json({ plan })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const pinned = await pinMoveToHomeRegion(c, workspaceId, body)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    try {
      const { move, plan } = await createMove({
        workspaceId,
        requesterId: String(auth.principal.userId ?? ''),
        isOwner: auth.access.workspaceRole === 'owner',
        direction: (body.direction ?? 'desktop_to_cloud') as MoveDirection,
        selection: body.selection,
        targetName: typeof body.targetName === 'string' ? body.targetName : undefined,
        targetKind: body.targetKind === 'desktop' ? 'desktop' : 'cloud',
      })
      return c.json({ move: publicMove(move), plan }, 201)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? ''
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const moves = await prisma.workspaceMove.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
    return c.json({ moves: moves.map(publicMove) })
  })

  app.get('/:moveId', async (c) => {
    const move = await prisma.workspaceMove.findUnique({ where: { id: c.req.param('moveId') } })
    if (!move) return errorResponse(c, 404, 'workspace_move_not_found', 'Move not found')
    // A resume, a switch or a status read of a stalled move can start the
    // runner, which reads and writes files: answer it where the workspace lives.
    const pinned = await pinMoveToHomeRegion(c, move.workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, move.workspaceId)
    if (!auth.ok) return auth.response
    // A row that says "records" with no job in this process is a move whose
    // desktop was restarted mid-way: pick it back up from its cursor.
    if ((move.status === 'records' || move.status === 'files' || move.status === 'planning') && !move.error) {
      void kickMove(move.id)
    }
    return c.json({ move: publicMove(move) })
  })

  for (const [action, status] of [
    ['pause', 'paused'],
    ['cancel', 'cancelled'],
  ] as const) {
    app.post(`/:moveId/${action}`, async (c) => {
      const move = await prisma.workspaceMove.findUnique({ where: { id: c.req.param('moveId') } })
      if (!move) return errorResponse(c, 404, 'workspace_move_not_found', 'Move not found')
      const auth = await authorize(c, move.workspaceId)
      if (!auth.ok) return auth.response
      if (move.status === 'done') {
        return errorResponse(c, 409, 'workspace_move_finished', 'This move already finished.')
      }
      await setMoveStatus(move.id, status)
      return c.json({ ok: true, status })
    })
  }

  app.post('/:moveId/resume', async (c) => {
    const move = await prisma.workspaceMove.findUnique({ where: { id: c.req.param('moveId') } })
    if (!move) return errorResponse(c, 404, 'workspace_move_not_found', 'Move not found')
    // A resume, a switch or a status read of a stalled move can start the
    // runner, which reads and writes files: answer it where the workspace lives.
    const pinned = await pinMoveToHomeRegion(c, move.workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, move.workspaceId)
    if (!auth.ok) return auth.response
    if (move.status !== 'paused' && move.status !== 'failed') {
      return errorResponse(c, 409, 'workspace_move_not_paused', 'Only a paused or failed move can be resumed.')
    }
    await setMoveStatus(move.id, 'records')
    void kickMove(move.id)
    return c.json({ ok: true, status: 'records' })
  })

  app.post('/:moveId/switch-over', async (c) => {
    const move = await prisma.workspaceMove.findUnique({ where: { id: c.req.param('moveId') } })
    if (!move) return errorResponse(c, 404, 'workspace_move_not_found', 'Move not found')
    // A resume, a switch or a status read of a stalled move can start the
    // runner, which reads and writes files: answer it where the workspace lives.
    const pinned = await pinMoveToHomeRegion(c, move.workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, move.workspaceId)
    if (!auth.ok) return auth.response
    try {
      await switchOverMove(move.id)
      return c.json({ ok: true })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/:moveId/switch-back', async (c) => {
    const move = await prisma.workspaceMove.findUnique({ where: { id: c.req.param('moveId') } })
    if (!move) return errorResponse(c, 404, 'workspace_move_not_found', 'Move not found')
    // A resume, a switch or a status read of a stalled move can start the
    // runner, which reads and writes files: answer it where the workspace lives.
    const pinned = await pinMoveToHomeRegion(c, move.workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, move.workspaceId)
    if (!auth.ok) return auth.response
    try {
      await switchBackMove(move.id)
      return c.json({ ok: true })
    } catch (err) {
      return failure(c, err)
    }
  })

  // ─── Serve (the reading side) ───────────────────────────────────────

  app.post('/serve/plan', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    try {
      const selection = normaliseSelection(body.selection)
      const result = await collectMoveRows({
        workspaceId,
        requesterId: String(auth.principal.userId ?? ''),
        isOwner: auth.access.workspaceRole === 'owner',
        selection,
      })
      const rows: Record<string, unknown[]> = {}
      for (const [model, list] of result.rows) if (shouldMoveModel(model)) rows[model] = list
      return c.json({ rows })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/serve/records', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const selection = normaliseSelection(body.selection)
    const moveId = String(body.moveId ?? '')
    const targetWorkspaceId = String(body.targetWorkspaceId ?? '')
    if (!moveId || !targetWorkspaceId) {
      return errorResponse(c, 400, 'workspace_move_bad_request', 'moveId and targetWorkspaceId are required.')
    }
    c.header('content-type', 'application/x-ndjson')
    c.header('cache-control', 'no-store')
    return stream(c, async (out) => {
      const iterator = streamSourceRecords(
        prisma,
        {
          workspaceId,
          requesterId: String(auth.principal.userId ?? ''),
          isOwner: auth.access.workspaceRole === 'owner',
          selection,
          moveId,
          targetWorkspaceId,
        },
        { model: body.fromModel ?? undefined, cursor: Number(body.cursor ?? 0) || 0 },
      )
      for await (const chunk of iterator) {
        await out.write(`${JSON.stringify(chunk)}\n`)
      }
    })
  })

  app.post('/serve/files/manifest', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const pinned = await pinMoveToHomeRegion(c, workspaceId, body)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    try {
      const projectId = String(body.projectId ?? '')
      await requireMoveProject(prisma, workspaceId, projectId)
      const manifest = await sourceFileManifest(prisma, { workspaceId, projectId })
      return c.json(manifest)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/serve/files/raw', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? ''
    const pinned = await pinMoveToHomeRegion(c, workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const projectId = c.req.query('projectId') ?? ''
    const relPath = c.req.query('path') ?? ''
    try {
      await requireMoveProject(prisma, workspaceId, projectId)
      const bytes = await readSourceFile(prisma, { workspaceId, projectId, path: relPath })
      return new Response(bytes as any, {
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
      })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/serve/enabled', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    await setEnabledAtSource(prisma, {
      workspaceId,
      kind: String(body.kind) as HandoverKind,
      ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
      enabled: body.enabled === true,
    })
    return c.json({ ok: true })
  })

  app.post('/serve/moved', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    await markSourceMoved(prisma, workspaceId, body.targetWorkspaceId ? String(body.targetWorkspaceId) : null)
    return c.json({ ok: true })
  })

  // ─── Receive (the writing side) ─────────────────────────────────────

  app.post('/receive/init', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const sourceWorkspaceId = String(body.sourceWorkspaceId ?? '')
    // This instance has never seen `sourceWorkspaceId` — creating its copy is
    // the whole point of the call. Authorising `workspace:move` against that id
    // therefore always failed (`loadAccess` finds no membership), so every push
    // died with a 403 before the target workspace existed. The caller is
    // authenticated by its own credential; the workspace it creates is owned by
    // it, and the later `/receive/*` calls are authorised against that target.
    //
    // Being signed in is not enough to create a workspace, though: the create
    // itself is gated by the same one-free-per-kind rule as
    // `POST /api/workspaces` inside `initTargetWorkspace` (SHO-256).
    const principal = principalOf(c)
    const ownerUserId = String(principal?.userId ?? '')
    if (!ownerUserId) return errorResponse(c, 401, 'unauthorized', 'Authentication required')
    try {
      const created = await initTargetWorkspace(prisma, {
        name: String(body.name ?? 'Moved workspace'),
        sourceWorkspaceId,
        ownerUserId,
      })
      return c.json(created, 201)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/receive/records', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const model = String(body.model ?? '')
    const rows = Array.isArray(body.rows) ? body.rows : []
    try {
      const result = await writeMoveRecordChunk(prisma, { workspaceId, model, rows })
      return c.json(result)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/receive/files/manifest', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const pinned = await pinMoveToHomeRegion(c, workspaceId, body)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const projectId = String(body.projectId ?? '')
    try {
      await requireMoveProject(prisma, workspaceId, projectId)
      const manifest = await targetFileManifest(projectId, workspaceId)
      return c.json({ ...manifest, projectId })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.put('/receive/files/raw', async (c) => {
    const workspaceId = c.req.query('workspaceId') ?? ''
    const pinned = await pinMoveToHomeRegion(c, workspaceId)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const projectId = c.req.query('projectId') ?? ''
    const relPath = c.req.query('path') ?? ''
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    try {
      await requireMoveProject(prisma, workspaceId, projectId)
      await receiveFile(projectId, workspaceId, relPath, bytes)
      return c.json({ ok: true, bytes: bytes.byteLength })
    } catch (err) {
      return failure(c, err)
    }
  })

  // Files landed on this instance's disk; this hands them to the store the
  // runtime actually reads (S3). A failure is a failed move, never a `done`
  // with files the pod cannot see.
  app.post('/receive/files/flush', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const pinned = await pinMoveToHomeRegion(c, workspaceId, body)
    if (pinned) return pinned
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    const projectId = String(body.projectId ?? '')
    try {
      const result = await flushTargetProject(projectId, workspaceId)
      return c.json({ ok: true, notices: result.notices })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/receive/enabled', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    await setEnabledAtTarget(prisma, {
      workspaceId,
      kind: String(body.kind) as HandoverKind,
      ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
      enabled: body.enabled === true,
    })
    return c.json({ ok: true })
  })

  app.post('/receive/relink', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const workspaceId = String(body.workspaceId ?? '')
    const auth = await authorize(c, workspaceId)
    if (!auth.ok) return auth.response
    try {
      const projectId = String(body.projectId ?? '')
      await requireMoveProject(prisma, workspaceId, projectId)
      const result = await relinkTargetProject(prisma, {
        workspaceId,
        projectId,
        name: String(body.name ?? 'Project'),
        remote: String(body.remote ?? ''),
        branch: String(body.branch ?? 'main'),
      })
      return c.json(result)
    } catch (err) {
      return failure(c, err)
    }
  })

  return app
}

/** BigInt/Date safe shape for the UI; the plan stays as it was stored. */
function publicMove(move: any) {
  return {
    id: move.id,
    direction: move.direction,
    status: move.status,
    workspaceId: move.workspaceId,
    sourceWorkspaceId: move.sourceWorkspaceId,
    sourceName: move.sourceName,
    targetWorkspaceId: move.targetWorkspaceId ?? null,
    targetName: move.targetName ?? null,
    selection: move.selection,
    plan: move.plan ?? null,
    progress: move.progress ?? null,
    handover: move.handover ?? null,
    rowsCopied: move.rowsCopied ?? 0,
    filesCopied: move.filesCopied ?? 0,
    bytesCopied: Number(move.bytesCopied ?? 0),
    error: move.error ?? null,
    switchedOverAt: move.switchedOverAt ?? null,
    createdAt: move.createdAt,
    updatedAt: move.updatedAt,
  }
}

/** Exported for the plan route's tests: the endpoints a move would use. */
export { endpointsFor, buildHandover }
