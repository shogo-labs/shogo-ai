// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runs cost-analytics raw SQL against a real in-memory SQLite database, the
 * engine desktop (local mode) uses. The Postgres-heavy unit tests mock
 * `$queryRaw`, so dialect-only syntax would otherwise ship unnoticed.
 *
 *   bun test apps/api/src/__tests__/cost-analytics-sqlite.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Prisma } from '../generated/prisma-sqlite/client'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const db = new Database(':memory:')

function bind(values: unknown[]) {
  return values.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as any[]
}

db.run(`CREATE TABLE "agent_cost_metrics" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "projectId" TEXT,
  "agentType" TEXT NOT NULL, "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0, "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0, "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "creditCost" REAL NOT NULL DEFAULT 0, "wallTimeMs" INTEGER NOT NULL DEFAULT 0,
  "success" BOOLEAN NOT NULL DEFAULT true, "hitMaxTurns" BOOLEAN NOT NULL DEFAULT false,
  "loopDetected" BOOLEAN NOT NULL DEFAULT false, "escalated" BOOLEAN NOT NULL DEFAULT false,
  "responseEmpty" BOOLEAN NOT NULL DEFAULT false, "metadata" TEXT, "createdAt" DATETIME NOT NULL
)`)
db.run(`CREATE TABLE "model_experiments" (
  "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL,
  "totalRunsA" INTEGER NOT NULL DEFAULT 0, "totalCostA" REAL NOT NULL DEFAULT 0, "totalTokensA" INTEGER NOT NULL DEFAULT 0,
  "successRateA" REAL NOT NULL DEFAULT 0, "avgLatencyMsA" REAL NOT NULL DEFAULT 0,
  "escalationsA" INTEGER NOT NULL DEFAULT 0, "loopDetectedA" INTEGER NOT NULL DEFAULT 0,
  "hitMaxTurnsA" INTEGER NOT NULL DEFAULT 0, "responseEmptyA" INTEGER NOT NULL DEFAULT 0,
  "totalRunsB" INTEGER NOT NULL DEFAULT 0, "totalCostB" REAL NOT NULL DEFAULT 0, "totalTokensB" INTEGER NOT NULL DEFAULT 0,
  "successRateB" REAL NOT NULL DEFAULT 0, "avgLatencyMsB" REAL NOT NULL DEFAULT 0,
  "escalationsB" INTEGER NOT NULL DEFAULT 0, "loopDetectedB" INTEGER NOT NULL DEFAULT 0,
  "hitMaxTurnsB" INTEGER NOT NULL DEFAULT 0, "responseEmptyB" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL
)`)

mock.module('../lib/prisma', () => withPrismaExports({
  Prisma,
  prisma: {
    agentCostMetric: {
      groupBy: async ({ where }: any) => db.query(`
        SELECT "agentType", "model", COUNT(*) AS n,
          SUM("inputTokens") AS i, SUM("outputTokens") AS o, SUM("cachedInputTokens") AS c, SUM("cacheWriteTokens") AS cw,
          SUM("toolCalls") AS t, SUM("creditCost") AS cost, SUM("wallTimeMs") AS w
        FROM "agent_cost_metrics" WHERE "workspaceId" = ? AND "createdAt" >= ?
        GROUP BY 1, 2
      `).all(where.workspaceId, where.createdAt.gte.toISOString()).map((r: any) => ({
        agentType: r.agentType,
        model: r.model,
        _count: { _all: r.n },
        _sum: { inputTokens: r.i, outputTokens: r.o, cachedInputTokens: r.c, cacheWriteTokens: r.cw, toolCalls: r.t, creditCost: r.cost, wallTimeMs: r.w },
      })),
    },
    $queryRaw: async (q: Prisma.Sql) => db.query(q.sql).all(...bind(q.values)),
    $executeRaw: async (q: Prisma.Sql) => db.query(q.sql).run(...bind(q.values)).changes,
  },
}))

const cost = await import('../services/cost-analytics.service')

const previousLocalMode = process.env.SHOGO_LOCAL_MODE
beforeAll(() => { process.env.SHOGO_LOCAL_MODE = 'true' })
afterAll(() => {
  if (previousLocalMode === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = previousLocalMode
})

beforeEach(() => {
  db.run('DELETE FROM "agent_cost_metrics"')
  db.run('DELETE FROM "model_experiments"')
})

let seq = 0
function metric(row: Partial<Record<string, unknown>>) {
  const r = {
    id: `m${++seq}`, workspaceId: 'ws-1', agentType: 'main-chat', model: 'claude-sonnet-4-6',
    creditCost: 1, success: 1, hitMaxTurns: 0, loopDetected: 0, escalated: 0, responseEmpty: 0,
    metadata: null, createdAt: new Date().toISOString(), ...row,
  }
  db.query(`INSERT INTO "agent_cost_metrics"
    ("id","workspaceId","agentType","model","creditCost","success","hitMaxTurns","loopDetected","escalated","responseEmpty","metadata","createdAt")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r.id, r.workspaceId, r.agentType, r.model, r.creditCost, r.success, r.hitMaxTurns, r.loopDetected, r.escalated, r.responseEmpty, r.metadata, r.createdAt,
  )
}

describe('cost analytics on SQLite', () => {
  test('getAgentCostBreakdown counts boolean flags per agent and model', async () => {
    metric({})
    metric({})
    metric({ hitMaxTurns: 1 })
    metric({ success: 0, escalated: 1 })
    metric({ workspaceId: 'other' })

    const { breakdown } = await cost.getAgentCostBreakdown('ws-1')

    expect(breakdown).toHaveLength(1)
    expect(breakdown[0].totalRuns).toBe(4)
    expect(breakdown[0].successRate).toBe(75)
    expect(breakdown[0].qualitySuccessRate).toBe(50)
    expect(breakdown[0].escalationRate).toBe(25)
  })

  test('rows with unknown quality count toward cost and runs but not quality rates', async () => {
    metric({ metadata: '{"chatSessionId":"c"}' })
    metric({ success: 0 })
    metric({ metadata: '{"usageSource":"local-proxy","backfill":"cache-cost-2026-10","qualityUnknown":true}', creditCost: 5 })
    metric({ metadata: '{"usageSource":"local-proxy","backfill":"cache-cost-2026-10","qualityUnknown":true}', creditCost: 5 })

    const { breakdown, totals } = await cost.getAgentCostBreakdown('ws-1')

    expect(breakdown[0].totalRuns).toBe(4)
    expect(breakdown[0].scoredRuns).toBe(2)
    expect(breakdown[0].successRate).toBe(50)
    expect(breakdown[0].qualitySuccessRate).toBe(50)
    expect(totals.totalCreditCost).toBe(12)
  })

  test('recordExperimentResult updates running averages', async () => {
    db.query(`INSERT INTO "model_experiments" ("id","status","updatedAt") VALUES ('exp','running',?)`).run(new Date(0).toISOString())

    await cost.recordExperimentResult('exp', 'A', { creditCost: 1, tokens: 10, success: true, latencyMs: 200 })
    await cost.recordExperimentResult('exp', 'A', { creditCost: 1, tokens: 10, success: false, latencyMs: 101, loopDetected: true })

    const row = db.query('SELECT * FROM "model_experiments" WHERE "id" = ?').get('exp') as any
    expect(row.totalRunsA).toBe(2)
    expect(row.successRateA).toBe(50)
    expect(row.avgLatencyMsA).toBe(151)
    expect(row.loopDetectedA).toBe(1)
    expect(row.updatedAt).not.toBe(new Date(0).toISOString())
  })
})
