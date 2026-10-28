// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The store's own contract against a real database: both surfaces run this one
 * path (SQLite on desktop, Postgres in the cloud), so the spec runs on whichever
 * `setupChannelsTestDb` gives it — `CHANNELS_TEST_PG_URL` switches it to
 * Postgres.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'
import {
  AGENT_CALL_STALE_MS,
  AGENT_CALL_TTL_SECONDS,
  getAgentCall,
  getAgentCallSessionLink,
  linkAgentCallSession,
  putAgentCall,
  waitForAgentCall,
} from '../agent-call-store'

const { dir } = setupChannelsTestDb()
const { prisma } = await import('../prisma')
const db = prisma as any

const projectId = 'proj-a'
const base = { runId: 'run-1', startedAt: Date.now(), updatedAt: Date.now() }

beforeEach(async () => {
  await db.agentCall.deleteMany({})
  await db.agentCallSessionLink.deleteMany({})
})

afterAll(async () => {
  await db.agentCall.deleteMany({})
  await db.agentCallSessionLink.deleteMany({})
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent-call-store', () => {
  it('scopes records by project', async () => {
    await putAgentCall(projectId, { ...base, status: 'running' })
    expect((await getAgentCall(projectId, 'run-1'))?.status).toBe('running')
    expect(await getAgentCall('proj-b', 'run-1')).toBeUndefined()
  })

  it('waitForAgentCall returns undefined for an unknown run without waiting', async () => {
    const t0 = Date.now()
    expect(await waitForAgentCall(projectId, 'nope', 5_000)).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('waitForAgentCall returns early once the call settles', async () => {
    await putAgentCall(projectId, { ...base, status: 'running' })
    setTimeout(() => void putAgentCall(projectId, { ...base, status: 'completed', reply: 'done' }), 30)
    const t0 = Date.now()
    const rec = await waitForAgentCall(projectId, 'run-1', 5_000, { pollIntervalMs: 5 })
    expect(rec).toMatchObject({ status: 'completed', reply: 'done' })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('waitForAgentCall returns the running record after waitMs', async () => {
    await putAgentCall(projectId, { ...base, status: 'running' })
    const rec = await waitForAgentCall(projectId, 'run-1', 30, { pollIntervalMs: 5 })
    expect(rec?.status).toBe('running')
  })

  it('keeps a call record for 7 days, so long background calls can still be polled', async () => {
    expect(AGENT_CALL_TTL_SECONDS).toBe(7 * 24 * 60 * 60)
    const before = Date.now()
    await putAgentCall(projectId, { ...base, status: 'running' })
    const row = await db.agentCall.findUnique({ where: { projectId_runId: { projectId, runId: 'run-1' } } })
    expect(new Date(row.expiresAt).getTime() - before).toBeGreaterThanOrEqual(AGENT_CALL_TTL_SECONDS * 1000 - 1_000)
  })

  it('round-trips the failure, session and chat fields', async () => {
    await putAgentCall(projectId, {
      ...base,
      status: 'failed',
      sessionId: 'sess-1',
      chatSessionId: 'chat-1',
      error: { code: 'agent_turn_failed', message: 'nope' },
    })
    expect(await getAgentCall(projectId, 'run-1')).toMatchObject({
      status: 'failed',
      sessionId: 'sess-1',
      chatSessionId: 'chat-1',
      error: { code: 'agent_turn_failed', message: 'nope' },
    })
  })

  it('fails a running record only once it has been silent past the window', async () => {
    await putAgentCall(projectId, { ...base, status: 'running' })
    await db.agentCall.update({
      where: { projectId_runId: { projectId, runId: 'run-1' } },
      data: { updatedAt: new Date(Date.now() - AGENT_CALL_STALE_MS - 1_000) },
    })
    expect(await getAgentCall(projectId, 'run-1')).toMatchObject({ status: 'failed', error: { code: 'interrupted' } })
  })
})

describe('agent-call session links', () => {
  it('maps a callee chat session back to its call', async () => {
    await linkAgentCallSession('chat-1', { projectId, runId: 'run-1', startedAt: 5 })
    expect(await getAgentCallSessionLink('chat-1')).toEqual({ projectId, runId: 'run-1', startedAt: 5 })
    expect(await getAgentCallSessionLink('chat-2')).toBeUndefined()
  })

  it('expires links with the call record', async () => {
    await linkAgentCallSession('chat-1', { projectId, runId: 'run-1', startedAt: 5 })
    await db.agentCallSessionLink.update({ where: { chatSessionId: 'chat-1' }, data: { expiresAt: new Date(Date.now() - 1) } })
    expect(await getAgentCallSessionLink('chat-1')).toBeUndefined()
  })
})
