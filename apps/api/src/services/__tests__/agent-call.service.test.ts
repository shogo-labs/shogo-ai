// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { rmSync } from 'fs'

// ─── mocks ───────────────────────────────────────────────────────────────────

const store = {
  resolution: null as any,
  relayResponse: null as any,
  relayCalledWith: null as any,
  tokenCalledWith: null as any,
}

mock.module('../../lib/agent-proxy-resolver', () => ({
  resolveAgentProxyPodUrl: async (projectId: string, opts?: any) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), resolveProjectId: projectId, resolveOpts: opts }
    return store.resolution
  },
}))

mock.module('../../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async (projectId: string, opts?: any) => {
    store.tokenCalledWith = { projectId, opts }
    return 'mock-runtime-token'
  },
}))

mock.module('../../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async (projectId: string) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), hostProjectId: projectId }
    return { url: 'http://127.0.0.1:37658', ready: true }
  },
}))

mock.module('../../lib/tunnel-relay', () => ({
  relayAgentProxyViaTunnel: async (opts: any) => {
    store.relayCalledWith = { ...(store.relayCalledWith ?? {}), tunnelOpts: opts }
    return store.relayResponse
  },
}))

const { setupChannelsTestDb } = await import('../../__tests__/helpers/channels-test-db')
const { dir } = setupChannelsTestDb()

// The helper flags local mode so `lib/prisma` builds a SQLite client; bind it
// first, then clear the flag so the service below exercises its cloud branches
// (the resolver/tunnel mocks in this file) rather than the local one.
const { prisma: callDb } = await import('../../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

const svc = await import('../agent-call.service')
const agentCallStore = await import('../../lib/agent-call-store')
const db = callDb as any

// ─── fixtures ────────────────────────────────────────────────────────────────

const FAKE_CTX = {} as any

beforeEach(() => {
  store.resolution = { ok: true, kind: 'pod', url: 'http://pod.internal:8080' }
  store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
  store.relayCalledWith = null
  store.tokenCalledWith = null
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
afterAll(async () => {
  await db.agentCall.deleteMany({})
  await db.agentCallSessionLink.deleteMany({})
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('callProjectAgent — validation', () => {
  it('400s when message is empty or whitespace-only, without resolving anything', async () => {
    const out1 = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: '' })
    expect(out1.status).toBe(400)
    expect(out1.body.error.code).toBe('bad_request')

    const out2 = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: '   ' })
    expect(out2.status).toBe(400)

    expect(store.relayCalledWith).toBeNull()
  })
})

describe('callProjectAgent — resolver failure', () => {
  it('propagates the resolver status/body verbatim', async () => {
    store.resolution = { ok: false, status: 503, body: { error: { code: 'instance_offline', message: 'offline' } } }
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(503)
    expect(out.body.error.code).toBe('instance_offline')
  })
})

describe('callProjectAgent — cloud (pod) branch', () => {
  it('forwards to `${url}/agent/pipeline/call` with the runtime token header and the request body', async () => {
    store.resolution = { ok: true, kind: 'pod', url: 'http://pod.internal:8080' }
    let capturedUrl = ''
    let capturedInit: any = null
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ status: 'completed', reply: 'from pod', runId: 'run-9' }), { status: 200 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'do the thing',
      runId: 'run-9',
      sessionId: 'sess-1',
      callerProjectId: 'proj-caller',
    })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from pod')
    expect(capturedUrl).toBe('http://pod.internal:8080/agent/pipeline/call')
    expect(capturedInit.headers['x-runtime-token']).toBe('mock-runtime-token')
    expect(capturedInit.headers['Content-Type']).toBe('application/json')
    const parsedBody = JSON.parse(capturedInit.body)
    expect(parsedBody).toEqual({
      message: 'do the thing',
      runId: 'run-9',
      sessionId: 'sess-1',
      wait: true,
      callerProjectId: 'proj-caller',
    })
    expect(store.tokenCalledWith.projectId).toBe('proj-1')
  })

  it('defaults wait to true when omitted, and passes wait:false through untouched', async () => {
    let capturedBody = ''
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = init.body
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', wait: false })
    expect(out.status).toBe(202)
    expect(JSON.parse(capturedBody).wait).toBe(false)
  })

  it('clamps timeoutMs into [10s, 20min] and reflects it in the timeout-error message', async () => {
    globalThis.fetch = (async () => {
      const err: any = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as any

    // Below the floor (5ms) should clamp to 10s.
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', timeoutMs: 5 })
    expect(out.status).toBe(504)
    expect(out.body.error.code).toBe('agent_call_timeout')
    expect(out.body.error.message).toContain('10s')
  })

  it('clamps an excessive timeoutMs down to 20 minutes', async () => {
    globalThis.fetch = (async () => {
      const err: any = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', timeoutMs: 999 * 60_000 })
    expect(out.body.error.message).toContain('1200s')
  })

  it('returns 502 agent_call_failed on a non-timeout fetch error, with the underlying message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(502)
    expect(out.body.error.code).toBe('agent_call_failed')
    expect(out.body.error.message).toBe('ECONNREFUSED')
  })

  it('falls back to a generic message when the thrown error has none', async () => {
    globalThis.fetch = (async () => { throw {} }) as any
    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi' })
    expect(out.status).toBe(502)
    expect(out.body.error.message).toBe('Failed to reach the target runtime')
  })
})

describe('callProjectAgent — tunnel branch', () => {
  it('relays through relayAgentProxyViaTunnel with the pipeline path and runtime token', async () => {
    store.resolution = { ok: true, kind: 'tunnel', instanceId: 'inst-1', workspaceId: 'ws-1', projectId: 'proj-1' }
    store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'from tunnel' }), { status: 200 })

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', runId: 'run-1' })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from tunnel')
    const tunnelOpts = store.relayCalledWith.tunnelOpts
    expect(tunnelOpts.instanceId).toBe('inst-1')
    expect(tunnelOpts.agentPath).toBe('/agent/pipeline/call')
    expect(tunnelOpts.cleanPath).toBe('/agent/pipeline/call')
    expect(tunnelOpts.method).toBe('POST')
    expect(tunnelOpts.headers['x-runtime-token']).toBe('mock-runtime-token')
    expect(JSON.parse(tunnelOpts.body).runId).toBe('run-1')
  })
})

describe('callProjectAgent — desktop (local mode)', () => {
  const previous = process.env.SHOGO_LOCAL_MODE
  beforeEach(() => { process.env.SHOGO_LOCAL_MODE = 'true' })
  afterEach(() => {
    if (previous === undefined) delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = previous
  })

  it('calls the target on the host runtime without the cloud tunnel resolver', async () => {
    let capturedUrl = ''
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ status: 'completed', reply: 'from host' }), { status: 200 })
    }) as any

    const out = await svc.callProjectAgent(FAKE_CTX, 'proj-2', 'ws-1', { message: 'hi' })

    expect(out.status).toBe(200)
    expect(out.body.reply).toBe('from host')
    expect(capturedUrl).toBe('http://127.0.0.1:37658/agent/pipeline/call')
    expect(store.relayCalledWith.hostProjectId).toBe('proj-2')
    expect(store.relayCalledWith.resolveProjectId).toBeUndefined()
    expect(store.tokenCalledWith.projectId).toBe('proj-2')
  })
})

describe('callProjectAgentAsChat — chat persistence', () => {
  const sessions = new Map<string, any>()
  const messages: any[] = []

  /** Prisma `where` evaluation for the two queries the call-chat writes use. */
  function matches(m: any, where: any): boolean {
    if (where.sessionId && m.sessionId !== where.sessionId) return false
    if (where.role && m.role !== where.role) return false
    const agent = where.agent
    if (typeof agent === 'string') {
      if (m.agent !== agent) return false
    } else if (agent?.in && !agent.in.includes(m.agent)) {
      return false
    }
    if (where.createdAt?.gte && !(new Date(m.createdAt) >= new Date(where.createdAt.gte))) return false
    return true
  }

  const fakeDb = {
    project: { findUnique: async () => ({ name: 'Caller' }) },
    chatSession: {
      upsert: async ({ where, create }: any) => {
        if (!sessions.has(where.id)) sessions.set(where.id, { ...create, cachedMessageCount: 0 })
        return sessions.get(where.id)
      },
      update: async ({ where, data }: any) => {
        const s = sessions.get(where.id)
        if (!s) throw new Error(`no chat session ${where.id}`)
        if (data.cachedMessageCount?.increment) s.cachedMessageCount += data.cachedMessageCount.increment
        return s
      },
    },
    chatMessage: {
      create: async ({ data }: any) => {
        const row = { ...data, createdAt: new Date() }
        messages.push(row)
        return row
      },
      findFirst: async ({ where, orderBy }: any) => {
        const rows = messages.filter((m) => matches(m, where))
        const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        if (orderBy?.createdAt === 'desc') return sorted[0] ?? null
        return rows[0] ?? null
      },
      count: async ({ where }: any) => messages.filter((m) => matches(m, where)).length,
    },
  }

  beforeEach(() => {
    sessions.clear()
    messages.length = 0
    svc.setCallChatDb(fakeDb)
  })
  afterEach(() => svc.setCallChatDb(null))

  it('derives one stable chat id per project and runId', () => {
    const a = svc.runChatSessionId('proj-1', 'run-1')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(svc.runChatSessionId('proj-1', 'run-1')).toBe(a)
    expect(svc.runChatSessionId('proj-2', 'run-1')).not.toBe(a)
    expect(svc.runChatSessionId('proj-1', 'run-2')).not.toBe(a)
  })

  it('records the request and reply, forwards the chat id as the runtime session, and returns it', async () => {
    let forwarded: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      forwarded = JSON.parse(init.body)
      return new Response(JSON.stringify({ status: 'completed', reply: 'all done', sessionId: forwarded.sessionId }), { status: 200 })
    }) as any

    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
      message: 'do it', runId: 'run-1', callerProjectId: 'proj-caller',
    })
    const chatId = svc.runChatSessionId('proj-1', 'run-1')

    expect(out.status).toBe(200)
    expect(out.body.chatSessionId).toBe(chatId)
    expect(forwarded.sessionId).toBe(chatId)
    expect(forwarded.runId).toBe('run-1')
    expect(sessions.get(chatId)).toMatchObject({ contextType: 'project', contextId: 'proj-1' })
    expect(sessions.get(chatId).inferredName).toBe('Caller: do it')
    expect(messages.map((m) => [m.role, m.agent, m.content])).toEqual([
      ['user', 'project_call', 'do it'],
      ['assistant', 'technical', 'all done'],
    ])
    expect(JSON.parse(messages[0].parts)).toEqual([
      { type: 'text', text: 'do it' },
      { type: 'data-project-call', data: { runId: 'run-1', callerName: 'Caller' } },
    ])
    expect(sessions.get(chatId).cachedMessageCount).toBe(2)
  })

  it('reuses one chat for every hop of the same runId', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })) as any
    await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'first', runId: 'run-7' })
    await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'second', runId: 'run-7' })
    expect(sessions.size).toBe(1)
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first', 'second'])
  })

  it('still calls the runtime when the chat cannot be recorded', async () => {
    svc.setCallChatDb({ ...fakeDb, chatSession: { ...fakeDb.chatSession, upsert: async () => { throw new Error('db down') } } })
    let forwarded: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      forwarded = JSON.parse(init.body)
      return new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
    }) as any
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', runId: 'run-9' })
    expect(out.status).toBe(200)
    expect(out.body.chatSessionId).toBeUndefined()
    expect(forwarded.sessionId).toBeUndefined()
  })

  it('leaves an explicit sessionId alone', async () => {
    let forwarded: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      forwarded = JSON.parse(init.body)
      return new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
    }) as any
    await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'hi', runId: 'r', sessionId: 'custom' })
    expect(forwarded.sessionId).toBe('custom')
    expect(sessions.size).toBe(0)
  })

  /**
   * A callee runtime that acks `wait: false` and buffers the turn: `/turn`
   * reports it once `turnVisible`, `/stream` serves its body.
   */
  function fakeCallee(opts: { ack?: Response; turnVisible?: () => boolean; streamStatus?: number } = {}) {
    const calls: Array<{ url: string; method: string; body?: any }> = []
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined })
      if (u.endsWith('/agent/pipeline/call')) return opts.ack ?? new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })
      if (u.includes('/turn')) {
        return (opts.turnVisible ?? (() => true))()
          ? new Response(JSON.stringify({ turnId: 't1', status: 'active', createdAt: Date.now() }), { status: 200 })
          : new Response(JSON.stringify({ status: 'unknown' }), { status: 404 })
      }
      if (u.includes('/stream')) {
        const status = opts.streamStatus ?? 200
        return status === 200 ? new Response('data: {"type":"text-delta"}\n\n', { status }) : new Response(null, { status })
      }
      return new Response('not found', { status: 404 })
    }) as any
    return calls
  }

  const turnState = { started: [] as string[], ended: [] as Array<[string, string]>, heartbeats: 0 }
  let trackCalls: any[] = []
  let trackResult: () => Promise<any> = async () => ({ outcome: 'complete', status: 'completed', text: 'final reply', assistantMessageId: 'msg-1' })

  beforeEach(() => {
    turnState.started.length = 0
    turnState.ended.length = 0
    turnState.heartbeats = 0
    trackCalls = []
    trackResult = async () => ({ outcome: 'complete', status: 'completed', text: 'final reply', assistantMessageId: 'msg-1' })
    svc.setCallTurnDeps({
      track: (async (...args: any[]) => {
        trackCalls.push(args)
        return trackResult()
      }) as any,
      markTurnStarted: async (id) => {
        turnState.started.push(id)
        return `turn-${id}`
      },
      markTurnEnded: async (id, turnId) => {
        turnState.ended.push([id, turnId])
      },
      startTurnHeartbeat: () => {
        turnState.heartbeats++
        return () => {}
      },
      turnPollIntervalMs: 1,
    })
  })
  afterEach(() => svc.setCallTurnDeps(null))

  async function until(cond: () => boolean) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('wait=false starts the callee turn without holding a request and follows it with the chat tracker', async () => {
    const calls = fakeCallee()
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'long job', runId: 'run-bg', wait: false })
    const chatId = svc.runChatSessionId('proj-1', 'run-bg')
    expect(out.status).toBe(202)
    expect(out.body).toMatchObject({ status: 'accepted', runId: 'run-bg', chatSessionId: chatId })

    const forward = calls.find((c) => c.url.endsWith('/agent/pipeline/call'))!
    expect(forward.body).toMatchObject({ wait: false, sessionId: chatId, runId: 'run-bg' })

    await until(() => turnState.ended.length > 0)
    expect(calls.some((c) => c.url === `http://pod.internal:8080/agent/chat/${chatId}/stream?fromSeq=0`)).toBe(true)
    expect(trackCalls).toHaveLength(1)
    const [, body, project, options] = trackCalls[0]
    expect(body).toEqual({ chatSessionId: chatId })
    expect(project).toEqual({ id: 'proj-1', workspaceId: 'ws-1' })
    expect(options.chatSessionId).toBe(chatId)
    expect(typeof options.expectedTurnStartedAt).toBe('number')
    expect(typeof options.resume).toBe('function')
    expect(turnState.started).toEqual([chatId])
    expect(turnState.ended).toEqual([[chatId, `turn-${chatId}`]])
    // The tracker owns the assistant row; the service no longer writes one.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('wait=false waits for the callee turn to start before streaming it', async () => {
    let visible = false
    const calls = fakeCallee({ turnVisible: () => visible })
    await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'queued job', runId: 'run-wait', wait: false })
    await until(() => calls.filter((c) => c.url.includes('/turn')).length >= 3)
    expect(calls.some((c) => c.url.includes('/stream'))).toBe(false)
    visible = true
    await until(() => turnState.ended.length > 0)
    expect(trackCalls).toHaveLength(1)
  })

  it('wait=false surfaces a runtime that refuses the call', async () => {
    fakeCallee({ ack: new Response(JSON.stringify({ error: { code: 'busy', message: 'nope' } }), { status: 503 }) })
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-refused', wait: false })
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ error: { code: 'busy' }, chatSessionId: svc.runChatSessionId('proj-1', 'run-refused') })
    expect(turnState.started).toHaveLength(0)
  })

  it('wait=false through an Instance tunnel falls back to holding the call', async () => {
    store.resolution = { ok: true, kind: 'tunnel', instanceId: 'inst-1', workspaceId: 'ws-1', projectId: 'proj-1' }
    store.relayResponse = new Response(JSON.stringify({ status: 'completed', reply: 'via tunnel' }), { status: 200 })
    const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-tun', wait: false })
    expect(out.status).toBe(202)
    await until(() => messages.some((m) => m.role === 'assistant'))
    expect(JSON.parse(store.relayCalledWith.tunnelOpts.body).wait).toBe(true)
    expect(messages.find((m) => m.role === 'assistant')?.content).toBe('via tunnel')
    expect(trackCalls).toHaveLength(0)
  })

  describe('track=true', () => {
    beforeEach(async () => {
      await db.agentCall.deleteMany({})
      await db.agentCallSessionLink.deleteMany({})
    })

    async function settled(runId: string) {
      for (let i = 0; i < 100; i++) {
        const rec = await agentCallStore.getAgentCall('proj-1', runId)
        if (rec && rec.status !== 'running') return rec
        await new Promise((r) => setTimeout(r, 5))
      }
      return agentCallStore.getAgentCall('proj-1', runId)
    }

    it('records running until the callee turn finishes, however long it takes, then completed with the reply', async () => {
      fakeCallee()
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      trackResult = async () => {
        await gate
        return { outcome: 'complete', status: 'completed', text: 'tracked reply', assistantMessageId: 'msg-1' }
      }

      const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-t1', wait: false, track: true })
      const chatId = svc.runChatSessionId('proj-1', 'run-t1')
      expect(out.status).toBe(202)
      expect(out.body).toMatchObject({ status: 'accepted', tracked: true, runId: 'run-t1', chatSessionId: chatId })
      expect((await agentCallStore.getAgentCall('proj-1', 'run-t1'))?.status).toBe('running')
      expect(await agentCallStore.getAgentCallSessionLink(chatId)).toMatchObject({ projectId: 'proj-1', runId: 'run-t1' })

      await until(() => trackCalls.length > 0)
      expect((await agentCallStore.getAgentCall('proj-1', 'run-t1'))?.status).toBe('running')

      release()
      const rec = await settled('run-t1')
      expect(rec).toMatchObject({ status: 'completed', reply: 'tracked reply', chatSessionId: chatId })
      expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
    })

    it('fails the call with callee_turn_lost when the tracker never sees the turn finish', async () => {
      fakeCallee()
      trackResult = async () => ({ outcome: 'partial', status: null, text: 'half a reply', assistantMessageId: 'msg-1' })
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-lost', wait: false, track: true })
      const rec = await settled('run-lost')
      expect(rec).toMatchObject({ status: 'failed', reply: 'half a reply', error: { code: svc.CALLEE_TURN_LOST } })
    })

    it('fails the call with callee_turn_never_started when the callee turn never starts', async () => {
      fakeCallee({ turnVisible: () => false })
      svc.setCallTurnDeps({
        track: (async (...args: any[]) => { trackCalls.push(args) }) as any,
        markTurnStarted: async () => 't',
        markTurnEnded: async () => {},
        startTurnHeartbeat: () => () => {},
        turnPollIntervalMs: 1,
        turnStartTimeoutMs: 20,
      })
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-never', wait: false, track: true })
      const rec = await settled('run-never')
      expect(rec).toMatchObject({ status: 'failed', error: { code: svc.CALLEE_TURN_NEVER_STARTED } })
      expect(rec!.error!.message).toContain('never started')
      expect(trackCalls).toHaveLength(0)
    })

    it('budgets a callee start at 90s, not 15 minutes', () => {
      expect(svc.CALLEE_TURN_START_TIMEOUT_MS).toBe(90_000)
    })

    it('does not spend the turn-start budget while the callee is still booting', async () => {
      // A cold callee refuses the probe until it is up, then starts the queued
      // call. The outage lasts far longer than the start budget; before SHO-265
      // that settled the call as callee_turn_never_started while the runtime
      // was still coming up.
      const BOOT_POLLS = 40
      let polls = 0
      globalThis.fetch = (async (url: any) => {
        const u = String(url)
        if (u.endsWith('/agent/pipeline/call')) return new Response(JSON.stringify({ status: 'queued' }), { status: 202 })
        if (u.includes('/turn')) {
          polls++
          if (polls <= BOOT_POLLS) return new Response(JSON.stringify({ error: { code: 'runtime_not_ready' } }), { status: 503 })
          return new Response(JSON.stringify({ turnId: 't1', status: 'active', callId: 'call-boot', createdAt: Date.now() }), { status: 200 })
        }
        if (u.includes('/stream')) return new Response('data: {"type":"text-delta"}\n\n', { status: 200 })
        return new Response('not found', { status: 404 })
      }) as any
      svc.setCallTurnDeps({
        track: (async (...args: any[]) => {
          trackCalls.push(args)
          return trackResult()
        }) as any,
        markTurnStarted: async () => 't',
        markTurnEnded: async () => {},
        startTurnHeartbeat: () => () => {},
        turnPollIntervalMs: 1,
        turnStartTimeoutMs: 10,
        calleeUnreachableTimeoutMs: 5_000,
      })
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-boot', wait: false, track: true })
      const rec = await settled('run-boot')
      expect(rec).toMatchObject({ status: 'completed' })
      expect(polls).toBeGreaterThan(BOOT_POLLS)
      expect(trackCalls).toHaveLength(1)
    })

    it('gives up on a callee that never answers the probe at all', async () => {
      globalThis.fetch = (async (url: any) => {
        if (String(url).endsWith('/agent/pipeline/call')) return new Response(JSON.stringify({ status: 'queued' }), { status: 202 })
        return new Response(null, { status: 503 })
      }) as any
      svc.setCallTurnDeps({
        track: (async (...args: any[]) => { trackCalls.push(args) }) as any,
        markTurnStarted: async () => 't',
        markTurnEnded: async () => {},
        startTurnHeartbeat: () => () => {},
        turnPollIntervalMs: 1,
        turnStartTimeoutMs: 50,
        calleeUnreachableTimeoutMs: 20,
      })
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-dark', wait: false, track: true })
      const rec = await settled('run-dark')
      // The caller must be told it could not reach the callee, not that a live
      // runtime dropped its call — that is what this call's rejection means.
      expect(rec).toMatchObject({ status: 'failed', error: { code: svc.CALLEE_UNREACHABLE } })
      expect(rec!.error!.message).toContain("Could not reach the target project's runtime")
      expect(rec!.error!.message).not.toContain('never started')
      expect(trackCalls).toHaveLength(0)
    })

    it('records a failed callee turn as failed', async () => {
      fakeCallee()
      trackResult = async () => ({ outcome: 'complete', status: 'failed', text: '', assistantMessageId: null })
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-tf', wait: false, track: true })
      const rec = await settled('run-tf')
      expect(rec).toMatchObject({ status: 'failed', error: { code: 'agent_turn_failed' } })
    })

    it('records failed with the runtime error', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { code: 'agent_turn_failed', message: 'boom' } }), { status: 500 })) as any
      await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', { message: 'job', runId: 'run-t2', wait: false, track: true })
      const rec = await settled('run-t2')
      expect(rec).toMatchObject({ status: 'failed', error: { code: 'agent_turn_failed', message: 'boom' } })
    })

    it('tracks calls with an explicit sessionId too, without creating a chat', async () => {
      let forwarded: any = null
      globalThis.fetch = (async (_url: any, init: any) => {
        forwarded = JSON.parse(init.body)
        return new Response(JSON.stringify({ status: 'completed', reply: 'ok' }), { status: 200 })
      }) as any
      const out = await svc.callProjectAgentAsChat(FAKE_CTX, 'proj-1', 'ws-1', {
        message: 'job', runId: 'run-t3', sessionId: 'custom', wait: false, track: true,
      })
      expect(out.body).toMatchObject({ tracked: true, sessionId: 'custom' })
      expect(out.body.chatSessionId).toBeUndefined()
      const rec = await settled('run-t3')
      expect(rec).toMatchObject({ status: 'completed', sessionId: 'custom' })
      expect(forwarded).toMatchObject({ sessionId: 'custom', wait: true })
      expect(sessions.size).toBe(0)
    })
  })

  /**
   * The reported bug: a finished call leaves its prompt in the callee chat with
   * no answer. The tracker owns the reply row when it saw the turn — every
   * other terminal outcome has to leave an answer behind.
   */
  describe('a terminal call always leaves an answer in its chat', () => {
    const chatId = 'chat-settle-1'
    const link = { projectId: 'proj-1', runId: 'run-settle', startedAt: Date.now() }

    function seedPrompt() {
      sessions.set(chatId, { id: chatId, cachedMessageCount: 1 })
      messages.push({
        sessionId: chatId,
        role: 'user',
        agent: 'project_call',
        content: 'do it',
        parts: JSON.stringify([
          { type: 'text', text: 'do it' },
          { type: 'data-project-call', data: { runId: 'run-settle', callerName: 'Caller' } },
        ]),
        createdAt: new Date(),
      })
    }

    const assistantRows = () => messages.filter((m) => m.role === 'assistant')

    it("writes the tracker's text when the tracker persisted no row", async () => {
      seedPrompt()
      fakeCallee()

      await svc.settleAgentCallFromTurn(link, chatId, {
        outcome: 'complete', status: 'completed', text: 'the answer', assistantMessageId: null,
      })

      expect(assistantRows()).toHaveLength(1)
      expect(assistantRows()[0]).toMatchObject({ agent: 'technical', content: 'the answer' })
      expect(JSON.parse(assistantRows()[0].parts)).toEqual([{ type: 'text', text: 'the answer' }])
      expect(sessions.get(chatId)?.cachedMessageCount).toBe(2)
    })

    it('does not write a second row when the tracker already persisted one', async () => {
      seedPrompt()
      fakeCallee()

      await svc.settleAgentCallFromTurn(link, chatId, {
        outcome: 'complete', status: 'completed', text: 'the answer', assistantMessageId: 'msg-1',
      })

      expect(assistantRows()).toHaveLength(0)
    })

    it('recovers the reply from the runtime turn record when this side saw no text', async () => {
      seedPrompt()
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ status: 'completed', reply: 'from the turn record' }), { status: 200 })) as any

      await svc.settleAgentCallFromTurn(link, chatId, null)

      expect(assistantRows()).toHaveLength(1)
      expect(assistantRows()[0].content).toBe('from the turn record')
      expect(await agentCallStore.getAgentCall('proj-1', 'run-settle')).toMatchObject({
        status: 'failed',
        error: { code: svc.CALLEE_TURN_LOST },
      })
    })

    it('writes an explicit failure row when the turn produced no text at all', async () => {
      seedPrompt()
      globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'unknown' }), { status: 404 })) as any

      await svc.settleAgentCallFromTurn(link, chatId, {
        outcome: 'complete', status: 'failed', text: '', assistantMessageId: null,
      })

      expect(assistantRows()).toHaveLength(1)
      expect(assistantRows()[0].content).toContain('ended before its reply could be saved')
      expect(assistantRows()[0].agent).toBe('technical')
    })

    it('is idempotent: settling the same turn twice writes one row', async () => {
      seedPrompt()
      fakeCallee()
      const result = { outcome: 'complete' as const, status: 'completed' as const, text: 'once', assistantMessageId: null }

      await svc.settleAgentCallFromTurn(link, chatId, result)
      await svc.settleAgentCallFromTurn(link, chatId, result)

      expect(assistantRows()).toHaveLength(1)
    })
  })
})
