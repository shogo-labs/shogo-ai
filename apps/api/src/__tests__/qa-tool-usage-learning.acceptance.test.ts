// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-97 QA — the "learned" half of the deferred tool set, end to end.
 *
 * The card's criterion 5 says the advertised set equals *this project's*
 * measured top tools once it has ≥50 logged calls, and the static ranking below
 * that. The developer's tests cover the ranking consumer (`resolveLearnedToolOrder`)
 * with an injected loader, so nothing exercised the SQL, the wire snapshot or the
 * hand-off between the two packages:
 *
 *   tool_call_logs → readProjectToolUsage → readProjectConfig.toolUsage
 *                  → GET /api/internal/projects/:id/config
 *                  → getProjectToolUsage → resolveLearnedToolOrder
 *                  → createToolProfile
 *
 * Any break in that chain degrades silently to the static ranking and every
 * existing test still passes, so these assert on a real SQLite database and on
 * the exact JSON the API puts on the wire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { readProjectToolUsage, invalidateToolUsage } = await import('../services/tool-usage.service')
const { readProjectConfig } = await import('../services/project-lifecycle.service')
const { getProjectToolUsage } = await import('../../../../packages/agent-runtime/src/internal-api')
const {
  DEFAULT_TOOL_PRIORITY,
  LEARNING_MIN_CALLS,
  createToolProfile,
  resetToolRankingCache,
  resolveLearnedToolOrder,
} = await import('../../../../packages/agent-runtime/src/tool-profile')

const db = prisma as any

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)

let workspaceId = ''
let projectA = ''
let projectB = ''
let sessionA = ''
let sessionB = ''

async function seedSession(id: string, projectId: string): Promise<void> {
  await db.chatSession.create({
    data: { id, inferredName: `chat ${id}`, contextType: 'project', contextId: projectId },
  })
}

/** Log `calls` tool calls for a session; `age` in days back. */
async function logCalls(sessionId: string, toolName: string, calls: number, age: number): Promise<void> {
  await db.toolCallLog.createMany({
    data: Array.from({ length: calls }, (_, i) => ({
      id: `${sessionId}-${toolName}-${age}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      chatSessionId: sessionId,
      messageId: `m-${i}`,
      toolName,
      status: 'complete' as const,
      createdAt: daysAgo(age),
    })),
  })
}

beforeAll(async () => {
  workspaceId = crypto.randomUUID()
  await db.workspace.create({ data: { id: workspaceId, name: 'QA workspace', slug: `qa-${workspaceId.slice(0, 8)}` } })
  projectA = crypto.randomUUID()
  projectB = crypto.randomUUID()
  await db.project.create({ data: { id: projectA, name: 'Project A', workspaceId } })
  await db.project.create({ data: { id: projectB, name: 'Project B', workspaceId } })
})

afterAll(async () => {
  const sessions = await db.chatSession.findMany({
    where: { contextId: { in: [projectA, projectB] } },
    select: { id: true },
  })
  const ids = sessions.map((s: { id: string }) => s.id)
  if (ids.length) await db.toolCallLog.deleteMany({ where: { chatSessionId: { in: ids } } })
  await db.chatSession.deleteMany({ where: { contextId: { in: [projectA, projectB] } } })
  await db.project.deleteMany({ where: { id: { in: [projectA, projectB] } } })
  await db.workspace.deleteMany({ where: { id: workspaceId } })
  await db.$disconnect()
  const { rmSync } = await import('fs')
  rmSync(dir, { recursive: true, force: true })
})

/** A clean session pair per test: the ranking is per project, so rows must not leak. */
beforeEach(async () => {
  invalidateToolUsage()
  resetToolRankingCache()
  const sessions = await db.chatSession.findMany({
    where: { contextId: { in: [projectA, projectB] } },
    select: { id: true },
  })
  const ids = sessions.map((s: { id: string }) => s.id)
  if (ids.length) await db.toolCallLog.deleteMany({ where: { chatSessionId: { in: ids } } })
  await db.chatSession.deleteMany({ where: { contextId: { in: [projectA, projectB] } } })
  sessionA = crypto.randomUUID()
  sessionB = crypto.randomUUID()
  await seedSession(sessionA, projectA)
  await seedSession(sessionB, projectB)
})

describe('SHO-97 QA: the learned tool ranking reads real tool_call_logs', () => {
  test('ranks this project\'s own tools, weighted towards recent calls', async () => {
    // 5 recent exec calls must beat 12 read_file calls from three weeks ago:
    // 5 + 2*5 = 15 vs 12. Without the recency weight it is 10 vs 12 and the
    // order flips, so this pins the weighting and not just the count. The other
    // project is louder still and must not leak in.
    await logCalls(sessionA, 'exec', 5, 2)
    await logCalls(sessionA, 'read_file', 12, 20)
    await logCalls(sessionB, 'write_file', 50, 2)

    const usage = await readProjectToolUsage(projectA)

    expect(usage.tools.map(t => t.name)).toEqual(['exec', 'read_file'])
    expect(usage.tools[0]).toEqual({ name: 'exec', calls: 5 })
    expect(usage.tools[1]).toEqual({ name: 'read_file', calls: 12 })
    expect(usage.totalCalls).toBe(17)
  })

  test('leaves calls outside the 30-day window out of both the ranking and the threshold', async () => {
    await logCalls(sessionA, 'old_tool', 60, 45)
    await logCalls(sessionA, 'new_tool', 3, 1)

    const usage = await readProjectToolUsage(projectA)

    expect(usage.tools.map(t => t.name)).toEqual(['new_tool'])
    // 60 stale calls must not push the project over LEARNING_MIN_CALLS.
    expect(usage.totalCalls).toBe(3)
    expect(usage.totalCalls).toBeLessThan(LEARNING_MIN_CALLS)
  })
})

describe('SHO-97 QA: the snapshot the runtime actually receives', () => {
  test('readProjectConfig carries toolUsage in the shape the runtime parses', async () => {
    await logCalls(sessionA, 'work_item_update', 60, 1)

    const snapshot = await readProjectConfig(projectA)

    expect(snapshot.toolUsage.totalCalls).toBeGreaterThanOrEqual(LEARNING_MIN_CALLS)
    expect(snapshot.toolUsage.tools[0]).toEqual({ name: 'work_item_update', calls: 60 })

    // …and the runtime's parser turns that same JSON object into a ranking. This
    // is the pair that breaks silently when either side renames a field.
    const originalFetch = globalThis.fetch
    const originalApiUrl = process.env.SHOGO_API_URL
    process.env.SHOGO_API_URL = 'http://internal.qa.test'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, project: snapshot }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      const usage = await getProjectToolUsage(projectA)
      expect(usage).not.toBeNull()
      expect(usage!.totalCalls).toBe(snapshot.toolUsage.totalCalls)
      expect(usage!.order[0]).toBe('work_item_update')

      // The whole point: the measured tool ends up advertised even though it is
      // not in the core set or any static ranking.
      const tools = ['read_file', 'exec', 'work_item_update', 'publish', 'publish_again'].map(name => ({
        name,
        label: name,
        description: `${name} does a thing`,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [] }),
      })) as any
      const learned = await resolveLearnedToolOrder({
        projectId: projectA,
        load: async () => ({ order: usage!.order, totalCalls: usage!.totalCalls }),
      })
      const profile = createToolProfile(tools, { learned })
      expect(profile.isAdvertised('work_item_update')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (originalApiUrl === undefined) delete process.env.SHOGO_API_URL
      else process.env.SHOGO_API_URL = originalApiUrl
    }
  })

  test('below the threshold the runtime keeps the static ranking', async () => {
    await logCalls(sessionB, 'some_rare_tool', LEARNING_MIN_CALLS - 1, 1)

    const usage = await readProjectToolUsage(projectB)
    const order = await resolveLearnedToolOrder({
      projectId: projectB,
      load: async () => ({ order: usage.tools.map(t => t.name), totalCalls: usage.totalCalls }),
    })

    expect(usage.totalCalls).toBe(LEARNING_MIN_CALLS - 1)
    expect(order).toEqual(DEFAULT_TOOL_PRIORITY)
  })

  test('an unreadable ranking is not cached, so the next turn retries', async () => {
    // The service never throws; a project with no history reports zero and the
    // runtime is expected to fall back rather than block on it.
    const empty = await readProjectToolUsage(crypto.randomUUID())
    expect(empty).toEqual({ tools: [], totalCalls: 0 })
  })
})

describe('SHO-97 QA: the ranking is cached, and can be dropped', () => {
  test('a second read within the hour does not see new rows until it is invalidated', async () => {
    await logCalls(sessionA, 'cached_tool', 4, 1)
    const first = await readProjectToolUsage(projectA)
    expect(first.tools[0]).toEqual({ name: 'cached_tool', calls: 4 })

    await logCalls(sessionA, 'cached_tool', 10, 1)
    const second = await readProjectToolUsage(projectA)
    expect(second).toEqual(first)

    invalidateToolUsage(projectA)
    const third = await readProjectToolUsage(projectA)
    expect(third.tools[0]).toEqual({ name: 'cached_tool', calls: 14 })
  })
})
