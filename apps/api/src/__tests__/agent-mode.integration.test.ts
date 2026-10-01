// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which model a channel run asks for: auto routing, unless the project's agent was given a model.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { agentModeFor, settleOrphanedAgentReplies } = await import('../services/conversation-agent-dispatcher')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('agentModeFor', () => {
  test('workspace-level runs and projects without a config use auto routing', async () => {
    expect(await agentModeFor(null)).toBe('auto')
    expect(await agentModeFor(seed.projectId)).toBe('auto')
  })

  test('the default model is not a choice, so it stays on auto', async () => {
    await db.agentConfig.create({ data: { projectId: seed.projectId, modelName: 'claude-haiku-4-5' } })
    expect(await agentModeFor(seed.projectId)).toBe('auto')
  })

  test('a model someone picked is used', async () => {
    await db.agentConfig.update({ where: { projectId: seed.projectId }, data: { modelName: 'claude-sonnet-4-6' } })
    expect(await agentModeFor(seed.projectId)).toBe('claude-sonnet-4-6')
  })
})

describe('settleOrphanedAgentReplies', () => {
  test('a placeholder left running by a restart is settled; finished replies are left alone', async () => {
    const conv = await db.conversation.create({ data: { workspaceId: seed.workspaceId, kind: 'channel', name: "orphans", createdById: seed.owner } })
    const base = { conversationId: conv.id, workspaceId: seed.workspaceId, authorType: 'agent', seq: 9000 }
    const stuck = await db.conversationMessage.create({ data: { ...base, seq: 9001, text: '', agentStatus: 'running' } })
    const done = await db.conversationMessage.create({ data: { ...base, seq: 9002, text: 'All done', agentStatus: 'done' } })
    expect(await settleOrphanedAgentReplies(60_000)).toBe(0) // too recent for another instance to be dead
    expect(await settleOrphanedAgentReplies(0)).toBeGreaterThanOrEqual(1)
    expect((await db.conversationMessage.findUnique({ where: { id: stuck.id } })).agentStatus).toBe('error')
    const after = await db.conversationMessage.findUnique({ where: { id: done.id } })
    expect([after.agentStatus, after.text]).toEqual(['done', 'All done'])
  })
})
