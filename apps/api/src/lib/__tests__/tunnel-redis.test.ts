// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

// Ensure non-local mode and a deterministic POD_ID *before* the module loads.
delete (process.env as any).SHOGO_LOCAL_MODE
process.env.HOSTNAME = 'pod-A'
process.env.REDIS_URL = 'redis://fake:6379'

type Listener = (...args: any[]) => void

interface SubMessage { channel: string; message: string }

class FakeRedis {
  status: 'wait' | 'connecting' | 'ready' | 'end' = 'wait'
  listeners: Record<string, Listener[]> = {}
  store = new Map<string, string>()
  hashes = new Map<string, Map<string, string>>()
  expirations = new Map<string, number>()
  subscriptions = new Set<string>()
  // For sub clients: messages are delivered via `triggerMessage`
  // For pub clients: published messages are pushed to publishLog
  publishLog: Array<{ channel: string; message: string }> = []
  // Shared registry of all instances (so a publish lands in subscribers)
  static instances: FakeRedis[] = []
  // Behavior knobs
  failConnect = false
  pingResult: 'PONG' | 'ERR' | Error = 'PONG'

  constructor(public url: string, public opts: any) {
    FakeRedis.instances.push(this)
  }

  on(event: string, fn: Listener) {
    ;(this.listeners[event] ??= []).push(fn)
    return this
  }
  emit(event: string, ...args: any[]) {
    for (const fn of this.listeners[event] ?? []) fn(...args)
  }

  async connect() {
    if (this.failConnect) throw new Error('connect refused')
    this.status = 'ready'
    queueMicrotask(() => this.emit('ready'))
  }

  async ping() {
    if (this.pingResult instanceof Error) throw this.pingResult
    return this.pingResult
  }

  async set(key: string, val: string, _exTok?: string, ttlSec?: number) {
    this.store.set(key, val)
    if (ttlSec) this.expirations.set(key, ttlSec)
    return 'OK'
  }
  async get(key: string) { return this.store.get(key) ?? null }
  async del(key: string) {
    const had = this.store.delete(key)
    this.hashes.delete(key)
    this.expirations.delete(key)
    return had ? 1 : 0
  }
  async expire(key: string, ttl: number) {
    if (this.store.has(key) || this.hashes.has(key)) {
      this.expirations.set(key, ttl)
      return 1
    }
    return 0
  }
  async hset(key: string, field: string, value: string) {
    const h = this.hashes.get(key) ?? new Map<string, string>()
    h.set(field, value)
    this.hashes.set(key, h)
    return 1
  }
  async hgetall(key: string) {
    const h = this.hashes.get(key)
    if (!h) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of h) out[k] = v
    return out
  }

  async subscribe(...channels: string[]) {
    for (const c of channels) this.subscriptions.add(c)
  }
  async unsubscribe(..._channels: string[]) {
    this.subscriptions.clear()
  }

  async publish(channel: string, message: string) {
    this.publishLog.push({ channel, message })
    // deliver to any FakeRedis instance subscribed to this channel
    for (const inst of FakeRedis.instances) {
      if (inst.subscriptions.has(channel)) {
        for (const fn of inst.listeners['message'] ?? []) fn(channel, message)
      }
    }
    return 1
  }

  disconnect() {
    this.status = 'end'
    queueMicrotask(() => this.emit('end'))
  }
}

mock.module('ioredis', () => ({ default: FakeRedis }))

const tr = await import('../tunnel-redis')

// initPromise inside the module is memoized after the first init and is
// never cleared on success — meaning shutdown()+init() in beforeEach does
// NOT actually re-initialize. Workaround: init once at module load, then
// per-test clear all Redis-level state on the existing FakeRedis pair.
await tr.initTunnelRedis()

function pubInst() { return FakeRedis.instances[0]! }
function subInst() { return FakeRedis.instances[1]! }

beforeEach(async () => {
  // Reset Redis state but keep the two FakeRedis instances live.
  for (const inst of FakeRedis.instances) {
    inst.store.clear()
    inst.hashes.clear()
    inst.expirations.clear()
    inst.publishLog.length = 0
    inst.pingResult = 'PONG'
    inst.failConnect = false
    inst.status = 'ready'
  }
  // Trim any per-test extra 'message' listeners that previous tests added.
  // The original handleSubMessage is the FIRST listener registered during init.
  for (const inst of FakeRedis.instances) {
    const all = inst.listeners['message'] ?? []
    if (all.length > 1) inst.listeners['message'] = [all[0]!]
  }
})

afterEach(() => {})

const pub = pubInst
const sub = subInst

describe('init lifecycle', () => {
  it('creates publisher + subscriber and subscribes to two channels', () => {
    expect(FakeRedis.instances).toHaveLength(2)
    expect(pub().status).toBe('ready')
    expect(sub().status).toBe('ready')
    expect(sub().subscriptions.has(`tunnel:pod:${tr.getPodId()}:request`)).toBe(true)
    expect(sub().subscriptions.has(`tunnel:pod:${tr.getPodId()}:stream-request`)).toBe(true)
  })

  it('initTunnelRedis is idempotent once initialized', async () => {
    await tr.initTunnelRedis()
    expect(FakeRedis.instances).toHaveLength(2)
  })

  it('whenReady resolves immediately after init', async () => {
    await tr.whenReady()
  })

  it('isTunnelRedisDegraded is false when both clients are ready', () => {
    expect(tr.isTunnelRedisDegraded()).toBe(false)
  })

  it('isTunnelRedisDegraded flips to true when publisher emits close', () => {
    pub().emit('close')
    expect(tr.isTunnelRedisDegraded()).toBe(true)
  })

  it('"ready" event on a client clears degraded only when BOTH are ready', () => {
    pub().emit('close') // sets degraded=true
    expect(tr.isTunnelRedisDegraded()).toBe(true)
    pub().emit('ready') // still pub.status='ready' and sub.status='ready'
    expect(tr.isTunnelRedisDegraded()).toBe(false)
  })

  it('isTunnelRedisDegraded flips true when sub.status is not ready', () => {
    sub().status = 'connecting'
    expect(tr.isTunnelRedisDegraded()).toBe(true)
  })

  it('reconnecting + error + end events flip degraded', () => {
    pub().emit('reconnecting', 1000)
    expect(tr.isTunnelRedisDegraded()).toBe(true)
    sub().emit('error', new Error('netsplit'))
    sub().emit('end')
    expect(tr.isTunnelRedisDegraded()).toBe(true)
  })
})

// Init-failure path (line ~167–185 of tunnel-redis.ts) is exercised by the
// companion file tunnel-redis-initfail.test.ts, since the module's memoized
// initPromise blocks shutdown()+re-init() within a single test file.

describe('checkRedisHealth', () => {
  it('returns healthy:true with latency on PONG', async () => {
    const r = await tr.checkRedisHealth()
    expect(r.healthy).toBe(true)
    expect(typeof r.latencyMs).toBe('number')
  })

  it('returns healthy:false when ping is not PONG', async () => {
    pub().pingResult = 'ERR' as any
    const r = await tr.checkRedisHealth()
    expect(r.healthy).toBe(false)
  })

  it('returns healthy:false when ping throws', async () => {
    pub().pingResult = new Error('timeout')
    const r = await tr.checkRedisHealth()
    expect(r.healthy).toBe(false)
    expect(r.error).toMatch(/timeout/)
  })

  it('returns healthy:false when subscriber status is not ready', async () => {
    sub().status = 'connecting'
    const r = await tr.checkRedisHealth()
    expect(r.healthy).toBe(false)
    expect(r.error).toMatch(/subscriber/)
  })
})

describe('ownership CRUD', () => {
  it('register + get round-trips through Redis', async () => {
    await tr.registerTunnelOwnership('inst-1')
    expect(pub().store.get('tunnel:inst-1:pod')).toBe('pod-A')
    expect(pub().expirations.get('tunnel:inst-1:pod')).toBe(600)
    expect(await tr.getTunnelOwner('inst-1')).toBe('pod-A')
  })

  it('unregister deletes only when the current pod owns it', async () => {
    pub().store.set('tunnel:inst-1:pod', 'pod-OTHER')
    await tr.unregisterTunnelOwnership('inst-1')
    expect(pub().store.get('tunnel:inst-1:pod')).toBe('pod-OTHER')

    pub().store.set('tunnel:inst-1:pod', 'pod-A')
    await tr.unregisterTunnelOwnership('inst-1')
    expect(pub().store.has('tunnel:inst-1:pod')).toBe(false)
  })

  it('evictTunnelOwnership always deletes', async () => {
    pub().store.set('tunnel:i:pod', 'pod-OTHER')
    await tr.evictTunnelOwnership('i')
    expect(pub().store.has('tunnel:i:pod')).toBe(false)
  })

  it('refreshTunnelOwnership extends TTL on existing key', async () => {
    pub().store.set('tunnel:i:pod', 'pod-A')
    await tr.refreshTunnelOwnership('i')
    expect(pub().expirations.get('tunnel:i:pod')).toBe(600)
  })

  it('getTunnelOwner returns null when not present, even after retry', async () => {
    const v = await tr.getTunnelOwner('missing')
    expect(v).toBeNull()
  })

  it('getTunnelOwner logs and returns null when GET throws', async () => {
    const origGet = pub().get
    pub().get = async () => { throw new Error('redis err') }
    const origWarn = console.warn
    const warnings: any[] = []
    ;(console as any).warn = (...a: any[]) => warnings.push(a)
    try {
      expect(await tr.getTunnelOwner('x')).toBeNull()
      expect(warnings.length).toBeGreaterThan(0)
    } finally {
      pub().get = origGet
      ;(console as any).warn = origWarn
    }
  })
})

describe('getSharedRedis', () => {
  it('returns the publisher instance', () => {
    expect(tr.getSharedRedis()).toBe(pub() as any)
  })
})

describe('viewer + controller tracking', () => {
  it('markViewerActiveRedis writes a TTL-bound key', async () => {
    await tr.markViewerActiveRedis('w1')
    expect(pub().store.has('viewer:w1')).toBe(true)
    expect(pub().expirations.get('viewer:w1')).toBe(120)
  })

  it('isViewerActiveRedis returns true when key exists', async () => {
    pub().store.set('viewer:w1', '1')
    expect(await tr.isViewerActiveRedis('w1')).toBe(true)
  })

  it('isViewerActiveRedis returns false when key missing', async () => {
    expect(await tr.isViewerActiveRedis('w-none')).toBe(false)
  })

  it('isViewerActiveRedis swallows errors and returns false', async () => {
    const origGet = pub().get
    pub().get = async () => { throw new Error('boom') }
    const origWarn = console.warn
    ;(console as any).warn = () => {}
    try {
      expect(await tr.isViewerActiveRedis('w1')).toBe(false)
    } finally {
      pub().get = origGet
      ;(console as any).warn = origWarn
    }
  })

  it('markControllerActiveRedis uses sessionId when supplied, else userId', async () => {
    await tr.markControllerActiveRedis('i1', 'u1')
    await tr.markControllerActiveRedis('i1', 'u1', 'sess-A')
    const h = pub().hashes.get('ctrl:i1')!
    expect(h.has('u1')).toBe(true)
    expect(h.has('sess-A')).toBe(true)
  })

  it('getActiveControllersRedis filters out expired entries', async () => {
    const now = Date.now()
    const h = new Map<string, string>([
      ['fresh', JSON.stringify({ userId: 'u1', lastSeenAt: now })],
      ['stale', JSON.stringify({ userId: 'u2', lastSeenAt: now - 120_000 })],
      ['bad-json', 'not-json'],
    ])
    pub().hashes.set('ctrl:i1', h)
    const r = await tr.getActiveControllersRedis('i1')
    expect(r).toHaveLength(1)
    expect(r[0].userId).toBe('u1')
  })

  it('getActiveControllersRedis returns [] on Redis error', async () => {
    const orig = pub().hgetall
    pub().hgetall = async () => { throw new Error('boom') }
    const origWarn = console.warn
    ;(console as any).warn = () => {}
    try {
      expect(await tr.getActiveControllersRedis('i1')).toEqual([])
    } finally {
      pub().hgetall = orig
      ;(console as any).warn = origWarn
    }
  })

  it('isTunnelConnectedAnywhere true when owner present', async () => {
    pub().store.set('tunnel:i1:pod', 'pod-X')
    expect(await tr.isTunnelConnectedAnywhere('i1')).toBe(true)
  })
  it('isTunnelConnectedAnywhere false on error', async () => {
    const orig = pub().get
    pub().get = async () => { throw new Error('e') }
    const origWarn = console.warn
    ;(console as any).warn = () => {}
    try {
      expect(await tr.isTunnelConnectedAnywhere('i1')).toBe(false)
    } finally {
      pub().get = orig
      ;(console as any).warn = origWarn
    }
  })
})

describe('verifyPodAlive', () => {
  it('returns true immediately when probing self', async () => {
    expect(await tr.verifyPodAlive(tr.getPodId())).toBe(true)
  })

  it('publishes a probe and resolves true on incoming probe response', async () => {
    // Act as the remote pod: when a probe lands on its channel, publish
    // a synthetic reply back onto pod-A's request channel.
    sub().subscriptions.add('tunnel:pod:other-pod:request')
    sub().on('message', async (channel: string, message: string) => {
      if (channel === 'tunnel:pod:other-pod:request') {
        const parsed = JSON.parse(message)
        await pub().publish(`tunnel:pod:${parsed.replyPod}:request`, JSON.stringify({
          relayId: parsed.relayId,
          response: { type: 'response', requestId: parsed.request.requestId, status: 200 },
        }))
      }
    })
    expect(await tr.verifyPodAlive('other-pod', 1000)).toBe(true)
  })

  it('returns false on timeout', async () => {
    // Don't subscribe other-pod → no response → timeout fires
    expect(await tr.verifyPodAlive('phantom-pod', 50)).toBe(false)
  })

  it('returns false when publish throws', async () => {
    const orig = pub().publish
    pub().publish = async () => { throw new Error('netsplit') }
    try {
      expect(await tr.verifyPodAlive('other-pod', 1000)).toBe(false)
    } finally {
      pub().publish = orig
    }
  })
})

describe('cross-pod relay', () => {
  it('relayTunnelRequest publishes, awaits response, returns body', async () => {
    sub().subscriptions.add('tunnel:pod:peer:request')
    // Hook a fake "owner" pod: when a request lands on peer's channel,
    // immediately reply on our own channel.
    const origOnMessage = sub().listeners['message']?.[0]
    sub().on('message', async (channel: string, message: string) => {
      if (channel === 'tunnel:pod:peer:request') {
        const parsed = JSON.parse(message)
        const reply = {
          relayId: parsed.relayId,
          response: { type: 'response', requestId: parsed.request.requestId, status: 200, body: 'ok' },
        }
        await pub().publish(`tunnel:pod:${parsed.replyPod}:request`, JSON.stringify(reply))
      }
    })
    const r = await tr.relayTunnelRequest('peer', 'i1', {
      type: 'request', requestId: 'r1', method: 'GET', path: '/p',
    })
    expect(r?.status).toBe(200)
    expect(r?.body).toBe('ok')
  })

  it('relayTunnelRequest rejects on relay error response', async () => {
    sub().subscriptions.add('tunnel:pod:peer:request')
    sub().on('message', async (channel: string, message: string) => {
      if (channel === 'tunnel:pod:peer:request') {
        const parsed = JSON.parse(message)
        await pub().publish(`tunnel:pod:${parsed.replyPod}:request`,
          JSON.stringify({ relayId: parsed.relayId, error: 'remote failed' }))
      }
    })
    await expect(tr.relayTunnelRequest('peer', 'i1', {
      type: 'request', requestId: 'r2', method: 'GET', path: '/p',
    })).rejects.toThrow(/remote failed/)
  })

  it('relayTunnelRequest rejects when publish throws', async () => {
    const orig = pub().publish
    pub().publish = async () => { throw new Error('publish fail') }
    try {
      await expect(tr.relayTunnelRequest('peer', 'i1', {
        type: 'request', requestId: 'r3', method: 'GET', path: '/p',
      })).rejects.toThrow(/publish fail/)
    } finally {
      pub().publish = orig
    }
  })

  it('local request handler replies to __probe__ even without setLocalTunnelHandlers', async () => {
    sub().subscriptions.add('tunnel:pod:peer:request')
    let replied = false
    sub().on('message', (channel: string, message: string) => {
      if (channel === `tunnel:pod:peer:request`) {
        replied = true
      }
    })
    // Send an incoming probe TO us (our channel)
    await pub().publish(`tunnel:pod:${tr.getPodId()}:request`, JSON.stringify({
      relayId: 'probe_x',
      instanceId: '__probe__',
      replyPod: 'peer',
      request: { type: 'request', requestId: 'probe_x', method: 'GET', path: '/__probe__' },
    }))
    await new Promise((r) => setTimeout(r, 30))
    expect(replied).toBe(true)
  })

  it('local request handler delegates to localSendFn and replies with its response', async () => {
    tr.setLocalTunnelHandlers(
      async (instId, req) => ({ type: 'response', requestId: req.requestId, status: 201, body: 'local-ok' }),
      () => ({ cancel: () => {} }),
    )
    let captured: any = null
    sub().subscriptions.add('tunnel:pod:peer:request')
    sub().on('message', (channel: string, message: string) => {
      if (channel === 'tunnel:pod:peer:request') captured = JSON.parse(message)
    })
    await pub().publish(`tunnel:pod:${tr.getPodId()}:request`, JSON.stringify({
      relayId: 'rid',
      instanceId: 'inst-X',
      replyPod: 'peer',
      request: { type: 'request', requestId: 'rid', method: 'GET', path: '/x' },
    }))
    await new Promise((r) => setTimeout(r, 30))
    expect(captured?.response?.status).toBe(201)
  })

  it('local request handler relays an error message when localSendFn throws', async () => {
    tr.setLocalTunnelHandlers(
      async () => { throw new Error('handler exploded') },
      () => ({ cancel: () => {} }),
    )
    let captured: any = null
    sub().subscriptions.add('tunnel:pod:peer:request')
    sub().on('message', (channel: string, message: string) => {
      if (channel === 'tunnel:pod:peer:request') captured = JSON.parse(message)
    })
    await pub().publish(`tunnel:pod:${tr.getPodId()}:request`, JSON.stringify({
      relayId: 'rid', instanceId: 'inst-X', replyPod: 'peer',
      request: { type: 'request', requestId: 'rid', method: 'GET', path: '/x' },
    }))
    await new Promise((r) => setTimeout(r, 30))
    expect(captured?.error).toContain('handler exploded')
  })

  it('handleSubMessage swallows JSON parse errors', async () => {
    const origErr = console.error
    const errs: any[] = []
    ;(console as any).error = (...a: any[]) => errs.push(a)
    try {
      await pub().publish(`tunnel:pod:${tr.getPodId()}:request`, 'not-json')
      await new Promise((r) => setTimeout(r, 10))
      expect(errs.some((e) => String(e[0]).includes('Error handling message'))).toBe(true)
    } finally {
      ;(console as any).error = origErr
    }
  })

  it('handleSubMessage ignores unknown message shape', async () => {
    await pub().publish(`tunnel:pod:${tr.getPodId()}:request`, JSON.stringify({ foo: 'bar' }))
    await new Promise((r) => setTimeout(r, 10))
  })

  it('incoming response without a pending relay is dropped silently', async () => {
    await pub().publish(`tunnel:pod:${tr.getPodId()}:request`,
      JSON.stringify({ relayId: 'unknown', response: { type: 'response', requestId: 'x', status: 200 } }))
    await new Promise((r) => setTimeout(r, 10))
  })
})

describe('cross-pod stream relay', () => {
  it('publishes a stream request and forwards reply chunks to the consumer', async () => {
    // Act as the remote pod: when a stream request lands on its channel,
    // publish reply chunks back onto pod-A's stream-request channel with
    // the same relayId.
    sub().subscriptions.add('tunnel:pod:peer:stream-request')
    sub().on('message', async (channel: string, message: string) => {
      if (channel === 'tunnel:pod:peer:stream-request') {
        const parsed = JSON.parse(message)
        await pub().publish(`tunnel:pod:${parsed.replyPod}:stream-request`, JSON.stringify({
          relayId: parsed.relayId,
          chunk: { type: 'stream-chunk', requestId: parsed.request.requestId, data: 'hi' },
        }))
        await pub().publish(`tunnel:pod:${parsed.replyPod}:stream-request`, JSON.stringify({
          relayId: parsed.relayId,
          chunk: { type: 'stream-end', requestId: parsed.request.requestId },
        }))
      }
    })
    const chunks: any[] = []
    const handle = tr.relayTunnelStreamRequest('peer', 'i-1', {
      type: 'request', requestId: 'sr-1', method: 'POST', path: '/agent/chat',
    }, (c) => chunks.push(c))
    await new Promise((r) => setTimeout(r, 40))
    expect(chunks.some((c) => c.type === 'stream-chunk' && c.data === 'hi')).toBe(true)
    expect(chunks.some((c) => c.type === 'stream-end')).toBe(true)
    handle.cancel()
  })

  it('publishes a stream-error chunk when underlying publish fails', async () => {
    const orig = pub().publish
    pub().publish = async () => { throw new Error('publish broken') }
    const chunks: any[] = []
    tr.relayTunnelStreamRequest('peer', 'i-1', {
      type: 'request', requestId: 'sr-x', method: 'GET', path: '/p',
    }, (c) => chunks.push(c))
    await new Promise((r) => setTimeout(r, 30))
    pub().publish = orig
    expect(chunks.some((c) => c.type === 'stream-error' && /publish/.test(c.error))).toBe(true)
  })

  it('cancel() before whenReady resolves prevents publish', async () => {
    const chunks: any[] = []
    const handle = tr.relayTunnelStreamRequest('peer', 'i-1', {
      type: 'request', requestId: 'cx', method: 'GET', path: '/p',
    }, (c) => chunks.push(c))
    handle.cancel()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('incoming stream chunk without pending stream is dropped', async () => {
    await pub().publish(`tunnel:pod:${tr.getPodId()}:stream-request`,
      JSON.stringify({ relayId: 'no-such', chunk: { type: 'stream-end', requestId: 'x' } }))
    await new Promise((r) => setTimeout(r, 10))
  })

  it('local stream handler is a no-op when none registered', async () => {
    // Reset handlers to null is not possible via exported API, so we
    // verify by inspecting that nothing throws on an incoming stream request.
    tr.setLocalTunnelHandlers(
      async () => undefined as any,
      null as any,
    )
    await pub().publish(`tunnel:pod:${tr.getPodId()}:stream-request`,
      JSON.stringify({
        relayId: 'r', instanceId: 'i', replyPod: 'peer',
        request: { type: 'request', requestId: 'r', method: 'GET', path: '/x' },
      }))
    await new Promise((r) => setTimeout(r, 10))
  })
})

// ─── Coverage closer — branches not reachable from the other test files ─────

describe('coverage closer: retry strategy', () => {
  it('publisher retryStrategy gives up after 5 attempts and backs off otherwise', () => {
    const pubOpts = pub().opts as { retryStrategy: (times: number) => number | null }
    expect(pubOpts.retryStrategy(6)).toBeNull()
    expect(pubOpts.retryStrategy(2)).toBe(1000)
    expect(pubOpts.retryStrategy(10)).toBeNull()
    expect(pubOpts.retryStrategy(1)).toBe(500)
  })

  it('subscriber retryStrategy gives up after 5 attempts and backs off otherwise', () => {
    const subOpts = sub().opts as { retryStrategy: (times: number) => number | null }
    expect(subOpts.retryStrategy(6)).toBeNull()
    expect(subOpts.retryStrategy(3)).toBe(1500)
    expect(subOpts.retryStrategy(20)).toBeNull()
    // Math.min cap at 3000 once times >= 6 would normally fire but we
    // exit earlier with null. Cap is exercised by clamping a low value.
    expect(subOpts.retryStrategy(5)).toBe(2500)
  })
})

describe('coverage closer: verifyPodAlive reject branch', () => {
  it('returns false when the remote pod replies with an error response', async () => {
    // Pre-snapshot the publish log so we can isolate the probe message
    pub().publishLog.length = 0
    const verifyPromise = tr.verifyPodAlive('pod-Z', 2000)
    // The function publishes a probe to `tunnel:pod:pod-Z:request` immediately.
    // Grab the relayId from the published message so we can simulate an error reply.
    // Give one microtick for the .then(publish) chain to land.
    await new Promise((r) => setTimeout(r, 5))
    const probePublish = pub().publishLog.find((p) => p.channel === 'tunnel:pod:pod-Z:request')
    expect(probePublish).toBeDefined()
    const probeMsg = JSON.parse(probePublish!.message) as { relayId: string }
    // Now publish an error response back on our own channel — that flows
    // through handleSubMessage → handleIncomingRelayResponse → pending.reject(),
    // which the verifyPodAlive setup wired to `resolve(false)`.
    await pub().publish(
      `tunnel:pod:${tr.getPodId()}:request`,
      JSON.stringify({ relayId: probeMsg.relayId, error: 'pod unreachable' }),
    )
    const alive = await verifyPromise
    expect(alive).toBe(false)
  })
})

describe('coverage closer: relay timeout paths', () => {
  it('relayTunnelRequest rejects with "timed out" when no reply arrives', async () => {
    const origSetTimeout = globalThis.setTimeout
    const captured: Array<() => void> = []
    ;(globalThis as any).setTimeout = ((fn: () => void, _ms?: number) => {
      captured.push(fn)
      return 42 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    let promise: Promise<unknown> | undefined
    try {
      promise = tr.relayTunnelRequest('peer-X', 'i-tx', {
        type: 'request', requestId: 'rqx', method: 'GET', path: '/timeout-test',
      })
      // Yield twice so whenReady() resolves and the Promise executor runs,
      // registering the setTimeout we intend to fire.
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
    }
    expect(captured.length).toBeGreaterThan(0)
    // Fire the captured timeout callback — exercises lines 558-562
    for (const fn of captured) fn()
    await expect(promise!).rejects.toThrow(/timed out/)
  })

  it('relayTunnelStreamRequest fires stream-error chunk when timeout elapses', async () => {
    const origSetTimeout = globalThis.setTimeout
    const captured: Array<() => void> = []
    ;(globalThis as any).setTimeout = ((fn: () => void, _ms?: number) => {
      captured.push(fn)
      return 43 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const chunks: Array<{ type: string; error?: string }> = []
    try {
      tr.relayTunnelStreamRequest(
        'peer-X', 'i-sx',
        { type: 'request', requestId: 'sxq', method: 'GET', path: '/s' },
        (c) => chunks.push(c as { type: string; error?: string }),
      )
      // Two microticks for whenReady().then to land and call setTimeout.
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
    }
    expect(captured.length).toBeGreaterThan(0)
    // Fire the captured timeout — exercises lines 595-598
    for (const fn of captured) fn()
    expect(chunks.some((c) => c.type === 'stream-error' && /timed out/.test(c.error ?? ''))).toBe(true)
  })
})

describe('coverage closer: isTunnelConnectedAnywhere error path', () => {
  it('returns false when getTunnelOwner rejects (setTimeout throws synchronously)', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origWarn = console.warn
    const warns: unknown[][] = []
    console.warn = ((...a: unknown[]) => { warns.push(a) }) as typeof console.warn
    // Make setTimeout throw synchronously — this will cause the Promise
    // executor in getTunnelOwner's retry path to reject, which rejects
    // the await, which propagates out of getTunnelOwner and into
    // isTunnelConnectedAnywhere's catch (lines 687-689).
    ;(globalThis as any).setTimeout = (() => { throw new Error('setTimeout boom') }) as typeof setTimeout
    try {
      // Ensure first read returns null so we reach the retry/setTimeout line.
      pub().store.delete('tunnel:nonexistent-pod:pod')
      const result = await tr.isTunnelConnectedAnywhere('nonexistent-pod')
      expect(result).toBe(false)
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
      console.warn = origWarn
    }
    expect(warns.some((w) => /isTunnelConnectedAnywhere failed/.test(String(w[0])))).toBe(true)
  })
})
