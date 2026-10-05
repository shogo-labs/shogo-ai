// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The runtime's trigger tools (and team_chat_add_member) end to end: the real
 * tool implementations call the real `/api/internal` routes over HTTP via
 * `internal-api`, exactly as an agent-runtime pod does.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import {
  buildEventsApp,
  createFakeComposio,
  runWorkerTick,
  seedWorkspace,
  setupEventsDb,
  waitForDelivery,
  writeEventScript,
  type FakeComposio,
  type SeededEventsWorkspace,
} from './helpers'

const { dir, scriptPath } = setupEventsDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { installScriptedEventAgentFromEnv } = await import('../../apps/api/src/services/event-agent-script')
const { setComposioTriggersClient } = await import('../../apps/api/src/services/composio-triggers.service')
const { upsertTeamChannel } = await import('../../apps/api/src/services/conversation-team-channels')

const db = prisma as any
const app = await buildEventsApp()
const server = Bun.serve({ port: 0, fetch: app.fetch })
process.env.SHOGO_API_URL = `http://127.0.0.1:${server.port}`

const triggerTools = await import('../../packages/agent-runtime/src/trigger-tools')
const { createChannelTools } = await import('../../packages/agent-runtime/src/channel-tools')

let seed: SeededEventsWorkspace
let fake: FakeComposio
let ctx: any

function tool(name: string): any {
  const all = [...triggerTools.createTriggerTools(ctx), ...createChannelTools(ctx)]
  const found = all.find((t) => t.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

async function run(name: string, params: Record<string, unknown>) {
  const result = await tool(name).execute('call', params)
  return result.details ?? JSON.parse(result.content?.[0]?.text ?? 'null')
}

beforeAll(async () => {
  installScriptedEventAgentFromEnv()
  seed = await seedWorkspace(db)
  fake = await createFakeComposio()
  setComposioTriggersClient(fake.client)
  fake.connect(`shogo_${seed.owner}_${seed.workspaceId}`, 'github')
  ctx = { workspaceId: seed.workspaceId, userId: seed.owner, workspaceDir: dir, channels: new Map(), config: {} }
  await upsertTeamChannel(seed.workspaceId, { name: 'general', agents: [], userEmails: [] })
  writeEventScript(scriptPath, { 'Welcome': [{ reply: 'Said hi to {{payload.member.name}}.' }] })
})

afterAll(async () => {
  setComposioTriggersClient(undefined)
  server.stop(true)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('trigger tools through internal-api', () => {
  let triggerId: string

  test('trigger_types_list returns Shogo events and connected app events', async () => {
    const result = await run('trigger_types_list', {})
    expect(result.ok).toBe(true)
    expect(result.shogo.map((e: any) => e.type)).toContain('member.joined')
    expect(result.apps.connected).toEqual(['github'])
    expect(result.apps.events.map((e: any) => e.type)).toContain('composio.github.GITHUB_ISSUE_ADDED_EVENT')
  })

  test('trigger_create for an unconnected app returns needs_connection', async () => {
    const result = await run('trigger_create', {
      name: 'Slack mentions', event_type: 'composio.slack.SLACK_RECEIVE_MESSAGE', prompt: 'Summarize it',
    })
    expect(result.code).toBe('needs_connection')
    expect(result.error).toContain('slack')
    expect(result.hint).toContain('connect')
  })

  test('trigger_create, trigger_list and trigger_test produce a delivery', async () => {
    const created = await run('trigger_create', {
      name: 'Welcome', event_type: 'member.joined', prompt: 'Say hi', notify_channel: 'general',
    })
    expect(created.ok).toBe(true)
    triggerId = created.trigger.id
    expect(created.trigger.ownerUserId).toBe(seed.owner)

    const listed = await run('trigger_list', {})
    expect(listed.triggers.map((t: any) => t.id)).toContain(triggerId)

    const tested = await run('trigger_test', { trigger_id: triggerId })
    expect(tested.ok).toBe(true)
    expect(tested.type).toBe('member.joined')
    const delivery = await waitForDelivery(db, triggerId, 'ok')
    expect(delivery.summary).toContain('Said hi to')

    const deliveries = await run('trigger_list', { trigger_id: triggerId })
    expect(deliveries.deliveries[0]).toMatchObject({ status: 'ok' })
  })

  test('trigger_update and an invalid filter', async () => {
    const bad = await run('trigger_update', { trigger_id: triggerId, filter: { 'member.role': { $ne: 'x' } } })
    expect(bad.code).toBe('invalid_field')
    const ok = await run('trigger_update', { trigger_id: triggerId, filter: { 'member.role': 'member' }, name: 'Welcome members' })
    expect(ok.trigger).toMatchObject({ name: 'Welcome members', filter: { 'member.role': 'member' } })
    await run('trigger_update', { trigger_id: triggerId, name: 'Welcome', filter: null })
  })

  test('another member cannot change the owner\'s trigger', async () => {
    const asMember = { ...ctx, userId: seed.member }
    const result = await triggerTools.createTriggerDeleteTool(asMember).execute('call', { trigger_id: triggerId })
    expect((result as any).details?.status ?? JSON.parse((result as any).content[0].text).status).toBe(403)
  })

  test('team_chat_add_member adds a teammate to a channel', async () => {
    const result = await run('team_chat_add_member', { channel: '#general', users: [seed.newcomerEmail] })
    expect(result.ok).toBe(true)
    expect(result.added).toEqual([])
    const general = await db.conversation.findFirst({ where: { workspaceId: seed.workspaceId, slug: 'general' } })
    await db.member.create({ data: { userId: seed.newcomer, workspaceId: seed.workspaceId, role: 'member' } })
    const again = await run('team_chat_add_member', { channel: 'general', users: [seed.newcomerEmail] })
    expect(again.added).toEqual([seed.newcomer])
    expect(await db.conversationMember.findFirst({ where: { conversationId: general.id, userId: seed.newcomer } })).toBeTruthy()
  })

  test('the owner losing workspace access disables the trigger on its next run', async () => {
    const tested = await run('trigger_test', { trigger_id: triggerId })
    expect(tested.ok).toBe(true)
    await db.member.deleteMany({ where: { workspaceId: seed.workspaceId, userId: seed.owner } })
    await runWorkerTick()
    const delivery = await db.eventDelivery.findFirst({ where: { subscriptionId: triggerId }, orderBy: { createdAt: 'desc' } })
    expect(delivery.status).toBe('dead')
    const sub = await db.eventSubscription.findUnique({ where: { id: triggerId } })
    expect(sub.enabled).toBe(false)
    expect(sub.lastError).toContain('no longer a member')
  })

  test('trigger_delete removes the trigger', async () => {
    await db.member.create({ data: { userId: seed.owner, workspaceId: seed.workspaceId, role: 'owner' } })
    const result = await run('trigger_delete', { trigger_id: triggerId })
    expect(result.ok).toBe(true)
    expect(await db.eventSubscription.findUnique({ where: { id: triggerId } })).toBeNull()
  })
})
