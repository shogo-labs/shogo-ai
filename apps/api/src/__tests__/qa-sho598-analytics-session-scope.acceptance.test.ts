// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-598, the analytics workspace session scope.
 *
 * The card is about a workspace filter that used to be an `OR` across two
 * relations (session → workspace, session → project → workspace). Prisma turned
 * that into LEFT JOINs plus a post-join `OR`, so Postgres walked every tenant's
 * rows in the window: 53–119 s for `tool_call_logs` in prod, and the Usage tab
 * timed out at 20 s.
 *
 * Three properties are pinned here, against a real SQLite database (the
 * desktop track) rather than a mock:
 *
 *   1. Semantics are unchanged — a session belongs to the workspace directly or
 *      through a project in it, a session that is both is counted once, and
 *      another workspace's sessions are never counted.
 *   2. The shape cannot come back — no reader emits the relation `OR`, and the
 *      scope goes through one `IN (SELECT …)` subquery per statement.
 *   3. The chat tiles follow the period, and the two indexes this needs are
 *      declared in both schemas and created by both migration tracks.
 *
 *   cd apps/api && bun test ./src/__tests__/qa-sho598-analytics-session-scope.acceptance.test.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { setupChannelsTestDb } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const analytics = await import('../services/analytics.service')
const db = prisma as any

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

/** Session ids, so a failure names the row instead of a random uuid. */
const ids = {
  direct: '',
  viaProject: '',
  both: '',
  foreignDirect: '',
  foreignProject: '',
}

let workspaceId = ''
let projectId = ''
let otherWorkspaceId = ''
let otherProjectId = ''

/** Every row this file creates is inside the 30-day window. */
const IN_WINDOW = new Date(Date.now() - 60 * 60 * 1000)
/** Outside it, so a reader that ignores the period counts it and fails. */
const OUT_OF_WINDOW = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)

const TOOL_CALLS = { direct: 3, viaProject: 2, both: 1, foreignDirect: 4, foreignProject: 5 }
const USER_MESSAGES = { direct: 2, viaProject: 2, both: 2, foreignDirect: 2, foreignProject: 2 }

/** The correct rule, written the way every reader wrote it before SHO-598. */
function legacySessionScope(workspace: string) {
  return {
    OR: [
      { workspaceId: workspace },
      { project: { workspaceId: workspace } },
    ],
  }
}

async function seedSession(opts: {
  name: string
  workspaceId: string | null
  contextId: string | null
  toolCalls: number
  userMessages: number
}) {
  const session = await db.chatSession.create({
    data: {
      name: opts.name,
      inferredName: opts.name,
      contextType: opts.contextId ? 'project' : 'workspace',
      contextId: opts.contextId,
      workspaceId: opts.workspaceId,
      createdAt: IN_WINDOW,
      lastActiveAt: IN_WINDOW,
    },
  })
  for (let i = 0; i < opts.toolCalls; i += 1) {
    await db.toolCallLog.create({
      data: {
        chatSessionId: session.id,
        messageId: crypto.randomUUID(),
        toolName: 'edit_file',
        status: 'complete',
        createdAt: IN_WINDOW,
      },
    })
  }
  for (let i = 0; i < opts.userMessages; i += 1) {
    await db.chatMessage.create({
      data: {
        sessionId: session.id,
        role: 'user',
        agent: 'technical',
        content: `prompt ${i}`,
        createdAt: IN_WINDOW,
      },
    })
  }
  // An assistant row in the same session: the message tile counts prompts only.
  await db.chatMessage.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      agent: 'technical',
      content: 'answer',
      createdAt: IN_WINDOW,
    },
  })
  return session.id as string
}

/** Records every raw statement the readers issue while `run` executes. */
async function captureSql<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const sql: string[] = []
  const original = db.$queryRawUnsafe.bind(db)
  db.$queryRawUnsafe = async (statement: string, ...params: any[]) => {
    sql.push(String(statement))
    return original(statement, ...params)
  }
  try {
    const result = await run()
    return { result, sql }
  } finally {
    db.$queryRawUnsafe = original
  }
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = await db.workspace.create({ data: { name: 'QA 598', slug: `qa-598-${suffix}`, kind: 'team' } })
  workspaceId = workspace.id
  const other = await db.workspace.create({ data: { name: 'QA 598 other', slug: `qa-598-other-${suffix}`, kind: 'team' } })
  otherWorkspaceId = other.id
  projectId = (await db.project.create({ data: { name: 'QA 598 project', workspaceId } })).id
  otherProjectId = (await db.project.create({ data: { name: 'QA 598 other project', workspaceId: otherWorkspaceId } })).id

  // (a) the workspace's own agent chat — no project
  ids.direct = await seedSession({
    name: 'direct',
    workspaceId,
    contextId: null,
    toolCalls: TOOL_CALLS.direct,
    userMessages: USER_MESSAGES.direct,
  })
  // (b) a project chat — no workspaceId
  ids.viaProject = await seedSession({
    name: 'via project',
    workspaceId: null,
    contextId: projectId,
    toolCalls: TOOL_CALLS.viaProject,
    userMessages: USER_MESSAGES.viaProject,
  })
  // (c) both, which is why the subquery is `UNION ALL` inside `IN`
  ids.both = await seedSession({
    name: 'both',
    workspaceId,
    contextId: projectId,
    toolCalls: TOOL_CALLS.both,
    userMessages: USER_MESSAGES.both,
  })
  // (d) another workspace, directly and through its project
  ids.foreignDirect = await seedSession({
    name: 'foreign direct',
    workspaceId: otherWorkspaceId,
    contextId: null,
    toolCalls: TOOL_CALLS.foreignDirect,
    userMessages: USER_MESSAGES.foreignDirect,
  })
  ids.foreignProject = await seedSession({
    name: 'foreign project',
    workspaceId: null,
    contextId: otherProjectId,
    toolCalls: TOOL_CALLS.foreignProject,
    userMessages: USER_MESSAGES.foreignProject,
  })

  // Out-of-window rows on an in-scope session: the period must exclude them
  // (AC3 — the chat counts used to be unbounded).
  await db.toolCallLog.create({
    data: {
      chatSessionId: ids.direct,
      messageId: crypto.randomUUID(),
      toolName: 'edit_file',
      status: 'complete',
      createdAt: OUT_OF_WINDOW,
    },
  })
  await db.chatMessage.create({
    data: {
      sessionId: ids.direct,
      role: 'user',
      agent: 'technical',
      content: 'last month',
      createdAt: OUT_OF_WINDOW,
    },
  })
})

const inScopeToolCalls = TOOL_CALLS.direct + TOOL_CALLS.viaProject + TOOL_CALLS.both
const inScopeMessages = USER_MESSAGES.direct + USER_MESSAGES.viaProject + USER_MESSAGES.both

describe('SHO-598: the workspace session scope keeps today\'s numbers', () => {
  test('the session ids are the workspace\'s own plus its projects\', once each', async () => {
    const sessionIds = await analytics.workspaceSessionIds([workspaceId])
    expect([...sessionIds].sort()).toEqual([ids.direct, ids.viaProject, ids.both].sort())
    // (c) belongs twice; resolving to ids must not hand back a duplicate.
    expect(new Set(sessionIds).size).toBe(sessionIds.length)
    expect(sessionIds).not.toContain(ids.foreignDirect)
    expect(sessionIds).not.toContain(ids.foreignProject)
  })

  test('the tool-call tile equals the relation filter it replaced', async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const legacy = await db.toolCallLog.count({
      where: { status: 'complete', createdAt: { gte: since }, chatSession: legacySessionScope(workspaceId) },
    })
    const dashboard = await analytics.getUsageDashboard({ workspaceId }, { period: '30d' })
    expect(legacy).toBe(inScopeToolCalls)
    expect((dashboard as any).summary.totals.totalToolCalls).toBe(legacy)
  })

  test('engagement counts the same tool calls and prompts', async () => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const legacyTools = await db.toolCallLog.count({
      where: { createdAt: { gte: since }, chatSession: legacySessionScope(workspaceId) },
    })
    const legacyPrompts = await db.chatMessage.count({
      where: {
        role: 'user',
        agent: 'technical',
        createdAt: { gte: since },
        session: legacySessionScope(workspaceId),
      },
    })
    const { result, sql } = await captureSql(() =>
      analytics.getToolCallAnalytics({ workspaceId }, '30d'),
    )
    expect(result.totals.totalCalls).toBe(legacyTools)
    expect(legacyTools).toBe(inScopeToolCalls)
    expect(legacyPrompts).toBe(inScopeMessages)
    // The prompt count the engagement readers issue is the same filter; it is
    // asserted through the ids the scope resolved to.
    const sessionIds = await analytics.workspaceSessionIds([workspaceId])
    const newPrompts = await db.chatMessage.count({
      where: { role: 'user', agent: 'technical', createdAt: { gte: since }, sessionId: { in: sessionIds } },
    })
    expect(newPrompts).toBe(legacyPrompts)
    expect(sql.length).toBeGreaterThan(0)
  })

  test('the chat tiles follow the period and include workspace chats', async () => {
    const { result } = await captureSql(() => analytics.getChatAnalytics({ workspaceId }, '30d'))
    // The period, not all time: the out-of-window prompt and tool call on
    // `direct` are excluded.
    expect(result.totalMessages).toBe(inScopeMessages)
    expect(result.totalToolCalls).toBe(inScopeToolCalls)
    // Workspace-level chats count too — the SHO-140 rule the tool-call tile
    // already followed. (a), (b) and (c), not the two foreign sessions.
    expect(result.totalSessions).toBe(3)
    expect(result.avgMessagesPerSession).toBe(Math.round((inScopeMessages / 3) * 10) / 10)
  })
})

describe('SHO-598: the scope shape cannot regress', () => {
  test('no reader sends a relation OR over the session or its project', async () => {
    const runs = await Promise.all([
      captureSql(() => analytics.getChatAnalytics({ workspaceId }, '30d')),
      captureSql(() => analytics.getToolCallAnalytics({ workspaceId }, '30d')),
      captureSql(() => analytics.getUsageDashboard({ workspaceId }, { period: '30d' })),
      captureSql(() => analytics.getMemberInsights(workspaceId, '30d')),
    ])
    const statements = runs.flatMap((run) => run.sql)
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) {
      // The forms that made Postgres walk every tenant's rows.
      expect(statement).not.toMatch(/OR\s+pj\."workspaceId"/)
      expect(statement).not.toMatch(/EXISTS \(SELECT 1 FROM "projects" p WHERE/)
      // Everything that needs the workspace's sessions asks for them by id.
      expect(statement).toContain('"chat_sessions"')
    }
    // Readers that filter in SQL inline the subquery (`IN (SELECT …)`).
    const inline = statements.filter((s) => s.includes('IN (SELECT "id" FROM "chat_sessions"'))
    expect(inline.length).toBeGreaterThan(0)
    // Prisma readers resolve it to ids once per read, and the helper
    // de-duplicates: a session that belongs both ways comes back twice from
    // `UNION ALL`.
    const resolved = statements.filter((s) => s.includes('SELECT DISTINCT "id" FROM ('))
    expect(resolved.length).toBeGreaterThan(0)
  })

  test('engagement sends session ids, never a relation OR', async () => {
    const engagement = await import('../services/engagement-analytics.service')
    const calls: any[] = []
    const original = db.toolCallLog.findMany.bind(db.toolCallLog)
    db.toolCallLog.findMany = async (args: any) => {
      calls.push(args?.where)
      return original(args)
    }
    try {
      await engagement.getEngagementStats({ workspaceId }, '30d', 'UTC', {
        from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        to: new Date(),
      })
    } finally {
      db.toolCallLog.findMany = original
    }
    expect(calls.length).toBeGreaterThan(0)
    for (const where of calls) {
      expect(where.chatSession).toBeUndefined()
      expect(Array.isArray(where.chatSessionId.in)).toBe(true)
      expect(where.chatSessionId.in.length).toBe(3)
    }
  })
})

describe('SHO-598: both tracks carry the indexes', () => {
  const TRACKS = [
    { name: 'cloud', schema: 'prisma/schema.prisma', migrations: 'prisma/migrations' },
    { name: 'desktop', schema: 'prisma/schema.local.prisma', migrations: 'apps/desktop/prisma/migrations' },
    // The desktop copy the desktop app actually runs migrations from.
    { name: 'desktop app', schema: 'apps/desktop/prisma/schema.prisma', migrations: 'apps/desktop/prisma/migrations' },
  ]

  for (const track of TRACKS) {
    test(`${track.name} declares the two composite indexes`, () => {
      const schema = readFileSync(resolve(REPO_ROOT, track.schema), 'utf-8')
      const toolCalls = schema.match(/model ToolCallLog \{([\s\S]*?)\n\}/)?.[1] ?? ''
      const usage = schema.match(/model UsageEvent \{([\s\S]*?)\n\}/)?.[1] ?? ''
      expect(toolCalls).toContain('@@index([chatSessionId, createdAt, status])')
      // The single-column index is gone: the composite one leads with it.
      expect(toolCalls).not.toContain('@@index([chatSessionId])')
      expect(usage).toContain('@@index([workspaceId, actionType, createdAt])')
      // Everything the other readers use stays (`usage-indexes.test.ts` owns
      // the full UsageEvent set; this only pins that nothing was removed).
      expect(usage).toContain('@@index([memberId, createdAt])')
    })
  }

  test('both migration tracks create them', () => {
    for (const dir of ['prisma/migrations', 'apps/desktop/prisma/migrations']) {
      const file = resolve(REPO_ROOT, dir, '20261127100000_sho598_analytics_scope_indexes', 'migration.sql')
      expect(existsSync(file)).toBe(true)
      const sql = readFileSync(file, 'utf-8')
      expect(sql).toContain('"tool_call_logs"("chatSessionId", "createdAt", "status")')
      expect(sql).toContain('"usage_events"("workspaceId", "actionType", "createdAt")')
      // The cloud migration must no-op where the index was built CONCURRENTLY
      // out of band before the deploy.
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS')
    }
  })
})
