// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-123 acceptance — QA. A `project_call` into a busy chat is queued, not
 * dropped: it runs once that chat's own turn ends, however long it was waiting.
 * `callee_turn_never_started` is kept for the real loss — the runtime restarted
 * or the queued call vanished — and is reported within the budget instead of
 * after 15 minutes.
 *
 * Two paths are measured here through the real service + SQLite:
 *  - a call queued behind the callee's own turn, which runs when that turn ends;
 *  - a call the runtime acks and then loses, which fails with its own code.
 * Plus the webhook wake path, and a positive control, so a green run proves
 * both directions.
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
function callee(
  ack: Response,
  opts: { turns?: Array<Record<string, unknown>> } = {},
) {
  const calls: Array<{ url: string; method: string; body?: any }> = []
  const pending = [...(opts.turns ?? [])]
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    if (u.endsWith('/agent/pipeline/call')) return ack
    if (u.includes('/turn')) {
      const body = pending.length > 1 ? pending.shift()! : pending[0] ?? { status: 'unknown' }
      return typeof body.status === 'number'
        ? new Response(JSON.stringify(body.body ?? {}), { status: body.status as number })
        : new Response(JSON.stringify(body), { status: 200 })
    }
    if (u.includes('/stream')) return new Response('data: {"type":"text-delta"}\n\n', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as any
  return calls
}

/** The runtime's ack for a `wait: false` call it will run: queued or started. */
const ackQueued = () => new Response(JSON.stringify({ status: 'queued', runId: 'run-1' }), { status: 202 })

/** The probe answering `queued` while the chat's own turn is still running. */
const queuedProbe = () => ({ chatSessionId: 'c-1', status: 'queued', queuedSince: Date.now(), queuedDepth: 1 })

async function settled(runId: string) {
  for (let i = 0; i < 200; i++) {
    const rec = await agentCallStore.getAgentCall('proj-1', runId)
    if (rec && rec.status !== 'running') return rec
    await new Promise((r) => setTimeout(r, 5))
  }
  return agentCallStore.getAgentCall('proj-1', runId)
}

describe('AC5/AC6: a queued call keeps waiting; only a lost one fails', () => {
  it('runs the call once the busy chat finishes its turn, however long it was queued', async () => {
    await db.agentCall.deleteMany({})
    await db.agentCallSessionLink.deleteMany({})
    svc.setCallTurnDeps({
      track: (async () => ({ outcome: 'complete', status: 'completed', text: 'answered after the chat', assistantMessageId: 'm2' })) as any,
      markTurnStarted: async () => 't',
      markTurnEnded: async () => {},
      startTurnHeartbeat: () => () => {},
      turnPollIntervalMs: 1,
      // A chat may be busy for far longer than this; being queued is not a failure.
      turnStartTimeoutMs: 40,
    })
    // Queued behind the chat's own turn for longer than the budget, then its turn.
    callee(ackQueued(), {
      turns: [queuedProbe(), queuedProbe(), queuedProbe(), queuedProbe(), queuedProbe(), { turnId: 't9', status: 'active', createdAt: Date.now() }],
    })

    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-queued',
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)

    const rec = await settled('run-queued')
    expect(rec).toMatchObject({ status: 'completed', reply: 'answered after the chat' })
    expect(rec!.error).toBeUndefined()
  })

  it('records callee_turn_never_started when nothing is queued and no turn appears', async () => {
    await db.agentCall.deleteMany({})
    await db.agentCallSessionLink.deleteMany({})
    // The follow path must not be what settles this: if the service saw a turn
    // it would burn its whole budget here.
    svc.setCallTurnDeps({
      track: (async () => {
        throw new Error('the call never started, so no turn may be tracked')
      }) as any,
      markTurnStarted: async () => 't',
      markTurnEnded: async () => {},
      startTurnHeartbeat: () => () => {},
      turnPollIntervalMs: 1,
      turnStartTimeoutMs: 40,
    })
    // Acked, then the runtime shows no sign of it at all: the queued item vanished.
    callee(ackQueued())

    const startedAt = Date.now()
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-neverstarted',
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)
    expect(out.body).toMatchObject({ tracked: true, runId: 'run-neverstarted' })

    const rec = await settled('run-neverstarted')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(rec).toMatchObject({ status: 'failed' })
    expect(rec!.error!.code).toBe(svc.CALLEE_TURN_NEVER_STARTED)
    expect(rec!.error!.code).not.toBe(svc.CALLEE_TURN_LOST)
    expect(String(rec!.error!.message)).toContain('never started')
  })

  it('the webhook wake path is not dropped by a busy chat', async () => {
    const calls = callee(ackQueued())
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'webhook wake',
      runId: 'run-webhook',
      wait: false,
    })
    expect(out.status).toBe(202)
    expect((out.body as any).status).toBe('queued')
    expect(calls.filter((c) => c.url.endsWith('/agent/pipeline/call'))).toHaveLength(1)
  })

  it('a queued call is followed by its own name, not the turn it is waiting behind', async () => {
    await db.agentCall.deleteMany({})
    await db.agentCallSessionLink.deleteMany({})
    let probes = 0
    let trackedAt = 0
    let trackedTurnId: string | undefined
    const probeUrls: string[] = []
    svc.setCallTurnDeps({
      track: (async (_body: any, _a: any, _b: any, options: any) => {
        trackedAt = probes
        trackedTurnId = options?.expectedTurnId
        return { outcome: 'complete', status: 'completed', text: 'the call answer', assistantMessageId: 'm-call' }
      }) as any,
      markTurnStarted: async () => 't',
      markTurnEnded: async () => {},
      startTurnHeartbeat: () => () => {},
      turnPollIntervalMs: 1,
      turnStartTimeoutMs: 500,
    })

    // The chat's own turn started 5 s before the call — inside the 30 s skew a
    // timestamp check cannot see through — and it answers as `active` with its
    // own `createdAt` plus our call's `queuedSince` for the first 8 polls.
    const busyStartedAt = Date.now() - 5_000
    const queued = () => ({
      chatSessionId: 'c-1',
      status: 'active',
      turnId: 't-busy',
      createdAt: busyStartedAt,
      queuedSince: Date.now(),
      queuedDepth: 1,
      reply: null,
    })
    globalThis.fetch = (async (url: any) => {
      const u = String(url)
      if (u.endsWith('/agent/pipeline/call')) return ackQueued()
      if (u.includes('/turn')) {
        probeUrls.push(u)
        probes++
        if (probes <= 8) return new Response(JSON.stringify(queued()), { status: 200 })
        return new Response(
          JSON.stringify({ chatSessionId: 'c-1', callId: 'run-q', turnId: 't-ours', status: 'active', createdAt: Date.now(), reply: null }),
          { status: 200 },
        )
      }
      if (u.includes('/stream')) return new Response('data: {"type":"text-delta"}\n\n', { status: 200 })
      return new Response('not found', { status: 404 })
    }) as any

    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'job',
      runId: 'run-q',
      wait: false,
      track: true,
    })
    expect(out.status).toBe(202)

    const rec = await settled('run-q')
    // The follower asked about this call by name, waited through every queued
    // answer instead of taking the busy chat's turn on the first probe, and only
    // then followed the turn the callee named as ours.
    expect(probeUrls.every((u) => u.includes('callId=run-q'))).toBe(true)
    expect(trackedAt).toBeGreaterThanOrEqual(8)
    expect(trackedTurnId).toBe('t-ours')
    expect(rec).toMatchObject({ status: 'completed', reply: 'the call answer' })
    expect(rec!.reply).not.toBe('the busy turn’s reply')
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
    callee(new Response(JSON.stringify({ status: 'started' }), { status: 202 }), {
      turns: [{ turnId: 't1', status: 'active', createdAt: Date.now() }],
    })

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
