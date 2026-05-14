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
let throwMetricCreate = false
let throwEvalFindFirst: any = null
let throwExperimentFindMany: any = null
let throwOverrideFindMany: any = null
let throwEvalSetFindMany: any = null

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    agentCostMetric: {
      groupBy: async () => store.groupByRows,
      aggregate: async ({ where }: any) => {
        const matched = store.metrics.filter((m) => {
          if (where.workspaceId && m.workspaceId !== where.workspaceId) return false
          if (where.agentType && m.agentType !== where.agentType) return false
          if (where.projectId && m.projectId !== where.projectId) return false
          if (where.createdAt?.gte && m.createdAt < where.createdAt.gte) return false
          if (where.createdAt?.lt && m.createdAt >= where.createdAt.lt) return false
          if (where.createdAt?.lte && m.createdAt > where.createdAt.lte) return false
          return true
        })
        const sum = matched.reduce((s, m) => s + (m.creditCost ?? 0), 0)
        return {
          _sum: { creditCost: sum },
          _avg: { creditCost: matched.length ? sum / matched.length : null },
          _count: { _all: matched.length },
        }
      },
      findMany: async ({ where }: any = {}) => {
        if (!where) return store.metrics
        return store.metrics.filter((m) => {
          if (where.workspaceId && m.workspaceId !== where.workspaceId) return false
          if (where.agentType && m.agentType !== where.agentType) return false
          if (where.projectId && m.projectId !== where.projectId) return false
          if (where.createdAt?.gte && m.createdAt < where.createdAt.gte) return false
          if (where.createdAt?.lt && m.createdAt >= where.createdAt.lt) return false
          if (where.createdAt?.lte && m.createdAt > where.createdAt.lte) return false
          return true
        })
      },
      create: async (args: any) => {
        if (throwMetricCreate) throw new Error('metric create failed')
        store.metricInserts.push(args.data)
        return args.data
      },
    },
    agentEvalResult: {
      findFirst: async ({ where }: any) => {
        if (throwEvalFindFirst) throw throwEvalFindFirst
        return store.agentEvalResults.find((r) =>
          r.agentType === where.agentType
          && r.model === where.model
          && (where.workspaceId === null ? r.workspaceId == null : r.workspaceId === where.workspaceId)
        ) ?? null
      },
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
      findMany: async ({ where }: any) => {
        if (throwExperimentFindMany) throw throwExperimentFindMany
        return store.experiments.filter((e) => e.workspaceId === where.workspaceId)
      },
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
      findMany: async ({ where }: any) => {
        if (throwOverrideFindMany) throw throwOverrideFindMany
        return store.subagentOverrides.filter((o) => o.workspaceId === where.workspaceId)
      },
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
      findMany: async ({ where }: any) => {
        if (throwEvalSetFindMany) throw throwEvalSetFindMany
        return store.agentEvalSets.filter((s) =>
          s.workspaceId === where.workspaceId
          && (where.agentType === undefined || s.agentType === where.agentType)
          && (where.enabled === undefined || s.enabled === where.enabled)
        )
      },
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
  throwMetricCreate = false
  throwEvalFindFirst = null
  throwExperimentFindMany = null
  throwOverrideFindMany = null
  throwEvalSetFindMany = null
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

// =========================================================================
// Additional coverage: recommendations downgrade path + eval anchor
// =========================================================================

describe('getCostRecommendations — downgrade path', () => {
  test('suggests a downgrade when quality gate passes and savings exceed minimum', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',  // tier 3 → candidate tier 2 (haiku)
      _count: { _all: 100 },
      _sum: { inputTokens: 5_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, toolCalls: 0, creditCost: 30, wallTimeMs: 0 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(100), qualitySuccesses: BigInt(95),
      hitMaxTurns: BigInt(0), loopDetected: BigInt(0), escalated: BigInt(2), responseEmpty: BigInt(0),
    }]
    // Workspace-level eval anchor — should be picked over global ones.
    store.agentEvalResults.push({
      workspaceId: 'ws-1', agentType: 'reviewer', model: 'claude-haiku-4-5',
      suite: 'pr-comments', passRate: 0.92, createdAt: new Date(),
    })
    const recs = await cost.getCostRecommendations('ws-1', '30d')
    const downgrade = recs.find((r) => r.estimatedSavingsPercent > 0 && r.recommendedModel === 'claude-haiku-4-5')
    expect(downgrade).toBeDefined()
    expect(downgrade!.evidence.evalAnchor?.suite).toBe('pr-comments')
    expect(downgrade!.confidence).toBe('high')  // passRate ≥ .85 and runs ≥ 50
    expect(downgrade!.estimatedMonthlySavings).toBeGreaterThan(0)
    expect(downgrade!.reason).toContain('Eval-anchored')
  })

  test('falls back to global eval anchor when no workspace-specific row exists', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 100 },
      _sum: { inputTokens: 200_000, outputTokens: 100_000, cachedInputTokens: 0, toolCalls: 0, creditCost: 30, wallTimeMs: 0 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(100), qualitySuccesses: BigInt(95),
      hitMaxTurns: BigInt(0), loopDetected: BigInt(0), escalated: BigInt(0), responseEmpty: BigInt(0),
    }]
    store.agentEvalResults.push({
      workspaceId: null, agentType: 'reviewer', model: 'claude-haiku-4-5',
      suite: 'global-eval', passRate: 0.7, createdAt: new Date(),
    })
    const recs = await cost.getCostRecommendations('ws-1', '7d')
    const downgrade = recs.find((r) => r.recommendedModel === 'claude-haiku-4-5')
    expect(downgrade!.evidence.evalAnchor?.suite).toBe('global-eval')
    // passRate < .85 → confidence is 'medium' (runs ≥ 20)
    expect(downgrade!.confidence).toBe('medium')
  })

  test('emits a cache-utilization hint when cache ratio is low and tokens are high', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 30 },
      // Very low cache utilisation, big input volume → triggers cache hint.
      _sum: { inputTokens: 500_000, outputTokens: 50_000, cachedInputTokens: 1000, toolCalls: 0, creditCost: 2, wallTimeMs: 0 },
    }]
    // Low quality success so downgrade doesn't fire; high quality so we don't get upgrade either.
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(30), qualitySuccesses: BigInt(22),  // 73% → no downgrade, no upgrade
      hitMaxTurns: BigInt(0), loopDetected: BigInt(0), escalated: BigInt(0), responseEmpty: BigInt(0),
    }]
    const recs = await cost.getCostRecommendations('ws-1')
    const cacheHint = recs.find((r) => r.reason.includes('prompt cache'))
    expect(cacheHint).toBeDefined()
    expect(cacheHint!.estimatedSavingsPercent).toBe(20)
  })

  test('iterates correctly for 90d and 1y periods', async () => {
    store.groupByRows = []
    store.flagsRows = []
    const recs90 = await cost.getCostRecommendations('ws-1', '90d')
    const recs1y = await cost.getCostRecommendations('ws-1', '1y')
    expect(recs90).toEqual([])
    expect(recs1y).toEqual([])
  })

  test('getAgentCostBreakdown filters by projectId when provided', async () => {
    store.groupByRows = []
    store.flagsRows = []
    const out = await cost.getAgentCostBreakdown('ws-1', '30d', 'proj-1')
    expect(out.breakdown).toEqual([])
  })

  test('continues without eval anchor when eval lookup table is unavailable', async () => {
    store.groupByRows = [{
      agentType: 'reviewer',
      model: 'claude-sonnet-4-6',
      _count: { _all: 100 },
      _sum: { inputTokens: 5_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, toolCalls: 0, creditCost: 30, wallTimeMs: 0 },
    }]
    store.flagsRows = [{
      agentType: 'reviewer', model: 'claude-sonnet-4-6',
      promiseSuccesses: BigInt(100), qualitySuccesses: BigInt(95),
      hitMaxTurns: BigInt(0), loopDetected: BigInt(0), escalated: BigInt(0), responseEmpty: BigInt(0),
    }]
    throwEvalFindFirst = Object.assign(new Error('no such table: agent_eval_results'), { code: 'P2021' })

    const recs = await cost.getCostRecommendations('ws-1')

    const downgrade = recs.find((r) => r.recommendedModel === 'claude-haiku-4-5')
    expect(downgrade).toBeDefined()
    expect(downgrade!.evidence.evalAnchor).toBeUndefined()
  })
})

// =========================================================================
// listSubagentOverrides / listAgentEvalResults
// =========================================================================

describe('listSubagentOverrides / listAgentEvalResults', () => {
  test('listSubagentOverrides returns rows scoped to workspace', async () => {
    await cost.upsertSubagentOverride('ws-1', { agentType: 'reviewer', model: 'a' })
    await cost.upsertSubagentOverride('ws-1', { agentType: 'browser', model: 'b' })
    const out = await cost.listSubagentOverrides('ws-1')
    expect(out.length).toBe(2)
  })

  test('listAgentEvalResults returns global rows when no workspaceId is provided', async () => {
    store.agentEvalResults.push(
      { agentType: 'r', model: 'm', workspaceId: null, suite: 's', passRate: 1, totalCases: 1, createdAt: new Date() },
    )
    const out = await cost.listAgentEvalResults({})
    expect(out.length).toBeGreaterThan(0)
  })

  test('listAgentEvalResults filters by workspaceId when supplied', async () => {
    store.agentEvalResults.push(
      { agentType: 'r', model: 'm', workspaceId: 'ws-1', suite: 's', passRate: 0.5, totalCases: 1, createdAt: new Date() },
    )
    const out = await cost.listAgentEvalResults({ workspaceId: 'ws-1', limit: 5 })
    expect(out.length).toBeGreaterThan(0)
  })

  test('listSubagentOverrides and listAgentEvalSets return empty arrays when tables are unavailable', async () => {
    throwOverrideFindMany = Object.assign(new Error('relation does not exist'), { code: 'P2021' })
    await expect(cost.listSubagentOverrides('ws-1')).resolves.toEqual([])

    throwEvalSetFindMany = Object.assign(new Error('no such table: agent_eval_sets'), { code: 'P2021' })
    await expect(cost.listAgentEvalSets({ workspaceId: 'ws-1' })).resolves.toEqual([])
  })

  test('getExperiments returns empty array when experiment table is unavailable', async () => {
    throwExperimentFindMany = Object.assign(new Error('model_experiments does not exist'), { code: 'P2021' })
    await expect(cost.getExperiments('ws-1')).resolves.toEqual([])
  })
})

// =========================================================================
// Additional experiment branches
// =========================================================================

describe('experiments — additional branches', () => {
  test('createExperiment normalises model aliases like opus-4.7', async () => {
    const e = await cost.createExperiment('ws-1', {
      name: 'alias', agentType: 'browser',
      modelA: 'opus-4.7', modelB: 'haiku-4.5',
    })
    expect(e.modelA).toBe('claude-opus-4-7')
    expect(e.modelB).toBe('claude-haiku-4-5')
  })

  test('normalizeExperimentAgentType resolves aliases (browser_qa, reviewer, generalpurpose)', async () => {
    const a = await cost.createExperiment('ws-1', {
      name: 'a', agentType: 'browserqa',
      modelA: 'claude-sonnet-4-6', modelB: 'claude-haiku-4-5',
    })
    expect(a.agentType).toBe('browser_qa')
    const b = await cost.createExperiment('ws-1', {
      name: 'b', agentType: 'reviewer',
      modelA: 'claude-sonnet-4-6', modelB: 'claude-haiku-4-5',
    })
    expect(b.agentType).toBe('code-reviewer')
    const c = await cost.createExperiment('ws-1', {
      name: 'c', agentType: 'generalpurpose',
      modelA: 'claude-sonnet-4-6', modelB: 'claude-haiku-4-5',
    })
    expect(c.agentType).toBe('general-purpose')
  })

  test('getExperiments + getExperiment return rows from the store', async () => {
    const e = await cost.createExperiment('ws-1', {
      name: 'list', agentType: 'explore',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    const list = await cost.getExperiments('ws-1')
    expect(list.length).toBe(1)
    const one = await cost.getExperiment(e.id, 'ws-1')
    expect(one).toBeDefined()
  })

  test('pickExperimentModel without a bucketKey uses the random / ratio branch', async () => {
    await cost.createExperiment('ws-1', {
      name: 'r', agentType: 'explore',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    const out = await cost.pickExperimentModel('ws-1', 'explore')
    expect(out).not.toBeNull()
    expect(['A', 'B']).toContain(out!.variant)
  })

  test('recordExperimentResult variant B path executes its SQL', async () => {
    await cost.createExperiment('ws-1', {
      name: 'rB', agentType: 'browser',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    await cost.recordExperimentResult('exp_1', 'B', {
      creditCost: 0.5, tokens: 100, success: false, latencyMs: 300,
      hitMaxTurns: true, escalated: true, responseEmpty: true,
    })
    expect(store.experimentUpdates.length).toBe(1)
  })

  test('summarizeExperiment returns "A" when B is no cheaper than A', async () => {
    const e = await cost.createExperiment('ws-1', {
      name: 'eq', agentType: 'explore',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    Object.assign(e, {
      totalRunsA: 50, totalRunsB: 50,
      totalCostA: 50, totalCostB: 60,  // B more expensive
      successRateA: 90, successRateB: 90,
      avgLatencyMsA: 250, avgLatencyMsB: 250,
      escalationsA: 0, escalationsB: 0,
      loopDetectedA: 0, loopDetectedB: 0,
      hitMaxTurnsA: 0, hitMaxTurnsB: 0,
      responseEmptyA: 0, responseEmptyB: 0,
    })
    const summary = await cost.summarizeExperiment(e.id, 'ws-1')
    expect(summary!.verdict).toBe('A')
  })

  test('summarizeExperiment returns "tie" when quality is close but cost direction is ambiguous', async () => {
    const e = await cost.createExperiment('ws-1', {
      name: 'tie', agentType: 'explore',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    Object.assign(e, {
      totalRunsA: 50, totalRunsB: 50,
      totalCostA: 50, totalCostB: 40,
      successRateA: 90, successRateB: 85,
      avgLatencyMsA: 250, avgLatencyMsB: 240,
      // B loop rate slightly worse so qualityCloseEnough=false but not qualityWorse either.
      escalationsA: 0, escalationsB: 0,
      loopDetectedA: 0, loopDetectedB: 1,
      hitMaxTurnsA: 0, hitMaxTurnsB: 0,
      responseEmptyA: 0, responseEmptyB: 0,
    })
    const summary = await cost.summarizeExperiment(e.id, 'ws-1')
    expect(summary!.verdict).toBe('tie')
  })

  test('summarizeExperiment returns null for an unknown experiment', async () => {
    const out = await cost.summarizeExperiment('does-not-exist', 'ws-1')
    expect(out).toBeNull()
  })
})

// =========================================================================
// Sub-agent override delete-with-projectId / agent eval set delete-existing
// =========================================================================

describe('sub-agent overrides — project scope', () => {
  test('resolveSubagentModelOverride falls through to workspace level when project has none', async () => {
    store.subagentOverrides.push({
      id: 'so_x', workspaceId: 'ws-1', projectId: null, agentType: 'reviewer',
      model: 'workspace-model', provider: null, updatedAt: new Date(),
    })
    const out = await cost.resolveSubagentModelOverride('ws-1', 'reviewer', 'proj-z')
    // Project-level findFirst (with projectId='proj-z') returns null because
    // the only row has projectId=null, so workspace-level lookup wins.
    expect(out!.source).toBe('workspace')
  })
})

describe('agent eval sets — extra branches', () => {
  test('upsertAgentEvalSet with an id that does not exist returns null', async () => {
    const out = await cost.upsertAgentEvalSet('ws-1', {
      id: 'missing', agentType: 'r', name: 'n', examples: [],
    })
    expect(out).toBeNull()
  })

  test('deleteAgentEvalSet removes an existing row', async () => {
    const row = await cost.upsertAgentEvalSet('ws-1', {
      agentType: 'reviewer', name: 'r', examples: [],
    })
    const out = await cost.deleteAgentEvalSet('ws-1', row!.id)
    expect(out!.id).toBe(row!.id)
    expect(store.agentEvalSets.length).toBe(0)
  })

  test('listAgentEvalSets honours agentType / enabled / projectId filters', async () => {
    store.agentEvalSets.push(
      { id: 'es_a', workspaceId: 'ws-1', agentType: 'reviewer', enabled: true, projectId: null },
      { id: 'es_b', workspaceId: 'ws-1', agentType: 'browser', enabled: false, projectId: null },
    )
    const filtered = await cost.listAgentEvalSets({
      workspaceId: 'ws-1', agentType: 'reviewer', enabled: true, projectId: null,
    })
    expect(filtered.length).toBe(1)
  })
})

// =========================================================================
// getOptimizerInActionReport — large uncovered block
// =========================================================================

describe('getOptimizerInActionReport', () => {
  test('returns empty arrays when the workspace has no data', async () => {
    const report = await cost.getOptimizerInActionReport('ws-empty')
    expect(report.overrides).toEqual([])
    expect(report.evalScores).toEqual([])
    expect(report.experiments).toEqual([])
    expect(report.monthlySavingsUSD).toBe(0)
    expect(report.workspaceId).toBe('ws-empty')
  })

  test('builds before/after windows for each override and rolls up monthly savings', async () => {
    const cutoff = new Date('2026-06-15T00:00:00Z')
    // Override row.
    store.subagentOverrides.push({
      id: 'so_opt', workspaceId: 'ws-opt', projectId: null,
      agentType: 'reviewer', model: 'claude-haiku-4-5', provider: null,
      updatedAt: cutoff, updatedBy: 'user-1',
    })
    // Pre-override (higher cost, lower quality).
    const before = new Date(cutoff.getTime() - 10 * 24 * 60 * 60 * 1000)
    store.metrics.push({
      workspaceId: 'ws-opt', agentType: 'reviewer', createdAt: before,
      creditCost: 1, success: true, hitMaxTurns: false, loopDetected: false, escalated: false, responseEmpty: false,
    }, {
      workspaceId: 'ws-opt', agentType: 'reviewer', createdAt: before,
      creditCost: 1, success: false, hitMaxTurns: true, loopDetected: false, escalated: false, responseEmpty: false,
    })
    // Post-override (lower cost, full quality).
    const after = new Date(cutoff.getTime() + 5 * 24 * 60 * 60 * 1000)
    store.metrics.push({
      workspaceId: 'ws-opt', agentType: 'reviewer', createdAt: after,
      creditCost: 0.1, success: true, hitMaxTurns: false, loopDetected: false, escalated: false, responseEmpty: false,
    }, {
      workspaceId: 'ws-opt', agentType: 'reviewer', createdAt: after,
      creditCost: 0.1, success: true, hitMaxTurns: false, loopDetected: false, escalated: false, responseEmpty: false,
    })
    // Eval rows — workspace shadows global of the same key.
    store.agentEvalResults.push(
      { workspaceId: null, agentType: 'reviewer', model: 'claude-haiku-4-5',
        suite: 'global', passRate: 0.7, totalCases: 10, createdAt: new Date('2026-05-01') },
      { workspaceId: 'ws-opt', agentType: 'reviewer', model: 'claude-haiku-4-5',
        suite: 'ws', passRate: 0.92, totalCases: 10, createdAt: new Date('2026-06-01') },
    )
    // One running experiment + one completed-recent + one completed-old.
    store.experiments.push(
      { id: 'exp_run', workspaceId: 'ws-opt', name: 'live', agentType: 'explore',
        modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6', status: 'running',
        expectedEndAt: null, updatedAt: new Date(),
        totalRunsA: 5, totalRunsB: 5, totalCostA: 0, totalCostB: 0,
        successRateA: 0, successRateB: 0, avgLatencyMsA: 0, avgLatencyMsB: 0,
        escalationsA: 0, escalationsB: 0, loopDetectedA: 0, loopDetectedB: 0,
        hitMaxTurnsA: 0, hitMaxTurnsB: 0, responseEmptyA: 0, responseEmptyB: 0 },
    )

    const report = await cost.getOptimizerInActionReport('ws-opt')
    expect(report.overrides.length).toBe(1)
    expect(report.overrides[0].toModel).toBe('claude-haiku-4-5')
    expect(report.overrides[0].runsBefore).toBe(2)
    expect(report.overrides[0].runsAfter).toBe(2)
    expect(report.overrides[0].avgCostBefore).toBeCloseTo(1, 5)
    expect(report.overrides[0].avgCostAfter).toBeCloseTo(0.1, 5)
    expect(report.overrides[0].qualitySuccessAfter).toBe(100)
    expect(report.monthlySavingsUSD).toBeGreaterThan(0)
    // Eval scores — workspace row should appear (most recent first); we
    // dedupe by (agentType, model) so only one row for the pair survives.
    const pair = report.evalScores.find((s) => s.agentType === 'reviewer' && s.model === 'claude-haiku-4-5')
    expect(pair).toBeDefined()
    // Experiment summarised with an inconclusive verdict (under MIN_RUNS).
    expect(report.experiments[0].verdict).toBe('inconclusive')
  })

  test('returns nulls when override window has no metrics', async () => {
    store.subagentOverrides.push({
      id: 'so_dry', workspaceId: 'ws-dry', projectId: null,
      agentType: 'browser', model: 'claude-haiku-4-5', provider: null,
      updatedAt: new Date(), updatedBy: null,
    })
    const report = await cost.getOptimizerInActionReport('ws-dry')
    expect(report.overrides[0].avgCostBefore).toBeNull()
    expect(report.overrides[0].avgCostAfter).toBeNull()
    expect(report.overrides[0].qualitySuccessBefore).toBeNull()
    expect(report.overrides[0].qualitySuccessAfter).toBeNull()
    expect(report.monthlySavingsUSD).toBe(0)
  })
})

// =========================================================================
// recordAgentCostMetric — no-active-experiment branch
// =========================================================================

describe('recordAgentCostMetric — no active experiment', () => {
  test('does not crash when no experiment matches the agent', async () => {
    await cost.recordAgentCostMetric({
      workspaceId: 'ws-noexp', agentType: 'browser',
      model: 'claude-haiku-4-5',
      inputTokens: 100, outputTokens: 50, toolCalls: 0,
      creditCost: 0.1, wallTimeMs: 50, success: true,
    })
    expect(store.metricInserts.length).toBe(1)
    // No experiment exists, so no SQL update should fire.
    await new Promise((r) => setTimeout(r, 5))
    expect(store.experimentUpdates.length).toBe(0)
  })

  test('skips experiment auto-attach when the recorded model matches neither variant', async () => {
    await cost.createExperiment('ws-mismatch', {
      name: 'mm', agentType: 'explore',
      modelA: 'claude-haiku-4-5', modelB: 'claude-sonnet-4-6',
    })
    await cost.recordAgentCostMetric({
      workspaceId: 'ws-mismatch', agentType: 'explore',
      model: 'claude-opus-4-7',  // matches neither A nor B
      inputTokens: 10, outputTokens: 5, toolCalls: 0,
      creditCost: 1, wallTimeMs: 100, success: true,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(store.experimentUpdates.length).toBe(0)
  })

  test('swallows metric insert errors because analytics recording is best effort', async () => {
    throwMetricCreate = true

    await cost.recordAgentCostMetric({
      workspaceId: 'ws-error', agentType: 'reviewer',
      model: 'claude-haiku-4-5',
      inputTokens: 100, outputTokens: 50, toolCalls: 1,
      creditCost: 0.1, wallTimeMs: 10, success: false,
      metadata: { source: 'test' },
    })

    expect(store.metricInserts).toHaveLength(0)
  })
})
