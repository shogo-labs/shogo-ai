// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The webhook ingress is the only unauthenticated door into social data, so
 * the signature check, the routing id and the event map are tested without a
 * database or a provider.
 */

import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  parseZernioEvent,
  scopeForExternalId,
  socialEventTypeFor,
  verifyZernioSignature,
  zernioEventType,
} from '../zernio-webhook'
import { handleZernioWebhook } from '../webhooks'

const SECRET = 'whsec_test'

const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex')

const commentBody = JSON.stringify({
  type: 'comment.received',
  profiles: [{ id: 'zp_1', externalId: 'ws_11111111-1111-4111-8111-111111111111' }],
  account: { id: 'acc_1', platform: 'Instagram', username: 'acme' },
  comment: { id: 'cmt_1', text: 'MERGE' },
})

describe('webhook signature', () => {
  test('accepts the HMAC of the raw body, with or without a sha256= prefix', () => {
    const signature = sign(commentBody)
    expect(verifyZernioSignature({ rawBody: commentBody, signature, secret: SECRET })).toBe(true)
    expect(verifyZernioSignature({ rawBody: commentBody, signature: `sha256=${signature}`, secret: SECRET })).toBe(true)
  })

  test('rejects a body that changed after signing', () => {
    const signature = sign(commentBody)
    expect(
      verifyZernioSignature({ rawBody: commentBody.replace('MERGE', 'FREE'), signature, secret: SECRET }),
    ).toBe(false)
  })

  test('rejects another secret, a missing header and an unconfigured secret', () => {
    expect(
      verifyZernioSignature({ rawBody: commentBody, signature: sign(commentBody, 'other'), secret: SECRET }),
    ).toBe(false)
    expect(verifyZernioSignature({ rawBody: commentBody, signature: null, secret: SECRET })).toBe(false)
    expect(verifyZernioSignature({ rawBody: commentBody, signature: sign(commentBody), secret: '' })).toBe(false)
  })
})

describe('event parsing and routing', () => {
  test('reads the provider event id, type, routing id and account', () => {
    const event = parseZernioEvent(commentBody, 'evt_1')
    expect(event).toMatchObject({
      id: 'evt_1',
      type: 'comment.received',
      externalId: 'ws_11111111-1111-4111-8111-111111111111',
      account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'acme' },
      detail: { id: 'cmt_1', text: 'MERGE' },
    })
  })

  test('falls back to the body for an event id and to `data` for the detail', () => {
    const body = JSON.stringify({
      id: 'evt_body',
      event: 'message.received',
      profile: { externalId: 'lws_22222222-2222-4222-8222-222222222222' },
      data: { id: 'msg_1', text: 'hi' },
    })
    expect(parseZernioEvent(body, null)).toMatchObject({
      id: 'evt_body',
      type: 'message.received',
      externalId: 'lws_22222222-2222-4222-8222-222222222222',
      detail: { id: 'msg_1', text: 'hi' },
    })
  })

  test('a body with no routing id or no event id is unreadable', () => {
    expect(parseZernioEvent(JSON.stringify({ type: 'comment.received' }), null)).toBeNull()
    expect(parseZernioEvent('not json', 'evt_1')).toBeNull()
  })

  test('maps each provider event onto the social event a trigger subscribes to', () => {
    expect(socialEventTypeFor('comment.received')).toBe('social.comment.received')
    expect(socialEventTypeFor('message.received')).toBe('social.message.received')
    expect(socialEventTypeFor('message.sent')).toBe('social.message.sent')
    expect(socialEventTypeFor('account.connected')).toBe('social.account.connected')
    expect(socialEventTypeFor('account.disconnected')).toBe('social.account.disconnected')
    expect(socialEventTypeFor('workflow.run.completed')).toBe('social.automation.run.completed')
    expect(socialEventTypeFor('workflow.run.failed')).toBe('social.automation.run.failed')
    expect(socialEventTypeFor('analytics.synced')).toBeNull()
  })

  test('the routing id says which scope it is, and refuses a malformed one', () => {
    expect(scopeForExternalId(`ws_${crypto.randomUUID()}`)).toEqual({ ok: true, localWorkspaceId: '' })
    expect(scopeForExternalId(`lws_${crypto.randomUUID()}`)).toEqual({
      ok: true,
      localWorkspaceId: expect.any(String),
    })
    expect(scopeForExternalId('lws_not-a-uuid')).toEqual({ ok: false })
    expect(scopeForExternalId('lws_')).toEqual({ ok: false })
  })
})

describe('deliveries that belong to no profile', () => {
  // The body Zernio's "Send test" button and POST /v1/webhooks/test deliver.
  const testBody = JSON.stringify({
    id: '3f0c1c2e-6c4a-4d3e-9b1f-2a7d8e9f0a1b',
    event: 'webhook.test',
    message: 'This is a test webhook from Zernio',
    timestamp: '2026-10-24T17:00:00Z',
  })

  test('reads the event name from `event` or `type`', () => {
    expect(zernioEventType(testBody)).toBe('webhook.test')
    expect(zernioEventType(commentBody)).toBe('comment.received')
    expect(zernioEventType('{}')).toBeNull()
    expect(zernioEventType('not json')).toBeNull()
  })

  test('a signed webhook.test is answered 200 so the dashboard test passes', async () => {
    const res = await handleZernioWebhook({ rawBody: testBody, signature: sign(testBody), secret: SECRET })
    expect(res).toEqual({ status: 200, body: { ok: true, test: true } })
  })

  test('an unsigned webhook.test is still refused', async () => {
    const res = await handleZernioWebhook({ rawBody: testBody, signature: sign(testBody, 'other'), secret: SECRET })
    expect(res.status).toBe(401)
  })

  test('a signed event with no profiles is accepted and dropped, not retried', async () => {
    const body = JSON.stringify({ id: 'evt_run', event: 'workflow.run.completed', run: { id: 'run_1' } })
    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), secret: SECRET })
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'no_profile' } })
  })

  test('a signed body we cannot read at all is still a 400', async () => {
    const body = 'not json'
    const res = await handleZernioWebhook({ rawBody: body, signature: sign(body), secret: SECRET })
    expect(res.status).toBe(400)
  })
})
