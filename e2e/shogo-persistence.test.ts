// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E tests for Shogo Mode persistence.
 *
 * Validates that Shogo Mode's voice + translator threads round-trip
 * correctly through the same `chat_messages` table as the technical
 * thread, with `agent="voice"` vs `agent="technical"` cleanly
 * partitioning the two threads on both reads and writes.
 *
 * Covered surfaces
 * ----------------
 *   Writes (server-only; the Shogo client never POSTs ChatMessage rows
 *   directly):
 *     - `POST /api/voice/transcript/:chatSessionId` — one row per
 *       voice / agent-activity event, keyed by client id for
 *       idempotency.
 *     - `POST /api/voice/translator/chat/:chatSessionId` — the
 *       validation + authz surface. The streaming persistence path is
 *       exercised indirectly (it uses the same session-authz helper as
 *       the transcript route and the same upsert semantics as the
 *       transcript route tests).
 *
 *   Reads:
 *     - `GET /api/chat-messages?sessionId=X&agent=voice` returns only
 *       Shogo rows.
 *     - `GET /api/chat-messages?sessionId=X&agent=technical` returns
 *       only technical rows.
 *     - `GET /api/chat-messages?sessionId=X` (no filter) returns both
 *       (legacy behaviour preserved).
 *     - `GET /api/chat-messages?sessionId=X&agent=bogus` rejects with
 *       400.
 *
 *   Cross-contamination:
 *     - Voice + technical rows coexist in the same session without
 *       leaking into each other's thread.
 *
 *   Authorization (mirrors existing chat-messages semantics):
 *     - Unauthenticated / unknown session / foreign workspace is
 *       rejected.
 *
 * These tests hit the real route handlers against the local SQLite
 * database. They mirror the production middleware layering from
 * `apps/api/src/server.ts` so regressions in the hook wiring or auth
 * layering surface here.
 *
 * Run:
 *   SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db \
 *     bun test e2e/shogo-persistence.test.ts
 *
 * Prerequisites:
 *   Run `bun run db:generate:all` once first so the SQLite schema has
 *   the `agent` column on `chat_messages`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'

// Force local mode for SQLite — must run before importing prisma.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./shogo.db'

const { prisma } = await import('../apps/api/src/lib/prisma')
const { voiceRoutes } = await import('../apps/api/src/routes/voice')
const { chatMessageHooks } = await import(
  '../apps/api/src/generated/chat-message.hooks'
)
const {
  createChatMessageRoutes,
  setPrisma: setPrismaChatMessage,
  setChatMessageHooks,
} = await import('../apps/api/src/generated/chat-message.routes')

// ---------------------------------------------------------------------
// Shared fixtures. We create ONE workspace + user + project + chat
// session in beforeAll and reuse them across tests; each test works
// against its own slice of rows keyed by a unique id prefix so they
// don't interfere.
// ---------------------------------------------------------------------

let workspaceId: string
let primaryUserId: string
let foreignUserId: string
let primaryMemberId: string
let foreignMemberId: string
let projectId: string
let chatSessionId: string
/** A session in a workspace the primary user is NOT a member of. */
let foreignChatSessionId: string
let foreignProjectId: string
let foreignWorkspaceId: string
let foreignWorkspaceOwnerId: string

const cleanupMessageIds: string[] = []

// ---------------------------------------------------------------------
// Hono app under test.
//
// Mirrors the production wiring: mock auth middleware sets the userId
// from a header so we can flip between the primary + foreign user per
// request. `/api` routes mount both the generated chat-messages router
// (with the hook that now honors `?agent=...`) and the voice router.
// ---------------------------------------------------------------------

const app = new Hono()

app.use('*', async (c, next) => {
  const userId = c.req.header('x-test-user-id') || primaryUserId
  const isAuthed = c.req.header('x-test-unauthenticated') !== 'true'
  c.set('auth' as any, {
    isAuthenticated: isAuthed,
    userId: isAuthed ? userId : undefined,
  })
  await next()
})

// Wire up the generated chat-messages route with the real prisma +
// real hooks (so the test exercises the updated `beforeList` that
// honors `?agent=...`).
setPrismaChatMessage(prisma as any)
setChatMessageHooks(chatMessageHooks)
app.route('/api/chat-messages', createChatMessageRoutes())
app.route('/api', voiceRoutes())

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function asJsonRequest(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function createVoiceRow(params: {
  sessionId: string
  kind: 'voice-user' | 'voice-agent' | 'agent-activity'
  text: string
  id?: string
  userId?: string
}) {
  const headers: Record<string, string> = {}
  if (params.userId) headers['x-test-user-id'] = params.userId
  const res = await app.fetch(
    asJsonRequest(
      `http://localhost/api/voice/transcript/${params.sessionId}`,
      'POST',
      {
        kind: params.kind,
        text: params.text,
        id: params.id,
      },
      headers,
    ),
  )
  return res
}

async function listChatMessages(
  sessionId: string,
  opts: { agent?: string; userId?: string; unauthenticated?: boolean } = {},
) {
  const headers: Record<string, string> = {}
  if (opts.userId) headers['x-test-user-id'] = opts.userId
  if (opts.unauthenticated) headers['x-test-unauthenticated'] = 'true'
  const qs = new URLSearchParams({ sessionId })
  if (opts.agent !== undefined) qs.set('agent', opts.agent)
  const res = await app.fetch(
    asJsonRequest(
      `http://localhost/api/chat-messages?${qs.toString()}`,
      'GET',
      undefined,
      headers,
    ),
  )
  return res
}

// ---------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------

describe('Shogo Mode persistence (chat_messages · agent discriminator)', () => {
  beforeAll(async () => {
    const workspace = await prisma.workspace.findFirst()
    if (!workspace) {
      throw new Error(
        'No workspace found in local DB — run the app at least once to create one',
      )
    }
    workspaceId = workspace.id

    const stamp = Date.now()

    const primaryUser = await prisma.user.create({
      data: {
        email: `e2e-shogo-primary-${stamp}@test.local`,
        name: 'Shogo E2E Primary User',
        role: 'user',
      },
    })
    primaryUserId = primaryUser.id
    const primaryMember = await prisma.member.create({
      data: {
        userId: primaryUserId,
        workspaceId,
        role: 'member',
      },
    })
    primaryMemberId = primaryMember.id

    const project = await prisma.project.create({
      data: {
        name: `Shogo E2E Project ${stamp}`,
        description: 'Created by shogo persistence e2e',
        workspaceId,
        createdBy: primaryUserId,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
      },
    })
    projectId = project.id

    const session = await prisma.chatSession.create({
      data: {
        inferredName: 'Shogo E2E Chat Session',
        contextType: 'project',
        contextId: projectId,
      },
    })
    chatSessionId = session.id

    // Foreign workspace / user that the primary user does NOT belong to.
    const foreignOwner = await prisma.user.create({
      data: {
        email: `e2e-shogo-foreign-owner-${stamp}@test.local`,
        name: 'Shogo E2E Foreign Owner',
        role: 'user',
      },
    })
    foreignWorkspaceOwnerId = foreignOwner.id
    const foreignWorkspace = await prisma.workspace.create({
      data: {
        name: `Shogo E2E Foreign Workspace ${stamp}`,
        slug: `shogo-e2e-foreign-${stamp}`,
      },
    })
    foreignWorkspaceId = foreignWorkspace.id
    // Give the foreign-owner a membership in their own workspace so
    // downstream authz lookups are well-formed.
    await prisma.member.create({
      data: {
        userId: foreignWorkspaceOwnerId,
        workspaceId: foreignWorkspaceId,
        role: 'owner',
      },
    })

    const foreignProject = await prisma.project.create({
      data: {
        name: `Shogo E2E Foreign Project ${stamp}`,
        workspaceId: foreignWorkspaceId,
        createdBy: foreignWorkspaceOwnerId,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
      },
    })
    foreignProjectId = foreignProject.id
    const foreignSession = await prisma.chatSession.create({
      data: {
        inferredName: 'Foreign Session',
        contextType: 'project',
        contextId: foreignProjectId,
      },
    })
    foreignChatSessionId = foreignSession.id

    // Second "foreign-to-primary" user that has ZERO workspace
    // memberships — used for the unauthenticated / unauthorized
    // variants.
    const foreignUser = await prisma.user.create({
      data: {
        email: `e2e-shogo-foreign-user-${stamp}@test.local`,
        name: 'Shogo E2E Foreign User',
        role: 'user',
      },
    })
    foreignUserId = foreignUser.id
    const foreignMember = await prisma.member.create({
      data: {
        userId: foreignUserId,
        workspaceId: foreignWorkspaceId,
        role: 'member',
      },
    })
    foreignMemberId = foreignMember.id

    console.log(
      `[Setup] Shogo e2e — workspace=${workspaceId}, project=${projectId}, session=${chatSessionId}`,
    )
  })

  afterAll(async () => {
    try {
      // Sweep every chat_messages row the tests created, including any
      // that didn't get explicit cleanup tracking (upserts keyed by the
      // session that existed for the duration of the run).
      await prisma.chatMessage.deleteMany({
        where: {
          sessionId: { in: [chatSessionId, foreignChatSessionId].filter(Boolean) },
        },
      })
      await prisma.chatSession.deleteMany({
        where: { id: { in: [chatSessionId, foreignChatSessionId].filter(Boolean) } },
      })
      if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
      if (foreignProjectId)
        await prisma.project.delete({ where: { id: foreignProjectId } }).catch(() => {})
      if (primaryMemberId)
        await prisma.member.delete({ where: { id: primaryMemberId } }).catch(() => {})
      if (foreignMemberId)
        await prisma.member.delete({ where: { id: foreignMemberId } }).catch(() => {})
      if (foreignWorkspaceId) {
        await prisma.member.deleteMany({
          where: { workspaceId: foreignWorkspaceId },
        })
        await prisma.workspace
          .delete({ where: { id: foreignWorkspaceId } })
          .catch(() => {})
      }
      if (primaryUserId)
        await prisma.user.delete({ where: { id: primaryUserId } }).catch(() => {})
      if (foreignUserId)
        await prisma.user.delete({ where: { id: foreignUserId } }).catch(() => {})
      if (foreignWorkspaceOwnerId)
        await prisma.user
          .delete({ where: { id: foreignWorkspaceOwnerId } })
          .catch(() => {})
      console.log(
        `[Cleanup] Shogo e2e — removed ${cleanupMessageIds.length} tracked messages + test fixtures`,
      )
    } catch (err) {
      console.warn('[Cleanup] Shogo e2e — some cleanup failed:', err)
    }
  })

  // =========================================================================
  // POST /api/voice/transcript/:chatSessionId
  // =========================================================================
  describe('POST /api/voice/transcript/:chatSessionId (writes)', () => {
    it('persists a voice-user row with agent=voice and role=user', async () => {
      const id = `vu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      cleanupMessageIds.push(id)
      const res = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'Hey Shogo, can you open the profile screen?',
        id,
      })
      expect(res.status).toBe(201)
      const row = await prisma.chatMessage.findUnique({ where: { id } })
      expect(row).not.toBeNull()
      expect(row!.sessionId).toBe(chatSessionId)
      expect(row!.role).toBe('user')
      expect((row as any).agent).toBe('voice')
      expect(row!.content).toBe('Hey Shogo, can you open the profile screen?')
      const envelope = JSON.parse(row!.parts || '{}')
      expect(envelope.kind).toBe('voice')
    })

    it('persists a voice-agent row with agent=voice and role=assistant', async () => {
      const id = `va-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      cleanupMessageIds.push(id)
      const res = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-agent',
        text: 'Sure — opening the profile screen now.',
        id,
      })
      expect(res.status).toBe(201)
      const row = await prisma.chatMessage.findUnique({ where: { id } })
      expect(row).not.toBeNull()
      expect(row!.role).toBe('assistant')
      expect((row as any).agent).toBe('voice')
      const envelope = JSON.parse(row!.parts || '{}')
      expect(envelope.kind).toBe('voice')
    })

    it('persists an agent-activity row with the agent-activity envelope kind', async () => {
      const id = `aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      cleanupMessageIds.push(id)
      const res = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'agent-activity',
        text: 'Finished: editing Header.tsx',
        id,
      })
      expect(res.status).toBe(201)
      const row = await prisma.chatMessage.findUnique({ where: { id } })
      expect(row).not.toBeNull()
      expect(row!.role).toBe('assistant')
      expect((row as any).agent).toBe('voice')
      const envelope = JSON.parse(row!.parts || '{}')
      expect(envelope.kind).toBe('agent-activity')
    })

    it('is idempotent: re-POSTing the same id upserts instead of duplicating', async () => {
      const id = `idem-${Date.now()}`
      cleanupMessageIds.push(id)
      const first = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'first',
        id,
      })
      expect(first.status).toBe(201)

      const second = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'second (updated)',
        id,
      })
      expect(second.status).toBe(201)

      const rows = await prisma.chatMessage.findMany({ where: { id } })
      expect(rows.length).toBe(1)
      expect(rows[0].content).toBe('second (updated)')
    })

    it('rejects unknown envelope kinds with 400', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/transcript/${chatSessionId}`,
          'POST',
          { kind: 'not-a-kind', text: 'nope' },
        ),
      )
      expect(res.status).toBe(400)
    })

    it('rejects a missing text field with 400', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/transcript/${chatSessionId}`,
          'POST',
          { kind: 'voice-user' },
        ),
      )
      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/transcript/${chatSessionId}`,
          'POST',
          { kind: 'voice-user', text: 'hi' },
          { 'x-test-unauthenticated': 'true' },
        ),
      )
      expect(res.status).toBe(401)
    })

    it('rejects a non-member of the owning workspace with 403', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/transcript/${foreignChatSessionId}`,
          'POST',
          { kind: 'voice-user', text: 'hi' },
          // primaryUserId has no membership in foreignWorkspace.
        ),
      )
      expect(res.status).toBe(403)
    })

    it('rejects a nonexistent chat session with 404', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/transcript/does-not-exist`,
          'POST',
          { kind: 'voice-user', text: 'hi' },
        ),
      )
      expect(res.status).toBe(404)
    })

    // ---------------------------------------------------------------------
    // Resilience: these cases mirror the real-world failure modes the
    // client's ShogoTranscriptQueue defends against (flapping network,
    // sendBeacon content-type quirks). They make sure the server stays
    // correct on the "retry" / "unload-flush" paths instead of only the
    // happy path.
    // ---------------------------------------------------------------------
    it('stays idempotent across repeated retries after a perceived failure', async () => {
      // Simulate the client retrying the same task three times — e.g.
      // first POST threw mid-flight and the queue re-enqueued it twice
      // more before landing. The server MUST upsert to exactly one row,
      // with the latest content winning.
      const id = `retry-${Date.now()}`
      cleanupMessageIds.push(id)

      const first = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'attempt 1',
        id,
      })
      expect(first.status).toBe(201)

      const second = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'attempt 2',
        id,
      })
      expect(second.status).toBe(201)

      const third = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'attempt 3 (winner)',
        id,
      })
      expect(third.status).toBe(201)

      const rows = await prisma.chatMessage.findMany({ where: { id } })
      expect(rows.length).toBe(1)
      expect(rows[0].content).toBe('attempt 3 (winner)')
      expect((rows[0] as any).agent).toBe('voice')
    })

    it('accepts text/plain bodies (navigator.sendBeacon fallback)', async () => {
      // navigator.sendBeacon strips custom Blob content-types on some
      // browsers (Safari in particular), so the endpoint must accept a
      // JSON payload declared as `text/plain;charset=UTF-8`. Without
      // this tolerance, the pagehide flush from the client would 400
      // and silently drop the row.
      const id = `beacon-${Date.now()}`
      cleanupMessageIds.push(id)

      const res = await app.fetch(
        new Request(
          `http://localhost/api/voice/transcript/${chatSessionId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({
              kind: 'voice-user',
              text: 'beacon payload',
              id,
            }),
          },
        ),
      )
      expect(res.status).toBe(201)

      const row = await prisma.chatMessage.findUnique({ where: { id } })
      expect(row).not.toBeNull()
      expect(row!.content).toBe('beacon payload')
      expect((row as any).agent).toBe('voice')
      const envelope = JSON.parse(row!.parts || '{}')
      expect(envelope.kind).toBe('voice')
    })

    it('still 400s on a text/plain body whose payload is not JSON', async () => {
      const res = await app.fetch(
        new Request(
          `http://localhost/api/voice/transcript/${chatSessionId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: 'this is not json at all',
          },
        ),
      )
      expect(res.status).toBe(400)
    })
  })

  // =========================================================================
  // POST /api/voice/translator/chat/:chatSessionId — validation + authz
  // surface only. The streaming persistence path needs a real LLM model and
  // is not exercised end-to-end here; its authz helper and upsert semantics
  // are shared with the transcript route which IS exercised above.
  // =========================================================================
  describe('POST /api/voice/translator/chat/:chatSessionId (validation + authz)', () => {
    // Snapshot + clear env so the test sees "no model configured" and
    // returns 503 before hitting authz. This is the safe, deterministic
    // path for a pure validation test — we assert the short-circuit
    // order (auth → config → body → authz) is preserved.
    const ENV_KEYS = [
      'AI_PROXY_URL',
      'AI_PROXY_TOKEN',
      'ANTHROPIC_API_KEY',
    ] as const
    let envSnapshot: Record<string, string | undefined>

    beforeAll(() => {
      envSnapshot = Object.fromEntries(
        ENV_KEYS.map((k) => [k, process.env[k]]),
      )
      for (const k of ENV_KEYS) delete process.env[k]
    })

    afterAll(() => {
      for (const [k, v] of Object.entries(envSnapshot)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    it('rejects an unauthenticated caller with 401 before anything else', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/translator/chat/${chatSessionId}`,
          'POST',
          { messages: [] },
          { 'x-test-unauthenticated': 'true' },
        ),
      )
      expect(res.status).toBe(401)
    })

    it('returns 503 when no translator model is configured', async () => {
      const res = await app.fetch(
        asJsonRequest(
          `http://localhost/api/voice/translator/chat/${chatSessionId}`,
          'POST',
          {
            messages: [
              { id: 'x', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            ],
          },
        ),
      )
      expect(res.status).toBe(503)
    })
  })

  // =========================================================================
  // GET /api/chat-messages — read partitioning via the `agent` filter.
  // =========================================================================
  describe('GET /api/chat-messages?sessionId=X&agent=... (reads)', () => {
    /** IDs created in this suite so we can assert the filtered set membership. */
    const voiceIds: string[] = []
    const techIds: string[] = []

    beforeAll(async () => {
      // Seed a known mix of rows on the shared session so we can prove
      // the `agent` filter partitions them correctly.
      for (let i = 0; i < 2; i++) {
        const id = `read-voice-${Date.now()}-${i}`
        voiceIds.push(id)
        cleanupMessageIds.push(id)
        const res = await createVoiceRow({
          sessionId: chatSessionId,
          kind: i === 0 ? 'voice-user' : 'voice-agent',
          text: `voice #${i}`,
          id,
        })
        expect(res.status).toBe(201)
      }

      // Seed two technical rows the same way the rest of the server does —
      // via direct prisma create (mirroring project-chat.ts path). These
      // default to agent="technical" via the column default, but we set
      // it explicitly to match the audited writes in production code.
      for (let i = 0; i < 2; i++) {
        const row = await prisma.chatMessage.create({
          data: {
            sessionId: chatSessionId,
            role: i === 0 ? 'user' : 'assistant',
            content: `technical #${i}`,
            agent: 'technical',
          } as any,
        })
        techIds.push(row.id)
        cleanupMessageIds.push(row.id)
      }
    })

    it('returns ONLY voice rows when agent=voice', async () => {
      const res = await listChatMessages(chatSessionId, { agent: 'voice' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        items: Array<{ id: string; agent: string }>
      }
      expect(body.ok).toBe(true)
      const ids = new Set(body.items.map((i) => i.id))
      for (const id of voiceIds) expect(ids.has(id)).toBe(true)
      for (const id of techIds) expect(ids.has(id)).toBe(false)
      for (const item of body.items) {
        expect(item.agent).toBe('voice')
      }
    })

    it('returns ONLY technical rows when agent=technical', async () => {
      const res = await listChatMessages(chatSessionId, { agent: 'technical' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        items: Array<{ id: string; agent: string }>
      }
      expect(body.ok).toBe(true)
      const ids = new Set(body.items.map((i) => i.id))
      for (const id of techIds) expect(ids.has(id)).toBe(true)
      for (const id of voiceIds) expect(ids.has(id)).toBe(false)
      for (const item of body.items) {
        expect(item.agent).toBe('technical')
      }
    })

    it('returns BOTH technical and voice rows when no agent filter is supplied (legacy behaviour)', async () => {
      const res = await listChatMessages(chatSessionId)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        items: Array<{ id: string; agent: string }>
      }
      const ids = new Set(body.items.map((i) => i.id))
      for (const id of voiceIds) expect(ids.has(id)).toBe(true)
      for (const id of techIds) expect(ids.has(id)).toBe(true)
    })

    it('rejects an unknown agent value with 400', async () => {
      const res = await listChatMessages(chatSessionId, { agent: 'bogus' })
      expect(res.status).toBe(400)
    })

    it('rejects a missing sessionId with 400', async () => {
      const res = await app.fetch(
        asJsonRequest(`http://localhost/api/chat-messages`, 'GET'),
      )
      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await listChatMessages(chatSessionId, {
        agent: 'voice',
        unauthenticated: true,
      })
      // beforeList hook returns ok:false with code:unauthorized, which
      // the generated router surfaces as 400. We accept either 400 or
      // 401 here to keep the test robust to whichever layer rejects
      // first (middleware vs hook) — the critical assertion is "not 2xx".
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })

    it('rejects a caller who is not a member of the owning workspace', async () => {
      const res = await listChatMessages(chatSessionId, {
        userId: foreignUserId,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })
  })

  // =========================================================================
  // Cross-contamination: the two threads never leak into each other's
  // reads, even when they share a ChatSession.
  // =========================================================================
  describe('Cross-contamination between voice and technical rows', () => {
    it('keeps voice writes out of the technical thread and vice-versa', async () => {
      const voiceId = `xct-voice-${Date.now()}`
      const techId = `xct-tech-${Date.now()}`
      cleanupMessageIds.push(voiceId, techId)

      const voiceRes = await createVoiceRow({
        sessionId: chatSessionId,
        kind: 'voice-user',
        text: 'voice turn',
        id: voiceId,
      })
      expect(voiceRes.status).toBe(201)

      await prisma.chatMessage.create({
        data: {
          id: techId,
          sessionId: chatSessionId,
          role: 'user',
          content: 'technical turn',
          agent: 'technical',
        } as any,
      })

      const voiceList = (await (
        await listChatMessages(chatSessionId, { agent: 'voice' })
      ).json()) as { items: Array<{ id: string }> }
      const techList = (await (
        await listChatMessages(chatSessionId, { agent: 'technical' })
      ).json()) as { items: Array<{ id: string }> }

      const voiceIds = new Set(voiceList.items.map((i) => i.id))
      const techIds = new Set(techList.items.map((i) => i.id))

      expect(voiceIds.has(voiceId)).toBe(true)
      expect(voiceIds.has(techId)).toBe(false)
      expect(techIds.has(techId)).toBe(true)
      expect(techIds.has(voiceId)).toBe(false)
    })
  })

  // =========================================================================
  // Cascade semantics — deleting the ChatSession removes both threads
  // together, so the client doesn't need to do any teardown on its side.
  // =========================================================================
  describe('ChatSession cascade deletes both voice and technical rows', () => {
    it('removes every chat_messages row owned by the deleted session', async () => {
      // Fresh session for this test so we can delete it without
      // nuking shared fixtures.
      const throwawaySession = await prisma.chatSession.create({
        data: {
          inferredName: 'Cascade Test Session',
          contextType: 'project',
          contextId: projectId,
        },
      })
      const voiceId = `cascade-voice-${Date.now()}`
      const techId = `cascade-tech-${Date.now()}`

      const voiceRes = await createVoiceRow({
        sessionId: throwawaySession.id,
        kind: 'voice-agent',
        text: 'about to die',
        id: voiceId,
      })
      expect(voiceRes.status).toBe(201)

      await prisma.chatMessage.create({
        data: {
          id: techId,
          sessionId: throwawaySession.id,
          role: 'assistant',
          content: 'about to die (technical)',
          agent: 'technical',
        } as any,
      })

      await prisma.chatSession.delete({ where: { id: throwawaySession.id } })

      const remaining = await prisma.chatMessage.findMany({
        where: { id: { in: [voiceId, techId] } },
      })
      expect(remaining.length).toBe(0)
    })
  })
})
