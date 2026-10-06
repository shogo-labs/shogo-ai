// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  apnsConfigFromEnv,
  apnsRequest,
  buildApnsBody,
  isDeadTokenResponse,
  liveActivityProps,
  pushAgentLiveActivity,
  signApnsJwt,
  type ApnsConfig,
  type ApnsRequest,
  type ApnsResponse,
} from '../live-activity-push'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CONFIG: ApnsConfig = { keyId: 'KEY123', teamId: 'TEAM456', privateKey: PEM, bundleId: 'ai.shogo.app', sandbox: false }
const NOW = 1_800_000_000_000

const props = (over: Partial<Parameters<typeof liveActivityProps>[0]> = {}) =>
  liveActivityProps({ agentId: 'p1', agentName: 'Atlas', state: 'needs_you', detail: 'Run npm install', color: '#12B886', now: NOW, ...over })

describe('liveActivityProps', () => {
  test('a waiting agent', () => {
    expect(props()).toEqual({
      agentId: 'p1',
      agentName: 'Atlas',
      state: 'needs_you',
      headline: '1 needs you',
      detail: 'Run npm install',
      color: '#12b886',
      waiting: 1,
      working: 0,
      link: 'shogo://agents/p1',
      startedAt: NOW,
    })
  })

  test('a working agent counts as working, not waiting', () => {
    expect(props({ state: 'running' })).toMatchObject({ headline: '1 working', waiting: 0, working: 1 })
  })

  test('an unusable colour falls back to the default blue; the link encodes the id', () => {
    expect(props({ color: 'red' }).color).toBe('#3b5bdb')
    expect(props({ agentId: 'a b' }).link).toBe('shogo://agents/a%20b')
  })
})

describe('buildApnsBody', () => {
  test('an update carries the content state the app decodes', () => {
    const { aps } = buildApnsBody({ event: 'update', props: props(), nowSeconds: 100 })
    expect(aps.event).toBe('update')
    expect(aps.timestamp).toBe(100)
    const state = aps['content-state'] as { name: string; props: string }
    expect(state.name).toBe('AgentActivity')
    expect(JSON.parse(state.props)).toEqual(props())
    expect(aps.alert).toBeUndefined()
    expect(aps['attributes-type']).toBeUndefined()
  })

  test('a start names the activity type, carries the link, and always has an alert', () => {
    const { aps } = buildApnsBody({ event: 'start', props: props(), nowSeconds: 100 })
    expect(aps['attributes-type']).toBe('LiveActivityAttributes')
    expect(aps.attributes).toEqual({ url: 'shogo://agents/p1' })
    expect(aps.alert).toEqual({ title: 'Atlas', body: 'Run npm install' })
  })

  test('an alert on an update is passed through', () => {
    const alert = { title: 'Atlas needs approval', body: 'Run npm install' }
    expect(buildApnsBody({ event: 'update', props: props(), nowSeconds: 1, alert }).aps.alert).toEqual(alert)
  })

  test('an end asks for the card to go after a while', () => {
    expect(buildApnsBody({ event: 'end', props: props(), nowSeconds: 1000 }).aps['dismissal-date']).toBe(1000 + 15 * 60)
  })
})

describe('apnsConfigFromEnv', () => {
  test('needs the key, the team and the private key', () => {
    expect(apnsConfigFromEnv({})).toBeNull()
    expect(apnsConfigFromEnv({ APNS_KEY_ID: 'a', APNS_TEAM_ID: 'b' })).toBeNull()
  })

  test('reads the config, unescaping newlines and defaulting the bundle id', () => {
    const config = apnsConfigFromEnv({ APNS_KEY_ID: 'a', APNS_TEAM_ID: 'b', APNS_PRIVATE_KEY: 'line1\\nline2', APNS_SANDBOX: 'true' })
    expect(config).toEqual({ keyId: 'a', teamId: 'b', privateKey: 'line1\nline2', bundleId: 'ai.shogo.app', sandbox: true })
  })
})

describe('signApnsJwt', () => {
  test('is an ES256 token for the team that verifies with the public key', () => {
    const jwt = signApnsJwt(CONFIG, 1234)
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1234 })
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey.export({ type: 'spki', format: 'pem' }).toString(), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('apnsRequest', () => {
  test('is a live activity push to the right host and topic', () => {
    const req = apnsRequest(CONFIG, 'tok', 'update', { aps: {} }, 1)
    expect(req.host).toBe('api.push.apple.com')
    expect(req.headers['apns-push-type']).toBe('liveactivity')
    expect(req.headers['apns-topic']).toBe('ai.shogo.app.push-type.liveactivity')
    expect(req.headers['apns-priority']).toBe('10')
    expect(req.headers.authorization.startsWith('bearer ')).toBe(true)
  })

  test('sandbox builds use the sandbox host; an end is low priority', () => {
    const req = apnsRequest({ ...CONFIG, sandbox: true }, 'tok', 'end', {}, 1)
    expect(req.host).toBe('api.sandbox.push.apple.com')
    expect(req.headers['apns-priority']).toBe('5')
  })
})

describe('isDeadTokenResponse', () => {
  test('knows a token APNs will never accept again', () => {
    expect(isDeadTokenResponse({ status: 410 })).toBe(true)
    expect(isDeadTokenResponse({ status: 400, reason: 'BadDeviceToken' })).toBe(true)
    expect(isDeadTokenResponse({ status: 400, reason: 'Unregistered' })).toBe(true)
    expect(isDeadTokenResponse({ status: 429, reason: 'TooManyRequests' })).toBe(false)
    expect(isDeadTokenResponse({ status: 200 })).toBe(false)
  })
})

function fakeDb(rows: Array<{ id: string; liveActivityToken: string | null; liveActivityPushToStartToken: string | null }>) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  let query: any
  return {
    updates,
    query: () => query,
    db: {
      mobilePushSubscription: {
        findMany: async (q: unknown) => ((query = q), rows),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => void updates.push({ id: where.id, data }),
      },
    },
  }
}

function recorder(respond: (req: ApnsRequest) => ApnsResponse = () => ({ status: 200 })) {
  const sent: ApnsRequest[] = []
  return { sent, transport: async (req: ApnsRequest) => (sent.push(req), respond(req)) }
}

const update = { event: 'update' as const, props: props(), startIfNone: true }

describe('pushAgentLiveActivity', () => {
  test('does nothing without APNs credentials', async () => {
    const { db } = fakeDb([{ id: 's1', liveActivityToken: 'aa'.repeat(16), liveActivityPushToStartToken: null }])
    const { sent, transport } = recorder()
    expect(await pushAgentLiveActivity('u1', update, { db, transport, config: null })).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test('updates a running activity on the iPhone', async () => {
    const token = 'ab'.repeat(16)
    const { db, query } = fakeDb([{ id: 's1', liveActivityToken: token, liveActivityPushToStartToken: 'cd'.repeat(16) }])
    const { sent, transport } = recorder()
    expect(await pushAgentLiveActivity('u1', update, { db, transport, config: CONFIG, now: () => NOW })).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].deviceToken).toBe(token)
    expect(JSON.parse(sent[0].body).aps.event).toBe('update')
    expect(query().where).toMatchObject({ userId: 'u1', platform: 'ios' })
  })

  test('starts one with the push-to-start token when none is running', async () => {
    const start = 'cd'.repeat(16)
    const { db } = fakeDb([{ id: 's1', liveActivityToken: null, liveActivityPushToStartToken: start }])
    const { sent, transport } = recorder()
    expect(await pushAgentLiveActivity('u1', update, { db, transport, config: CONFIG })).toBe(1)
    expect(sent[0].deviceToken).toBe(start)
    expect(JSON.parse(sent[0].body).aps.event).toBe('start')
  })

  test('does not start one when only updating', async () => {
    const { db } = fakeDb([{ id: 's1', liveActivityToken: null, liveActivityPushToStartToken: 'cd'.repeat(16) }])
    const { sent, transport } = recorder()
    expect(await pushAgentLiveActivity('u1', { ...update, startIfNone: false }, { db, transport, config: CONFIG })).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test('an end is never turned into a start', async () => {
    const { db } = fakeDb([{ id: 's1', liveActivityToken: null, liveActivityPushToStartToken: 'cd'.repeat(16) }])
    const { sent, transport } = recorder()
    await pushAgentLiveActivity('u1', { event: 'end', props: props(), startIfNone: true }, { db, transport, config: CONFIG })
    expect(sent).toHaveLength(0)
  })

  test('forgets the activity token once the activity has ended', async () => {
    const { db, updates } = fakeDb([{ id: 's1', liveActivityToken: 'ab'.repeat(16), liveActivityPushToStartToken: null }])
    const { transport } = recorder()
    await pushAgentLiveActivity('u1', { event: 'end', props: props() }, { db, transport, config: CONFIG })
    expect(updates).toEqual([{ id: 's1', data: { liveActivityToken: null } }])
  })

  test('forgets a token APNs rejects, and keeps one that merely failed', async () => {
    const dead = fakeDb([{ id: 's1', liveActivityToken: 'ab'.repeat(16), liveActivityPushToStartToken: null }])
    await pushAgentLiveActivity('u1', update, { db: dead.db, transport: recorder(() => ({ status: 410, reason: 'Unregistered' })).transport, config: CONFIG })
    expect(dead.updates).toEqual([{ id: 's1', data: { liveActivityToken: null } }])

    const flaky = fakeDb([{ id: 's1', liveActivityToken: 'ab'.repeat(16), liveActivityPushToStartToken: null }])
    expect(await pushAgentLiveActivity('u1', update, { db: flaky.db, transport: recorder(() => ({ status: 503 })).transport, config: CONFIG })).toBe(0)
    expect(flaky.updates).toEqual([])
  })

  test('a push failure never throws into the caller', async () => {
    const db = { mobilePushSubscription: { findMany: async () => { throw new Error('db down') } } }
    expect(await pushAgentLiveActivity('u1', update, { db, transport: recorder().transport, config: CONFIG })).toBe(0)
  })
})
