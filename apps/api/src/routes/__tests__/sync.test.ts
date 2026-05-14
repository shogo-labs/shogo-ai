// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let memberImpl: (args: any) => Promise<any | null> = async () => null

mock.module('../../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async (args: any) => memberImpl(args),
    },
  },
}))

interface Captured {
  publishCalls: any[]
  replayCalls: any[]
}

const captured: Captured = { publishCalls: [], replayCalls: [] }
let replayImpl: (args: any) => any = (_args) => ({
  events: [],
  cursor: 0,
  hasMore: false,
})

mock.module('../../lib/sync-engine', () => ({
  getSyncEngine: () => ({
    publish: (ev: any) => {
      captured.publishCalls.push(ev)
      ev.serverTimestamp = Date.now()
    },
    replayEvents: (args: any) => {
      captured.replayCalls.push(args)
      return replayImpl(args)
    },
  }),
}))

const { syncRoutes } = await import('../sync')

function makeRequest(
  path: string,
  opts: { method?: string; body?: any; auth?: any } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  })
}

async function run(req: Request, auth: any = undefined) {
  // Wrap syncRoutes() in a parent app so we can inject auth via
  // middleware that runs BEFORE the route handlers. (In Hono,
  // middleware registered after routes on the same app doesn't run.)
  const { Hono } = await import('hono')
  const parent = new Hono()
  parent.use('*', async (c, next) => {
    c.set('auth', auth)
    await next()
  })
  parent.route('/', syncRoutes())
  return parent.fetch(req)
}

beforeEach(() => {
  memberImpl = async () => null
  captured.publishCalls = []
  captured.replayCalls = []
  replayImpl = () => ({ events: [], cursor: 0, hasMore: false })
})

afterEach(() => {})

describe('GET /sync — catch-up', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await run(makeRequest('/sync?workspaceId=w&since=0'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
  })

  it('returns 401 when auth has no userId', async () => {
    const res = await run(makeRequest('/sync?workspaceId=w&since=0'), {})
    expect(res.status).toBe(401)
  })

  it('returns 400 when workspaceId is missing', async () => {
    const res = await run(makeRequest('/sync?since=0'), { userId: 'u-1' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('invalid_request')
  })

  it('returns 400 when since is missing', async () => {
    const res = await run(makeRequest('/sync?workspaceId=w'), { userId: 'u-1' })
    expect(res.status).toBe(400)
  })

  it('returns 403 when user is not a workspace member', async () => {
    memberImpl = async () => null
    const res = await run(makeRequest('/sync?workspaceId=w&since=0'), { userId: 'u-1' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('forbidden')
  })

  it('returns 400 when since is not a valid number', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const res = await run(makeRequest('/sync?workspaceId=w&since=notanumber'), {
      userId: 'u-1',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('since must be a valid timestamp')
  })

  it('returns events from the sync engine on the happy path', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    replayImpl = () => ({
      events: [{ id: 'e-1' }, { id: 'e-2' }],
      cursor: 12345,
      hasMore: true,
    })
    const res = await run(makeRequest('/sync?workspaceId=w-1&since=1000&limit=10'), {
      userId: 'u-1',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.events).toHaveLength(2)
    expect(body.cursor).toBe(12345)
    expect(body.hasMore).toBe(true)
    expect(captured.replayCalls[0]).toEqual({ workspaceId: 'w-1', since: 1000, limit: 10 })
  })

  it('defaults limit to 500 when omitted', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    await run(makeRequest('/sync?workspaceId=w&since=0'), { userId: 'u-1' })
    expect(captured.replayCalls[0].limit).toBe(500)
  })

  it('queries member with the user+workspace pair', async () => {
    let capturedWhere: any = null
    memberImpl = async (args) => {
      capturedWhere = args.where
      return { id: 'm-1' }
    }
    await run(makeRequest('/sync?workspaceId=ws-99&since=0'), { userId: 'user-99' })
    expect(capturedWhere).toEqual({ userId: 'user-99', workspaceId: 'ws-99' })
  })
})

describe('POST /sync/events — publish', () => {
  const validBody = {
    type: 'PROJECT_CREATED',
    entityId: 'p-1',
    payload: { foo: 'bar' },
    source: 'web',
    workspaceId: 'w-1',
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await run(makeRequest('/sync/events', { method: 'POST', body: validBody }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when required field is missing (type)', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const { type: _drop, ...without } = validBody
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: without }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when entityId is missing', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const { entityId: _, ...without } = validBody
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: without }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when payload is missing', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const { payload: _, ...without } = validBody
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: without }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when source is missing', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const { source: _, ...without } = validBody
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: without }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when workspaceId is missing', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const { workspaceId: _, ...without } = validBody
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: without }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(400)
  })

  it('returns 403 when not a member of the workspace', async () => {
    memberImpl = async () => null
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(403)
  })

  it('publishes the event on the happy path and returns ok with eventId', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const res = await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.serverTimestamp).toBeGreaterThan(0)
    expect(captured.publishCalls).toHaveLength(1)
    expect(captured.publishCalls[0].userId).toBe('u-1')
    expect(captured.publishCalls[0].type).toBe('PROJECT_CREATED')
    expect(captured.publishCalls[0].workspaceId).toBe('w-1')
  })

  it('stamps userId from auth (ignores any user-supplied userId)', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    await run(
      makeRequest('/sync/events', {
        method: 'POST',
        body: { ...validBody, userId: 'attacker' as any },
      }),
      { userId: 'real-user' },
    )
    expect(captured.publishCalls[0].userId).toBe('real-user')
  })

  it('defaults version to 1 when not provided', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    expect(captured.publishCalls[0].version).toBe(1)
  })

  it('honours explicit version when provided', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    await run(
      makeRequest('/sync/events', {
        method: 'POST',
        body: { ...validBody, version: 42 },
      }),
      { userId: 'u-1' },
    )
    expect(captured.publishCalls[0].version).toBe(42)
  })

  it('passes through instanceId when provided', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    await run(
      makeRequest('/sync/events', {
        method: 'POST',
        body: { ...validBody, instanceId: 'inst-99' },
      }),
      { userId: 'u-1' },
    )
    expect(captured.publishCalls[0].instanceId).toBe('inst-99')
  })

  it('stamps a fresh timestamp at publish time', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const before = Date.now()
    await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    const after = Date.now()
    expect(captured.publishCalls[0].timestamp).toBeGreaterThanOrEqual(before)
    expect(captured.publishCalls[0].timestamp).toBeLessThanOrEqual(after)
  })

  it('generates UUID v4 ids', async () => {
    memberImpl = async () => ({ id: 'm-1' })
    const a = await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    const b = await run(
      makeRequest('/sync/events', { method: 'POST', body: validBody }),
      { userId: 'u-1' },
    )
    const ids = [(await a.json()).eventId, (await b.json()).eventId]
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('factory', () => {
  it('returns a Hono router instance on each call', () => {
    const a = syncRoutes()
    const b = syncRoutes()
    expect(a).not.toBe(b)
  })
})
