// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { FakeMailProvider, getMailProvider, parseResendEvent, ResendProvider, setMailProviderForTests, verifySvixSignature } from '../provider'

const SECRET = `whsec_${Buffer.from('a-very-secret-key-for-tests-0123').toString('base64')}`

function sign(body: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.slice(6), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  const headers: Record<string, string> = { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,bad v1,${sig}` }
  return (name: string) => headers[name]
}

describe('webhook signatures', () => {
  test('accepts a correct signature among several', () => {
    const body = '{"type":"email.received"}'
    expect(verifySvixSignature(SECRET, body, sign(body))).toBe(true)
  })

  test('rejects a changed body, a stale timestamp and missing headers', () => {
    const body = '{"type":"email.received"}'
    expect(verifySvixSignature(SECRET, `${body} `, sign(body))).toBe(false)
    const old = Math.floor(Date.now() / 1000) - 600
    expect(verifySvixSignature(SECRET, body, sign(body, 'msg_1', old))).toBe(false)
    expect(verifySvixSignature(SECRET, body, () => undefined)).toBe(false)
  })

  test('the Resend provider refuses unsigned webhooks', () => {
    const provider = new ResendProvider('re_test', SECRET)
    expect(() => provider.parseWebhook('{}', () => undefined)).toThrow('Bad webhook signature')
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } })
    expect(provider.parseWebhook(body, sign(body))).toEqual({ kind: 'received', providerMessageId: 'e1' })
  })
})

describe('Resend events', () => {
  test('maps delivery events, with hard and soft bounces told apart', () => {
    expect(parseResendEvent({ type: 'email.delivered', data: { email_id: 'e', to: ['a@b.io'] } }))
      .toEqual({ kind: 'delivery', event: { type: 'delivered', providerMessageId: 'e', recipients: ['a@b.io'] } })
    const hard = parseResendEvent({ type: 'email.bounced', data: { email_id: 'e', to: ['a@b.io'], bounce: { type: 'Permanent', message: 'No such user' } } })
    expect(hard).toMatchObject({ kind: 'delivery', event: { type: 'bounced', permanent: true, detail: 'No such user' } })
    const soft = parseResendEvent({ type: 'email.bounced', data: { email_id: 'e', to: ['a@b.io'], bounce: { type: 'Transient', subType: 'MailboxFull' } } })
    expect(soft).toMatchObject({ event: { permanent: false } })
    expect(parseResendEvent({ type: 'contact.created', data: {} })).toEqual({ kind: 'ignored', type: 'contact.created' })
  })
})

describe('Resend API calls', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('sends with threading headers, an idempotency key and no tracking', async () => {
    const calls: Array<{ url: string; init: any }> = []
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'resend-1', status: 'not_started', records: [] }), { status: 200 })
    }) as any
    const provider = new ResendProvider('re_test', null)
    const result = await provider.send({
      from: { address: 'support@acme.com', name: 'Acme' },
      to: [{ address: 'jane@x.io', name: null }],
      cc: [],
      bcc: [],
      subject: 'Re: Hi',
      text: 'Hello',
      html: '<p>Hello</p>',
      messageId: '<m2@acme.com>',
      inReplyTo: '<m1@x.io>',
      references: '<m1@x.io>',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: new TextEncoder().encode('hi') }],
      idempotencyKey: 'mail-1',
    })
    expect(result.providerMessageId).toBe('resend-1')
    const body = JSON.parse(calls[0].init.body)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].init.headers['Idempotency-Key']).toBe('mail-1')
    expect(body.from).toBe('Acme <support@acme.com>')
    expect(body.headers).toEqual({ 'Message-ID': '<m2@acme.com>', 'In-Reply-To': '<m1@x.io>', References: '<m1@x.io>' })
    expect(body.attachments[0]).toEqual({ filename: 'a.txt', content: Buffer.from('hi').toString('base64'), content_type: 'text/plain' })

    calls.length = 0
    await provider.createDomain('acme.com')
    expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'acme.com', capabilities: { sending: 'enabled', receiving: 'enabled' } })
    expect(calls[1].init.method).toBe('PATCH')
    expect(JSON.parse(calls[1].init.body)).toEqual({ open_tracking: false, click_tracking: false })
  })

  test('marks 429 and 5xx as retryable', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'slow down' }), { status: 429 })) as any
    const provider = new ResendProvider('re_test', null)
    const err: any = await provider.getDomain('d1').catch((e) => e)
    expect(err.message).toBe('slow down')
    expect(err.retryable).toBe(true)
  })
})

describe('choosing a provider', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    setMailProviderForTests(null)
  })
  function pick(env: Record<string, string | undefined>) {
    for (const k of ['MAIL_PROVIDER', 'RESEND_API_KEY', 'NODE_ENV', 'SHOGO_LOCAL_MODE']) delete process.env[k]
    Object.assign(process.env, env)
    setMailProviderForTests(null)
    return getMailProvider()
  }

  test('a production cloud server without a Resend key refuses instead of faking sends', async () => {
    const provider = pick({ NODE_ENV: 'production' })
    expect(provider.name).toBe('unconfigured')
    const err: any = await provider.send({} as any).catch((e) => e)
    expect(err.message).toContain('RESEND_API_KEY')
    expect(err.retryable).toBe(false)
  })

  test('local mode, development and an explicit fake keep the fake provider', () => {
    expect(pick({ NODE_ENV: 'production', SHOGO_LOCAL_MODE: 'true' })).toBeInstanceOf(FakeMailProvider)
    expect(pick({ NODE_ENV: 'development' })).toBeInstanceOf(FakeMailProvider)
    expect(pick({ NODE_ENV: 'production', MAIL_PROVIDER: 'fake' })).toBeInstanceOf(FakeMailProvider)
  })

  test('a Resend key picks Resend', () => {
    expect(pick({ NODE_ENV: 'production', RESEND_API_KEY: 're_test' })).toBeInstanceOf(ResendProvider)
  })
})
