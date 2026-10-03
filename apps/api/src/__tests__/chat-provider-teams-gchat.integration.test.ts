// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat on Microsoft Teams and Google Chat: webhook auth, connect codes,
 * the account-link route, and threaded agent replies.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
process.env.BETTER_AUTH_SECRET ||= 'test-secret-for-chat-links'
process.env.TEAMS_APP_ID = 'teams-app-id'
process.env.TEAMS_APP_PASSWORD = 'teams-password'
process.env.GOOGLE_CHAT_AUDIENCE = '1234567890'
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const chatMode = await import('../services/chat-mode')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const registry = await import('../services/chat-providers/registry')
const { registerBuiltInChatProviders } = await import('../services/chat-providers')
const jwt = await import('../services/chat-providers/jwt')
const link = await import('../services/chat-providers/link')
const inbound = await import('../services/chat-providers/inbound')
const teams = await import('../services/chat-providers/teams')
const gchat = await import('../services/chat-providers/google-chat')
const { chatProviderRoutes } = await import('../routes/chat-providers')

const db = prisma as any
let seed: SeededWorkspace

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 })
const saKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
const privatePem = signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
process.env.GOOGLE_CHAT_SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'shogo-chat@proj.iam.gserviceaccount.com',
  private_key: saKey.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  token_uri: 'https://oauth2.googleapis.com/token',
})

const now = () => Math.floor(Date.now() / 1000)
const token = (claims: Record<string, unknown>, kid = 'k1') => jwt.signJwt({ iat: now(), exp: now() + 600, ...claims }, privatePem, kid)

type HttpCall = { url: string; method: string; body: any }
let http: HttpCall[] = []
let invocations: Array<{ projectId: string | null; userId: string }> = []
let nextId = 0

function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const raw = init?.body
  const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw
  http.push({ url, method, body })
  if (url.includes('/oauth2/') || url.startsWith('https://oauth2.googleapis.com/')) return Promise.resolve(Response.json({ access_token: 'tok', expires_in: 3600 }))
  if (url.endsWith('/v3/conversations') && method === 'POST') return Promise.resolve(Response.json({ id: 'a:personal-1' }))
  if (url.includes('chat.googleapis.com') && method === 'POST') {
    const space = url.split('/v1/')[1].split('/messages')[0]
    const id = ++nextId
    return Promise.resolve(Response.json({ name: `${space}/messages/m${id}`, thread: { name: body.thread?.name ?? `${space}/threads/t${id}` } }))
  }
  if (method === 'POST') return Promise.resolve(Response.json({ id: `act-${++nextId}` }))
  return Promise.resolve(Response.json({}))
}

async function setMode(mode: string | null, provider: string | null) {
  await db.workspace.update({ where: { id: seed.workspaceId }, data: { chatMode: mode, chatProvider: provider } })
  chatMode._resetChatModeCacheForTests()
}

const app = new Hono()
app.route('/api', chatProviderRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  registry._resetChatProvidersForTests()
  registerBuiltInChatProviders()
  jwt._setJwksLoaderForTests(async () => ({ keys: [publicJwk as any] }))
  teams._setTeamsFetchForTests(fakeFetch as any)
  gchat._setGoogleChatFetchForTests(fakeFetch as any)
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, userId: args.userId })
      return sseResponse([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Done — see **notes**.' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ])
    },
  })
})

beforeEach(() => {
  http = []
  invocations = []
})

afterAll(async () => {
  registry._resetChatProvidersForTests()
  jwt._setJwksLoaderForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('jwt', () => {
  const opts = { jwksUri: 'https://keys', issuers: ['iss'], audience: 'aud' }
  test('accepts a valid token and rejects tampering, expiry, audience, and unknown keys', async () => {
    expect(await jwt.verifyJwt(token({ iss: 'iss', aud: 'aud', sub: 'x' }), opts)).toMatchObject({ sub: 'x' })
    const good = token({ iss: 'iss', aud: 'aud' })
    const [h, , s] = good.split('.')
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: 'iss', aud: 'aud', exp: now() + 600, admin: true })).toString('base64url')}.${s}`
    expect(await jwt.verifyJwt(forged, opts)).toBeNull()
    expect(await jwt.verifyJwt(token({ iss: 'iss', aud: 'aud', exp: now() - 3600 }), opts)).toBeNull()
    expect(await jwt.verifyJwt(token({ iss: 'iss', aud: 'other' }), opts)).toBeNull()
    expect(await jwt.verifyJwt(token({ iss: 'evil', aud: 'aud' }), opts)).toBeNull()
    expect(await jwt.verifyJwt(token({ iss: 'iss', aud: 'aud' }, 'k2'), opts)).toBeNull()
    expect(await jwt.verifyJwt('not-a-jwt', opts)).toBeNull()
  })
})

const TENANT = 'aad-tenant-1'
const CHANNEL = '19:abc@thread.tacv2'

function teamsActivity(fields: Record<string, any> = {}) {
  const id = fields.id ?? `${Date.now()}${Math.random().toString().slice(2, 6)}`
  return {
    type: 'message',
    id,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
    from: { id: '29:user-owner', aadObjectId: 'aad-owner', name: 'Olivia Owner' },
    recipient: { id: '28:bot', name: 'Shogo' },
    conversation: { id: `${CHANNEL};messageid=${id}`, conversationType: 'channel', tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, team: { id: 'team-1', name: 'Acme Team' }, channel: { id: CHANNEL, name: 'General' } },
    text: '<at>Shogo</at> hello',
    entities: [{ type: 'mention', text: '<at>Shogo</at>', mentioned: { id: '28:bot', name: 'Shogo' } }],
    ...fields,
  }
}

describe('Microsoft Teams', () => {
  test('webhooks need a valid Bot Framework token', async () => {
    const body = JSON.stringify(teamsActivity())
    expect((await call(null, 'POST', '/chat-providers/teams/events', body)).status).toBe(401)
    const bad = token({ iss: 'https://api.botframework.com', aud: 'someone-else' })
    expect((await call(null, 'POST', '/chat-providers/teams/events', body, { Authorization: `Bearer ${bad}` })).status).toBe(401)
    const ok = token({ iss: 'https://api.botframework.com', aud: 'teams-app-id', serviceurl: 'https://smba.trafficmanager.net/amer/' })
    expect((await call(null, 'POST', '/chat-providers/teams/events', body, { Authorization: `Bearer ${ok}` })).status).toBe(200)
    expect((await call(null, 'POST', '/chat-providers/slack/events', body)).status).toBe(404)
  })

  test('activities normalize mentions, threads, and edits', () => {
    const root = teamsActivity({ id: '100', text: '<at>Shogo</at> ask <at>Dana</at> about Q3&nbsp;&amp; <b>budget</b>' })
    const [msg] = teams.teamsEventsFromActivity(root) as any[]
    expect(msg).toMatchObject({
      channelId: CHANNEL, messageId: '100', threadId: '100', addressed: true, channelName: 'General',
      text: 'ask @Dana about Q3 & budget', user: { externalUserId: 'aad-owner', displayName: 'Olivia Owner' },
    })
    const [reply] = teams.teamsEventsFromActivity(teamsActivity({ id: '101', conversation: { id: `${CHANNEL};messageid=100`, conversationType: 'channel' }, text: 'thanks', entities: [] })) as any[]
    expect(reply).toMatchObject({ threadId: '100', addressed: false })
    expect(teams.teamsEventsFromActivity(teamsActivity({ from: { id: '28:bot' } }))).toEqual([])
    expect(teams.teamsEventsFromActivity(teamsActivity({ type: 'messageUpdate', id: '100', text: 'edited' }))[0]).toMatchObject({ type: 'edit', messageId: '100' })
  })

  test('connect codes bind the tenant; bad codes are refused', async () => {
    const [bad] = teams.teamsEventsFromActivity(teamsActivity({ text: '<at>Shogo</at> connect nope.nope' }))
    await inbound.handleInboundEvent(teams.teamsProvider, bad)
    expect(await db.chatInstallation.findFirst({ where: { provider: 'teams' } })).toBeNull()
    expect(http.find((h) => h.url.includes('/activities'))?.body.text).toContain('invalid or has expired')

    expect((await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/chat-installations/teams/connect-code`)).status).toBe(403)
    const issued = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/chat-installations/teams/connect-code`)
    expect(issued.json.command).toBe(`@Shogo connect ${issued.json.code}`)
    const [connect] = teams.teamsEventsFromActivity(teamsActivity({ text: `<at>Shogo</at> connect ${issued.json.code}` }))
    await inbound.handleInboundEvent(teams.teamsProvider, connect)
    const install = await db.chatInstallation.findFirst({ where: { provider: 'teams', workspaceId: seed.workspaceId } })
    expect(install).toMatchObject({ externalTenantId: TENANT, botUserId: '28:bot' })
    expect(await db.chatIdentityLink.findFirst({ where: { provider: 'teams', externalUserId: 'aad-owner' } })).toMatchObject({ userId: seed.owner })
    expect(http.at(-1)!.body.text).toContain('Connected to the "Acme" workspace')
  })

  test('a mention runs the agent and the reply threads under the Teams post', async () => {
    await setMode('external', 'teams')
    const root = teamsActivity({ text: '<at>Shogo</at> summarize the week' })
    const [event] = teams.teamsEventsFromActivity(root)
    const res = await inbound.handleInboundEvent(teams.teamsProvider, event)
    expect(res!.conversation).toMatchObject({ provider: 'teams', externalId: CHANNEL, name: 'General' })
    await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: res!.row.id, agentStatus: 'done' } }))
    expect(invocations).toEqual([{ projectId: null, userId: seed.owner }])
    const threadPath = `/v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=${root.id}`)}/activities`
    const placeholder = http.find((h) => h.method === 'POST' && h.url.endsWith(threadPath))!
    expect(placeholder.body.text).toContain('Working on it')
    await waitFor(async () => http.some((h) => h.method === 'PUT' && h.body.text.endsWith('Done — see **notes**.')))
  })

  test('unlinked people get the link in a 1:1 chat, and linking resumes their message', async () => {
    const activity = teamsActivity({ from: { id: '29:user-new', aadObjectId: 'aad-new', name: 'Nina New' }, text: '<at>Shogo</at> what changed?' })
    const [event] = teams.teamsEventsFromActivity(activity)
    const res = await inbound.handleInboundEvent(teams.teamsProvider, event)
    expect(res!.row.authorUserId).toBeNull()
    expect(invocations).toHaveLength(0)
    const created = http.find((h) => h.url.endsWith('/v3/conversations'))!
    expect(created.body.members).toEqual([{ id: 'aad-new' }])
    const prompt = http.find((h) => h.url.includes(encodeURIComponent('a:personal-1')))!
    const state = decodeURIComponent(/state=([^)\s]+)/.exec(prompt.body.text)![1])

    expect((await call(seed.outsider, 'POST', '/chat-providers/link', { state })).status).toBe(403)
    const linked = await call(seed.member, 'POST', '/chat-providers/link', { state })
    expect(linked.json).toEqual({ ok: true, provider: 'teams', resumed: true })
    await waitFor(async () => invocations.length === 1)
    expect(invocations[0].userId).toBe(seed.member)
    expect((await call(seed.member, 'POST', '/chat-providers/link', { state: `${state}x` })).status).toBe(400)
  })
})

const SPACE = 'spaces/AAA'
function gchatEvent(message: Record<string, any>, space: Record<string, any> = { name: SPACE, type: 'ROOM', spaceType: 'SPACE', displayName: 'Launch' }) {
  return {
    type: 'MESSAGE',
    space,
    user: { name: 'users/1', displayName: 'Olivia', email: 'olivia@acme.test', type: 'HUMAN' },
    message: {
      sender: { name: 'users/1', displayName: 'Olivia', email: 'olivia@acme.test', type: 'HUMAN' },
      annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/app', type: 'BOT' } } }],
      ...message,
    },
  }
}

describe('Google Chat', () => {
  test('webhooks need a Chat-issued token for this project', async () => {
    const body = JSON.stringify(gchatEvent({ name: `${SPACE}/messages/x`, text: '@Shogo hi', argumentText: 'hi' }))
    const wrongIss = token({ iss: 'someone@else', aud: '1234567890' })
    expect((await call(null, 'POST', '/chat-providers/google_chat/events', body, { Authorization: `Bearer ${wrongIss}` })).status).toBe(401)
    const ok = token({ iss: 'chat@system.gserviceaccount.com', aud: '1234567890' })
    expect((await call(null, 'POST', '/chat-providers/google_chat/events', body, { Authorization: `Bearer ${ok}` })).status).toBe(200)
  })

  test('top-level posts carry their thread; replies point at it', () => {
    const [top] = gchat.googleChatEventsFromBody(gchatEvent({ name: `${SPACE}/messages/1`, text: '@Shogo plan it', argumentText: ' plan it', thread: { name: `${SPACE}/threads/T1` } })) as any[]
    expect(top).toMatchObject({ tenantId: 'acme.test', channelKind: 'private', threadId: null, threadKey: `${SPACE}/threads/T1`, text: 'plan it', addressed: true })
    const [reply] = gchat.googleChatEventsFromBody(gchatEvent({ name: `${SPACE}/messages/2`, text: 'more', thread: { name: `${SPACE}/threads/T1` }, threadReply: true, annotations: [] })) as any[]
    expect(reply).toMatchObject({ threadId: `${SPACE}/threads/T1`, threadKey: null, addressed: false })
    const [addOn] = gchat.googleChatEventsFromBody({ chat: { user: { name: 'users/1', email: 'o@acme.test' }, messagePayload: { space: { name: SPACE, spaceType: 'DIRECT_MESSAGE' }, message: { name: `${SPACE}/messages/3`, text: 'hey', sender: { name: 'users/1', email: 'o@acme.test' } } } } }) as any[]
    expect(addOn).toMatchObject({ channelKind: 'dm', addressed: true })
    expect(gchat.markdownToGoogleChat('**Hi** [docs](https://d.io)')).toBe('*Hi* <https://d.io|docs>')
  })

  test('connect, then threaded replies use the Chat thread name', async () => {
    const issued = link.createConnectCode({ workspaceId: seed.workspaceId, provider: 'google_chat', userId: seed.owner })
    const [connect] = gchat.googleChatEventsFromBody(gchatEvent({ name: `${SPACE}/messages/c1`, text: `@Shogo connect ${issued.code}`, argumentText: ` connect ${issued.code}`, thread: { name: `${SPACE}/threads/TC` } }))
    await inbound.handleInboundEvent(gchat.googleChatProvider, connect)
    expect(await db.chatInstallation.findFirst({ where: { provider: 'google_chat' } })).toMatchObject({ externalTenantId: 'acme.test', workspaceId: seed.workspaceId })
    const tokenCall = http.find((h) => h.url.includes('oauth2.googleapis.com'))!
    expect(tokenCall.body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    await setMode('external', 'google_chat')
    http = []

    const [top] = gchat.googleChatEventsFromBody(gchatEvent({ name: `${SPACE}/messages/10`, text: '@Shogo draft launch notes', argumentText: 'draft launch notes', thread: { name: `${SPACE}/threads/T10` } }))
    const res = await inbound.handleInboundEvent(gchat.googleChatProvider, top)
    expect(res!.row).toMatchObject({ externalRef: `google_chat:${encodeURIComponent(SPACE)}:${encodeURIComponent(`${SPACE}/messages/10`)}` })
    await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: res!.row.id, agentStatus: 'done' } }))
    const placeholder = http.find((h) => h.method === 'POST' && h.url.includes(`${SPACE}/messages`))!
    expect(placeholder.body.thread).toEqual({ name: `${SPACE}/threads/T10` })
    expect(placeholder.url).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    await waitFor(async () => http.some((h) => h.method === 'PATCH' && h.body.text === '*Shogo:* Done — see *notes*.'))

    const [reply] = gchat.googleChatEventsFromBody(gchatEvent({ name: `${SPACE}/messages/11`, text: 'shorter please', thread: { name: `${SPACE}/threads/T10` }, threadReply: true, annotations: [] }))
    const follow = await inbound.handleInboundEvent(gchat.googleChatProvider, reply)
    expect(follow!.row.threadRootId).toBe(res!.row.id)
    await waitFor(async () => invocations.length === 2)
  })

  test('unlinked people in a space get a private link prompt', async () => {
    const [event] = gchat.googleChatEventsFromBody(gchatEvent({
      name: `${SPACE}/messages/20`, text: '@Shogo hi', argumentText: 'hi', thread: { name: `${SPACE}/threads/T20` },
      sender: { name: 'users/9', displayName: 'Sam', email: 'sam@acme.test', type: 'HUMAN' },
    }))
    await inbound.handleInboundEvent(gchat.googleChatProvider, event)
    const prompt = http.find((h) => h.body?.privateMessageViewer)!
    expect(prompt.body.privateMessageViewer).toEqual({ name: 'users/9' })
    expect(prompt.body.text).toContain('/auth/chat-link?state=')
    expect(invocations).toHaveLength(0)
  })

  test('disconnecting falls back to Shogo chat', async () => {
    expect((await call(seed.owner, 'DELETE', `/workspaces/${seed.workspaceId}/chat-installations/google_chat`)).status).toBe(200)
    chatMode._resetChatModeCacheForTests()
    expect((await chatMode.getWorkspaceChatConfig(seed.workspaceId)).mode).toBe('native')
    expect(await db.chatInstallation.findFirst({ where: { provider: 'google_chat' } })).toBeNull()
  })
})
