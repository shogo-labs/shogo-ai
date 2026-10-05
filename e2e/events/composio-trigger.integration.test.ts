// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A Composio trigger (GitHub "issue added") that wakes a project agent:
 * trigger creation against the owner's Composio entity, the signed public
 * webhook (verified by the real Composio SDK), dedupe, retries and
 * auto-disable, and cleanup when the connection is removed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import {
  buildEventsApp,
  caller,
  createFakeComposio,
  freezeBackoff,
  runWorkerTick,
  seedWorkspace,
  setupEventsDb,
  signComposioWebhook,
  waitForDelivery,
  writeEventScript,
  type FakeComposio,
  type SeededEventsWorkspace,
} from './helpers'

const { dir, scriptPath } = setupEventsDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { installScriptedEventAgentFromEnv, scriptedEventRuns } = await import('../../apps/api/src/services/event-agent-script')
const { setComposioTriggersClient, reconcileComposioTriggers } = await import('../../apps/api/src/services/composio-triggers.service')
const { setIntegrationsComposioClient } = await import('../../apps/api/src/routes/integrations')
const { MAX_DELIVERY_ATTEMPTS } = await import('../../apps/api/src/jobs/run-event-delivery-dispatch')

const db = prisma as any
const app = await buildEventsApp()
const call = caller(app)

const EVENT = 'composio.github.GITHUB_ISSUE_ADDED_EVENT'
let seed: SeededEventsWorkspace
let fake: FakeComposio
let entityId: string
let accountId: string
let trigger: any

function postWebhook(signed: { body: string; headers: Record<string, string> }) {
  return app.request('/api/webhooks/composio', { method: 'POST', headers: signed.headers, body: signed.body })
}

function issueWebhook(data: Record<string, unknown>, extra: Partial<Parameters<typeof signComposioWebhook>[0]> = {}) {
  return signComposioWebhook({
    triggerId: trigger.composioTriggerId,
    triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT',
    connectedAccountId: accountId,
    entityId,
    data,
    ...extra,
  })
}

beforeAll(async () => {
  installScriptedEventAgentFromEnv()
  seed = await seedWorkspace(db)
  fake = await createFakeComposio()
  setComposioTriggersClient(fake.client)
  setIntegrationsComposioClient(fake.client)
  entityId = `shogo_${seed.owner}_${seed.workspaceId}`
  accountId = fake.connect(entityId, 'github')
  writeEventScript(scriptPath, {
    'Triage new issues': [{ reply: 'Labeled #{{payload.data.number}} as {{payload.data.label}}.' }],
  })
})

afterAll(async () => {
  setComposioTriggersClient(undefined)
  setIntegrationsComposioClient(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('Composio trigger → project agent', () => {
  test('trigger types include the owner\'s connected apps', async () => {
    const types = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/trigger-types`)
    expect(types.status).toBe(200)
    expect(types.json.composio.available).toBe(true)
    expect(types.json.composio.connectedToolkits).toEqual(['github'])
    expect(types.json.composio.types.map((t: any) => t.type)).toEqual([EVENT])

    const slack = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/trigger-types?toolkit=slack`)
    expect(slack.json.composio.types[0].type).toBe('composio.slack.SLACK_RECEIVE_MESSAGE')
  })

  test('creating without a connection asks for one', async () => {
    const res = await call(seed.member, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Member triage', eventType: EVENT, prompt: 'Triage it', triggerConfig: { owner: 'acme', repo: 'web' },
    })
    expect(res.status).toBe(409)
    expect(res.json.error).toMatchObject({ code: 'needs_connection', toolkit: 'github' })
    expect(fake.calls.filter((c) => c.method === 'create')).toHaveLength(0)
  })

  test('creates the Composio trigger on the owner\'s entity and account', async () => {
    const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Triage new issues',
      eventType: EVENT,
      target: 'project',
      targetProjectId: seed.projectId,
      prompt: 'Label the issue and route it to the right person.',
      triggerConfig: { owner: 'acme', repo: 'web' },
    })
    expect(res.status).toBe(201)
    trigger = res.json.trigger
    expect(trigger).toMatchObject({
      source: 'composio',
      composioTriggerSlug: 'GITHUB_ISSUE_ADDED_EVENT',
      composioEntityId: entityId,
      composioConnectedAccountId: accountId,
      target: 'project',
      targetMode: 'agent',
    })
    expect(fake.calls.find((c) => c.method === 'create')?.args).toEqual([
      entityId,
      'GITHUB_ISSUE_ADDED_EVENT',
      { connectedAccountId: accountId, triggerConfig: { owner: 'acme', repo: 'web' } },
    ])
    expect(fake.triggers.has(trigger.composioTriggerId)).toBe(true)
  })

  test('a signed webhook wakes the project agent with the payload fenced', async () => {
    const res = await postWebhook(issueWebhook({ number: 42, label: 'bug', title: 'Checkout is broken' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, delivered: true })

    const delivery = await waitForDelivery(db, trigger.id, 'ok')
    expect(delivery.summary).toBe('Labeled #42 as bug.')
    const run = scriptedEventRuns.at(-1)!
    expect(run.projectId).toBe(seed.projectId)
    expect(run.eventType).toBe(EVENT)
    const fenced = run.prompt.slice(run.prompt.indexOf('<event_payload>'))
    expect(fenced).toContain('Checkout is broken')
    expect(run.prompt).toContain('untrusted data')
  })

  test('bad signatures, unknown triggers and duplicates', async () => {
    const tampered = issueWebhook({ number: 1 })
    const bad = await postWebhook({ ...tampered, body: tampered.body.replace('"number":1', '"number":2') })
    expect(bad.status).toBe(401)

    const wrongSecret = await postWebhook(issueWebhook({ number: 1 }, { secret: 'whsec_wrong' }))
    expect(wrongSecret.status).toBe(401)

    const unknown = await postWebhook(issueWebhook({ number: 1 }, { triggerId: 'ti_does_not_exist' }))
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toMatchObject({ delivered: false, reason: 'unknown_trigger' })

    const before = await db.eventDelivery.count({ where: { subscriptionId: trigger.id } })
    const first = issueWebhook({ number: 7, label: 'docs' })
    await postWebhook(first)
    const replay = await postWebhook(first)
    expect(await replay.json()).toMatchObject({ delivered: false, reason: 'duplicate' })
    await runWorkerTick()
    expect(await db.eventDelivery.count({ where: { subscriptionId: trigger.id } })).toBe(before + 1)
  })

  test('failing deliveries retry, die, and disable the trigger upstream', async () => {
    await freezeBackoff()
    writeEventScript(scriptPath, { 'Triage new issues': [{ fail: 'GitHub rate limited' }] })
    await postWebhook(issueWebhook({ number: 99 }))
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) await runWorkerTick()

    const delivery = await db.eventDelivery.findFirst({ where: { subscriptionId: trigger.id }, orderBy: { createdAt: 'desc' } })
    expect(delivery).toMatchObject({ status: 'dead', attempts: MAX_DELIVERY_ATTEMPTS, error: 'GitHub rate limited' })
    const sub = await db.eventSubscription.findUnique({ where: { id: trigger.id } })
    expect(sub.enabled).toBe(false)
    expect(sub.lastError).toContain('consecutive failed deliveries')
    expect(fake.calls.some((c) => c.method === 'disable' && c.args[0] === trigger.composioTriggerId)).toBe(true)

    const ignored = await postWebhook(issueWebhook({ number: 100 }))
    expect(await ignored.json()).toMatchObject({ delivered: false, reason: 'disabled' })
  })

  test('re-enabling resets health and enables the Composio trigger', async () => {
    writeEventScript(scriptPath, { 'Triage new issues': [{ reply: 'ok' }] })
    const res = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${trigger.id}`, { enabled: true })
    expect(res.status).toBe(200)
    expect(res.json.trigger).toMatchObject({ enabled: true, consecutiveFailures: 0, lastError: null })
    expect(fake.triggers.get(trigger.composioTriggerId)?.disabled).toBe(false)
  })

  test('reconcile disables a subscription whose Composio trigger vanished', async () => {
    const other = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Vanishing', eventType: EVENT, prompt: 'x', triggerConfig: { owner: 'acme', repo: 'api' },
    })
    fake.triggers.delete(other.json.trigger.composioTriggerId)
    const result = await reconcileComposioTriggers()
    expect(result.disabled).toBe(1)
    expect((await db.eventSubscription.findUnique({ where: { id: other.json.trigger.id } })).enabled).toBe(false)
    await call(seed.owner, 'DELETE', `/workspaces/${seed.workspaceId}/triggers/${other.json.trigger.id}`)
  })

  test('disconnecting the account disables dependent triggers', async () => {
    const res = await call(seed.owner, 'DELETE', `/integrations/connections/${accountId}`)
    expect(res.status).toBe(200)
    const sub = await db.eventSubscription.findUnique({ where: { id: trigger.id } })
    expect(sub.enabled).toBe(false)
    expect(sub.lastError).toContain('disconnected')
    expect(fake.triggers.has(trigger.composioTriggerId)).toBe(false)
  })

  test('deleting the trigger deletes it upstream', async () => {
    fake.connect(entityId, 'github', 'ca_second')
    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Short lived', eventType: EVENT, prompt: 'x', triggerConfig: { owner: 'acme', repo: 'web' },
    })
    const tid = created.json.trigger.composioTriggerId
    expect(fake.triggers.has(tid)).toBe(true)
    const del = await call(seed.owner, 'DELETE', `/workspaces/${seed.workspaceId}/triggers/${created.json.trigger.id}`)
    expect(del.status).toBe(200)
    expect(fake.triggers.has(tid)).toBe(false)
  })
})
