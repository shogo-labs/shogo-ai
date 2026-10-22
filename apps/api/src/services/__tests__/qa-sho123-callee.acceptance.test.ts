// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-123 acceptance — QA. A `project_call` whose callee turn never starts is a
 * failure the caller gets within seconds, with its own code — not an `accepted`
 * record that only gives up 15 minutes later (or 90s after the budget change).
 *
 * Two paths are measured here through the real service + SQLite:
 *  - the callee refuses the call because its chat was busy (the runtime's 409),
 *    which is what a caller actually hits now that the runtime bounds its own
 *    wait for a turn to start;
 *  - the positive control, so a green run proves both directions.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { rmSync } from 'fs'

const store = {
  resolution: null as any,
  relayResponse: null as any,
}

mock.module('../../lib/agent-proxy-resolver', () => ({
  resolveAgentProxyPodUrl: async () => store.resolution,
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'mock-runtime-token',
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://127.0.0.1:37658', ready: true }),
}))

mock.module('../../lib/tunnel-relay', () => ({
  relayAgentProxyViaTunnel: async () => store.relayResponse,
}))

const { setupChannelsTestDb } = await import('../../__tests__/helpers/channels-test-db')
const { dir } = setupChannelsTestDb()

const { prisma: callDb } = await import('../../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const svc = await import('../agent-call.service')
const agentCallStore = await import('../../lib/agent-call-store')
const db = callDb as any

const FAKE_CTX = {} as any
const realFetch = globalThis.fetch

beforeEach(async () => {
  store.resolution = { ok: true, kind: 'pod', url: 'http://pod.internal:8080' }
  store.relayResponse = null
  // The call chat is a real ChatSession row whose `contextId` is the callee
  // project, so without these two rows the persistence path (and the chat id a
  // refused call hands back) never happens.
  await db.workspace.upsert({ where: { id: 'ws-1' }, update: {}, create: { id: 'ws-1', name: 'WS', slug: 'ws-1' } })
  await db.project.upsert({ where: { id: 'proj-1' }, update: {}, create: { id: 'proj-1', name: 'Callee', workspaceId: 'ws-1' } })
})

afterEach(() => {
  globalThis.fetch = realFetch
  svc.setCallTurnDeps(null)
})

afterAll(async () => {
  await db.chatMessage.deleteMany({ where: { session: { contextId: 'proj-1' } } }).catch(() => {})
  await db.chatSession.deleteMany({ where: { contextId: 'proj-1' } }).catch(() => {})
  await db.project.deleteMany({ where: { id: 'proj-1' } }).catch(() => {})
  await db.workspace.deleteMany({ where: { id: 'ws-1' } }).catch(() => {})
  await db.agentCall.deleteMany({})
  await db.agentCallSessionLink.deleteMany({})
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

/** A callee runtime whose `/agent/pipeline/call` answers with `ack`. */
function callee(ack: Response, opts: { turnVisible?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    if (u.endsWith('/agent/pipeline/call')) return ack
    if (u.includes('/turn')) {
      return (opts.turnVisible ?? true)
        ? new Response(JSON.stringify({ turnId: 't1', status: 'active', createdAt: Date.now() }), { status: 200 })
        : new Response(JSON.stringify({ status: 'unknown' }), { status: 404 })
    }
    if (u.includes('/stream')) return new Response('data: {"type":"text-delta"}\n\n', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as any
  return calls
}

const neverStarted = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'callee_turn_never_started',
        message: 'The target chat c-1 was busy with its own turn for 10s, so this call never started.',
      },
      status: 'accepted',
      started: false,
    }),
    { status: 409 },
  )

async function settled(runId: string) {
  for (let i = 0; i < 200; i++) {
    const rec = await agentCallStore.getAgentCall('proj-1', runId)
    if (rec && rec.status !== 'running') return rec
    await new Promise((r) => setTimeout(r, 5))
  }
  return agentCallStore.getAgentCall('proj-1', runId)
}

describe('AC5/AC6: a call that never started is a failure with its own code', () => {
  it('records callee_turn_never_started inside the ack window, not callee_turn_lost after 15 minutes', async () => {
    await db.agentCall.deleteMany({})
    await db.agentCallSessionLink.deleteMany({})
    // The follow path must not be what settles this: if the service waited for a
    // turn it would burn its whole budget here.
    svc.setCallTurnDeps({
      track: (async () => {
        throw new Error('the call never started, so no turn may be tracked')
      }) as any,
      markTurnStarted: async () => 't',
      markTurnEnded: async () => {},
      startTurnHeartbeat: () => () => {},
      turnPollIntervalMs: 1,
    })
    callee(neverStarted())

    const startedAt = Date.now()
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-neverstarted',
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)
    expect(out.body).toMatchObject({ status: 'accepted', tracked: true, runId: 'run-neverstarted' })

    const rec = await settled('run-neverstarted')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(rec).toMatchObject({ status: 'failed' })
    expect(rec!.error!.code).toBe(svc.CALLEE_TURN_NEVER_STARTED)
    expect(rec!.error!.code).not.toBe(svc.CALLEE_TURN_LOST)
    expect(String(rec!.error!.message)).toContain('never started')
  })

  it('hands the caller the same code and the chat to read when tracking is not asked for', async () => {
    callee(neverStarted())
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-refused',
      wait: false,
    })
    expect(out.status).toBe(409)
    expect((out.body as any).error.code).toBe('callee_turn_never_started')
    expect((out.body as any).chatSessionId).toBe(svc.runChatSessionId('proj-1', 'run-refused'))
  })

  it('control: a callee that starts its turn still completes with the reply', async () => {
    await db.agentCall.deleteMany({})
    await db.agentCallSessionLink.deleteMany({})
    svc.setCallTurnDeps({
      track: (async () => ({ outcome: 'complete', status: 'completed', text: 'the real answer', assistantMessageId: 'm1' })) as any,
      markTurnStarted: async () => 't',
      markTurnEnded: async () => {},
      startTurnHeartbeat: () => () => {},
      turnPollIntervalMs: 1,
    })
    callee(new Response(JSON.stringify({ status: 'accepted', started: true }), { status: 202 }), { turnVisible: true })

    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-ok',
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)
    const rec = await settled('run-ok')
    expect(rec).toMatchObject({ status: 'completed', reply: 'the real answer' })
    expect(rec!.error).toBeUndefined()
  })
})
