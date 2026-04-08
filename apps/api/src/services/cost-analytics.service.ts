// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Analytics Service — Agent Cost Optimizer & AI Advisor
 *
 * Per-agent cost breakdown, AI-powered model recommendations,
 * budget alerts with auto-throttle, historical trends with
 * forecasting, and A/B model experiment tracking.
 */

import { prisma, Prisma } from '../lib/prisma'
import {
  MODEL_DOLLAR_COSTS,
  calculateCreditCost,
  type ModelName,
} from '../lib/credit-cost'

// ============================================================================
// Types
// ============================================================================

export type CostPeriod = '7d' | '30d' | '90d' | '1y'

interface AgentBreakdownEntry {
  agentType: string
  model: string
  totalRuns: number
  successes: number
  failures: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedInputTokens: number
  totalToolCalls: number
  totalCreditCost: number
  totalWallTimeMs: number
  avgCostPerRun: number
  avgLatencyMs: number
  successRate: number
}

interface CostRecommendation {
  agentType: string
  currentModel: string
  recommendedModel: string
  reason: string
  estimatedSavingsPercent: number
  estimatedMonthlySavings: number
  confidence: 'high' | 'medium' | 'low'
  currentMonthlyCost: number
}

interface CostTrendPoint {
  date: string
  totalCost: number
  totalRuns: number
  avgCostPerRun: number
  byModel: Record<string, number>
}

interface CostForecast {
  nextMonth: number
  trend: 'increasing' | 'decreasing' | 'stable'
  percentChange: number
}

// ============================================================================
// Helpers
// ============================================================================

function periodToDate(period: CostPeriod): Date {
  const now = new Date()
  switch (period) {
    case '7d':  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    case '1y':  return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
  }
}

const MODEL_QUALITY_TIER: Record<string, number> = {
  'gpt-5.4-nano': 1,
  haiku: 2,
  'gpt-5.4-mini': 2,
  sonnet: 3,
  opus: 4,
}

function getModelCostPerMillionOutput(model: string): number {
  const costs = MODEL_DOLLAR_COSTS[model as ModelName]
  return costs?.outputPerMillion ?? MODEL_DOLLAR_COSTS.sonnet.outputPerMillion
}

// ============================================================================
// 1. Per-Agent Cost Breakdown
// ============================================================================

export async function getAgentCostBreakdown(
  workspaceId: string,
  period: CostPeriod = '30d',
  projectId?: string,
) {
  const since = periodToDate(period)
  const where: Prisma.AgentCostMetricWhereInput = {
    workspaceId,
    createdAt: { gte: since },
    ...(projectId ? { projectId } : {}),
  }

  const metrics = await prisma.agentCostMetric.findMany({ where })

  const aggregateMap = new Map<string, AgentBreakdownEntry>()

  for (const m of metrics) {
    const key = `${m.agentType}::${m.model}`
    const existing = aggregateMap.get(key)

    if (existing) {
      existing.totalRuns += 1
      existing.successes += m.success ? 1 : 0
      existing.failures += m.success ? 0 : 1
      existing.totalInputTokens += m.inputTokens
      existing.totalOutputTokens += m.outputTokens
      existing.totalCachedInputTokens += m.cachedInputTokens
      existing.totalToolCalls += m.toolCalls
      existing.totalCreditCost += m.creditCost
      existing.totalWallTimeMs += m.wallTimeMs
    } else {
      aggregateMap.set(key, {
        agentType: m.agentType,
        model: m.model,
        totalRuns: 1,
        successes: m.success ? 1 : 0,
        failures: m.success ? 0 : 1,
        totalInputTokens: m.inputTokens,
        totalOutputTokens: m.outputTokens,
        totalCachedInputTokens: m.cachedInputTokens,
        totalToolCalls: m.toolCalls,
        totalCreditCost: m.creditCost,
        totalWallTimeMs: m.wallTimeMs,
        avgCostPerRun: 0,
        avgLatencyMs: 0,
        successRate: 0,
      })
    }
  }

  const breakdown: AgentBreakdownEntry[] = [...aggregateMap.values()].map(entry => ({
    ...entry,
    avgCostPerRun: entry.totalRuns > 0 ? Math.round((entry.totalCreditCost / entry.totalRuns) * 100) / 100 : 0,
    avgLatencyMs: entry.totalRuns > 0 ? Math.round(entry.totalWallTimeMs / entry.totalRuns) : 0,
    successRate: entry.totalRuns > 0 ? Math.round((entry.successes / entry.totalRuns) * 1000) / 10 : 0,
  })).sort((a, b) => b.totalCreditCost - a.totalCreditCost)

  const totals = {
    totalCreditCost: breakdown.reduce((s, e) => s + e.totalCreditCost, 0),
    totalRuns: breakdown.reduce((s, e) => s + e.totalRuns, 0),
    totalInputTokens: breakdown.reduce((s, e) => s + e.totalInputTokens, 0),
    totalOutputTokens: breakdown.reduce((s, e) => s + e.totalOutputTokens, 0),
    totalToolCalls: breakdown.reduce((s, e) => s + e.totalToolCalls, 0),
    uniqueAgents: new Set(breakdown.map(b => b.agentType)).size,
    uniqueModels: new Set(breakdown.map(b => b.model)).size,
  }

  return { breakdown, totals }
}

// ============================================================================
// 2. AI-Powered Recommendations
// ============================================================================

export async function getCostRecommendations(
  workspaceId: string,
  period: CostPeriod = '30d',
): Promise<CostRecommendation[]> {
  const { breakdown } = await getAgentCostBreakdown(workspaceId, period)
  const recommendations: CostRecommendation[] = []

  for (const entry of breakdown) {
    if (entry.totalRuns < 5) continue

    const currentTier = MODEL_QUALITY_TIER[entry.model] ?? 3
    const currentOutputCost = getModelCostPerMillionOutput(entry.model)

    // High success rate with premium model → suggest downgrade
    if (entry.successRate >= 90 && currentTier >= 3) {
      const candidates = Object.entries(MODEL_QUALITY_TIER)
        .filter(([, tier]) => tier === currentTier - 1)
        .map(([model]) => model)

      for (const candidate of candidates) {
        const candidateOutputCost = getModelCostPerMillionOutput(candidate)
        const savingsPercent = Math.round((1 - candidateOutputCost / currentOutputCost) * 100)

        if (savingsPercent > 20) {
          const daysInPeriod = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365
          const monthlyCost = (entry.totalCreditCost / daysInPeriod) * 30
          const monthlySavings = Math.round(monthlyCost * (savingsPercent / 100) * 100) / 100

          recommendations.push({
            agentType: entry.agentType,
            currentModel: entry.model,
            recommendedModel: candidate,
            reason: `${entry.agentType} has a ${entry.successRate}% success rate on ${entry.model}. Switching to ${candidate} could maintain quality at a fraction of the cost.`,
            estimatedSavingsPercent: savingsPercent,
            estimatedMonthlySavings: monthlySavings,
            confidence: entry.totalRuns >= 50 ? 'high' : entry.totalRuns >= 20 ? 'medium' : 'low',
            currentMonthlyCost: Math.round(monthlyCost * 100) / 100,
          })
        }
      }
    }

    // Low success rate → suggest upgrade
    if (entry.successRate < 60 && currentTier < 4) {
      const candidates = Object.entries(MODEL_QUALITY_TIER)
        .filter(([, tier]) => tier === currentTier + 1)
        .map(([model]) => model)

      for (const candidate of candidates) {
        const daysInPeriod = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365
        const monthlyCost = (entry.totalCreditCost / daysInPeriod) * 30

        recommendations.push({
          agentType: entry.agentType,
          currentModel: entry.model,
          recommendedModel: candidate,
          reason: `${entry.agentType} only succeeds ${entry.successRate}% of the time on ${entry.model}. Upgrading to ${candidate} may improve reliability and reduce wasted token spend on retries.`,
          estimatedSavingsPercent: -30, // cost increase but quality gain
          estimatedMonthlySavings: -Math.round(monthlyCost * 0.3 * 100) / 100,
          confidence: entry.totalRuns >= 30 ? 'medium' : 'low',
          currentMonthlyCost: Math.round(monthlyCost * 100) / 100,
        })
      }
    }

    // High cache-read ratio → already efficient, note it
    const cacheRatio = entry.totalCachedInputTokens / Math.max(entry.totalInputTokens + entry.totalCachedInputTokens, 1)
    if (cacheRatio < 0.1 && entry.totalInputTokens > 100_000 && currentTier >= 3) {
      recommendations.push({
        agentType: entry.agentType,
        currentModel: entry.model,
        recommendedModel: entry.model,
        reason: `${entry.agentType} has very low prompt cache utilization (${Math.round(cacheRatio * 100)}%). Enabling prompt caching could reduce input token costs by up to 90%.`,
        estimatedSavingsPercent: 20,
        estimatedMonthlySavings: 0, // hard to estimate
        confidence: 'medium',
        currentMonthlyCost: 0,
      })
    }
  }

  return recommendations.sort((a, b) => b.estimatedSavingsPercent - a.estimatedSavingsPercent)
}

// ============================================================================
// 3. Budget Alerts & Auto-Throttle
// ============================================================================

export async function getBudgetAlerts(workspaceId: string) {
  return prisma.budgetAlert.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createBudgetAlert(
  workspaceId: string,
  data: {
    name: string
    creditLimit: number
    periodType?: string
    autoThrottle?: boolean
    throttleToModel?: string
    notifyEmail?: boolean
  },
) {
  return prisma.budgetAlert.create({
    data: {
      workspaceId,
      name: data.name,
      creditLimit: data.creditLimit,
      periodType: data.periodType ?? 'monthly',
      autoThrottle: data.autoThrottle ?? false,
      throttleToModel: data.throttleToModel ?? null,
      notifyEmail: data.notifyEmail ?? true,
    },
  })
}

export async function updateBudgetAlert(
  id: string,
  workspaceId: string,
  data: Partial<{
    name: string
    creditLimit: number
    periodType: string
    enabled: boolean
    autoThrottle: boolean
    throttleToModel: string | null
    notifyEmail: boolean
  }>,
) {
  return prisma.budgetAlert.update({
    where: { id, workspaceId },
    data,
  })
}

export async function deleteBudgetAlert(id: string, workspaceId: string) {
  return prisma.budgetAlert.delete({ where: { id, workspaceId } })
}

/**
 * Check all budget alerts for a workspace and return any that are breached.
 * Called after cost metric recording to evaluate auto-throttle.
 */
export async function checkBudgetAlerts(workspaceId: string): Promise<Array<{
  alert: { id: string; name: string; creditLimit: number; autoThrottle: boolean; throttleToModel: string | null }
  currentSpend: number
  percentUsed: number
}>> {
  const alerts = await prisma.budgetAlert.findMany({
    where: { workspaceId, enabled: true },
  })

  if (alerts.length === 0) return []

  const breached: Array<{
    alert: { id: string; name: string; creditLimit: number; autoThrottle: boolean; throttleToModel: string | null }
    currentSpend: number
    percentUsed: number
  }> = []

  for (const alert of alerts) {
    const periodStart = getPeriodStart(alert.periodType)

    const result = await prisma.agentCostMetric.aggregate({
      where: { workspaceId, createdAt: { gte: periodStart } },
      _sum: { creditCost: true },
    })

    const currentSpend = result._sum.creditCost ?? 0
    const percentUsed = Math.round((currentSpend / alert.creditLimit) * 1000) / 10

    if (percentUsed >= 80) {
      breached.push({
        alert: {
          id: alert.id,
          name: alert.name,
          creditLimit: alert.creditLimit,
          autoThrottle: alert.autoThrottle,
          throttleToModel: alert.throttleToModel,
        },
        currentSpend: Math.round(currentSpend * 100) / 100,
        percentUsed,
      })

      if (percentUsed >= 100 && !alert.lastTriggeredAt) {
        await prisma.budgetAlert.update({
          where: { id: alert.id },
          data: { lastTriggeredAt: new Date() },
        })
      }
    }
  }

  return breached
}

/**
 * Determine the active throttle model if any budget alert's auto-throttle is active.
 * Returns null if no throttling needed, or the model name to throttle to.
 */
export async function getActiveThrottleModel(workspaceId: string): Promise<string | null> {
  const breached = await checkBudgetAlerts(workspaceId)
  for (const b of breached) {
    if (b.percentUsed >= 100 && b.alert.autoThrottle && b.alert.throttleToModel) {
      return b.alert.throttleToModel
    }
  }
  return null
}

function getPeriodStart(periodType: string): Date {
  const now = new Date()
  switch (periodType) {
    case 'daily':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate())
    case 'weekly': {
      const d = new Date(now)
      d.setDate(d.getDate() - d.getDay())
      d.setHours(0, 0, 0, 0)
      return d
    }
    case 'monthly':
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1)
  }
}

// ============================================================================
// 4. Historical Cost Trends & Forecasting
// ============================================================================

export async function getCostTrends(
  workspaceId: string,
  period: CostPeriod = '30d',
  projectId?: string,
): Promise<{ trends: CostTrendPoint[]; forecast: CostForecast }> {
  const since = periodToDate(period)
  const where: Prisma.AgentCostMetricWhereInput = {
    workspaceId,
    createdAt: { gte: since },
    ...(projectId ? { projectId } : {}),
  }

  const metrics = await prisma.agentCostMetric.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  })

  const dayMap = new Map<string, { totalCost: number; totalRuns: number; byModel: Record<string, number> }>()

  for (const m of metrics) {
    const date = m.createdAt.toISOString().split('T')[0]
    const existing = dayMap.get(date)

    if (existing) {
      existing.totalCost += m.creditCost
      existing.totalRuns += 1
      existing.byModel[m.model] = (existing.byModel[m.model] ?? 0) + m.creditCost
    } else {
      dayMap.set(date, {
        totalCost: m.creditCost,
        totalRuns: 1,
        byModel: { [m.model]: m.creditCost },
      })
    }
  }

  const trends: CostTrendPoint[] = [...dayMap.entries()]
    .map(([date, data]) => ({
      date,
      totalCost: Math.round(data.totalCost * 100) / 100,
      totalRuns: data.totalRuns,
      avgCostPerRun: data.totalRuns > 0
        ? Math.round((data.totalCost / data.totalRuns) * 100) / 100
        : 0,
      byModel: Object.fromEntries(
        Object.entries(data.byModel).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const forecast = computeForecast(trends)

  return { trends, forecast }
}

function computeForecast(trends: CostTrendPoint[]): CostForecast {
  if (trends.length < 3) {
    const avgDaily = trends.length > 0
      ? trends.reduce((s, t) => s + t.totalCost, 0) / trends.length
      : 0
    return {
      nextMonth: Math.round(avgDaily * 30 * 100) / 100,
      trend: 'stable',
      percentChange: 0,
    }
  }

  const mid = Math.floor(trends.length / 2)
  const firstHalf = trends.slice(0, mid)
  const secondHalf = trends.slice(mid)

  const avgFirst = firstHalf.reduce((s, t) => s + t.totalCost, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, t) => s + t.totalCost, 0) / secondHalf.length

  const percentChange = avgFirst > 0
    ? Math.round(((avgSecond - avgFirst) / avgFirst) * 100)
    : 0

  let trend: 'increasing' | 'decreasing' | 'stable'
  if (percentChange > 10) trend = 'increasing'
  else if (percentChange < -10) trend = 'decreasing'
  else trend = 'stable'

  const recentDaily = avgSecond
  const nextMonth = Math.round(recentDaily * 30 * 100) / 100

  return { nextMonth, trend, percentChange }
}

// ============================================================================
// 5. A/B Model Experiments
// ============================================================================

export async function createExperiment(
  workspaceId: string,
  data: {
    name: string
    agentType: string
    modelA: string
    modelB: string
    projectId?: string
    splitPercentage?: number
  },
) {
  return prisma.modelExperiment.create({
    data: {
      workspaceId,
      projectId: data.projectId ?? null,
      name: data.name,
      agentType: data.agentType,
      modelA: data.modelA,
      modelB: data.modelB,
      splitPercentage: data.splitPercentage ?? 50,
    },
  })
}

export async function getExperiments(workspaceId: string) {
  return prisma.modelExperiment.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getExperiment(id: string, workspaceId: string) {
  return prisma.modelExperiment.findFirst({
    where: { id, workspaceId },
  })
}

export async function stopExperiment(id: string, workspaceId: string) {
  return prisma.modelExperiment.update({
    where: { id, workspaceId },
    data: { status: 'completed' },
  })
}

/**
 * Pick which model variant to use for an experiment run, then record the result.
 * Returns null if no running experiment matches the agent type.
 */
export async function pickExperimentModel(
  workspaceId: string,
  agentType: string,
): Promise<{ experimentId: string; model: string; variant: 'A' | 'B' } | null> {
  const experiment = await prisma.modelExperiment.findFirst({
    where: { workspaceId, agentType, status: 'running' },
  })
  if (!experiment) return null

  const totalRuns = experiment.totalRunsA + experiment.totalRunsB
  const useA = totalRuns === 0
    ? Math.random() * 100 < experiment.splitPercentage
    : (experiment.totalRunsA / totalRuns) * 100 < experiment.splitPercentage

  return {
    experimentId: experiment.id,
    model: useA ? experiment.modelA : experiment.modelB,
    variant: useA ? 'A' : 'B',
  }
}

/**
 * Record the outcome of an experiment run for one variant.
 */
export async function recordExperimentResult(
  experimentId: string,
  variant: 'A' | 'B',
  result: { creditCost: number; tokens: number; success: boolean; latencyMs: number },
) {
  const experiment = await prisma.modelExperiment.findUnique({
    where: { id: experimentId },
  })
  if (!experiment || experiment.status !== 'running') return

  if (variant === 'A') {
    const newRuns = experiment.totalRunsA + 1
    const newCost = experiment.totalCostA + result.creditCost
    const newTokens = experiment.totalTokensA + result.tokens
    const newSuccessRate = ((experiment.successRateA * experiment.totalRunsA) + (result.success ? 100 : 0)) / newRuns
    const newLatency = ((experiment.avgLatencyMsA * experiment.totalRunsA) + result.latencyMs) / newRuns

    await prisma.modelExperiment.update({
      where: { id: experimentId },
      data: {
        totalRunsA: newRuns,
        totalCostA: newCost,
        totalTokensA: newTokens,
        successRateA: Math.round(newSuccessRate * 10) / 10,
        avgLatencyMsA: Math.round(newLatency),
      },
    })
  } else {
    const newRuns = experiment.totalRunsB + 1
    const newCost = experiment.totalCostB + result.creditCost
    const newTokens = experiment.totalTokensB + result.tokens
    const newSuccessRate = ((experiment.successRateB * experiment.totalRunsB) + (result.success ? 100 : 0)) / newRuns
    const newLatency = ((experiment.avgLatencyMsB * experiment.totalRunsB) + result.latencyMs) / newRuns

    await prisma.modelExperiment.update({
      where: { id: experimentId },
      data: {
        totalRunsB: newRuns,
        totalCostB: newCost,
        totalTokensB: newTokens,
        successRateB: Math.round(newSuccessRate * 10) / 10,
        avgLatencyMsB: Math.round(newLatency),
      },
    })
  }
}

// ============================================================================
// 6. Record Agent Cost Metric (called from agent-manager / proxy)
// ============================================================================

export async function recordAgentCostMetric(data: {
  workspaceId: string
  projectId?: string
  agentType: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  toolCalls: number
  creditCost: number
  wallTimeMs: number
  success: boolean
  metadata?: Record<string, unknown>
}) {
  try {
    await prisma.agentCostMetric.create({
      data: {
        workspaceId: data.workspaceId,
        projectId: data.projectId ?? null,
        agentType: data.agentType,
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cachedInputTokens: data.cachedInputTokens ?? 0,
        toolCalls: data.toolCalls,
        creditCost: data.creditCost,
        wallTimeMs: data.wallTimeMs,
        success: data.success,
        metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : undefined,
      },
    })
  } catch (err) {
    console.warn('[CostAnalytics] Failed to record agent cost metric:', err)
  }
}
