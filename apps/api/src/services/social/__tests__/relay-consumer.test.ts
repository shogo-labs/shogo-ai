// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop end of relayed events (SHO-71 B3): one poll per local scope
 * collects the deliveries the cloud stored, applies them with the same handler
 * the cloud uses, and acks only what it applied.
 *
 * Both sides are injected here, so this proves the ordering and the
 * exactly-once behaviour without a provider or a second database.
 */

import { describe, expect, test } from 'bun:test'
import { drainRelayedEvents, type RelayedEventDelivery } from '../relay-consumer'
import type { ApplySocialEventInput } from '../webhooks'

const RELAY_BASE = 'https://cloud.test/api/social-relay'

const delivery = (over: Partial<RelayedEventDelivery>): RelayedEventDelivery => ({
  id: 'row-1',
  dedupeKey: 'zernio:evt_1',
  workspaceId: 'cloud-ws',
  localWorkspaceId: 'local-a',
  externalId: 'lws_local-a',
  eventId: 'evt_1',
  type: 'comment.received',
  account: { zernioAccountId: 'acc_1', platform: 'instagram', username: 'ig' },
  detail: { id: 'cmt_1', text: 'MERGE' },
  occurredAt: '2026-10-19T22:00:00.000Z',
  ...over,
})

/** Per-scope queue: the scope in the header decides which events come back. */
function fakeFetch(byScope: Record<string, RelayedEventDelivery[]>) {
  const calls: { url: string; init: any }[] = []
  const impl = (async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/events/ack')) {
      const body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ ok: true, acked: body.ids.length }), { status: 200 })
    }
    const scope = init.headers?.['x-shogo-local-workspace'] ?? ''
    return new Response(JSON.stringify({ events: byScope[scope] ?? [] }), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const relayConfig = () => ({ mode: 'relay' as const, baseUrl: RELAY_BASE, apiKey: 'shogo_sk_test' })

describe('relayed event consumer', () => {
  test('polls each local scope, applies in that workspace, then acks once', async () => {
    const { impl, calls } = fakeFetch({
      'local-a': [delivery({ id: 'row-1', eventId: 'evt_1' })],
      'local-b': [
        delivery({ id: 'row-2', eventId: 'evt_2', localWorkspaceId: 'local-b', externalId: 'lws_local-b' }),
      ],
    })
    const applied: ApplySocialEventInput[] = []

    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a', 'local-b'],
      apply: async (input) => {
        applied.push(input)
        return { status: 200, body: { ok: true } }
      },
    })

    expect(result).toEqual({ fetched: 2, applied: 2, acked: 2 })

    // The local workspace id the delivery names is this database's workspace.
    expect(applied.map((input) => input.workspaceId)).toEqual(['local-a', 'local-b'])
    expect(applied[0].externalId).toBe('lws_local-a')
    expect(applied[0].eventId).toBe('evt_1')
    expect(applied[0].type).toBe('comment.received')
    expect(applied[0].detail).toEqual({ id: 'cmt_1', text: 'MERGE' })

    const polls = calls.filter((call) => !call.url.endsWith('/ack'))
    expect(polls.map((call) => call.init.headers['x-shogo-local-workspace'])).toEqual([
      'local-a',
      'local-b',
    ])
    expect(polls[0].init.headers.Authorization).toBe('Bearer shogo_sk_test')

    const ack = calls.find((call) => call.url.endsWith('/events/ack'))
    expect(JSON.parse(ack!.init.body).ids).toEqual(['row-1', 'row-2'])
  })

  test('a machine with no local workspaces polls nothing', async () => {
    const { impl, calls } = fakeFetch({})
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => [],
      apply: async () => ({ status: 200, body: {} }),
    })
    expect(result).toEqual({ fetched: 0, applied: 0, acked: 0 })
    expect(calls).toHaveLength(0)
  })

  test('an empty poll does no work and sends no ack', async () => {
    const { impl, calls } = fakeFetch({ 'local-a': [] })
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      apply: async () => {
        throw new Error('must not apply anything')
      },
    })
    expect(result).toEqual({ fetched: 0, applied: 0, acked: 0 })
    expect(calls.some((call) => call.url.endsWith('/events/ack'))).toBe(false)
  })

  test('a delivery that fails to apply stays unacked, and the failure is reported', async () => {
    const { impl, calls } = fakeFetch({ 'local-a': [delivery({ id: 'row-1', eventId: 'evt_1' })] })
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      apply: async () => {
        throw new Error('local DB is locked')
      },
    })
    expect(result).toMatchObject({ fetched: 1, applied: 0, acked: 0 })

    // It must NOT be acked — and the failure has to reach the cloud, or the
    // delivery is retried for ever without anybody counting the attempts.
    const ack = calls.find((call) => call.url.endsWith('/events/ack'))
    const body = JSON.parse(ack!.init.body)
    expect(body.ids).toEqual([])
    expect(body.failed).toEqual([{ id: 'row-1', error: 'local DB is locked' }])
  })

  test('a rejected payload is a failure to retry, not a delivery to ack', async () => {
    const { impl, calls } = fakeFetch({ 'local-a': [delivery({ id: 'row-1', eventId: 'evt_1' })] })
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      // What `applySocialEvent` answers when the catalog refuses the payload.
      apply: async () => ({
        status: 502,
        body: { error: { code: 'social_event_rejected', message: 'payload failed the validator' } },
      }),
    })
    expect(result).toMatchObject({ fetched: 1, applied: 0, acked: 0 })
    const body = JSON.parse(calls.find((call) => call.url.endsWith('/events/ack'))!.init.body)
    expect(body.failed).toEqual([{ id: 'row-1', error: 'payload failed the validator' }])
  })

  test('a delivery with nothing to apply is reported, not retried silently', async () => {
    const { impl, calls } = fakeFetch({ 'local-a': [delivery({ id: 'row-1', eventId: '' })] })
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      apply: async () => {
        throw new Error('must not apply')
      },
    })
    expect(result).toMatchObject({ fetched: 1, applied: 0, acked: 0 })
    const body = JSON.parse(calls.find((call) => call.url.endsWith('/events/ack'))!.init.body)
    expect(body.failed[0].id).toBe('row-1')
    expect(body.failed[0].error).toContain('missing')
  })

  test('the whole payload is handed to apply, so the inbox can read the conversation', async () => {
    const withPayload = delivery({
      id: 'row-1',
      eventId: 'evt_1',
      payload: { conversation: { id: 'conv_1' }, message: { id: 'msg_1' } } as never,
    })
    const { impl } = fakeFetch({ 'local-a': [withPayload] })
    const applied: ApplySocialEventInput[] = []
    await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      apply: async (input) => {
        applied.push(input)
        return { status: 200, body: { ok: true } }
      },
    })
    expect(applied[0].payload).toEqual({ conversation: { id: 'conv_1' }, message: { id: 'msg_1' } })
  })

  test('a cloud scope or BYOK machine polls nothing at all', async () => {
    const { impl, calls } = fakeFetch({})
    const cloud = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: () => ({ mode: 'cloud', baseUrl: 'https://zernio.test', apiKey: 'master' }),
      localScopes: async () => ['local-a'],
      apply: async () => ({ status: 200, body: {} }),
    })
    const byok = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: () => ({ mode: 'byok', baseUrl: 'https://zernio.test', apiKey: 'user' }),
      localScopes: async () => ['local-a'],
      apply: async () => ({ status: 200, body: {} }),
    })
    expect(cloud).toEqual({ fetched: 0, applied: 0, acked: 0 })
    expect(byok).toEqual({ fetched: 0, applied: 0, acked: 0 })
    expect(calls).toHaveLength(0)
  })

  test('an unreachable relay is a quiet no-op, never a crash', async () => {
    const impl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await drainRelayedEvents({
      fetchImpl: impl,
      resolveConfig: relayConfig,
      localScopes: async () => ['local-a'],
      apply: async () => ({ status: 200, body: {} }),
    })
    expect(result).toEqual({ fetched: 0, applied: 0, acked: 0 })
  })
})
