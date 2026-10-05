// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "When someone joins, welcome them": an agent trigger on member.joined,
 * driven through the real trigger routes, the real invite-link and member
 * routes, the delivery worker, and the scripted event agent, whose actions
 * are real channel side effects.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { buildEventsApp, caller, seedWorkspace, setupEventsDb, runWorkerTick, waitFor, waitForDelivery, writeEventScript, type SeededEventsWorkspace } from './helpers'

const { dir, scriptPath } = setupEventsDb()

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { installScriptedEventAgentFromEnv, scriptedEventRuns } = await import('../../apps/api/src/services/event-agent-script')
const { upsertTeamChannel } = await import('../../apps/api/src/services/conversation-team-channels')
const { onWorkspaceMemberJoined } = await import('../../apps/api/src/services/workspace-events')
const bus = await import('../../apps/api/src/lib/conversation-bus')

const db = prisma as any
const app = await buildEventsApp()
const call = caller(app)

let seed: SeededEventsWorkspace
let onboarding: string
let teamLog: string
let triggerId: string

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  expect(installScriptedEventAgentFromEnv()).toBe(true)
  seed = await seedWorkspace(db)
  onboarding = (await upsertTeamChannel(seed.workspaceId, { name: 'onboarding', agents: [], userEmails: [] })).channel.id
  teamLog = (await upsertTeamChannel(seed.workspaceId, { name: 'team-log', agents: [], userEmails: [] })).channel.id
  writeEventScript(scriptPath, {
    'Welcome new members': [{
      when: '^member\\.joined$',
      actions: [
        { tool: 'team_chat_dm', args: { user: '{{payload.member.userId}}', text: 'Welcome aboard, {{payload.member.name}}! Start in #onboarding.' } },
        { tool: 'team_chat_add_member', args: { channel: 'onboarding', users: ['{{payload.member.userId}}'] } },
      ],
      reply: 'Welcomed {{payload.member.name}} and added them to #onboarding.',
    }],
  })
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('member.joined → workspace agent', () => {
  test('a member can create the trigger; a viewer cannot', async () => {
    const denied = await call(seed.viewer, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Nope', eventType: 'member.joined', prompt: 'x',
    })
    expect(denied.status).toBe(403)

    const missingPrompt = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'No prompt', eventType: 'member.joined',
    })
    expect(missingPrompt.status).toBe(400)

    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Welcome new members',
      eventType: 'member.joined',
      prompt: 'DM the new member a welcome and add them to #onboarding.',
      notifyConversationId: 'team-log',
    })
    expect(created.status).toBe(201)
    expect(created.json.trigger).toMatchObject({
      eventType: 'member.joined', target: 'agent', ownerUserId: seed.owner, notifyConversationId: teamLog, enabled: true,
    })
    triggerId = created.json.trigger.id

    const types = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/trigger-types`)
    expect(types.status).toBe(200)
    expect(types.json.native.map((t: any) => t.type)).toContain('member.joined')
  })

  test('accepting an invite link welcomes the newcomer', async () => {
    const link = await db.inviteLink.create({ data: { workspaceId: seed.workspaceId, role: 'member', createdBy: seed.owner } })
    const accepted = await call(seed.newcomer, 'POST', `/invite-links/${link.token}/accept`)
    expect(accepted.status).toBe(200)

    const delivery = await waitForDelivery(db, triggerId, 'ok')
    expect(delivery.attempts).toBe(1)
    expect(delivery.summary).toContain('Welcomed Newcomer')

    const run = scriptedEventRuns.find((r) => r.subscriptionId === triggerId)!
    expect(run.prompt).toContain('<event_payload>')
    expect(run.prompt).toContain(seed.newcomer)

    const dm = await db.conversation.findFirst({ where: { workspaceId: seed.workspaceId, kind: 'dm', dmKey: `a:${seed.newcomer}:ws` } })
    expect(dm).toBeTruthy()
    const welcome = await db.conversationMessage.findFirst({ where: { conversationId: dm.id, authorType: 'agent' } })
    expect(welcome.text).toContain('Welcome aboard, Newcomer')

    const inOnboarding = await db.conversationMember.findFirst({ where: { conversationId: onboarding, userId: seed.newcomer } })
    expect(inOnboarding).toBeTruthy()

    const log = await db.conversationMessage.findFirst({ where: { conversationId: teamLog }, orderBy: { seq: 'desc' } })
    expect(log.text).toContain('Welcomed Newcomer')

    const trigger = await db.eventSubscription.findUnique({ where: { id: triggerId } })
    expect(trigger.lastDeliveredAt).toBeTruthy()
    expect(trigger.consecutiveFailures).toBe(0)
  })

  test('accepting again or re-emitting the same membership does not deliver twice', async () => {
    const link = await db.inviteLink.findFirst({ where: { workspaceId: seed.workspaceId } })
    const again = await call(seed.newcomer, 'POST', `/invite-links/${link.token}/accept`)
    expect(again.json.alreadyMember).toBe(true)

    const member = await db.member.findFirst({ where: { workspaceId: seed.workspaceId, userId: seed.newcomer } })
    await onWorkspaceMemberJoined({ workspaceId: seed.workspaceId, userId: seed.newcomer, memberId: member.id, role: 'member', source: 'invite_link' })
    await runWorkerTick()
    expect(await db.eventDelivery.count({ where: { subscriptionId: triggerId } })).toBe(1)
    expect(await db.workspaceEvent.count({ where: { workspaceId: seed.workspaceId, type: 'member.joined' } })).toBe(1)
  })

  test('the email-invitation path (POST /api/members) fires too', async () => {
    const invited = await db.user.create({ data: { name: 'Invitee', email: `invitee-${Date.now()}@example.com` } })
    const res = await call(seed.owner, 'POST', '/members', { userId: invited.id, workspaceId: seed.workspaceId, role: 'member' })
    expect(res.status).toBe(201)
    // The generated route's afterCreate hook emits fire-and-forget.
    await waitFor(async () => {
      await runWorkerTick()
      return (await db.eventDelivery.count({ where: { subscriptionId: triggerId, status: 'ok' } })) === 2
    })
    const event = await db.workspaceEvent.findFirst({ where: { workspaceId: seed.workspaceId, dedupeKey: { startsWith: 'member.joined:' } }, orderBy: { occurredAt: 'desc' } })
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
    expect(payload).toMatchObject({ source: 'invitation', member: { userId: invited.id, role: 'member' } })
    expect(await db.conversationMember.findFirst({ where: { conversationId: onboarding, userId: invited.id } })).toBeTruthy()
  })

  test('a filter skips joins that do not match', async () => {
    const admins = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers`, {
      name: 'Admins only', eventType: 'member.joined', prompt: 'x', filter: { 'member.role': 'admin' },
    })
    expect(admins.status).toBe(201)
    const someone = await db.user.create({ data: { name: 'Plain', email: `plain-${Date.now()}@example.com` } })
    const link = await db.inviteLink.create({ data: { workspaceId: seed.workspaceId, role: 'member', createdBy: seed.owner } })
    await call(someone.id, 'POST', `/invite-links/${link.token}/accept`)
    await runWorkerTick()
    expect(await db.eventDelivery.count({ where: { subscriptionId: admins.json.trigger.id } })).toBe(0)
    expect(await db.eventDelivery.count({ where: { subscriptionId: triggerId } })).toBe(3)
  })

  test('deliveries are listed and only the owner or an admin may change the trigger', async () => {
    const list = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/triggers/${triggerId}/deliveries`)
    expect(list.status).toBe(200)
    expect(list.json.deliveries.length).toBe(3)
    expect(list.json.deliveries[0].event.type).toBe('member.joined')

    const byMember = await call(seed.member, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { enabled: false })
    expect(byMember.status).toBe(403)
    const byOwner = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${triggerId}`, { enabled: false })
    expect(byOwner.status).toBe(200)
    expect(byOwner.json.trigger.enabled).toBe(false)

    const testDisabled = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers/${triggerId}/test`, {})
    expect(testDisabled.status).toBe(409)
  })
})
