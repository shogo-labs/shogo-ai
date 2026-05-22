// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * chat-message-edits routes tests.
 *
 * Covers both:
 *
 *   POST /api/chat-messages/:id/truncate-from
 *     - 401 unauthenticated
 *     - 404 when the message id is unknown
 *     - 403 when the caller is not a workspace member
 *     - 200 happy path (deletes target + same-session tail, bumps
 *       updatedAt, returns count, atomic via $transaction)
 *     - tunnel-authenticated callers skip the membership check
 *
 *   GET /api/chat-messages/:id/preceding-checkpoint
 *     - 401 / 404 / 403 same auth gates as truncate-from
 *     - `reason: 'no_project_context'` for feature-scoped sessions
 *     - `reason: 'external_mode'` for folder-linked projects
 *     - `reason: 'no_checkpoint'` when no prior checkpoint exists
 *     - 200 with the latest pre-cutoff checkpoint + projectId
 *
 * Run: bun test apps/api/src/routes/__tests__/chat-message-edits.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Prisma mock ──────────────────────────────────────────────────────────
type CheckpointFixture = {
  id: string
  projectId: string
  createdAt: Date
  commitMessage: string
  filesChanged: number
  additions: number
  deletions: number
  isAutomatic: boolean
  includesDb: boolean
  name: string | null
}

type SessionFixture = {
  sessionId: string
  contextType: 'project' | 'feature' | 'general'
  projectId: string | null
  workingMode: string | null
  workspaceMembers: string[]
}

type MessageFixture = {
  id: string
  sessionId: string
  createdAt: Date
}

const messagesById = new Map<string, MessageFixture>()
const sessionsById = new Map<string, SessionFixture>()
const checkpointsByProject = new Map<string, CheckpointFixture[]>()
const sessionUpdatedAt = new Map<string, Date>()
const deleteManyCalls: Array<{ where: any }> = []

// Build the nested shape `findUnique` returns for either route.
// `findUnique` is called with the same `include` block (session ->
// project -> workspace.members) in both — keeping the shaper
// centralized means a schema-shape drift only needs one fix.
function shapeFindUniqueResult(msg: MessageFixture) {
  const session = sessionsById.get(msg.sessionId)
  if (!session) return null
  // For non-project sessions (`contextType === 'feature'`), the
  // generated relation `session.project` returns null but the row
  // itself still exists — mirror that nullable shape so the route
  // exercises its `no_project_context` branch.
  const project =
    session.contextType === 'project' && session.projectId
      ? {
          id: session.projectId,
          workingMode: session.workingMode ?? undefined,
          workspace: {
            members: session.workspaceMembers.map((userId) => ({ userId })),
          },
        }
      : null
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    createdAt: msg.createdAt,
    session: {
      // contextType is on the row for preceding-checkpoint's
      // no_project_context branch; truncate-from doesn't read it.
      contextType: session.contextType,
      project,
    },
  }
}

const mockPrisma = {
  chatMessage: {
    findUnique: mock(async (args: any) => {
      const fixture = messagesById.get(args.where?.id)
      if (!fixture) return null
      return shapeFindUniqueResult(fixture)
    }),
    deleteMany: mock(async (args: any) => {
      deleteManyCalls.push({ where: args.where })
      const sessionId = args.where?.sessionId
      const gte = args.where?.createdAt?.gte as Date | undefined
      if (!sessionId || !gte) return { count: 0 }
      let count = 0
      for (const [id, msg] of messagesById) {
        if (msg.sessionId === sessionId && msg.createdAt.getTime() >= gte.getTime()) {
          messagesById.delete(id)
          count++
        }
      }
      return { count }
    }),
  },
  chatSession: {
    update: mock(async (args: any) => {
      sessionUpdatedAt.set(args.where.id, args.data.updatedAt)
      return { id: args.where.id, updatedAt: args.data.updatedAt }
    }),
  },
  projectCheckpoint: {
    findFirst: mock(async (args: any) => {
      const projectId = args.where?.projectId as string | undefined
      const lt = args.where?.createdAt?.lt as Date | undefined
      if (!projectId || !lt) return null
      const candidates = (checkpointsByProject.get(projectId) ?? []).filter(
        (cp) => cp.createdAt.getTime() < lt.getTime(),
      )
      candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const top = candidates[0]
      if (!top) return null
      // Mirror the `select` projection from the route so callers
      // can't accidentally rely on fields we deliberately omit
      // (commitSha, branch, createdBy, projectId).
      return {
        id: top.id,
        name: top.name,
        commitMessage: top.commitMessage,
        filesChanged: top.filesChanged,
        additions: top.additions,
        deletions: top.deletions,
        isAutomatic: top.isAutomatic,
        includesDb: top.includesDb,
        createdAt: top.createdAt,
      }
    }),
  },
  $transaction: mock(async (fn: any) => {
    // The route passes a callback; we just hand it the same mock
    // proxy so the deleteMany / chatSession.update calls land on
    // the same instrumented mocks above.
    return await fn(mockPrisma)
  }),
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

const { createChatMessageEditRoutes } = await import('../chat-message-edits')

// ─── Helpers ──────────────────────────────────────────────────────────────
type AuthContext = {
  isAuthenticated?: boolean
  userId?: string
  tunnelAuthenticated?: boolean
}

function createApp(auth: AuthContext | null) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth)
    await next()
  })
  app.route('/api/chat-messages', createChatMessageEditRoutes())
  return app
}

function seedSession(opts: {
  sessionId: string
  ownerUserId: string
  rows: Array<{ id: string; createdAtMs: number }>
  /**
   * Optional. Defaults to a "project" scoped session linked to a
   * deterministic projectId (`proj-${sessionId}`) in normal mode.
   * Override to test feature-scoped or external-mode branches.
   */
  contextType?: 'project' | 'feature' | 'general'
  projectId?: string | null
  workingMode?: string | null
}) {
  const contextType = opts.contextType ?? 'project'
  const projectId =
    opts.projectId === undefined
      ? contextType === 'project'
        ? `proj-${opts.sessionId}`
        : null
      : opts.projectId
  sessionsById.set(opts.sessionId, {
    sessionId: opts.sessionId,
    contextType,
    projectId,
    workingMode: opts.workingMode ?? null,
    workspaceMembers: [opts.ownerUserId],
  })
  for (const row of opts.rows) {
    messagesById.set(row.id, {
      id: row.id,
      sessionId: opts.sessionId,
      createdAt: new Date(row.createdAtMs),
    })
  }
}

function seedCheckpoint(opts: {
  projectId: string
  id: string
  createdAtMs: number
  commitMessage?: string
  filesChanged?: number
  includesDb?: boolean
}) {
  const list = checkpointsByProject.get(opts.projectId) ?? []
  list.push({
    id: opts.id,
    projectId: opts.projectId,
    createdAt: new Date(opts.createdAtMs),
    commitMessage: opts.commitMessage ?? 'AI: write_file (1 tool calls)',
    filesChanged: opts.filesChanged ?? 1,
    additions: 5,
    deletions: 0,
    isAutomatic: true,
    includesDb: opts.includesDb ?? false,
    name: null,
  })
  checkpointsByProject.set(opts.projectId, list)
}

beforeEach(() => {
  messagesById.clear()
  sessionsById.clear()
  checkpointsByProject.clear()
  sessionUpdatedAt.clear()
  deleteManyCalls.length = 0
  mockPrisma.chatMessage.findUnique.mockClear()
  mockPrisma.chatMessage.deleteMany.mockClear()
  mockPrisma.chatSession.update.mockClear()
  mockPrisma.projectCheckpoint.findFirst.mockClear()
  mockPrisma.$transaction.mockClear()
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/chat-messages/:id/truncate-from — auth gate', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-messages/msg-1/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  test('401 when isAuthenticated is false', async () => {
    const app = createApp({ isAuthenticated: false, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-1/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  test('404 when message id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/ghost/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'owner-user',
      rows: [{ id: 'msg-1', createdAtMs: 1000 }],
    })
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-messages/msg-1/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect(messagesById.has('msg-1')).toBe(true)
  })
})

describe('POST /api/chat-messages/:id/truncate-from — happy path', () => {
  test('deletes target + all later same-session rows, bumps session updatedAt, returns count', async () => {
    // Five rows across two sessions. Truncating from msg-c should
    // delete msg-c, msg-d, msg-e (the same-session tail) and leave
    // msg-a, msg-b in place — plus the other-session row untouched.
    seedSession({
      sessionId: 's1',
      ownerUserId: 'u1',
      rows: [
        { id: 'msg-a', createdAtMs: 1000 },
        { id: 'msg-b', createdAtMs: 2000 },
        { id: 'msg-c', createdAtMs: 3000 }, // cutoff
        { id: 'msg-d', createdAtMs: 4000 },
        { id: 'msg-e', createdAtMs: 5000 },
      ],
    })
    seedSession({
      sessionId: 's2',
      ownerUserId: 'u1',
      rows: [{ id: 'other-session', createdAtMs: 3500 }],
    })

    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/msg-c/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      sessionId: string
      deletedCount: number
    }
    expect(body.ok).toBe(true)
    expect(body.sessionId).toBe('s1')
    expect(body.deletedCount).toBe(3)

    // The cutoff row + later same-session rows are gone…
    expect(messagesById.has('msg-c')).toBe(false)
    expect(messagesById.has('msg-d')).toBe(false)
    expect(messagesById.has('msg-e')).toBe(false)
    // …earlier rows in the same session are preserved…
    expect(messagesById.has('msg-a')).toBe(true)
    expect(messagesById.has('msg-b')).toBe(true)
    // …and the sibling session is completely untouched.
    expect(messagesById.has('other-session')).toBe(true)

    // The transaction wrapper was used (atomicity contract).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // Session updatedAt was bumped so chat lists re-order correctly.
    expect(sessionUpdatedAt.has('s1')).toBe(true)
    expect(sessionUpdatedAt.has('s2')).toBe(false)

    // The deleteMany clause scopes by sessionId + createdAt >= cutoff.
    // This is the crucial isolation guarantee — without sessionId the
    // millisecond-collision edge case could leak across sessions.
    expect(deleteManyCalls).toHaveLength(1)
    expect(deleteManyCalls[0]!.where.sessionId).toBe('s1')
    expect(deleteManyCalls[0]!.where.createdAt.gte).toEqual(new Date(3000))
  })

  test('deletedCount is 0 when the row is the only one in its session', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'u1',
      rows: [{ id: 'lone', createdAtMs: 1000 }],
    })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/lone/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deletedCount: number }
    // The lone row is itself part of the cutoff bucket, so still 1
    // gets deleted (the target itself). The endpoint name is
    // "truncate-from" (inclusive) deliberately.
    expect(body.deletedCount).toBe(1)
    expect(messagesById.has('lone')).toBe(false)
  })

  test('tunnel-authenticated callers skip the membership check', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'someone-else',
      rows: [{ id: 'msg-x', createdAtMs: 1000 }],
    })
    const app = createApp({
      isAuthenticated: true,
      // userId belongs to a NON-member, but tunnel auth bypasses the
      // member check. This mirrors the existing chat-message hooks
      // (chat-message.hooks.ts beforeList / beforeGet).
      userId: 'bridge-proxy',
      tunnelAuthenticated: true,
    })
    const res = await app.request('/api/chat-messages/msg-x/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(messagesById.has('msg-x')).toBe(false)
  })
})

// =============================================================================
// GET /api/chat-messages/:id/preceding-checkpoint
// =============================================================================

describe('GET /api/chat-messages/:id/preceding-checkpoint — auth gate', () => {
  test('401 when unauthenticated', async () => {
    const app = createApp(null)
    const res = await app.request('/api/chat-messages/msg-1/preceding-checkpoint')
    expect(res.status).toBe(401)
  })

  test('404 when message id is unknown', async () => {
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/ghost/preceding-checkpoint')
    expect(res.status).toBe(404)
  })

  test('403 when caller is not a workspace member', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'owner-user',
      rows: [{ id: 'msg-1', createdAtMs: 1000 }],
    })
    const app = createApp({ isAuthenticated: true, userId: 'intruder' })
    const res = await app.request('/api/chat-messages/msg-1/preceding-checkpoint')
    expect(res.status).toBe(403)
  })
})

describe('GET /api/chat-messages/:id/preceding-checkpoint — soft-fail branches', () => {
  test('returns reason=no_project_context for feature-scoped sessions', async () => {
    // Feature-scoped chat sessions exist (see ContextType enum). The
    // route must NOT 500 trying to look up checkpoints — it should
    // hand back a soft-fail so the dialog can render the "file
    // revert isn't available for this conversation" hint.
    seedSession({
      sessionId: 's-feature',
      ownerUserId: 'u1',
      contextType: 'feature',
      projectId: null,
      rows: [{ id: 'msg-feature', createdAtMs: 5000 }],
    })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request(
      '/api/chat-messages/msg-feature/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      checkpoint: null | unknown
      reason?: string
    }
    expect(body.ok).toBe(true)
    expect(body.checkpoint).toBeNull()
    expect(body.reason).toBe('no_project_context')
    // findFirst must NOT have been called — bailing early saves a
    // useless DB round-trip per cancelled edit.
    expect(mockPrisma.projectCheckpoint.findFirst).not.toHaveBeenCalled()
  })

  test('returns reason=external_mode for folder-linked projects', async () => {
    seedSession({
      sessionId: 's-ext',
      ownerUserId: 'u1',
      workingMode: 'external',
      rows: [{ id: 'msg-ext', createdAtMs: 5000 }],
    })
    seedCheckpoint({
      projectId: 'proj-s-ext',
      id: 'cp-ext',
      createdAtMs: 1000,
    })
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request(
      '/api/chat-messages/msg-ext/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checkpoint: unknown; reason?: string }
    expect(body.checkpoint).toBeNull()
    expect(body.reason).toBe('external_mode')
    // Same bail-early guarantee as the no_project_context branch —
    // external-mode projects never have managed checkpoints, so the
    // findFirst call would be pointless.
    expect(mockPrisma.projectCheckpoint.findFirst).not.toHaveBeenCalled()
  })

  test('returns reason=no_checkpoint when nothing precedes the cutoff', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'u1',
      rows: [{ id: 'msg-1', createdAtMs: 1000 }],
    })
    // No checkpoints seeded at all for proj-s1.
    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request(
      '/api/chat-messages/msg-1/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checkpoint: unknown; reason?: string }
    expect(body.checkpoint).toBeNull()
    expect(body.reason).toBe('no_checkpoint')
  })

  test('returns reason=no_checkpoint when all checkpoints are AT or AFTER the cutoff', async () => {
    // Defensive: `findFirst` filters strictly less-than, so a
    // checkpoint with the same timestamp as the message must NOT be
    // returned (would otherwise undo the very work this message
    // triggered).
    seedSession({
      sessionId: 's1',
      ownerUserId: 'u1',
      rows: [{ id: 'msg-1', createdAtMs: 5000 }],
    })
    seedCheckpoint({ projectId: 'proj-s1', id: 'cp-equal', createdAtMs: 5000 })
    seedCheckpoint({ projectId: 'proj-s1', id: 'cp-after', createdAtMs: 9000 })

    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request(
      '/api/chat-messages/msg-1/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checkpoint: unknown; reason?: string }
    expect(body.checkpoint).toBeNull()
    expect(body.reason).toBe('no_checkpoint')
  })
})

describe('GET /api/chat-messages/:id/preceding-checkpoint — happy path', () => {
  test('returns the latest checkpoint strictly before the message + the projectId', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'u1',
      rows: [{ id: 'msg-target', createdAtMs: 5000 }],
    })
    // Three checkpoints — only cp-2 (createdAt 4000) should win:
    //   cp-1 createdAt 1000  (older — losing candidate)
    //   cp-2 createdAt 4000  (latest before cutoff — should win)
    //   cp-3 createdAt 5500  (after cutoff — must be ignored)
    seedCheckpoint({
      projectId: 'proj-s1',
      id: 'cp-1',
      createdAtMs: 1000,
      commitMessage: 'old',
    })
    seedCheckpoint({
      projectId: 'proj-s1',
      id: 'cp-2',
      createdAtMs: 4000,
      commitMessage: 'AI: edit_file (2 tool calls)',
      filesChanged: 3,
      includesDb: false,
    })
    seedCheckpoint({
      projectId: 'proj-s1',
      id: 'cp-3',
      createdAtMs: 5500,
      commitMessage: 'too new',
    })

    const app = createApp({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request(
      '/api/chat-messages/msg-target/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      checkpoint: {
        id: string
        commitMessage: string
        filesChanged: number
        createdAt: string
      } | null
      projectId?: string
      reason?: string
    }
    expect(body.ok).toBe(true)
    expect(body.projectId).toBe('proj-s1')
    expect(body.checkpoint).not.toBeNull()
    expect(body.checkpoint!.id).toBe('cp-2')
    expect(body.checkpoint!.commitMessage).toBe('AI: edit_file (2 tool calls)')
    expect(body.checkpoint!.filesChanged).toBe(3)
    expect(body.reason).toBeUndefined()

    // Sanity: findFirst was called with a strictly-less-than filter.
    // This is what protects users from accidentally undoing the work
    // their current message triggered.
    expect(mockPrisma.projectCheckpoint.findFirst).toHaveBeenCalledTimes(1)
    const args = mockPrisma.projectCheckpoint.findFirst.mock.calls[0]![0] as any
    expect(args.where.projectId).toBe('proj-s1')
    expect(args.where.createdAt.lt).toEqual(new Date(5000))
    expect(args.orderBy).toEqual({ createdAt: 'desc' })

    // The route deliberately omits `commitSha` from the projection
    // so the client can't bypass the rollback service. Verify the
    // payload doesn't leak it.
    expect((body.checkpoint as Record<string, unknown>).commitSha).toBeUndefined()
  })

  test('tunnel-authenticated callers skip the membership check and still get the checkpoint', async () => {
    seedSession({
      sessionId: 's1',
      ownerUserId: 'someone-else',
      rows: [{ id: 'msg-x', createdAtMs: 5000 }],
    })
    seedCheckpoint({ projectId: 'proj-s1', id: 'cp-1', createdAtMs: 1000 })
    const app = createApp({
      isAuthenticated: true,
      userId: 'bridge-proxy',
      tunnelAuthenticated: true,
    })
    const res = await app.request(
      '/api/chat-messages/msg-x/preceding-checkpoint',
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checkpoint: { id: string } | null }
    expect(body.checkpoint?.id).toBe('cp-1')
  })
})

// =============================================================================
// Defensive empty-id 400 branches
//
// Hono's router doesn't match empty path segments, so the `if (!id)` guard
// in both handlers can't be reached through normal routing. The defensive
// behaviour matters anyway because the route was written assuming any caller
// could land on the handler (defense in depth — same shape as the auth
// gate). We reach it by stubbing `c.req.param('id')` to '' via a one-off
// middleware that wraps the request before the router sees it.
// =============================================================================

function createAppWithEmptyId(auth: AuthContext | null) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth)
    const orig = c.req.param.bind(c.req)
    ;(c.req as any).param = ((name?: string) => {
      if (name === 'id') return ''
      return orig(name as any)
    })
    await next()
  })
  app.route('/api/chat-messages', createChatMessageEditRoutes())
  return app
}

describe('defensive empty-id 400 branches', () => {
  test('POST /:id/truncate-from returns 400 bad_request when param id is empty', async () => {
    const app = createAppWithEmptyId({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/X/truncate-from', {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toMatch(/Message id is required/i)
  })

  test('GET /:id/preceding-checkpoint returns 400 bad_request when param id is empty', async () => {
    const app = createAppWithEmptyId({ isAuthenticated: true, userId: 'u1' })
    const res = await app.request('/api/chat-messages/X/preceding-checkpoint')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toMatch(/Message id is required/i)
  })
})
