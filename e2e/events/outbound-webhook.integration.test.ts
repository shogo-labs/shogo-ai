// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed outbound webhooks: a `webhook` trigger POSTs the event envelope to a
 * receiver that verifies it with `verifyShogoSignature` from the public SDK,
 * the way a third-party integration would. Covers tampering, retries to
 * dead, 410 Gone, secret rotation, and the SSRF guard at create, update and
 * delivery time.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { buildEventsApp, caller, freezeBackoff, runWorkerTick, seedWorkspace, setupEventsDb, waitForDelivery, type SeededEventsWorkspace } from './helpers'

const { dir } = setupEventsDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { onWorkspaceMemberJoined } = await import('../../apps/api/src/services/workspace-events')
const sdkEvents = await import(Bun.resolveSync('@shogo-ai/sdk/events', join(import.meta.dir, '../../apps/api')))
const { verifyShogoSignature, SHOGO_SIGNATURE_HEADER, SHOGO_TIMESTAMP_HEADER, SHOGO_EVENT_ID_HEADER } = sdkEvents

const db = prisma as any
const app = await buildEventsApp()
const call = caller(app)

interface Received { body: string; headers: Record<string, string>; verified: boolean }

let mode: 'ok' | 'fail' | 'gone' = 'ok'
let secret = ''
const received: Received[] = []
const receiver = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = await req.text()
    const headers = Object.fromEntries(req.headers.entries())
    const verified = await verifyShogoSignature({
      body,
      signature: headers[SHOGO_SIGNATURE_HEADER],
      timestamp: headers[SHOGO_TIMESTAMP_HEADER],
      secret,
    })
    received.push({ body, headers, verified })
    if (!verified) return new Response('bad signature', { status: 401 })
    if (mode === 'fail') return new Response('nope', { status: 500 })
    if (mode === 'gone') return new Response('gone', { status: 410 })
    return Response.json({ ok: true })
  },
})
const receiverUrl = `http://127.0.0.1:${receiver.port}/shogo`
process.env.SHOGO_WEBHOOK_ALLOWED_HOSTS = `127.0.0.1:${receiver.port}`

let seed: SeededEventsWorkspace
let triggerId: string

async function joinMember(name: string) {
  const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` } })
  const member = await db.member.create({ data: { userId: user.id, workspaceId: seed.workspaceId, role: 'member' } })
  await onWorkspaceMemberJoined({ workspaceId: seed.workspaceId, userId: user.id, memberId: member.id, role: 'member', source: 'invitation' })
  return user
}

async function createWebhook(webhookUrl: string, name = 'Webhook') {
  return call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, { name, eventType: 'member.joined', target: 'webhook', webhookUrl })
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  receiver.stop(true)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('outbound webhooks', () => {
  test('creating a webhook trigger returns its signing secret exactly once', async () => {
    const created = await createWebhook(receiverUrl)
    expect(created.status).toBe(201)
    expect(created.json.webhookSecret).toMatch(/^whsec_/)
    expect(created.json.trigger).toMatchObject({ target: 'webhook', webhookUrl: receiverUrl, hasWebhookSecret: true })
    expect(created.json.trigger.webhookSecret).toBeUndefined()
    secret = created.json.webhookSecret
    triggerId = created.json.trigger.id

    const listed = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/triggers`)
    const row = listed.json.triggers.find((t: any) => t.id === triggerId)
    expect(row.webhookSecret).toBeUndefined()
    expect(JSON.stringify(listed.json)).not.toContain(secret)
  })

  test('a join is delivered as a signed envelope the SDK verifies', async () => {
    const user = await joinMember('Hooked')
    const delivery = await waitForDelivery(db, triggerId, 'ok')
    expect(delivery.responseStatus).toBe(200)

    const hit = received.at(-1)!
    expect(hit.verified).toBe(true)
    expect(hit.headers[SHOGO_EVENT_ID_HEADER]).toBe(delivery.eventId)
    expect(hit.headers['shogo-event-type']).toBe('member.joined')
    expect(hit.headers['shogo-delivery-id']).toBe(delivery.id)
    const envelope = JSON.parse(hit.body)
    expect(envelope).toMatchObject({ id: delivery.eventId, type: 'member.joined', workspaceId: seed.workspaceId })
    expect(envelope.payload.member.userId).toBe(user.id)

    const tampered = hit.body.replace(user.id, 'someone-else')
    expect(await verifyShogoSignature({ body: tampered, signature: hit.headers[SHOGO_SIGNATURE_HEADER], timestamp: hit.headers[SHOGO_TIMESTAMP_HEADER], secret })).toBe(false)
    expect(await verifyShogoSignature({ body: hit.body, signature: hit.headers[SHOGO_SIGNATURE_HEADER], timestamp: hit.headers[SHOGO_TIMESTAMP_HEADER], secret: 'whsec_wrong' })).toBe(false)
    expect(await verifyShogoSignature({
      body: hit.body, signature: hit.headers[SHOGO_SIGNATURE_HEADER], timestamp: hit.headers[SHOGO_TIMESTAMP_HEADER], secret,
      now: Number(hit.headers[SHOGO_TIMESTAMP_HEADER]) + 3600,
    })).toBe(false)
  })

  test('the /test endpoint sends a signed sample event', async () => {
    const before = received.length
    const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers/${triggerId}/test`, {})
    expect(res.status).toBe(202)
    await waitForDelivery(db, triggerId, 'ok')
    await runWorkerTick()
    expect(received.length).toBe(before + 1)
    expect(received.at(-1)!.verified).toBe(true)
    expect(JSON.parse(received.at(-1)!.body).type).toBe('member.joined')
  })

  test('a failing receiver is retried with backoff, then the delivery goes dead', async () => {
    await freezeBackoff()
    mode = 'fail'
    const before = received.length
    await joinMember('Retried')
    const dead = await waitForDelivery(db, triggerId, 'dead', 15_000)
    expect(dead.attempts).toBe(5)
    expect(dead.responseStatus).toBe(500)
    expect(received.length - before).toBe(5)
    expect(new Set(received.slice(before).map((r) => r.headers[SHOGO_EVENT_ID_HEADER])).size).toBe(1)
    const trigger = await db.eventSubscription.findUnique({ where: { id: triggerId } })
    expect(trigger.enabled).toBe(false)
    expect(trigger.consecutiveFailures).toBeGreaterThanOrEqual(5)
    mode = 'ok'
    const reenabled = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { enabled: true })
    expect(reenabled.json.trigger).toMatchObject({ enabled: true, consecutiveFailures: 0 })
  })

  test('rotating the secret: old secret stops verifying, the new one works', async () => {
    const oldSecret = secret
    const rotated = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { rotateWebhookSecret: true })
    expect(rotated.status).toBe(200)
    expect(rotated.json.webhookSecret).toMatch(/^whsec_/)
    expect(rotated.json.webhookSecret).not.toBe(oldSecret)
    secret = rotated.json.webhookSecret

    await joinMember('Rotated')
    await waitForDelivery(db, triggerId, 'ok')
    const hit = received.at(-1)!
    expect(hit.verified).toBe(true)
    expect(await verifyShogoSignature({ body: hit.body, signature: hit.headers[SHOGO_SIGNATURE_HEADER], timestamp: hit.headers[SHOGO_TIMESTAMP_HEADER], secret: oldSecret })).toBe(false)

    const member = await call(seed.member, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { rotateWebhookSecret: true })
    expect(member.status).toBe(403)
  })

  test('410 Gone disables the trigger without retrying', async () => {
    mode = 'gone'
    const before = received.length
    await joinMember('Gone')
    const dead = await waitForDelivery(db, triggerId, 'dead')
    expect(dead.attempts).toBe(1)
    expect(received.length - before).toBe(1)
    expect((await db.eventSubscription.findUnique({ where: { id: triggerId } })).enabled).toBe(false)
    mode = 'ok'
  })

  test('SSRF: non-https, loopback, private and metadata URLs are rejected at create and update', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://localhost/hook',
      'https://api.localhost/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://user:pass@example.com/hook',
      'https://metadata.google.internal/hook',
      'not a url',
    ]) {
      const res = await createWebhook(url, 'Bad')
      expect({ url, status: res.status }).toEqual({ url, status: 400 })
    }
    const update = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { webhookUrl: 'https://127.0.0.1:9/hook' })
    expect(update.status).toBe(400)
  })

  test('SSRF: an address that became internal after creation is refused at delivery', async () => {
    const created = await createWebhook(receiverUrl, 'Repointed')
    const id = created.json.trigger.id
    await db.eventSubscription.update({ where: { id }, data: { webhookUrl: 'https://169.254.169.254/latest/meta-data' } })
    const before = received.length
    await joinMember('Metadata')
    const dead = await waitForDelivery(db, id, 'dead')
    expect(dead.attempts).toBe(1)
    expect(dead.error).toMatch(/private or internal/)
    expect(received.length).toBe(before)
    expect((await db.eventSubscription.findUnique({ where: { id } })).enabled).toBe(false)
  })

  test('SSRF: a public hostname resolving to loopback is refused at delivery (needs DNS)', async () => {
    const resolvesToLoopback = await lookup('localtest.me').then((a) => a.address === '127.0.0.1').catch(() => false)
    if (!resolvesToLoopback) {
      console.warn('[outbound-webhook] skipping DNS-rebinding check: localtest.me does not resolve here')
      return
    }
    const rejected = await createWebhook('https://localtest.me/hook', 'Rebinding')
    expect(rejected.status).toBe(400)

    const created = await createWebhook(receiverUrl, 'Rebinding')
    const id = created.json.trigger.id
    await db.eventSubscription.update({ where: { id }, data: { webhookUrl: 'https://localtest.me/hook' } })
    await joinMember('Rebinding')
    const dead = await waitForDelivery(db, id, 'dead')
    expect(dead.error).toMatch(/resolves to a private or internal address/)
  })
})
