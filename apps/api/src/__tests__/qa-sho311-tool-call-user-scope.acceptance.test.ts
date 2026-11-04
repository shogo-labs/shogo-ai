// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-311 acceptance 5 — a member-scoped usage summary counts only that
 * member's tool calls.
 *
 * `getUsageSummary({ userId })` reaches its tool-call total through
 * `toolCallWhereFor`, which spread the *workspace/project* session scope but
 * dropped `scope.userId`. Every `/me/analytics/usage-summary` response (and the
 * per-member workspace tab) therefore reported the whole workspace's tool-call
 * count to the person looking at their own page.
 *
 * The numbers are the seeded ones, so this fails on `main` (4 calls reported to
 * a member who made 1) and passes once the where clause filters by `userId`.
 *
 *   bun test apps/api/src/__tests__/qa-sho311-tool-call-user-scope.acceptance.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const db = prisma as any

const suffix = crypto.randomUUID().slice(0, 8)

let workspaceId = ''
let aliceId = ''
let bobId = ''

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: 'Tool Scope', slug: `tool-scope-${suffix}`, kind: 'team' },
  })
  workspaceId = workspace.id
  const project = await db.project.create({ data: { name: 'Tool Scope', workspaceId } })

  const [alice, bob] = await Promise.all([
    db.user.create({ data: { name: 'Alice', email: `tcs-alice-${suffix}@example.com` } }),
    db.user.create({ data: { name: 'Bob', email: `tcs-bob-${suffix}@example.com` } }),
  ])
  aliceId = alice.id
  bobId = bob.id

  const projectSession = await db.chatSession.create({
    data: {
      inferredName: 'project chat',
      contextType: 'project',
      contextId: project.id,
      createdAt: new Date(Date.now() - 60_000),
    },
  })
  const workspaceSession = await db.chatSession.create({
    data: {
      inferredName: 'workspace chat',
      contextType: 'workspace',
      workspaceId,
      createdByUserId: alice.id,
      createdAt: new Date(Date.now() - 60_000),
    },
  })

  await db.toolCallLog.createMany({
    data: [
      // Alice: 1 through the project session, 1 workspace-scoped session.
      {
        chatSessionId: projectSession.id,
        messageId: `m-a1-${suffix}`,
        toolName: 'read_file',
        status: 'complete',
        userId: aliceId,
        createdAt: new Date(Date.now() - 120_000),
      },
      {
        chatSessionId: workspaceSession.id,
        messageId: `m-a2-${suffix}`,
        toolName: 'write_file',
        status: 'complete',
        userId: aliceId,
        createdAt: new Date(Date.now() - 120_000),
      },
      // Bob: 3, all through the project session.
      ...Array.from({ length: 3 }, (_, i) => ({
        chatSessionId: projectSession.id,
        messageId: `m-b${i}-${suffix}`,
        toolName: 'grep',
        status: 'complete',
        userId: bobId,
        createdAt: new Date(Date.now() - 120_000),
      })),
    ],
  })
})

describe('member-scoped usage summary counts only that member', () => {
  test('getUsageSummary({ userId }) reports the member’s own tool calls', async () => {
    const scope = { workspaceId, userId: aliceId }
    const summary = await analytics.getUsageSummary(scope, '30d', { limit: 500 })

    // Fails on main: the workspace-wide 5 comes back instead of Alice's 2.
    expect(summary.totals.totalToolCalls).toBe(2)
  })

  test('the same scope through getUsageDashboard agrees', async () => {
    const dashboard = await analytics.getUsageDashboard(
      { workspaceId, userId: aliceId },
      { period: '30d', limit: 500 },
    )

    expect(dashboard.summary.totals.totalToolCalls).toBe(2)
  })

  test('an unscoped workspace summary still counts every member', async () => {
    const summary = await analytics.getUsageSummary({ workspaceId }, '30d', { limit: 500 })

    expect(summary.totals.totalToolCalls).toBe(5)
  })
})
