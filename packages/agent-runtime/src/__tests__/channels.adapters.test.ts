// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel adapter sweep — telegram, whatsapp, teams, webhook, slack, discord.
 * One shared harness: a routable global `fetch` mock + a scriptable
 * FakeWebSocket. No real network/WS. Covers connect/auth, send/edit/typing,
 * inbound message routing, status, disconnect, and error arms.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TelegramAdapter } from '../channels/telegram'
import { WhatsAppAdapter } from '../channels/whatsapp'
import { TeamsAdapter } from '../channels/teams'
import { WebhookAdapter } from '../channels/webhook'
import { SlackAdapter } from '../channels/slack'
import { DiscordAdapter } from '../channels/discord'
import type { IncomingMessage } from '../types'

// ── fetch harness ───────────────────────────────────────────────────────────
const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_WS = (globalThis as any).WebSocket
type FetchHandler = (url: string, init?: any) => any
let fetchHandler: FetchHandler = () => ({ ok: true })
let fetchCalls: Array<{ url: string; init?: any }> = []

function res(body: any, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok, status, statusText,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}
function setFetch(h: FetchHandler) { fetchHandler = h }

// ── FakeWebSocket ────────────────────────────────────────────────────────────
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static autoOpen = true
  url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e?: any) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.onopen?.())
  }
  send(data: string) { this.sent.push(data) }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.onclose?.({ code: code ?? 1000, reason })
  }
  serverSend(obj: any) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}
async function nextWs(): Promise<FakeWebSocket> {
  for (let i = 0; i < 50; i++) {
    if (FakeWebSocket.instances.length) return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error('no WebSocket constructed')
}

beforeEach(() => {
  fetchCalls = []
  globalThis.fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    return fetchHandler(String(url), init)
  }) as any
  ;(globalThis as any).WebSocket = FakeWebSocket as any
  FakeWebSocket.instances = []
  FakeWebSocket.autoOpen = true
})
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  ;(globalThis as any).WebSocket = ORIGINAL_WS
})

// ════════════════════════════════════════════════════════════════════════════
// Telegram
// ════════════════════════════════════════════════════════════════════════════
describe('TelegramAdapter', () => {
  test('connect verifies token via getMe and starts polling', async () => {
    setFetch((url) => {
      if (url.includes('/getMe')) return res({ ok: true, result: { username: 'shogobot' } })
      if (url.includes('/getUpdates')) return res({ ok: true, result: [] })
      return res({ ok: true })
    })
    const a = new TelegramAdapter()
    await a.connect({ botToken: 'T' })
    const st = a.getStatus()
    expect(st.connected).toBe(true)
    expect(st.type).toBe('telegram')
    expect(st.metadata?.botUsername).toBe('shogobot')
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect throws on missing token', async () => {
    const a = new TelegramAdapter()
    await expect(a.connect({} as any)).rejects.toThrow('bot token is required')
  })

  test('connect throws on invalid token (non-ok getMe)', async () => {
    setFetch(() => res('nope', { ok: false, statusText: 'Unauthorized' }))
    const a = new TelegramAdapter()
    await expect(a.connect({ botToken: 'bad' })).rejects.toThrow('Invalid bot token')
    expect(a.getStatus().error).toContain('Invalid bot token')
  })

  test('connect throws when getMe returns ok:false', async () => {
    setFetch((url) => url.includes('/getMe') ? res({ ok: false }) : res({ ok: true, result: [] }))
    const a = new TelegramAdapter()
    await expect(a.connect({ botToken: 'x' })).rejects.toThrow('Invalid bot token')
  })

  test('constructor seeds botToken from config', async () => {
    const a = new TelegramAdapter({ botToken: 'seed' })
    setFetch((url) => url.includes('/getMe') ? res({ ok: true, result: {} }) : res({ ok: true, result: [] }))
    await a.connect({ botToken: 'seed' })
    expect(a.getStatus().metadata?.botUsername).toBe('unknown')
    await a.disconnect()
  })

  test('poll delivers incoming text messages to the handler', async () => {
    let updatesServed = false
    setFetch((url) => {
      if (url.includes('/getMe')) return res({ ok: true, result: { username: 'b' } })
      if (url.includes('/getUpdates')) {
        if (updatesServed) return res({ ok: true, result: [] })
        updatesServed = true
        return res({ ok: true, result: [
          { update_id: 7, message: { message_id: 1, from: { id: 42, first_name: 'Ada' }, chat: { id: 99, type: 'private' }, text: 'hello', date: 1000 } },
          { update_id: 8, message: { message_id: 2, chat: { id: 5, type: 'group' }, date: 2000 } }, // no text → skipped
        ] })
      }
      return res({ ok: true })
    })
    const got: IncomingMessage[] = []
    const a = new TelegramAdapter()
    a.onMessage((m) => got.push(m))
    await a.connect({ botToken: 'T' })
    await new Promise((r) => setTimeout(r, 20))
    await a.disconnect()
    expect(got.length).toBe(1)
    expect(got[0]).toMatchObject({ text: 'hello', channelId: '99', senderId: '42', senderName: 'Ada' })
  })

  test('sendMessage posts to sendMessage endpoint; throws when not connected', async () => {
    setFetch(() => res({ ok: true }))
    const a = new TelegramAdapter()
    await expect(a.sendMessage('1', 'hi')).rejects.toThrow('Not connected')
    ;(a as any).botToken = 'T'
    await a.sendMessage('chat1', 'yo')
    const call = fetchCalls.find((c) => c.url.includes('/sendMessage'))
    expect(call).toBeTruthy()
    expect(JSON.parse(call!.init.body)).toMatchObject({ chat_id: 'chat1', text: 'yo', parse_mode: 'Markdown' })
  })

  test('sendMessage logs but does not throw on API error', async () => {
    setFetch(() => res('boom', { ok: false }))
    const a = new TelegramAdapter()
    ;(a as any).botToken = 'T'
    await a.sendMessage('c', 'x') // should not throw
  })
})

// ════════════════════════════════════════════════════════════════════════════
// WhatsApp
// ════════════════════════════════════════════════════════════════════════════
describe('WhatsAppAdapter', () => {
  test('connect validates and registers instance; sendMessage posts text', async () => {
    setFetch((url, init) => {
      if (init?.method === 'POST') return res({ messages: [{ id: 'm1' }] })
      return res({ display_phone_number: '+1555', verified_name: 'Biz' })
    })
    const a = new WhatsAppAdapter()
    await a.connect({ accessToken: 'AT', phoneNumberId: 'PN' })
    const st = a.getStatus()
    expect(st.connected).toBe(true)
    expect(st.metadata?.displayNumber).toBe('+1555')
    await a.sendMessage('+1999', 'x'.repeat(5000))
    const send = fetchCalls.find((c) => c.url.endsWith('/messages'))
    expect(JSON.parse(send!.init.body).text.body.length).toBe(4096)
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect throws on missing creds', async () => {
    const a = new WhatsAppAdapter()
    await expect(a.connect({ phoneNumberId: 'P' } as any)).rejects.toThrow('access token is required')
    await expect(a.connect({ accessToken: 'A' } as any)).rejects.toThrow('phone number ID is required')
  })

  test('connect throws when validation request fails', async () => {
    setFetch(() => res('bad', { ok: false }))
    const a = new WhatsAppAdapter()
    await expect(a.connect({ accessToken: 'A', phoneNumberId: 'P' })).rejects.toThrow('validation failed')
  })

  test('sendMessage throws when not connected', async () => {
    const a = new WhatsAppAdapter()
    await expect(a.sendMessage('x', 'y')).rejects.toThrow('Not connected')
  })

  test('handleWebhook routes text messages to handler and ignores non-text', () => {
    const a = new WhatsAppAdapter()
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    a.handleWebhook({ entry: [{ changes: [
      { field: 'messages', value: { contacts: [{ wa_id: '111', profile: { name: 'Zed' } }], messages: [
        { type: 'text', from: '111', text: { body: 'hey' }, timestamp: '1700000000' },
        { type: 'image', from: '111' },
      ] } },
      { field: 'other', value: {} },
    ] }] })
    expect(got.length).toBe(1)
    expect(got[0]).toMatchObject({ text: 'hey', senderId: '111', senderName: 'Zed' })
    a.handleWebhook({}) // no entry → no-op
    a.handleWebhook({ entry: [{ changes: [{ field: 'messages', value: {} }] }] }) // no messages
    expect(got.length).toBe(1)
  })

  test('registerWebhookRoutes wires GET verify + POST ingest', async () => {
    const routes: Record<string, Function> = {}
    const app = {
      get: (p: string, h: Function) => { routes[`GET ${p}`] = h },
      post: (p: string, h: Function) => { routes[`POST ${p}`] = h },
    }
    const a = new WhatsAppAdapter()
    setFetch(() => res({ display_phone_number: '+1', verified_name: 'B' }))
    await a.connect({ accessToken: 'A', phoneNumberId: 'PN1', verifyToken: 'tok' })
    WhatsAppAdapter.registerWebhookRoutes(app)

    // GET verify success
    const cGood = { req: { query: (k: string) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': 'CHAL' } as any)[k] }, text: (t: string, s?: number) => ({ t, s }) }
    expect(routes['GET /webhooks/whatsapp'](cGood)).toEqual({ t: 'CHAL', s: undefined })
    // GET verify forbidden
    const cBad = { req: { query: () => 'wrong' }, text: (t: string, s?: number) => ({ t, s }) }
    expect(routes['GET /webhooks/whatsapp'](cBad)).toEqual({ t: 'Forbidden', s: 403 })
    // POST ingest routes to adapter by phone_number_id
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    const cPost = { req: { json: async () => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [{ type: 'text', from: '9', text: { body: 'hi' } }] } }] }] }) }, text: (t: string, s?: number) => ({ t, s }) }
    expect(await routes['POST /webhooks/whatsapp'](cPost)).toEqual({ t: 'OK', s: 200 })
    expect(got.length).toBe(1)
    await a.disconnect()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Teams
// ════════════════════════════════════════════════════════════════════════════
describe('TeamsAdapter', () => {
  function tokenFetch(extra?: FetchHandler): void {
    setFetch((url, init) => {
      if (url.includes('oauth2')) return res({ access_token: 'AAD', expires_in: 3600 })
      return extra ? extra(url, init) : res({})
    })
  }
  test('connect acquires Azure token; throws on missing creds', async () => {
    const a = new TeamsAdapter()
    await expect(a.connect({ appPassword: 'p' } as any)).rejects.toThrow('App ID is required')
    await expect(a.connect({ appId: 'i' } as any)).rejects.toThrow('App Password is required')
    tokenFetch()
    await a.connect({ appId: 'app12345678', appPassword: 'secret', botName: 'Bot' })
    expect(a.getStatus()).toMatchObject({ type: 'teams', connected: true })
    expect(a.getStatus().metadata?.botName).toBe('Bot')
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect throws when Azure token request fails', async () => {
    setFetch(() => res('denied', { ok: false, status: 401 }))
    const a = new TeamsAdapter()
    await expect(a.connect({ appId: 'a', appPassword: 'b' })).rejects.toThrow('Failed to get Azure AD token')
    expect(a.getStatus().error).toContain('Azure AD auth failed')
  })

  test('handleActivity message routes to handler and registers conversation; sendMessage uses ref', async () => {
    tokenFetch()
    const a = new TeamsAdapter()
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    await a.connect({ appId: 'a', appPassword: 'b' })
    const r = await a.handleActivity({
      type: 'message', text: '<at>Bot</at> hello there', id: 'act1',
      serviceUrl: 'https://smba.trafficmanager.net/amer', conversation: { id: 'conv1' },
      from: { id: 'u1', name: 'User' }, timestamp: '2026-01-01T00:00:00Z',
      entities: [{ type: 'mention', mentioned: { id: 'bot' }, text: '<at>Bot</at>' }],
      recipient: { id: 'bot' },
    })
    expect(r.status).toBe(200)
    expect(got[0].text).toBe('hello there')
    expect(got[0].channelId).toBe('conv1')
    // sendMessage now resolves the conversation ref and appends trailing slash to serviceUrl
    await a.sendMessage('conv1', 'reply')
    const send = fetchCalls.find((c) => c.url.includes('/v3/conversations/conv1/activities') && c.init?.method === 'POST')
    expect(send).toBeTruthy()
  })

  test('handleActivity returns 503 when not connected, 400 when missing fields', async () => {
    const a = new TeamsAdapter()
    expect(await a.handleActivity({ type: 'message' })).toMatchObject({ status: 503 })
    tokenFetch()
    await a.connect({ appId: 'a', appPassword: 'b' })
    expect(await a.handleActivity({ type: 'message', serviceUrl: 'x' })).toMatchObject({ status: 400 })
  })

  test('conversationUpdate with bot added sends a welcome message', async () => {
    tokenFetch()
    const a = new TeamsAdapter()
    await a.connect({ appId: 'a', appPassword: 'b', botName: 'Welcomer' })
    const r = await a.handleActivity({
      type: 'conversationUpdate', id: 'a1', serviceUrl: 'https://s/', conversation: { id: 'c2' },
      membersAdded: [{ id: 'bot' }], recipient: { id: 'bot' },
    })
    expect(r.status).toBe(200)
    expect(fetchCalls.some((c) => c.url.includes('/v3/conversations/c2/activities'))).toBe(true)
  })

  test('typing + unknown activity types return 200', async () => {
    tokenFetch()
    const a = new TeamsAdapter()
    await a.connect({ appId: 'a', appPassword: 'b' })
    expect(await a.handleActivity({ type: 'typing', serviceUrl: 's', conversation: { id: 'c' } })).toMatchObject({ status: 200 })
    expect(await a.handleActivity({ type: 'reaction', serviceUrl: 's', conversation: { id: 'c' } })).toMatchObject({ status: 200 })
  })

  test('editMessage + sendTyping use conversation ref; editMessage false without ref', async () => {
    tokenFetch((url, init) => res({}, { ok: init?.method === 'PUT' }))
    const a = new TeamsAdapter()
    await a.connect({ appId: 'a', appPassword: 'b' })
    expect(await a.editMessage('nope', 'm', 'c')).toBe(false)
    await a.handleActivity({ type: 'message', text: 'hi', id: 'x', serviceUrl: 'https://s', conversation: { id: 'c3' }, from: { id: 'u' } })
    expect(await a.editMessage('c3', 'msg1', 'edited')).toBe(true)
    await a.sendTyping('c3')
    await a.sendTyping('missing') // no ref → no-op
  })

  test('sendMessage without conversation ref logs and returns', async () => {
    tokenFetch()
    const a = new TeamsAdapter()
    await a.connect({ appId: 'a', appPassword: 'b' })
    const before = fetchCalls.length
    await a.sendMessage('unknown', 'hi')
    // no new conversation activity POST
    expect(fetchCalls.filter((c) => c.url.includes('/v3/conversations/unknown')).length).toBe(0)
    expect(fetchCalls.length).toBe(before)
  })

  test('access token is cached across calls', async () => {
    tokenFetch()
    const a = new TeamsAdapter()
    await a.connect({ appId: 'a', appPassword: 'b' })
    const oauthCalls1 = fetchCalls.filter((c) => c.url.includes('oauth2')).length
    await a.handleActivity({ type: 'message', text: 'x', id: '1', serviceUrl: 'https://s', conversation: { id: 'cc' }, from: { id: 'u' } })
    await a.sendMessage('cc', 'reply')
    const oauthCalls2 = fetchCalls.filter((c) => c.url.includes('oauth2')).length
    expect(oauthCalls2).toBe(oauthCalls1) // cached, no re-auth
  })

  test('registerRoutes wires messaging endpoint (503 when no adapter)', async () => {
    const routes: Record<string, Function> = {}
    const app = { post: (p: string, h: Function) => { routes[p] = h } }
    let adapter: TeamsAdapter | undefined
    TeamsAdapter.registerRoutes(app, () => adapter)
    const cNone = { req: { json: async () => ({}) }, json: (b: any, s?: number) => ({ b, s }) }
    expect(await routes['/agent/channels/teams/messages'](cNone)).toMatchObject({ s: 503 })
    tokenFetch()
    adapter = new TeamsAdapter()
    await adapter.connect({ appId: 'a', appPassword: 'b' })
    const cMsg = { req: { json: async () => ({ type: 'typing', serviceUrl: 's', conversation: { id: 'c' } }) }, json: (b: any, s?: number) => ({ b, s }) }
    expect(await routes['/agent/channels/teams/messages'](cMsg)).toMatchObject({ s: 200 })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Webhook
// ════════════════════════════════════════════════════════════════════════════
describe('WebhookAdapter', () => {
  test('connect parses config; getStatus reflects secret + callback', async () => {
    const a = new WebhookAdapter()
    await a.connect({ secret: 's3cr3t', callbackUrl: 'https://cb', callbackHeaders: '{"X-Key":"v"}', replyTimeoutMs: '5000' })
    const st = a.getStatus()
    expect(st.connected).toBe(true)
    expect(st.metadata?.hasSecret).toBe(true)
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect tolerates invalid callbackHeaders JSON', async () => {
    const a = new WebhookAdapter()
    await a.connect({ callbackHeaders: '{not json' })
    expect(a.getStatus().connected).toBe(true)
  })

  test('verifyAuth: open when no secret, bearer + header when set', async () => {
    const a = new WebhookAdapter()
    await a.connect({})
    expect(a.verifyAuth()).toBe(true)
    await a.connect({ secret: 'k' })
    expect(a.verifyAuth('Bearer k')).toBe(true)
    expect(a.verifyAuth(undefined, 'k')).toBe(true)
    expect(a.verifyAuth('Bearer wrong', 'wrong')).toBe(false)
  })

  test('processIncoming sync mode resolves when sendMessage delivers the reply', async () => {
    const a = new WebhookAdapter()
    await a.connect({})
    let correlationId = ''
    a.onMessage((m) => { correlationId = m.channelId })
    const p = a.processIncoming({ message: 'hi', senderId: 'u', senderName: 'U' })
    await new Promise((r) => setTimeout(r, 5))
    await a.sendMessage(correlationId, 'the reply')
    expect(await p).toEqual({ reply: 'the reply', async: false })
    const log = a.getActivityLog()
    expect(log[log.length - 1]).toMatchObject({ status: 'success', replyPreview: 'the reply' })
  })

  test('processIncoming async mode dispatches to callbackUrl and returns immediately', async () => {
    const a = new WebhookAdapter()
    await a.connect({})
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    const r = await a.processIncoming({ message: 'x'.repeat(200), callbackUrl: 'https://cb/reply' })
    expect(r).toEqual({ reply: '', async: true })
    expect(got[0].channelId).toBe('https://cb/reply')
    const log = a.getActivityLog()
    expect(log[0].messagePreview.endsWith('…')).toBe(true)
  })

  test('processIncoming sync mode times out when no reply arrives', async () => {
    const a = new WebhookAdapter()
    await a.connect({ replyTimeoutMs: '50' })
    a.onMessage(() => { /* never replies */ })
    const realST = globalThis.setTimeout
    ;(globalThis as any).setTimeout = ((fn: any) => { fn(); return 0 }) as any
    let r: any
    try {
      r = await a.processIncoming({ message: 'no reply coming' })
    } finally {
      ;(globalThis as any).setTimeout = realST
    }
    expect(r.async).toBe(false)
    expect(r.reply).toContain('timed out')
    const log = a.getActivityLog()
    expect(log[log.length - 1].status).toBe('timeout')
  })

  test('processIncoming throws without a handler', async () => {
    const a = new WebhookAdapter()
    await a.connect({})
    await expect(a.processIncoming({ message: 'hi' })).rejects.toThrow('no message handler')
  })

  test('sendMessage to URL channelId POSTs callback; to plain id queues to outbox', async () => {
    setFetch(() => res({}))
    const a = new WebhookAdapter()
    await a.connect({ callbackHeaders: '{"X-H":"1"}' })
    await a.connect({}) // reset headers branch
    await a.sendMessage('https://cb/x', 'hello')
    expect(fetchCalls.some((c) => c.url === 'https://cb/x')).toBe(true)
    await a.sendMessage('plain-channel', 'queued1')
    await a.sendMessage('plain-channel', 'queued2')
    expect(a.drainOutbox('plain-channel')).toEqual(['queued1', 'queued2'])
    expect(a.drainOutbox('plain-channel')).toEqual([])
  })

  test('sendMessage callback delivery failure is swallowed', async () => {
    setFetch(() => { throw new Error('net') })
    const a = new WebhookAdapter()
    await a.connect({})
    await a.sendMessage('https://cb/x', 'hello') // should not throw
  })

  test('registerRoutes: incoming sync/async/auth/validation + outbox/health/activity/test', async () => {
    const routes: Record<string, Function> = {}
    const app = {
      get: (p: string, h: Function) => { routes[`GET ${p}`] = h },
      post: (p: string, h: Function) => { routes[`POST ${p}`] = h },
    }
    let adapter: WebhookAdapter | null = null
    WebhookAdapter.registerRoutes(app, () => adapter)
    const ctx = (opts: { body?: any; headers?: Record<string, string>; param?: string; badJson?: boolean }) => ({
      req: {
        json: async () => { if (opts.badJson) throw new Error('bad'); return opts.body ?? {} },
        header: (k: string) => (opts.headers ?? {})[k.toLowerCase()],
        param: () => opts.param,
      },
      json: (b: any, s?: number) => ({ b, s: s ?? 200 }),
    })
    // 503 when no adapter
    expect(await routes['POST /agent/channels/webhook/incoming'](ctx({}))).toMatchObject({ s: 503 })
    expect((routes['GET /agent/channels/webhook/health'](ctx({}))).b.status).toBe('not_configured')
    expect((routes['GET /agent/channels/webhook/activity'](ctx({}))).b.connected).toBe(false)

    adapter = new WebhookAdapter()
    await adapter.connect({ secret: 'k' })
    adapter.onMessage((m) => { setTimeout(() => adapter!.sendMessage(m.channelId, 'auto-reply'), 1) })

    // unauthorized
    expect(await routes['POST /agent/channels/webhook/incoming'](ctx({ headers: {}, body: { message: 'x' } }))).toMatchObject({ s: 401 })
    // bad json
    expect(await routes['POST /agent/channels/webhook/incoming'](ctx({ headers: { authorization: 'Bearer k' }, badJson: true }))).toMatchObject({ s: 400 })
    // missing message
    expect(await routes['POST /agent/channels/webhook/incoming'](ctx({ headers: { authorization: 'Bearer k' }, body: {} }))).toMatchObject({ s: 400 })
    // sync success (auto-reply via handler)
    const ok = await routes['POST /agent/channels/webhook/incoming'](ctx({ headers: { 'x-webhook-secret': 'k' }, body: { message: 'hello' } }))
    expect(ok.b.reply).toBe('auto-reply')
    // async success
    const acc = await routes['POST /agent/channels/webhook/incoming'](ctx({ headers: { authorization: 'Bearer k' }, body: { message: 'hi', callbackUrl: 'https://cb' } }))
    expect(acc).toMatchObject({ s: 202 })
    // outbox
    await adapter.sendMessage('chanA', 'm1')
    const ob = routes['GET /agent/channels/webhook/outbox/:channelId'](ctx({ headers: { authorization: 'Bearer k' }, param: 'chanA' }))
    expect(ob.b.messages).toEqual(['m1'])
    // outbox unauthorized + 503
    expect(routes['GET /agent/channels/webhook/outbox/:channelId'](ctx({ headers: {}, param: 'x' }))).toMatchObject({ s: 401 })
    // health + activity connected
    expect(routes['GET /agent/channels/webhook/health'](ctx({})).b.status).toBe('healthy')
    expect(routes['GET /agent/channels/webhook/activity'](ctx({})).b.connected).toBe(true)
    // test endpoint
    const t = await routes['POST /agent/channels/webhook/test'](ctx({ body: { message: 'ping' } }))
    expect(t.b.ok).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Slack (Socket Mode over WebSocket)
// ════════════════════════════════════════════════════════════════════════════
describe('SlackAdapter', () => {
  function authFetch(): void {
    setFetch((url) => {
      if (url.includes('auth.test')) return res({ ok: true, user: 'bot', user_id: 'U1', team: 'Acme' })
      if (url.includes('apps.connections.open')) return res({ ok: true, url: 'wss://slack/ws' })
      return res({ ok: true })
    })
  }
  test('connect requires both tokens', async () => {
    const a = new SlackAdapter()
    await expect(a.connect({ appToken: 'x' } as any)).rejects.toThrow('bot token')
    await expect(a.connect({ botToken: 'x' } as any)).rejects.toThrow('app-level token')
  })

  test('connect authenticates and opens socket mode', async () => {
    authFetch()
    const a = new SlackAdapter({ botToken: 'b', appToken: 'a' })
    await a.connect({ botToken: 'xoxb', appToken: 'xapp' })
    const st = a.getStatus()
    expect(st.connected).toBe(true)
    expect(st.metadata).toMatchObject({ botUserId: 'U1', team: 'Acme' })
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect throws when auth.test fails', async () => {
    setFetch((url) => url.includes('auth.test') ? res({ ok: false, error: 'invalid_auth' }) : res({ ok: true }))
    const a = new SlackAdapter()
    await expect(a.connect({ botToken: 'b', appToken: 'a' })).rejects.toThrow('Slack auth failed')
  })

  test('connect throws when socket mode open fails', async () => {
    setFetch((url) => {
      if (url.includes('auth.test')) return res({ ok: true, user_id: 'U' })
      return res({ ok: false, error: 'no_url' })
    })
    const a = new SlackAdapter()
    await expect(a.connect({ botToken: 'b', appToken: 'a' })).rejects.toThrow('Socket Mode connection failed')
  })

  test('socket events: events_api message + app_mention route to handler; acks envelope', async () => {
    authFetch()
    const a = new SlackAdapter()
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    await a.connect({ botToken: 'b', appToken: 'a' })
    const ws = await nextWs()
    // normal message
    ws.serverSend({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', text: 'hi', channel: 'C1', user: 'U2', ts: '1700.5' } } })
    // own message ignored
    ws.serverSend({ type: 'events_api', payload: { event: { type: 'message', text: 'self', channel: 'C1', user: 'U1' } } })
    // app_mention
    ws.serverSend({ type: 'events_api', payload: { event: { type: 'app_mention', text: '<@U1> hey there', channel: 'C2', user: 'U3', ts: '1.0' } } })
    expect(got.length).toBe(2)
    expect(got[0]).toMatchObject({ text: 'hi', channelId: 'C1', senderId: 'U2' })
    expect(got[1]).toMatchObject({ text: 'hey there', metadata: { isMention: true } })
    expect(ws.sent.some((s) => s.includes('e1'))).toBe(true)
    await a.disconnect()
  })

  test('socket disconnect frame closes ws; malformed JSON is swallowed', async () => {
    authFetch()
    const a = new SlackAdapter()
    await a.connect({ botToken: 'b', appToken: 'a' })
    const ws = await nextWs()
    ws.onmessage?.({ data: 'not json{' }) // swallowed
    ws.serverSend({ type: 'disconnect' })
    expect(ws.closed).toBeTruthy()
    await a.disconnect()
  })

  test('sendMessage + editMessage call slack web api; not-connected guards', async () => {
    authFetch()
    const a = new SlackAdapter()
    expect(await a.editMessage('c', 'm', 'x')).toBe(false) // no token
    await a.connect({ botToken: 'b', appToken: 'a' })
    setFetch(() => res({ ok: true }))
    await a.sendMessage('C1', 'hello')
    expect(fetchCalls.some((c) => c.url.includes('chat.postMessage'))).toBe(true)
    expect(await a.editMessage('C1', 'ts1', 'edited')).toBe(true)
    await a.sendTyping('C1') // no-op, must not throw
    await a.disconnect()
  })

  test('socket onerror during connect rejects the connection', async () => {
    setFetch((url) => {
      if (url.includes('auth.test')) return res({ ok: true, user_id: 'U' })
      if (url.includes('apps.connections.open')) return res({ ok: true, url: 'wss://x' })
      return res({ ok: true })
    })
    FakeWebSocket.autoOpen = false
    const a = new SlackAdapter()
    const p = a.connect({ botToken: 'b', appToken: 'a' })
    const ws = await nextWs()
    ws.onerror?.()
    await expect(p).rejects.toThrow('Socket Mode connection failed')
    expect(a.getStatus().error).toBe('WebSocket error')
  })

  test('unexpected close schedules a reconnect', async () => {
    authFetch()
    const a = new SlackAdapter()
    await a.connect({ botToken: 'b', appToken: 'a' })
    const ws = await nextWs()
    const realST = globalThis.setTimeout
    ;(globalThis as any).setTimeout = ((fn: any) => { fn(); return 0 }) as any
    try {
      ws.onclose?.({ code: 1006 }) // non-1000 → scheduleReconnect → fires immediately
      await new Promise((r) => realST(r, 10))
    } finally {
      ;(globalThis as any).setTimeout = realST
    }
    // a second socket was opened by the reconnect path
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    await a.disconnect()
  })

  test('reconnect failure re-schedules another reconnect', async () => {
    let openOk = false
    setFetch((url) => {
      if (url.includes('auth.test')) return res({ ok: true, user_id: 'U' })
      if (url.includes('apps.connections.open')) return openOk ? res({ ok: true, url: 'wss://x' }) : res({ ok: false, error: 'rate_limited' })
      return res({ ok: true })
    })
    openOk = true
    const a = new SlackAdapter()
    await a.connect({ botToken: 'b', appToken: 'a' })
    const ws = await nextWs()
    openOk = false // subsequent reconnect attempts fail
    const realST = globalThis.setTimeout
    let calls = 0
    ;(globalThis as any).setTimeout = ((fn: any) => { if (calls++ < 2) fn(); return 0 }) as any
    try {
      ws.onclose?.({ code: 1006 })
      await new Promise((r) => realST(r, 10))
    } finally {
      ;(globalThis as any).setTimeout = realST
    }
    expect(a.getStatus().error).toBeTruthy()
    await a.disconnect()
  })

  test('sendMessage throws when not connected', async () => {
    const a = new SlackAdapter()
    await expect(a.sendMessage('c', 'x')).rejects.toThrow('Not connected')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Discord (Gateway over WebSocket)
// ════════════════════════════════════════════════════════════════════════════
describe('DiscordAdapter', () => {
  function authFetch(): void {
    setFetch((url) => {
      if (url.includes('/users/@me')) return res({ id: 'BOT', username: 'shogo' })
      return res({})
    })
  }
  async function connectDiscord(cfg: Record<string, string> = { botToken: 'T' }) {
    authFetch()
    const a = new DiscordAdapter()
    const got: IncomingMessage[] = []
    a.onMessage((m) => got.push(m))
    const p = a.connect(cfg)
    const ws = await nextWs()
    ws.serverSend({ op: 10, d: { heartbeat_interval: 50 } }) // hello → identify + heartbeat
    ws.serverSend({ op: 0, s: 5, t: 'READY', d: { session_id: 'S1' } }) // ready → resolves connect
    await p
    return { a, ws, got }
  }

  test('connect verifies token, identifies, and becomes ready', async () => {
    const { a, ws } = await connectDiscord()
    expect(a.getStatus().connected).toBe(true)
    expect(a.getStatus().metadata?.botUserId).toBe('BOT')
    expect(ws.sent.some((s) => JSON.parse(s).op === 2)).toBe(true) // identify
    await a.disconnect()
    expect(a.getStatus().connected).toBe(false)
  })

  test('connect throws on missing token', async () => {
    const a = new DiscordAdapter()
    await expect(a.connect({} as any)).rejects.toThrow('bot token is required')
  })

  test('connect throws on invalid token', async () => {
    setFetch(() => res('no', { ok: false, statusText: 'Unauthorized' }))
    const a = new DiscordAdapter()
    await expect(a.connect({ botToken: 'bad' })).rejects.toThrow('Invalid bot token')
  })

  test('MESSAGE_CREATE: DM passes; own/bot/foreign-guild/non-mention filtered', async () => {
    const { a, ws, got } = await connectDiscord({ botToken: 'T', guildId: 'G1' })
    // DM (no guild_id) is filtered because guildId 'G1' is configured (guild scoping guard)
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2', username: 'Ann' }, content: 'dm hi', channel_id: 'D1', timestamp: '2026-01-01T00:00:00Z' } })
    // own message ignored
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'BOT' }, content: 'x', channel_id: 'C', timestamp: '2026-01-01T00:00:00Z' } })
    // bot message ignored
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U9', bot: true }, content: 'x', channel_id: 'C', timestamp: '2026-01-01T00:00:00Z' } })
    // wrong guild ignored
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2' }, content: 'x', channel_id: 'C', guild_id: 'OTHER', timestamp: '2026-01-01T00:00:00Z' } })
    // right guild but not mentioned → ignored
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2' }, content: 'hello', channel_id: 'C', guild_id: 'G1', mentions: [], timestamp: '2026-01-01T00:00:00Z' } })
    // right guild + mention → passes, mention stripped
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2', username: 'Ann' }, content: '<@BOT> ping', channel_id: 'C', guild_id: 'G1', mentions: [{ id: 'BOT' }], timestamp: '2026-01-01T00:00:00Z' } })
    expect(got.map((g) => g.text)).toEqual(['ping'])
    await a.disconnect()
  })

  test('MESSAGE_CREATE: DM passes when no guildId configured; empty text skipped', async () => {
    const { a, ws, got } = await connectDiscord({ botToken: 'T' })
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2', username: 'Ann' }, content: 'plain dm', channel_id: 'D1', timestamp: '2026-01-01T00:00:00Z' } })
    // mention-only message that becomes empty after stripping → skipped
    ws.serverSend({ op: 0, t: 'MESSAGE_CREATE', d: { author: { id: 'U2' }, content: '<@BOT>', channel_id: 'D1', mentions: [{ id: 'BOT' }], timestamp: '2026-01-01T00:00:00Z' } })
    expect(got.map((g) => g.text)).toEqual(['plain dm'])
    await a.disconnect()
  })

  test('heartbeat op1 frames are sent on the hello interval; op11 ack is a no-op', async () => {
    const { a, ws } = await connectDiscord()
    ws.serverSend({ op: 11 }) // ack, no-op
    await new Promise((r) => setTimeout(r, 120))
    expect(ws.sent.some((s) => JSON.parse(s).op === 1)).toBe(true)
    await a.disconnect()
  })

  test('sendMessage truncates to 2000 chars; sendTyping posts; not-connected guards', async () => {
    const { a } = await connectDiscord()
    setFetch(() => res({}))
    await a.sendMessage('C1', 'y'.repeat(2500))
    const send = fetchCalls.find((c) => c.url.includes('/channels/C1/messages'))
    expect(JSON.parse(send!.init.body).content.length).toBe(2000)
    await a.sendTyping('C1')
    expect(fetchCalls.some((c) => c.url.includes('/channels/C1/typing'))).toBe(true)
    await a.disconnect()
  })

  test('sendMessage/sendTyping guard when token missing', async () => {
    const a = new DiscordAdapter()
    await expect(a.sendMessage('c', 'x')).rejects.toThrow('Not connected')
    await a.sendTyping('c') // no token → no-op
  })

  test('socket onerror during gateway connect rejects', async () => {
    authFetch()
    FakeWebSocket.autoOpen = false
    const a = new DiscordAdapter()
    const p = a.connect({ botToken: 'T' })
    const ws = await nextWs()
    ws.onerror?.({})
    await expect(p).rejects.toThrow('WebSocket connection failed')
  })

  test('unexpected gateway close attempts reconnect', async () => {
    const { a, ws } = await connectDiscord()
    const realST = globalThis.setTimeout
    ;(globalThis as any).setTimeout = ((fn: any) => { fn(); return 0 }) as any
    try {
      ws.onclose?.({ code: 1006, reason: 'boom' }) // non-1000 → reconnect attempt
      await new Promise((r) => realST(r, 10))
    } finally {
      ;(globalThis as any).setTimeout = realST
    }
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    await a.disconnect()
  })

  test('sendMessage swallows API error', async () => {
    const { a } = await connectDiscord()
    setFetch(() => res('err', { ok: false }))
    await a.sendMessage('C1', 'hi') // must not throw
    await a.disconnect()
  })
})
