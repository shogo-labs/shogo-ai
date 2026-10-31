// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Inbound idempotency for the webhook channel.
 *
 * The alert relay forwards one SigNoz/Alertmanager notification and the hop
 * arrives as three identical POSTs inside half a second; before this guard each
 * one started its own agent turn. These tests drive the real route (a Hono app
 * with the adapter's routes registered) so they cover the ordering constraint
 * that matters — auth and body validation still run first — not just the
 * helper in isolation.
 *
 * Key precedence is the load-bearing part: the relay sends both
 * `metadata.dedupeKey` (status-aware) and `metadata.groupKey` (status-blind),
 * and picking the group key would let a `resolved` be suppressed as a duplicate
 * of its own firing twin. Covered explicitly below.
 *
 * No network: every request uses a `callbackUrl`, which is the adapter's async
 * mode, so nothing waits on `sendMessage`.
 */
import { describe, test, expect } from 'bun:test'
import { WebhookAdapter } from '../channels/webhook'
import type { IncomingMessage } from '../types'

const INCOMING = 'http://local/agent/channels/webhook/incoming'

async function harness(config: Record<string, string> = {}) {
  const { Hono } = await import('hono')
  const adapter = new WebhookAdapter()
  const delivered: IncomingMessage[] = []
  adapter.onMessage((msg) => { delivered.push(msg) })
  await adapter.connect(config)

  const app = new Hono()
  WebhookAdapter.registerRoutes(app, () => adapter)

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(new Request(INCOMING, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }))
    return { status: res.status, body: (await res.json()) as any }
  }

  return { adapter, post, delivered }
}

const CALLBACK = 'https://relay.example.org/reply'

describe('webhook inbound dedupe — route', () => {
  test('collapses a burst: one dispatch, the rest reported as duplicates', async () => {
    const { post, delivered } = await harness()

    const alert = { message: '[FIRING] PlatformPostgresMemory', callbackUrl: CALLBACK, metadata: { groupKey: 'g-1' } }
    const results = [await post(alert), await post(alert), await post(alert)]

    expect(results.map((r) => r.status)).toEqual([202, 202, 202])
    expect(results[0].body.status).toBe('accepted')
    expect(results[1].body.status).toBe('duplicate-ignored')
    expect(results[2].body.status).toBe('duplicate-ignored')
    expect(delivered.length).toBe(1)
  })

  test('accepts a top-level dedupeKey when no metadata key is present', async () => {
    const { post, delivered } = await harness()
    const body = { message: 'hello', callbackUrl: CALLBACK, dedupeKey: 'k-1' }

    expect((await post(body)).body.status).toBe('accepted')
    expect((await post(body)).body.status).toBe('duplicate-ignored')
    expect(delivered.length).toBe(1)
  })

  // The relay publishes metadata.dedupeKey *and* metadata.groupKey. Only the
  // former hashes the alert status in, so it must win — otherwise a `resolved`
  // re-send inside the TTL is dropped as a duplicate of its own firing twin.
  test('prefers metadata.dedupeKey over metadata.groupKey', async () => {
    const { post, delivered } = await harness()

    const first = await post({ message: 'a', callbackUrl: CALLBACK, metadata: { groupKey: 'g-2', dedupeKey: 'firing:g-2' } })
    // Same group, different dedupeKey → the key is the dedupeKey, not the group.
    const second = await post({ message: 'b', callbackUrl: CALLBACK, metadata: { groupKey: 'g-2', dedupeKey: 'resolved:g-2' } })

    expect(first.body.status).toBe('accepted')
    expect(second.body.status).toBe('accepted')
    expect(delivered.length).toBe(2)
  })

  test('a resolved is not swallowed by its firing twin', async () => {
    const { post, delivered } = await harness()
    const alert = (status: string) => ({
      message: `[${status}] PlatformPostgresMemory`,
      callbackUrl: CALLBACK,
      metadata: { groupKey: 'g-twin', dedupeKey: `${status}|group:g-twin` },
    })

    expect((await post(alert('firing'))).body.status).toBe('accepted')
    expect((await post(alert('resolved'))).body.status).toBe('accepted')
    // ...while a genuine repeat of the firing still collapses.
    expect((await post(alert('firing'))).body.status).toBe('duplicate-ignored')
    expect(delivered.length).toBe(2)
  })

  test('falls back to metadata.groupKey when there is no dedupeKey', async () => {
    const { post, delivered } = await harness()
    const body = { message: 'only a group key', callbackUrl: CALLBACK, metadata: { groupKey: 'g-3' } }

    expect((await post(body)).body.status).toBe('accepted')
    expect((await post(body)).body.status).toBe('duplicate-ignored')
    expect(delivered.length).toBe(1)
  })

  test('is inert when the sender sends no key', async () => {
    const { post, delivered } = await harness()
    const body = { message: 'no key here', callbackUrl: CALLBACK, metadata: { orderId: '1' } }

    const results = [await post(body), await post(body), await post(body)]

    expect(results.map((r) => r.body.status)).toEqual(['accepted', 'accepted', 'accepted'])
    expect(delivered.length).toBe(3)
  })

  test('distinct keys are not duplicates', async () => {
    const { post, delivered } = await harness()

    await post({ message: 'a', callbackUrl: CALLBACK, metadata: { groupKey: 'g-a' } })
    await post({ message: 'b', callbackUrl: CALLBACK, metadata: { groupKey: 'g-b' } })

    expect(delivered.length).toBe(2)
  })

  test('the same key is dispatched again once the TTL has passed', async () => {
    const { post, delivered } = await harness({ dedupeTtlMs: '40' })
    const body = { message: 'repeat', callbackUrl: CALLBACK, metadata: { groupKey: 'g-ttl' } }

    expect((await post(body)).body.status).toBe('accepted')
    expect((await post(body)).body.status).toBe('duplicate-ignored')
    await new Promise((r) => setTimeout(r, 80))
    expect((await post(body)).body.status).toBe('accepted')
    expect(delivered.length).toBe(2)
  })

  // The guard must sit *after* auth: an unauthenticated repeat is a 401, never a
  // 202 that quietly consumes the dedupe slot a real request needed.
  test('auth still gates duplicates', async () => {
    const { post, delivered } = await harness({ secret: 's3cret' })
    const body = { message: 'paged', callbackUrl: CALLBACK, metadata: { groupKey: 'g-auth' } }

    expect((await post(body, { authorization: 'Bearer s3cret' })).body.status).toBe('accepted')
    expect((await post(body)).status).toBe(401)
    // The unauthenticated attempt must not have marked the key as seen.
    expect((await post(body, { authorization: 'Bearer s3cret' })).body.status).toBe('duplicate-ignored')
    expect(delivered.length).toBe(1)
  })
})

describe('webhook inbound dedupe — isDuplicate', () => {
  test('a missing or empty key is never a duplicate', async () => {
    const { adapter } = await harness()
    expect(adapter.isDuplicate(undefined)).toBe(false)
    expect(adapter.isDuplicate(null)).toBe(false)
    expect(adapter.isDuplicate('')).toBe(false)
  })

  test('remembers a key for the TTL and then forgets it', async () => {
    const { adapter } = await harness({ dedupeTtlMs: '40' })
    expect(adapter.isDuplicate('k')).toBe(false)
    expect(adapter.isDuplicate('k')).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(adapter.isDuplicate('k')).toBe(false)
  })

  test('disconnect clears the remembered keys', async () => {
    const { adapter } = await harness()
    expect(adapter.isDuplicate('k')).toBe(false)
    expect(adapter.isDuplicate('k')).toBe(true)
    await adapter.disconnect()
    expect(adapter.isDuplicate('k')).toBe(false)
  })
})
