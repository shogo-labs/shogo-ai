// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * cost-analytics.service unit tests.
 *
 * Strategy: heavy mock of `../lib/prisma` so we can exercise the bulk of
 * the service surface without a real database. We focus on the pure
 * helpers and the high-fan-out branches:
 *
 *   - Period helpers (isCostPeriod, isBudgetPeriod, deriveActiveThrottleModel)
 *   - getAgentCostBreakdown   (groupBy + $queryRaw paths)
 *   - getCostRecommendations  (downgrade / upgrade / cache-hint gates)
 *   - Budget alert CRUD       (validation + happy path)
 *   - getBudgetAlertUsage / checkBudgetAlerts (rearm logic)
 *   - Cost trends + computeForecast (via getCostTrends)
 *   - Experiment CRUD         (normalisation + validation)
 *   - pickExperimentModel     (bucketed vs. unbucketed)
 *   - summarizeExperiment     (under MIN_RUNS, B-wins, A-wins, tie)
 *   - Sub-agent override resolution / upsert / delete
 *   - Agent eval set CRUD
 *   - recordAgentCostMetric   (credit-cost recomputation + experiment auto-attach)
 *
 *   bun test apps/api/src/__tests__/cost-analytics-service.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// In-memory stores so tests can preload fixtures.
type Store = {
  metrics: any[]
  groupByRows: any[]
  flagsRows: any[]
  trendRows: any[]
  budgetAlerts: any[]
  agentEvalResults: any[]
  experiments: any[]
  subagentOverrides: any[]
  agentEvalSets: any[]
  budgetUpdates: any[]
  metricInserts: any[]
  experimentUpdates: { id: string; sql: any }[]
}

const store: Store = {
  metrics: [],
  groupByRows: [],
  flagsRows: [],
  trendRows: [],
  budgetAlerts: [],
  agentEvalResults: [],
  experiments: [],
  subagentOverrides: [],
  agentEvalSets: [],
  budgetUpdates: [],
  metricInserts: [],
  experimentUpdates: [],
}

let queryRawNext: 'flags' | 'trends' | null = null

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    agentCostMetric: {
      groupBy: async () => store.groupByRows,
      aggregate: async ({ where }: any) => ({
        _sum: { creditCost: store.metrics
          .filter((m) => m.workspaceId === where.workspaceId && (!where.createdAt?.gte || m.createdAt >= where.createdAt.gte))
          .reduce((s, m) => s + m.creditCost, 0) },
      }),
      findMany: async () => store.metrics,
      create: async (args: any) => {
        store.metricInserts.push(args.data)
        return args.data
      },
    },
    agentEvalResult: {
      findFirst: async ({ where }: any) => store.agentEvalResults.find((r) =>
        r.agentType === where.agentType
        && r.model === where.model
        && (where.workspaceId === null ? r.workspaceId == null : r.workspaceId === where.workspaceId)
      ) ?? null,
      findMany: async () => store.agentEvalResults,
      create: async (args: any) => args.data,
    },
    budgetAlert: {
      findMany: async ({ where }: any) => store.budgetAlerts.filter((a) =>
        a.workspaceId === where.workspaceId
        && (where.enabled === undefined || a.enabled === where.enabled)
      ),
      create: async (args: any) => {
        const row = { id: `ba_${store.budgetAlerts.length + 1}`, enabled: true, createdAt: new Date(), lastTriggeredAt: null, ...args.data }
        store.budgetAlerts.push(row)
        return row
      },
      update: async (args: any) => {
        const target = store.budgetAlerts.find((a) => a.id === args.where.id)
        if (!target) throw new Error('budget alert not found')
        Object.assign(target, args.data)
        store.budgetUpdates.push({ id: args.where.id, data: args.data })
        return target
      },
      delete: async (args: any) => {
        const idx = store.budgetAlerts.findIndex((a) => a.id === args.where.id)
        if (idx >= 0) store.budgetAlerts.splice(idx, 1)
        return { id: args.where.id }
      },
    },
    modelExperiment: {
      create: async (args: any) => {
        const row = {
          id: `exp_${store.experiments.length + 1}`,
          totalRunsA: 0, totalRunsB: 0, totalCostA: 0, totalCostB: 0,
          totalTokensA: 0, totalTokensB: 0, successRateA: 0, successRateB: 0,
          avgLatencyMsA: 0, avgLatencyMsB: 0, escalationsA: 0, escalationsB: 0,
          loopDetectedA: 0, loopDetectedB: 0, hitMaxTurnsA: 0, hitMaxTurnsB: 0,
          responseEmptyA: 0, responseEmptyB: 0,
          expectedEndAt: null, createdAt: new Date(),
          ...args.data,
        }
        store.experiments.push(row)
        return row
      },
      findMany: async ({ where }: any) => store.experiments.filter((e) => e.workspaceId === where.workspaceId),
      findFirst: async ({ where }: any) => store.experiments.find((e) => {
        if (where.workspaceId && e.workspaceId !== where.workspaceId) return false
        if (where.id && e.id !== where.id) return false
        if (where.agentType && e.agentType !== where.agentType) return false
        if (where.status?.in && !where.status.in.includes(e.status)) return false
        return true
      }) ?? null,
      update: async (args: any) => {
        const e = store.experiments.find((x) => x.id === args.where.id)
        if (e) Object.assign(e, args.data)
        return e
      },
    },
    subagentModelOverride: {
      findFirst: async ({ where }: any) => store.subagentOverrides.find((o) =>
        o.workspaceId === where.workspaceId
        && (where.projectId === undefined || o.projectId === where.projectId)
        && (where.agentType === undefined || o.agentType === where.agentType)
      ) ?? null,
      findMany: async ({ where }: any) => store.subagentOverrides.filter((o) => o.workspaceId === where.workspaceId),
      create: async (args: any) => {
        const row = { id: `so_${store.subagentOverrides.length + 1}`, updatedAt: new Date(), ...args.data }
        store.subagentOverrides.push(row)
        return row
      },
      update: async (args: any) => {
        const row = store.subagentOverrides.find((o) => o.id === args.where.id)
        if (row) Object.assign(row, args.data)
        return row
      },
      delete: async (args: any) => {
        const idx = store.subagentOverrides.findIndex((o) => o.id === args.where.id)
        if (idx >= 0) store.subagentOverrides.splice(idx, 1)
        return { id: args.where.id }
      },
    },
    agentEvalSet: {
      findMany: async ({ where }: any) => store.agentEvalSets.filter((s) =>
        s.workspaceId === where.workspaceId
        && (where.agentType === undefined || s.agentType === where.agentType)
        && (where.enabled === undefined || s.enabled === where.enabled)
      ),
      findFirst: async ({ where }: any) => store.agentEvalSets.find((s) => s.id === where.id && s.workspaceId === where.workspaceId) ?? null,
      create: async (args: any) => {
        const row = { id: `es_${store.agentEvalSets.length + 1}`, updatedAt: new Date(), ...args.data }
        store.agentEvalSets.push(row)
        return row
      },
      update: async (args: any) => {
        const row = store.agentEvalSets.find((s) => s.id === args.where.id)
        if (row) Object.assign(row, args.data)
        return row
      },
      delete: async (args: any) => {
        const idx = store.agentEvalSets.findIndex((s) => s.id === args.where.id)
        if (idx >= 0) store.agentEvalSets.splice(idx, 1)
        return { id: args.where.id }
      },
    },
    $queryRaw: async () => {
      if (queryRawNext === 'trends') {
        queryRawNext = null
        return store.trendRows
      }
      queryRawNext = null
      return store.flagsRows
    },
    $executeRaw: async (...args: any[]) => {
      store.experimentUpdates.push({ id: 'unknown', sql: args })
      return 1
    },
  },
}))

// Stub the @shogo/model-catalog dep that cost-analytics uses for model id
// resolution. The real catalog imports a JSON registry; for our tests we
// just need a stable identity function for known IDs and a couple of
// dollar-cost helpers that the service / usage-cost call.
mock.module('@shogo/model-catalog', () => ({
  resolveModelId: (s: string) => s,
  getModelTier: () => ({ name: 'medium', includeBudget: 0, overageRate: 0 }),
  getModelBillingModel: (s: string) => s,
  resolveAgentModeDefault: () => 'claude-sonnet-4-6',
  MODEL_DOLLAR_COSTS: {
    'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
    'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
    'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
    'gpt-5.4-nano': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    haiku: { inputPerMillion: 1, outputPerMillion: 5 },
    sonnet: { inputPerMillion: 3, outputPerMillion: 15 },
    opus: { inputPerMillion: 15, outputPerMillion: 75 },
  },
  calculateDollarCost: (model: string, inT: number, outT: number, cachedT: number) => {
    const cost = (inT * 3 + outT * 15 + cachedT * 1) / 1_000_000
    return cost
  },
}))

const cost = await import('../services/cost-analytics.service')

beforeEach(() => {
  store.metrics = []
  store.groupByRows = []
  store.flagsRows = []
  store.trendRows = []
  store.budgetAlerts = []
  store.agentEvalResults = []
  store.experiments = []
  store.subagentOverrides = []
  store.agentEvalSets = []
  store.budgetUpdates = []
  store.metricInserts = []
  store.experimentUpdates = []
  queryRawNext = null
})

// =========================================================================
// Pure helpers
// =========================================================================

describe('pure helpers', () => {
  test('isCostPeriod accepts only valid period strings', () => {
    expect(cost.isCostPeriod('7d')).toBe(true)
    expect(cost.isCostPeriod('30d')).toBe(true)
    expect(cost.isCostPeriod('90d')).toBe(true)
    expect(cost.isCostPeriod('1y')).toBe(true)
    expect(cost.isCostPeriod('bogus')).toBe(false)
  })

  test('isBudgetPeriod accepts only valid budget periods', () => {
    expect(cost.isBudgetPeriod('daily')).toBe(true)
    expect(cost.isBudgetPeriod('weekly')).toBe(true)
    expect(cost.isBudgetPeriod('monthly')).toBe(true)
    expect(cost.isBudgetPeriod('yearly')).toBe(false)
  })

  test('deriveActiveThrottleModel picks the first breached alert with autoThrottle', () => {
    const out = cost.deriveActiveThrottleModel([
      { alert: { id: 'a', name: 'A', creditLimit: 10, autoThrottle: false, throttleToModel: 'x' }, currentSpend: 11, percentUsed: 110 },
      { alert: { id: 'b', name: 'B', creditLimit: 10, autoThrottle: true, throttleToModel: 'cheap' }, currentSpend: 11, percentUsed: 110 },
    ])
    expect(out).toBe('cheap')
  })

  test('deriveActiveThrottleModel returns null when no breach qualifies', () => {
    const out = cost.deriveActiveThrottleModel([
      { alert: { id: 'a', name: 'A', creditLimit: 10, autoThrottle: true, throttleToModel: null }, currentSpend: 11, percentUsed: 110 },
      { alert: { id: 'b', name: 'B', creditLimit: 10, autoThrottle: true, throttleToModel: 'x' }, currentSpend: 5, percentUsed: 50 },
    ])
    expect(out).toBeNull()
  })
})

// =========================================================================
// getAgentCostBreakdown
// =========================================================================

describe('getAgentCostBreakdown', () => {
  test('returns empty totals when groupBy has no rows', async () => {
    store.groupByRows = []
    store.flagsRows = []
    const { breakdown, totals } = await cost.getAgentCostBreakdown('ws-1')
    expect(breakdown).toEqual([])
    expect(totals.totalCreditCost).toBe(0)
    expect(totals.uniqueAgents).toBe(0)
  })

  test('joins groupBy aggregates with the $queryRaw flag counts', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 100 },
      _sum: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, toolCalls: 10, creditCost: 5, wallTimeMs: 2000 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(95), qualitySuccesses: BigInt(90),
      hitMaxTurns: BigInt(2), loopDetected: BigInt(1), escalated: BigInt(1), responseEmpty: BigInt(0),
    }]
    const { breakdown, totals } = await cost.getAgentCostBreakdown('ws-1')
    expect(breakdown[0].qualitySuccessRate).toBe(90)
    expect(breakdown[0].escalationRate).toBe(1)
    expect(breakdown[0].successRate).toBe(95)
    expect(totals.uniqueAgents).toBe(1)
    expect(totals.totalCreditCost).toBe(5)
  })

  test('sorts breakdown by totalCreditCost descending', async () => {
    store.groupByRows = [
      { agentType: 'a', model: 'm', _count: { _all: 1 }, _sum: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0, creditCost: 1, wallTimeMs: 0 } },
      { agentType: 'b', model: 'm', _count: { _all: 1 }, _sum: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0, creditCost: 10, wallTimeMs: 0 } },
    ]
    store.flagsRows = []
    const { breakdown } = await cost.getAgentCostBreakdown('ws-1')
    expect(breakdown[0].agentType).toBe('b')
  })
})

// =========================================================================
// getCostRecommendations
// =========================================================================

describe('getCostRecommendations', () => {
  test('returns empty list when no entries meet minRuns threshold', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 5 },
      _sum: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0, creditCost: 1, wallTimeMs: 0 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(5), qualitySuccesses: BigInt(5),
      hitMaxTurns: BigInt(0), loopDetected: BigInt(0), escalated: BigInt(0), responseEmpty: BigInt(0),
    }]
    const recs = await cost.getCostRecommendations('ws-1')
    expect(recs).toEqual([])
  })

  test('suggests an upgrade when quality success rate is below threshold and tier < 4', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 50 },
      _sum: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0, creditCost: 5, wallTimeMs: 0 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(30), qualitySuccesses: BigInt(20),
      hitMaxTurns: BigInt(5), loopDetected: BigInt(5), escalated: BigInt(10), responseEmpty: BigInt(0),
    }]
    const recs = await cost.getCostRecommendations('ws-1')
    const upgrade = recs.find((r) => r.estimatedSavingsPercent === -30)
    expect(upgrade).toBeDefined()
    expect(upgrade!.recommendedModel).toContain('opus')
  })
})

// =========================================================================
// Budget alert CRUD
// =========================================================================

describe('budget alert CRUD', () => {
  test('createBudgetAlert rejects invalid periodType', async () => {
    await expect(
      cost.createBudgetAlert('ws-1', { name: 'x', creditLimit: 10, periodType: 'yearly' as any })
    ).rejects.toThrow(/Invalid periodType/)
  })

  test('createBudgetAlert defaults periodType to monthly', async () => {
    const alert = await cost.createBudgetAlert('ws-1', { name: 'x', creditLimit: 10 })
    expect(alert.periodType).toBe('monthly')
    expect(alert.autoThrottle).toBe(false)
    expect(alert.notifyEmail).toBe(true)
  })

  test('updateBudgetAlert rejects invalid periodType', async () => {
    const a = await cost.createBudgetAlert('ws-1', { name: 'x', creditLimit: 10 })
    await expect(
      cost.updateBudgetAlert(a.id, 'ws-1', { periodType: 'yearly' as any })
    ).rejects.toThrow(/Invalid periodType/)
  })

  test('deleteBudgetAlert removes the row', async () => {
    const a = await cost.createBudgetAlert('ws-1', { name: 'x', creditLimit: 10 })
    await cost.deleteBudgetAlert(a.id, 'ws-1')
    const remaining = await cost.getBudgetAlerts('ws-1')
    expect(remaining.find((x: any) => x.id === a.id)).toBeUndefined()
  })

  test('getBudgetAlertUsage returns empty list when there are no alerts', async () => {
    const out = await cost.getBudgetAlertUsage('ws-1')
    expect(out).toEqual([])
  })

  test('getBudgetAlertUsage computes percentUsed and re-arms on each period', async () => {
    await cost.createBudgetAlert('ws-1', { name: 'cap', creditLimit: 10 })
    store.metrics = [{ workspaceId: 'ws-1', creditCost: 11, createdAt: new Date() }]
    const out = await cost.getBudgetAlertUsage('ws-1')
    expect(out[0].percentUsed).toBe(110)
    expect(out[0].currentSpend).toBe(11)
    // The breach should have triggered an update on lastTriggeredAt.
    expect(store.budgetUpdates.find((u) => u.data.lastTriggeredAt)).toBeDefined()
  })

  test('checkBudgetAlerts filters to entries at ≥80% used', async () => {
    await cost.createBudgetAlert('ws-1', { name: 'cap', creditLimit: 10 })
    store.metrics = [{ workspaceId: 'ws-1', creditCost: 1, createdAt: new Date() }]
    expect((await cost.checkBudgetAlerts('ws-1')).length).toBe(0)
    store.metrics = [{ workspaceId: 'ws-1', creditCost: 9, createdAt: new Date() }]
    expect((await cost.checkBudgetAlerts('ws-1')).length).toBe(1)
  })
})

// =========================================================================
// getCostTrends + computeForecast
// =========================================================================

describe('getCostTrends', () => {
  test('aggregates rows into per-day points and produces a forecast', async () => {
    queryRawNext = 'trends'
    store.trendRows = [
      { day: new Date('2026-05-01'), totalCost: 1, totalRuns: BigInt(2), model: 'sonnet' },
      { day: new Date('2026-05-02'), totalCost: 2, totalRuns: BigInt(2), model: 'sonnet' },
      { day: new Date('2026-05-03'), totalCost: 3, totalRuns: BigInt(2), model: 'sonnet' },
      { day: new Date('2026-05-04'), totalCost: 4, totalRuns: BigInt(2), model: 'sonnet' },
    ]
    const { trends, forecast } = await cost.getCostTrends('ws-1')
    expect(trends.length).toBe(4)
    expect(forecast.trend).toBe('increasing')
    expect(forecast.percentChange).toBeGreaterThan(0)
  })

  test('forecast falls back to a stable / average estimate with < 3 points', async () => {
    queryRawNext = 'trends'
    store.trendRows = [
      { day: new Date('2026-05-01'), totalCost: 10, totalRuns: BigInt(1), model: 'sonnet' },
    ]
    const { forecast } = await cost.getCostTrends('ws-1')
    expect(forecast.trend).toBe('stable')
  })
})

// =========================================================================
// Experiments
// =========================================================================

describe('experiments', () => {
  test('createExperiment rejects unsupported agentType', async () => {
    await expect(
      cost.createExperiment('ws-1', { name: 'x', agentType: 'totally-fake', modelA: 'claude-sonnet-4-6', modelB: 'claude-haiku-4-5' })
    ).rejects.toThrow(/Unsupported experiment agentType/)
  })

  test('createExperiment rejects same modelA / modelB', async () => {
    await expect(
      cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-haiku-4-5' })
    ).rejects.toThrow(/different models/)
  })

  test('createShadowExperiment defaults to 14 days and status=shadow', async () => {
    const e = await cost.createShadowExperiment('ws-1', { agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    expect(e.status).toBe('shadow')
    expect(e.expectedEndAt).toBeInstanceOf(Date)
    expect(e.name).toContain('Shadow A/B')
  })

  test('pickExperimentModel returns null when no experiment is active', async () => {
    const out = await cost.pickExperimentModel('ws-1', 'explore')
    expect(out).toBeNull()
  })

  test('pickExperimentModel honours a stable bucketKey', async () => {
    await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    const a = await cost.pickExperimentModel('ws-1', 'explore', 'run-1')
    const b = await cost.pickExperimentModel('ws-1', 'explore', 'run-1')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.variant).toBe(b!.variant)
  })

  test('recordExperimentResult issues a SQL update', async () => {
    await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    await cost.recordExperimentResult('exp_1', 'A', { creditCost: 1, tokens: 100, success: true, latencyMs: 250 })
    await cost.recordExperimentResult('exp_1', 'B', { creditCost: 2, tokens: 100, success: false, latencyMs: 250, loopDetected: true })
    expect(store.experimentUpdates.length).toBe(2)
  })

  test('summarizeExperiment returns "inconclusive" under MIN_RUNS', async () => {
    const e = await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    e.totalRunsA = 5; e.totalRunsB = 5
    const summary = await cost.summarizeExperiment(e.id, 'ws-1')
    expect(summary!.verdict).toBe('inconclusive')
  })

  test('summarizeExperiment picks B when B is cheaper and quality is close', async () => {
    const e = await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    Object.assign(e, {
      totalRunsA: 50, totalRunsB: 50,
      totalCostA: 100, totalCostB: 50,
      successRateA: 95, successRateB: 95,
      avgLatencyMsA: 300, avgLatencyMsB: 250,
      escalationsA: 1, escalationsB: 1,
      loopDetectedA: 0, loopDetectedB: 0,
      hitMaxTurnsA: 0, hitMaxTurnsB: 0,
      responseEmptyA: 0, responseEmptyB: 0,
    })
    const summary = await cost.summarizeExperiment(e.id, 'ws-1')
    expect(summary!.verdict).toBe('B')
  })

  test('summarizeExperiment picks A when B regresses quality', async () => {
    const e = await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    Object.assign(e, {
      totalRunsA: 50, totalRunsB: 50,
      totalCostA: 50, totalCostB: 100,
      escalationsA: 0, escalationsB: 30,
    })
    const summary = await cost.summarizeExperiment(e.id, 'ws-1')
    expect(summary!.verdict).toBe('A')
  })

  test('stopExperiment marks status as completed', async () => {
    const e = await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    await cost.stopExperiment(e.id, 'ws-1')
    expect(e.status).toBe('completed')
  })

  test('getActiveExperimentForAgent finds running/shadow experiments only', async () => {
    const e = await cost.createExperiment('ws-1', { name: 'x', agentType: 'explore', modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6' })
    expect(await cost.getActiveExperimentForAgent('ws-1', 'explore')).toBe(e)
    await cost.stopExperiment(e.id, 'ws-1')
    expect(await cost.getActiveExperimentForAgent('ws-1', 'explore')).toBeNull()
  })
})

// =========================================================================
// Sub-agent overrides
// =========================================================================

describe('sub-agent overrides', () => {
  test('resolveSubagentModelOverride returns null when no override exists', async () => {
    expect(await cost.resolveSubagentModelOverride('ws-1', 'reviewer')).toBeNull()
  })

  test('resolveSubagentModelOverride prefers project-level over workspace-level', async () => {
    store.subagentOverrides.push(
      { id: 'so_1', workspaceId: 'ws-1', projectId: null, agentType: 'reviewer', model: 'workspace-model', provider: null, updatedAt: new Date() },
      { id: 'so_2', workspaceId: 'ws-1', projectId: 'proj-1', agentType: 'reviewer', model: 'project-model', provider: null, updatedAt: new Date() },
    )
    const out = await cost.resolveSubagentModelOverride('ws-1', 'reviewer', 'proj-1')
    expect(out!.source).toBe('project')
    expect(out!.model).toBe('project-model')
  })

  test('upsertSubagentOverride forbids main-chat', async () => {
    await expect(
      cost.upsertSubagentOverride('ws-1', { agentType: 'main-chat', model: 'x' })
    ).rejects.toThrow(/main-chat/)
  })

  test('upsertSubagentOverride creates a new row when none exists', async () => {
    const out = await cost.upsertSubagentOverride('ws-1', { agentType: 'reviewer', model: 'cheap-model' })
    expect(out.id).toBeDefined()
    expect(out.model).toBe('cheap-model')
  })

  test('upsertSubagentOverride updates an existing row', async () => {
    await cost.upsertSubagentOverride('ws-1', { agentType: 'reviewer', model: 'a' })
    const out = await cost.upsertSubagentOverride('ws-1', { agentType: 'reviewer', model: 'b' })
    expect(out.model).toBe('b')
    expect(store.subagentOverrides.length).toBe(1)
  })

  test('deleteSubagentOverride returns null when nothing to delete', async () => {
    expect(await cost.deleteSubagentOverride('ws-1', 'reviewer')).toBeNull()
  })

  test('deleteSubagentOverride removes an existing row', async () => {
    await cost.upsertSubagentOverride('ws-1', { agentType: 'reviewer', model: 'a' })
    expect(store.subagentOverrides.length).toBe(1)
    await cost.deleteSubagentOverride('ws-1', 'reviewer')
    expect(store.subagentOverrides.length).toBe(0)
  })
})

// =========================================================================
// Agent eval sets
// =========================================================================

describe('agent eval sets', () => {
  test('listAgentEvalSets returns empty array when nothing exists', async () => {
    expect(await cost.listAgentEvalSets({ workspaceId: 'ws-1' })).toEqual([])
  })

  test('upsertAgentEvalSet creates a new row', async () => {
    const row = await cost.upsertAgentEvalSet('ws-1', {
      agentType: 'reviewer',
      name: 'Reviewer set',
      examples: [],
    })
    expect(row!.agentType).toBe('reviewer')
  })

  test('upsertAgentEvalSet updates an existing row when id is provided', async () => {
    const row = await cost.upsertAgentEvalSet('ws-1', { agentType: 'r', name: 'r', examples: [] })
    const updated = await cost.upsertAgentEvalSet('ws-1', { id: row!.id, agentType: 'r', name: 'updated', examples: [] })
    expect(updated!.name).toBe('updated')
  })

  test('deleteAgentEvalSet returns null when missing', async () => {
    expect(await cost.deleteAgentEvalSet('ws-1', 'missing')).toBeNull()
  })

  test('recordAgentEvalResult computes passRate and stores the row', async () => {
    const out = await cost.recordAgentEvalResult({
      agentType: 'reviewer', model: 'sonnet', suite: 'pr-comments',
      totalCases: 10, passedCases: 8,
    })
    expect(out.passRate).toBe(0.8)
  })
})

// =========================================================================
// recordAgentCostMetric
// =========================================================================

describe('recordAgentCostMetric', () => {
  test('inserts a metric row', async () => {
    await cost.recordAgentCostMetric({
      workspaceId: 'ws-1', agentType: 'reviewer', model: 'claude-haiku-4-5',
      inputTokens: 0, outputTokens: 0, toolCalls: 0, creditCost: 0,
      wallTimeMs: 0, success: true,
    })
    expect(store.metricInserts.length).toBe(1)
  })

  test('server recomputes creditCost when caller passes 0 and there are tokens', async () => {
    await cost.recordAgentCostMetric({
      workspaceId: 'ws-1', agentType: 'reviewer', model: 'claude-haiku-4-5',
      inputTokens: 1000, outputTokens: 500, toolCalls: 0, creditCost: 0,
      wallTimeMs: 100, success: true,
    })
    expect(store.metricInserts[0].creditCost).toBeGreaterThan(0)
  })

  test('auto-attaches a run to an active experiment when the model matches', async () => {
    // `normalizeExperimentAgentType('reviewer')` rewrites to 'code-reviewer',
    // so the recorded metric's agentType must match the normalized form
    // used by the experiment.
    await cost.createExperiment('ws-1', {
      name: 'x', agentType: 'code-reviewer',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    await cost.recordAgentCostMetric({
      workspaceId: 'ws-1', agentType: 'code-reviewer', model: 'claude-haiku-4-5',
      inputTokens: 1000, outputTokens: 500, toolCalls: 0, creditCost: 0.1,
      wallTimeMs: 200, success: true,
    })
    // Wait a microtask cycle for the fire-and-forget recordExperimentResult.
    await new Promise((r) => setTimeout(r, 5))
    expect(store.experimentUpdates.length).toBeGreaterThan(0)
  })
})
