// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A tracked `project_call` in flight, and the process that was writing it goes
 * away — a desktop API restart (app update, quit/relaunch, the SIGKILL recovery
 * in `apps/desktop/src/local-server.ts`) or a cloud pod roll. The record and the
 * callee-chat link used to live in per-process state, so after the restart the
 * caller's long-poll found nothing and the callee chat stayed a prompt with no
 * answer, forever.
 *
 * The store keeps both in the database now, on both surfaces. This spec runs
 * against SQLite by default and against Postgres when `CHANNELS_TEST_PG_URL` is
 * set (the same helper the other cloud integration suites use), so the two
 * tracks are exercised by one file.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const store = await import('../lib/agent-call-store')
const { reconcileCallReplyOnRead } = await import('../services/agent-call-reconcile.service')

const db = prisma as any
const seed: SeededWorkspace = await seedWorkspace(db)

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Replace the API process. On a build that still keeps per-process state this
 * drops it — which is exactly what the caller and the callee chat then have to
 * survive.
 */
function simulateRestart() {
  const testing = (store as any)._testing
  testing?.records?.clear?.()
  testing?.sessionLinks?.clear?.()
  testing?.simulateRestart?.()
}

/** What `callProjectAgentAsChat` leaves behind: the session and the prompt row. */
async function seedCallChat(chatSessionId: string, projectId: string, runId: string, text = 'Reply with PONG') {
  await db.chatSession.create({
    data: { id: chatSessionId, inferredName: 'Caller', contextType: 'project', contextId: projectId },
  })
  await db.chatMessage.create({
    data: {
      sessionId: chatSessionId,
      role: 'user',
      content: text,
      parts: JSON.stringify([
        { type: 'text', text },
        { type: 'data-project-call', data: { runId, callerName: 'Caller' } },
      ]),
      agent: 'project_call',
    },
  })
}

async function assistantRows(chatSessionId: string) {
  return db.chatMessage.findMany({
    where: { sessionId: chatSessionId, role: 'assistant' },
    orderBy: { createdAt: 'asc' },
  })
}

/** A runId left `running` by a process that then died. */
async function seedStaleCall(projectId: string, runId: string, chatSessionId: string, silentForMs: number) {
  const startedAt = Date.now() - 10 * 60_000
  await db.agentCall.create({
    data: {
      projectId,
      runId,
      status: 'running',
      sessionId: chatSessionId,
      chatSessionId,
      startedAt: new Date(startedAt),
      updatedAt: new Date(Date.now() - silentForMs),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  })
  await db.agentCallSessionLink.create({
    data: { chatSessionId, projectId, runId, startedAt: new Date(startedAt), expiresAt: new Date(Date.now() + 60 * 60_000) },
  })
}

describe('agent-call store across a restart', () => {
  test('the record and the chat link survive, so opening the chat writes the reply once', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-1'
    const chatSessionId = `chat-restart-1-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = Date.now()

    await seedCallChat(chatSessionId, projectId, runId)

    await store.putAgentCall(projectId, {
      status: 'running',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      startedAt,
      updatedAt: startedAt,
    })
    await store.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt })
    await store.putAgentCall(projectId, {
      status: 'completed',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      reply: 'PONG',
      startedAt,
      updatedAt: Date.now(),
    })

    simulateRestart()

    expect(await store.getAgentCall(projectId, runId)).toMatchObject({ status: 'completed', reply: 'PONG' })
    expect(await store.getAgentCallSessionLink(chatSessionId)).toMatchObject({ projectId, runId })

    // The caller's long-poll path resolves the call that was in flight.
    expect(await store.waitForAgentCall(projectId, runId, 0)).toMatchObject({ status: 'completed', reply: 'PONG' })

    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(true)
    const rows = await assistantRows(chatSessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'technical', content: 'PONG' })

    // A second open finds the reply as the newest row and writes nothing more.
    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(false)
    expect(await assistantRows(chatSessionId)).toHaveLength(1)
  })

  test('the caller long-polls across the restart and sees the callee finish afterwards', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-poll'
    const chatSessionId = `chat-restart-poll-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = Date.now()

    await seedCallChat(chatSessionId, projectId, runId)
    await store.putAgentCall(projectId, {
      status: 'running',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      startedAt,
      updatedAt: startedAt,
    })
    await store.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt })

    // The process that started the call is gone; a fresh one has no memory of it.
    simulateRestart()
    expect((await store.getAgentCall(projectId, runId))?.status).toBe('running')

    // The callee is still working (it outlived the caller's API) and finishes
    // while the caller is mid-poll.
    const finishing = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      await store.putAgentCall(projectId, {
        status: 'completed',
        runId,
        sessionId: chatSessionId,
        chatSessionId,
        reply: 'PONG',
        startedAt,
        updatedAt: Date.now(),
      })
    })()

    const settled = await store.waitForAgentCall(projectId, runId, 5_000, { pollIntervalMs: 50 })
    await finishing

    // The poll settled on the answer instead of timing out on an empty record.
    expect(settled).toMatchObject({ status: 'completed', reply: 'PONG' })

    // And the late reply still reaches the chat.
    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(true)
    const rows = await assistantRows(chatSessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'technical', content: 'PONG' })
  })

  test('a call whose owner died ends as an explicit failure row once it is stale', async () => {
    const projectId = seed.projectId
    const runId = 'run-restart-2'
    const chatSessionId = `chat-restart-2-${crypto.randomUUID().slice(0, 8)}`

    await seedCallChat(chatSessionId, projectId, runId)
    await seedStaleCall(projectId, runId, chatSessionId, store.AGENT_CALL_STALE_MS + 60_000)

    simulateRestart()

    const record = await store.getAgentCall(projectId, runId)
    expect(record).toMatchObject({ status: 'failed' })
    expect(record?.error?.code).toBe('interrupted')

    // The caller's poll settles instead of waiting out its whole budget.
    expect((await store.waitForAgentCall(projectId, runId, 0))?.status).toBe('failed')

    expect(await reconcileCallReplyOnRead(db, chatSessionId)).toBe(true)
    const rows = await assistantRows(chatSessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain('interrupted')
  })

  test('a call another replica is still running is never failed', async () => {
    const projectId = seed.projectId
    const runId = 'run-live-elsewhere'
    const chatSessionId = `chat-live-${crypto.randomUUID().slice(0, 8)}`

    await seedCallChat(chatSessionId, projectId, runId)
    // Beaten a moment ago: the owner is alive on some other replica.
    await seedStaleCall(projectId, runId, chatSessionId, store.AGENT_CALL_STALE_MS - 5_000)

    expect((await store.getAgentCall(projectId, runId))?.status).toBe('running')
  })

  test('the staleness boundary sits exactly at AGENT_CALL_STALE_MS', async () => {
    // The window has to be longer than the runtime's 60 s long-poll and the
    // owner's beat, or a slow-but-healthy call would be killed.
    expect(store.AGENT_CALL_STALE_MS).toBeGreaterThan(store.AGENT_CALL_HEARTBEAT_MS * 3)
    expect(store.AGENT_CALL_STALE_MS).toBeGreaterThan(60_000)

    const projectId = seed.projectId
    const inside = 'run-boundary-inside'
    const outside = 'run-boundary-outside'
    await seedStaleCall(projectId, inside, `chat-boundary-in-${crypto.randomUUID().slice(0, 8)}`, store.AGENT_CALL_STALE_MS - 2_000)
    await seedStaleCall(projectId, outside, `chat-boundary-out-${crypto.randomUUID().slice(0, 8)}`, store.AGENT_CALL_STALE_MS + 2_000)

    expect((await store.getAgentCall(projectId, inside))?.status).toBe('running')
    expect((await store.getAgentCall(projectId, outside))?.status).toBe('failed')

    // The row really moved, so the next reader (another replica) agrees.
    const row = await db.agentCall.findUnique({ where: { projectId_runId: { projectId, runId: outside } } })
    expect(row.status).toBe('failed')
  })

  test('a heartbeat keeps a slow call alive', async () => {
    const projectId = seed.projectId
    const runId = 'run-heartbeat'
    const chatSessionId = `chat-beat-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = Date.now()

    await store.putAgentCall(projectId, {
      status: 'running',
      runId,
      sessionId: chatSessionId,
      chatSessionId,
      startedAt,
      updatedAt: startedAt,
    })
    // Pretend it has been running longer than the window: a beat just landed.
    await db.agentCall.update({
      where: { projectId_runId: { projectId, runId } },
      data: { startedAt: new Date(Date.now() - 30 * 60_000), updatedAt: new Date(Date.now() - store.AGENT_CALL_STALE_MS + 2_000) },
    })
    await store.touchAgentCall(projectId, runId)

    const record = await store.getAgentCall(projectId, runId)
    expect(record?.status).toBe('running')
    expect(record!.updatedAt).toBeGreaterThan(Date.now() - 5_000)

    // A beat after the call is terminal changes nothing: the status is final.
    await store.putAgentCall(projectId, { status: 'completed', runId, reply: 'late', startedAt, updatedAt: Date.now() })
    await store.touchAgentCall(projectId, runId)
    expect(await store.getAgentCall(projectId, runId)).toMatchObject({ status: 'completed', reply: 'late' })
  })

  test('expired records and links resolve to nothing and are deleted', async () => {
    const projectId = seed.projectId
    const runId = 'run-expired'
    const chatSessionId = `chat-expired-${crypto.randomUUID().slice(0, 8)}`
    const expiredAt = new Date(Date.now() - 60_000)

    await db.agentCall.create({
      data: {
        projectId,
        runId,
        status: 'completed',
        reply: 'too late',
        startedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
        expiresAt: expiredAt,
      },
    })
    await db.agentCallSessionLink.create({
      data: {
        chatSessionId,
        projectId,
        runId,
        startedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
        expiresAt: expiredAt,
      },
    })

    expect(await store.getAgentCall(projectId, runId)).toBeUndefined()
    expect(await store.getAgentCallSessionLink(chatSessionId)).toBeUndefined()
    expect(await db.agentCall.count({ where: { runId } })).toBe(0)
    expect(await db.agentCallSessionLink.count({ where: { chatSessionId } })).toBe(0)
  })

  test('every write refreshes the 7-day expiry, and a call is scoped to its project', async () => {
    const projectId = seed.projectId
    const runId = 'run-scoped'
    const ttlMs = store.AGENT_CALL_TTL_SECONDS * 1000
    // Started six days ago: measured from `startedAt` this record would have a
    // single day left, so the assertion below can only pass if the expiry is
    // recomputed from the write.
    const startedAt = Date.now() - 6 * 24 * 60 * 60_000
    const chatSessionId = `chat-ttl-${crypto.randomUUID().slice(0, 8)}`
    const callRow = () => db.agentCall.findUnique({ where: { projectId_runId: { projectId, runId } } })
    const linkRow = () => db.agentCallSessionLink.findUnique({ where: { chatSessionId } })
    const expiryOf = (row: any) => new Date(row.expiresAt).getTime()

    await store.putAgentCall(projectId, { status: 'running', runId, sessionId: chatSessionId, chatSessionId, startedAt, updatedAt: startedAt })
    await store.linkAgentCallSession(chatSessionId, { projectId, runId, startedAt })

    const first = await callRow()
    expect(expiryOf(first)).toBeGreaterThan(Date.now() + ttlMs - 60_000)
    expect(expiryOf(first)).toBeLessThanOrEqual(Date.now() + ttlMs)
    expect(expiryOf(await linkRow())).toBeGreaterThan(Date.now() + ttlMs - 60_000)

    expect(await store.getAgentCall(seed.foreignProjectId, runId)).toBeUndefined()

    // Each later write (a status change, then a heartbeat) pushes the expiry out
    // again, so a long call never expires out from under its own reader.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.putAgentCall(projectId, { status: 'running', runId, sessionId: chatSessionId, chatSessionId, startedAt, updatedAt: Date.now() })
    const second = await callRow()
    expect(expiryOf(second)).toBeGreaterThan(expiryOf(first))

    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.touchAgentCall(projectId, runId)
    expect(expiryOf(await callRow())).toBeGreaterThan(expiryOf(second))

    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.putAgentCall(projectId, { status: 'completed', runId, reply: 'PONG', startedAt, updatedAt: Date.now() })
    const done = await callRow()
    expect(expiryOf(done)).toBeGreaterThan(expiryOf(second))
    expect(done.status).toBe('completed')
  })
})
