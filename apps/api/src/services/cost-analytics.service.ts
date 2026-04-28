// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Analytics Service — Agent Cost Optimizer & AI Advisor
 *
 * Per-agent cost breakdown, model recommendations gated on multi-signal
 * quality (not just `success: true`), budget alerts with auto-throttle,
 * trends with forecasting, A/B model experiments, and user-controlled
 * sub-agent model overrides so recommendations can actually be applied.
 *
 * Multi-signal "success" gating (Phase 2.3):
 *   A run only counts as a *quality* success when ALL of:
 *     - run promise resolved (legacy `success` column = true)
 *     - hitMaxTurns = false
 *     - loopDetected = false
 *     - escalated   = false
 *     - responseEmpty = false
 *   Recommendations cite the breakdown so the user can see *why* a swap is safe.
 */

import { prisma, Prisma } from '../lib/prisma'
import {
  MODEL_DOLLAR_COSTS,
  calculateDollarCost,
  proxyModelToBillingModel,
  type ModelName,
} from '../lib/usage-cost'

// ============================================================================
// Types
// ============================================================================

export type CostPeriod = '7d' | '30d' | '90d' | '1y'

export const VALID_COST_PERIODS = ['7d', '30d', '90d', '1y'] as const

export function isCostPeriod(value: string): value is CostPeriod {
  return (VALID_COST_PERIODS as readonly string[]).includes(value)
}

interface AgentBreakdownEntry {
  agentType: string
  model: string
  totalRuns: number
  /** Legacy "promise resolved" successes — kept for backwards compat / debug. */
  promiseSuccesses: number
  /** Multi-signal quality successes (see file header). The number used in recommendations. */
  qualitySuccesses: number
  hitMaxTurns: number
  loopDetected: number
  escalated: number
  responseEmpty: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedInputTokens: number
  totalToolCalls: number
  totalCreditCost: number
  totalWallTimeMs: number
  avgCostPerRun: number
  avgLatencyMs: number
  /** Multi-signal quality success rate (0..100). Use this for gating. */
  qualitySuccessRate: number
  /** Escalation rate (0..100). */
  escalationRate: number
  /** Legacy success rate from the `success` column — DO NOT use for gating. */
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
  /** Audit trail explaining the gate so the UI can render "why this is safe". */
  evidence: {
    runs: number
    qualitySuccessRate: number
    escalationRate: number
    loopTrips: number
    maxTurnHits: number
    /** When set, references a recent eval row that backs this recommendation. */
    evalAnchor?: { suite: string; passRate: number; model: string }
  }
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

function periodToDays(period: CostPeriod): number {
  switch (period) {
    case '7d': return 7
    case '30d': return 30
    case '90d': return 90
    case '1y': return 365
  }
}

const MODEL_QUALITY_TIER: Record<string, number> = {
  'gpt-5.4-nano': 1,
  haiku: 2,
  'claude-haiku': 2,
  'claude-haiku-4-5': 2,
  'claude-haiku-4-5-20251001': 2,
  'gpt-5.4-mini': 2,
  sonnet: 3,
  'claude-sonnet': 3,
  'claude-sonnet-4-6': 3,
  opus: 4,
  'claude-opus': 4,
  'claude-opus-4-7': 4,
}

function getModelCostPerMillionOutput(model: string): number {
  const billingModel = proxyModelToBillingModel(model)
  const costs = MODEL_DOLLAR_COSTS[billingModel as ModelName]
  return costs?.outputPerMillion ?? MODEL_DOLLAR_COSTS.sonnet.outputPerMillion
}

function recommendationCandidatesForTier(tier: number): string[] {
  switch (tier) {
    case 1: return ['gpt-5.4-nano']
    case 2: return ['claude-haiku-4-5']
    case 3: return ['claude-sonnet-4-6']
    case 4: return ['claude-opus-4-7']
    default: return []
  }
}

// ============================================================================
// 1. Per-Agent Cost Breakdown
// ----------------------------------------------------------------------------
// Uses Prisma `groupBy` + a small companion query for boolean counts so we no
// longer pull every row into memory (the OOM risk flagged in PR #319 review).
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

  // Aggregate the numeric columns server-side. This kills the OOM risk on
  // `period=1y` for high-volume workspaces.
  const grouped = await prisma.agentCostMetric.groupBy({
    by: ['agentType', 'model'],
    where,
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cachedInputTokens: true,
      toolCalls: true,
      creditCost: true,
      wallTimeMs: true,
    },
    _count: { _all: true },
  })

  // Boolean counts can't go in a groupBy `_sum` (Prisma rejects them), so we
  // do a single raw SQL aggregation alongside. CAST to int8 to count true rows.
  const projectFilter = projectId ? Prisma.sql`AND "projectId" = ${projectId}` : Prisma.empty
  const flags = await prisma.$queryRaw<Array<{
    agentType: string
    model: string
    promiseSuccesses: bigint
    qualitySuccesses: bigint
    hitMaxTurns: bigint
    loopDetected: bigint
    escalated: bigint
    responseEmpty: bigint
  }>>(Prisma.sql`
    SELECT
      "agentType",
      "model",
      COUNT(*) FILTER (WHERE "success" = true)            AS "promiseSuccesses",
      COUNT(*) FILTER (
        WHERE "success" = true
          AND "hitMaxTurns" = false
          AND "loopDetected" = false
          AND "escalated" = false
          AND "responseEmpty" = false
      )                                                   AS "qualitySuccesses",
      COUNT(*) FILTER (WHERE "hitMaxTurns" = true)        AS "hitMaxTurns",
      COUNT(*) FILTER (WHERE "loopDetected" = true)       AS "loopDetected",
      COUNT(*) FILTER (WHERE "escalated" = true)          AS "escalated",
      COUNT(*) FILTER (WHERE "responseEmpty" = true)      AS "responseEmpty"
    FROM "agent_cost_metrics"
    WHERE "workspaceId" = ${workspaceId}
      AND "createdAt"   >= ${since}
      ${projectFilter}
    GROUP BY "agentType", "model"
  `)

  const flagsKey = (a: string, m: string) => `${a}::${m}`
  const flagsMap = new Map(flags.map(f => [flagsKey(f.agentType, f.model), f]))

  const breakdown: AgentBreakdownEntry[] = grouped.map(g => {
    const totalRuns = g._count._all
    const f = flagsMap.get(flagsKey(g.agentType, g.model))
    const promiseSuccesses = Number(f?.promiseSuccesses ?? 0)
    const qualitySuccesses = Number(f?.qualitySuccesses ?? 0)
    const hitMaxTurns = Number(f?.hitMaxTurns ?? 0)
    const loopDetected = Number(f?.loopDetected ?? 0)
    const escalated = Number(f?.escalated ?? 0)
    const responseEmpty = Number(f?.responseEmpty ?? 0)

    const totalInputTokens = g._sum.inputTokens ?? 0
    const totalOutputTokens = g._sum.outputTokens ?? 0
    const totalCachedInputTokens = g._sum.cachedInputTokens ?? 0
    const totalToolCalls = g._sum.toolCalls ?? 0
    const totalCreditCost = g._sum.creditCost ?? 0
    const totalWallTimeMs = g._sum.wallTimeMs ?? 0

    return {
      agentType: g.agentType,
      model: g.model,
      totalRuns,
      promiseSuccesses,
      qualitySuccesses,
      hitMaxTurns,
      loopDetected,
      escalated,
      responseEmpty,
      totalInputTokens,
      totalOutputTokens,
      totalCachedInputTokens,
      totalToolCalls,
      totalCreditCost,
      totalWallTimeMs,
      avgCostPerRun: totalRuns > 0 ? Math.round((totalCreditCost / totalRuns) * 100) / 100 : 0,
      avgLatencyMs: totalRuns > 0 ? Math.round(totalWallTimeMs / totalRuns) : 0,
      qualitySuccessRate: totalRuns > 0 ? Math.round((qualitySuccesses / totalRuns) * 1000) / 10 : 0,
      escalationRate: totalRuns > 0 ? Math.round((escalated / totalRuns) * 1000) / 10 : 0,
      successRate: totalRuns > 0 ? Math.round((promiseSuccesses / totalRuns) * 1000) / 10 : 0,
    }
  }).sort((a, b) => b.totalCreditCost - a.totalCreditCost)

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
// 2. AI-Powered Recommendations (multi-signal gated — Phase 2.3)
// ============================================================================

const RECOMMENDATION_THRESHOLDS = {
  /** Don't recommend anything until we have at least this many runs. */
  minRuns: 20,
  /** Quality success rate must be at least this to consider a downgrade. */
  qualitySuccessRateForDowngrade: 85,
  /** Escalation rate must be below this to downgrade. */
  maxEscalationRateForDowngrade: 10,
  /** Quality success rate below this triggers an upgrade recommendation. */
  qualitySuccessRateForUpgrade: 60,
  /** Estimated savings must beat this percentage to surface as a downgrade. */
  minSavingsPercent: 20,
} as const

export async function getCostRecommendations(
  workspaceId: string,
  period: CostPeriod = '30d',
): Promise<CostRecommendation[]> {
  const { breakdown } = await getAgentCostBreakdown(workspaceId, period)
  const recommendations: CostRecommendation[] = []
  const daysInPeriod = periodToDays(period)

  for (const entry of breakdown) {
    if (entry.totalRuns < RECOMMENDATION_THRESHOLDS.minRuns) continue

    const currentTier = MODEL_QUALITY_TIER[entry.model] ?? 3
    const currentOutputCost = getModelCostPerMillionOutput(entry.model)
    const monthlyCost = (entry.totalCreditCost / daysInPeriod) * 30
    const evidenceBase = {
      runs: entry.totalRuns,
      qualitySuccessRate: entry.qualitySuccessRate,
      escalationRate: entry.escalationRate,
      loopTrips: entry.loopDetected,
      maxTurnHits: entry.hitMaxTurns,
    }

    // Multi-signal downgrade gate. Replaces the old single `successRate` check
    // that fired on `success: true` (which was always true).
    const downgradeGateOk =
      entry.qualitySuccessRate >= RECOMMENDATION_THRESHOLDS.qualitySuccessRateForDowngrade
      && entry.escalationRate < RECOMMENDATION_THRESHOLDS.maxEscalationRateForDowngrade
      && entry.loopDetected === 0

    if (downgradeGateOk && currentTier >= 3) {
      const candidates = recommendationCandidatesForTier(currentTier - 1)

      for (const candidate of candidates) {
        const candidateOutputCost = getModelCostPerMillionOutput(candidate)
        const savingsPercent = Math.round((1 - candidateOutputCost / currentOutputCost) * 100)

        if (savingsPercent <= RECOMMENDATION_THRESHOLDS.minSavingsPercent) continue

        const monthlySavings = Math.round(monthlyCost * (savingsPercent / 100) * 100) / 100
        const evalAnchor = await getEvalAnchor(entry.agentType, candidate, workspaceId)

        const reason = buildDowngradeReason(entry, candidate, evalAnchor)

        recommendations.push({
          agentType: entry.agentType,
          currentModel: entry.model,
          recommendedModel: candidate,
          reason,
          estimatedSavingsPercent: savingsPercent,
          estimatedMonthlySavings: monthlySavings,
          confidence: deriveConfidence(entry, evalAnchor),
          currentMonthlyCost: Math.round(monthlyCost * 100) / 100,
          evidence: { ...evidenceBase, evalAnchor: evalAnchor || undefined },
        })
      }
    }

    // Upgrade signal — too many bad runs.
    if (entry.qualitySuccessRate < RECOMMENDATION_THRESHOLDS.qualitySuccessRateForUpgrade
        && currentTier < 4) {
      const candidates = recommendationCandidatesForTier(currentTier + 1)

      for (const candidate of candidates) {
        recommendations.push({
          agentType: entry.agentType,
          currentModel: entry.model,
          recommendedModel: candidate,
          reason: `${entry.agentType} succeeds on only ${entry.qualitySuccessRate}% of runs (loop trips: ${entry.loopDetected}, max-turn hits: ${entry.hitMaxTurns}, escalations: ${entry.escalated}). Upgrading to ${candidate} should reduce wasted spend on retries.`,
          estimatedSavingsPercent: -30,
          estimatedMonthlySavings: -Math.round(monthlyCost * 0.3 * 100) / 100,
          confidence: entry.totalRuns >= 30 ? 'medium' : 'low',
          currentMonthlyCost: Math.round(monthlyCost * 100) / 100,
          evidence: evidenceBase,
        })
      }
    }

    // Cache-utilization hint (unchanged from the original recommender).
    const cacheRatio = entry.totalCachedInputTokens / Math.max(entry.totalInputTokens + entry.totalCachedInputTokens, 1)
    if (cacheRatio < 0.1 && entry.totalInputTokens > 100_000 && currentTier >= 3) {
      recommendations.push({
        agentType: entry.agentType,
        currentModel: entry.model,
        recommendedModel: entry.model,
        reason: `${entry.agentType} has very low prompt cache utilization (${Math.round(cacheRatio * 100)}%). Enabling prompt caching could reduce input token costs by up to 90%.`,
        estimatedSavingsPercent: 20,
        estimatedMonthlySavings: 0,
        confidence: 'medium',
        currentMonthlyCost: 0,
        evidence: evidenceBase,
      })
    }
  }

  return recommendations.sort((a, b) => b.estimatedSavingsPercent - a.estimatedSavingsPercent)
}

function deriveConfidence(
  entry: AgentBreakdownEntry,
  evalAnchor: { passRate: number } | null,
): 'high' | 'medium' | 'low' {
  if (evalAnchor && evalAnchor.passRate >= 0.85 && entry.totalRuns >= 50) return 'high'
  if (entry.totalRuns >= 20) return 'medium'
  return 'low'
}

function buildDowngradeReason(
  entry: AgentBreakdownEntry,
  candidate: string,
  evalAnchor: { suite: string; passRate: number; model: string } | null,
): string {
  const parts = [
    `${entry.totalRuns} runs`,
    `${entry.qualitySuccessRate}% quality success`,
  ]
  if (entry.escalated > 0) parts.push(`${entry.escalated} escalations`)
  else parts.push('0 escalations')
  if (entry.loopDetected > 0) parts.push(`${entry.loopDetected} loop trips`)
  if (entry.hitMaxTurns > 0) parts.push(`${entry.hitMaxTurns} max-turn hits`)

  let reason = `${entry.agentType} on ${entry.model}: ${parts.join(' · ')}. Switching to ${candidate} should preserve quality at lower cost.`
  if (evalAnchor) {
    reason += ` Eval-anchored: ${candidate} passes ${Math.round(evalAnchor.passRate * 100)}% of ${evalAnchor.suite}.`
  }
  return reason
}

/** Fetch the most recent eval result for a (agentType, model) pair. */
async function getEvalAnchor(
  agentType: string,
  model: string,
  workspaceId?: string,
): Promise<{ suite: string; passRate: number; model: string } | null> {
  try {
    const evalRow = await prisma.agentEvalResult.findFirst({
      where: {
        agentType,
        model,
        OR: [{ workspaceId: null }, ...(workspaceId ? [{ workspaceId }] : [])],
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!evalRow) return null
    return { suite: evalRow.suite, passRate: evalRow.passRate, model }
  } catch {
    return null
  }
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

export const VALID_BUDGET_PERIODS = ['daily', 'weekly', 'monthly'] as const
export type BudgetPeriodType = typeof VALID_BUDGET_PERIODS[number]
export function isBudgetPeriod(value: string): value is BudgetPeriodType {
  return (VALID_BUDGET_PERIODS as readonly string[]).includes(value)
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
  // Phase 4.2 — explicit allowlist on the periodType. Previously an invalid
  // string (e.g. 'yearly') silently fell through to `getPeriodStart` which
  // defaulted to monthly — quietly wrong, hard to debug.
  const periodType = data.periodType ?? 'monthly'
  if (!isBudgetPeriod(periodType)) {
    throw new Error(`Invalid periodType '${periodType}'. Allowed: ${VALID_BUDGET_PERIODS.join(', ')}.`)
  }
  return prisma.budgetAlert.create({
    data: {
      workspaceId,
      name: data.name,
      creditLimit: data.creditLimit,
      periodType,
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
  if (data.periodType !== undefined && !isBudgetPeriod(data.periodType)) {
    throw new Error(`Invalid periodType '${data.periodType}'. Allowed: ${VALID_BUDGET_PERIODS.join(', ')}.`)
  }
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
 * `lastTriggeredAt < periodStart` re-arms alerts for each new billing period
 * (Phase 4.2 fix for the stuck-trigger bug from PR review).
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

      // Re-arm per period: trigger when crossed and we haven't already
      // triggered *within the current period*.
      const shouldTrigger =
        percentUsed >= 100
        && (!alert.lastTriggeredAt || alert.lastTriggeredAt < periodStart)
      if (shouldTrigger) {
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
 * Pure compute helper that derives the throttle model from an already-computed
 * `breached` list. Used by the routes layer to avoid double-running
 * checkBudgetAlerts (Phase 4.2 fix for the duplicate-aggregation bug).
 */
export function deriveActiveThrottleModel(
  breached: Awaited<ReturnType<typeof checkBudgetAlerts>>,
): string | null {
  for (const b of breached) {
    if (b.percentUsed >= 100 && b.alert.autoThrottle && b.alert.throttleToModel) {
      return b.alert.throttleToModel
    }
  }
  return null
}

/**
 * @deprecated Use `deriveActiveThrottleModel(breached)` to avoid double-checking.
 * Kept for backwards compatibility with any external callers.
 */
export async function getActiveThrottleModel(workspaceId: string): Promise<string | null> {
  const breached = await checkBudgetAlerts(workspaceId)
  return deriveActiveThrottleModel(breached)
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
// ----------------------------------------------------------------------------
// Date bucketing pushed to Postgres via DATE_TRUNC so we don't pull every row
// (Phase 4.1 fix for the OOM risk on `period=1y`).
// ============================================================================

interface DailyAgg {
  day: Date
  totalCost: number
  totalRuns: bigint
  model: string
}

export async function getCostTrends(
  workspaceId: string,
  period: CostPeriod = '30d',
  projectId?: string,
): Promise<{ trends: CostTrendPoint[]; forecast: CostForecast }> {
  const since = periodToDate(period)
  const projectFilter = projectId ? Prisma.sql`AND "projectId" = ${projectId}` : Prisma.empty

  // Per-(day,model) aggregation — much smaller result set than `findMany`.
  const rows = await prisma.$queryRaw<DailyAgg[]>(Prisma.sql`
    SELECT
      DATE_TRUNC('day', "createdAt") AS "day",
      SUM("creditCost")              AS "totalCost",
      COUNT(*)                        AS "totalRuns",
      "model"
    FROM "agent_cost_metrics"
    WHERE "workspaceId" = ${workspaceId}
      AND "createdAt"   >= ${since}
      ${projectFilter}
    GROUP BY 1, "model"
    ORDER BY 1 ASC
  `)

  const dayMap = new Map<string, { totalCost: number; totalRuns: number; byModel: Record<string, number> }>()
  for (const r of rows) {
    const date = r.day.toISOString().split('T')[0]
    const existing = dayMap.get(date)
    const cost = Number(r.totalCost)
    const runs = Number(r.totalRuns)
    if (existing) {
      existing.totalCost += cost
      existing.totalRuns += runs
      existing.byModel[r.model] = (existing.byModel[r.model] ?? 0) + cost
    } else {
      dayMap.set(date, { totalCost: cost, totalRuns: runs, byModel: { [r.model]: cost } })
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

  return { trends, forecast: computeForecast(trends) }
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

  return {
    nextMonth: Math.round(avgSecond * 30 * 100) / 100,
    trend,
    percentChange,
  }
}

// ============================================================================
// 5. A/B Model Experiments
// ----------------------------------------------------------------------------
// Atomic UPDATE … SET col = col + n for the per-variant counters so concurrent
// runs no longer race (Phase 4.1 fix for the read-then-write bug from review).
// Running averages use the incremental formula:
//   new_avg = old_avg + (sample - old_avg) / new_count
// expressed in pure SQL so the read-modify-write happens in one statement.
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
    /** Optional duration. When set, `expectedEndAt = now + durationDays`
     *  and the experiment is created in `shadow` status — used by the
     *  Phase 3.2 two-week explore A/B. */
    durationDays?: number
    status?: 'running' | 'shadow'
  },
) {
  const expectedEndAt = data.durationDays
    ? new Date(Date.now() + data.durationDays * 24 * 60 * 60 * 1000)
    : null
  return prisma.modelExperiment.create({
    data: {
      workspaceId,
      projectId: data.projectId ?? null,
      name: data.name,
      agentType: data.agentType,
      modelA: data.modelA,
      modelB: data.modelB,
      splitPercentage: data.splitPercentage ?? 50,
      status: data.status ?? 'running',
      expectedEndAt,
    },
  })
}

/**
 * Convenience wrapper that creates a 14-day shadow A/B for a sub-agent. The
 * boss asked specifically for this for `explore` (haiku-4-5 vs sonnet-4-6),
 * but the helper takes any agent / model pair so we can reuse it.
 */
export async function createShadowExperiment(
  workspaceId: string,
  data: {
    name?: string
    agentType: string
    modelA: string
    modelB: string
    projectId?: string
    splitPercentage?: number
    durationDays?: number
  },
) {
  return createExperiment(workspaceId, {
    name: data.name ?? `Shadow A/B: ${data.agentType} (${data.modelA} vs ${data.modelB})`,
    agentType: data.agentType,
    modelA: data.modelA,
    modelB: data.modelB,
    projectId: data.projectId,
    splitPercentage: data.splitPercentage ?? 50,
    durationDays: data.durationDays ?? 14,
    status: 'shadow',
  })
}

export async function getExperiments(workspaceId: string) {
  try {
    return await prisma.modelExperiment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    })
  } catch (error) {
    if (isAnalyticsTableUnavailable(error)) return []
    throw error
  }
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

/** Find the active experiment (status = 'running' or 'shadow') for an agent
 *  in the given workspace. Used by both runtime model resolution and the
 *  metric-recording auto-attach. */
export async function getActiveExperimentForAgent(
  workspaceId: string,
  agentType: string,
) {
  return prisma.modelExperiment.findFirst({
    where: {
      workspaceId,
      agentType,
      status: { in: ['running', 'shadow'] },
    },
  })
}

export async function pickExperimentModel(
  workspaceId: string,
  agentType: string,
  /** Optional stable bucket key (e.g. agentRunId). When provided, assignment
   *  is deterministic for the same key, which keeps a single chat turn on
   *  one variant if the runtime calls pickExperimentModel multiple times. */
  bucketKey?: string,
): Promise<{ experimentId: string; model: string; variant: 'A' | 'B' } | null> {
  const experiment = await getActiveExperimentForAgent(workspaceId, agentType)
  if (!experiment) return null

  let useA: boolean
  if (bucketKey) {
    // FNV-1a 32-bit hash → percentage in [0, 100). Stable per agentRunId.
    let h = 0x811c9dc5
    for (let i = 0; i < bucketKey.length; i++) {
      h ^= bucketKey.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    const pct = Math.abs(h) % 100
    useA = pct < experiment.splitPercentage
  } else {
    const totalRuns = experiment.totalRunsA + experiment.totalRunsB
    useA = totalRuns === 0
      ? Math.random() * 100 < experiment.splitPercentage
      : (experiment.totalRunsA / totalRuns) * 100 < experiment.splitPercentage
  }

  return {
    experimentId: experiment.id,
    model: useA ? experiment.modelA : experiment.modelB,
    variant: useA ? 'A' : 'B',
  }
}

export interface ExperimentRunResult {
  creditCost: number
  tokens: number
  success: boolean
  latencyMs: number
  // Phase 3.2 — quality signals; default to false / null when missing so the
  // legacy callers don't have to change.
  hitMaxTurns?: boolean
  loopDetected?: boolean
  escalated?: boolean
  responseEmpty?: boolean
}

export async function recordExperimentResult(
  experimentId: string,
  variant: 'A' | 'B',
  result: ExperimentRunResult,
) {
  const successInt = result.success ? 100 : 0
  // Quality-signal increments expressed as ints so the SQL stays simple.
  const incEsc   = result.escalated     ? 1 : 0
  const incLoop  = result.loopDetected  ? 1 : 0
  const incMax   = result.hitMaxTurns   ? 1 : 0
  const incEmpty = result.responseEmpty ? 1 : 0

  if (variant === 'A') {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "model_experiments" SET
        "totalRunsA"     = "totalRunsA"  + 1,
        "totalCostA"     = "totalCostA"  + ${result.creditCost},
        "totalTokensA"   = "totalTokensA" + ${result.tokens},
        "successRateA"   = ROUND(("successRateA"  + ((${successInt}::float - "successRateA")  / ("totalRunsA" + 1)))::numeric, 1)::float,
        "avgLatencyMsA"  = ROUND(("avgLatencyMsA" + ((${result.latencyMs}::float - "avgLatencyMsA") / ("totalRunsA" + 1)))::numeric, 0)::float,
        "escalationsA"   = "escalationsA"   + ${incEsc},
        "loopDetectedA"  = "loopDetectedA"  + ${incLoop},
        "hitMaxTurnsA"   = "hitMaxTurnsA"   + ${incMax},
        "responseEmptyA" = "responseEmptyA" + ${incEmpty},
        "updatedAt"      = NOW()
      WHERE "id" = ${experimentId} AND "status" IN ('running', 'shadow')
    `)
  } else {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "model_experiments" SET
        "totalRunsB"     = "totalRunsB"  + 1,
        "totalCostB"     = "totalCostB"  + ${result.creditCost},
        "totalTokensB"   = "totalTokensB" + ${result.tokens},
        "successRateB"   = ROUND(("successRateB"  + ((${successInt}::float - "successRateB")  / ("totalRunsB" + 1)))::numeric, 1)::float,
        "avgLatencyMsB"  = ROUND(("avgLatencyMsB" + ((${result.latencyMs}::float - "avgLatencyMsB") / ("totalRunsB" + 1)))::numeric, 0)::float,
        "escalationsB"   = "escalationsB"   + ${incEsc},
        "loopDetectedB"  = "loopDetectedB"  + ${incLoop},
        "hitMaxTurnsB"   = "hitMaxTurnsB"   + ${incMax},
        "responseEmptyB" = "responseEmptyB" + ${incEmpty},
        "updatedAt"      = NOW()
      WHERE "id" = ${experimentId} AND "status" IN ('running', 'shadow')
    `)
  }
}

/**
 * Reduces an experiment's accumulated counters into a verdict using the same
 * multi-signal threshold gate as the recommendations path. We surface the
 * full breakdown so the UI can show *why* a winner was called.
 *
 *   winner = 'B' iff
 *     totalRunsA + totalRunsB ≥ MIN_RUNS &&
 *     escalationRateB ≤ escalationRateA + 2 &&
 *     loopRateB ≤ loopRateA &&
 *     hitMaxTurnsRateB ≤ hitMaxTurnsRateA &&
 *     totalCostB < totalCostA
 *
 * `inconclusive` is returned when the run count is too low or the gates trip
 * in opposite directions.
 */
export async function summarizeExperiment(experimentId: string, workspaceId: string) {
  const exp = await prisma.modelExperiment.findFirst({
    where: { id: experimentId, workspaceId },
  })
  if (!exp) return null

  const safe = (num: number, denom: number) => (denom > 0 ? (num / denom) * 100 : 0)
  const a = {
    runs: exp.totalRunsA,
    cost: exp.totalCostA,
    successRate: exp.successRateA,
    escalationRate: safe(exp.escalationsA, exp.totalRunsA),
    loopRate: safe(exp.loopDetectedA, exp.totalRunsA),
    hitMaxRate: safe(exp.hitMaxTurnsA, exp.totalRunsA),
    emptyRate: safe(exp.responseEmptyA, exp.totalRunsA),
    avgCostPerRun: exp.totalRunsA > 0 ? exp.totalCostA / exp.totalRunsA : 0,
    avgLatencyMs: exp.avgLatencyMsA,
  }
  const b = {
    runs: exp.totalRunsB,
    cost: exp.totalCostB,
    successRate: exp.successRateB,
    escalationRate: safe(exp.escalationsB, exp.totalRunsB),
    loopRate: safe(exp.loopDetectedB, exp.totalRunsB),
    hitMaxRate: safe(exp.hitMaxTurnsB, exp.totalRunsB),
    emptyRate: safe(exp.responseEmptyB, exp.totalRunsB),
    avgCostPerRun: exp.totalRunsB > 0 ? exp.totalCostB / exp.totalRunsB : 0,
    avgLatencyMs: exp.avgLatencyMsB,
  }

  const MIN_RUNS = 20
  const totalRuns = a.runs + b.runs
  let verdict: 'inconclusive' | 'A' | 'B' | 'tie' = 'inconclusive'
  const reasons: string[] = []

  if (totalRuns < MIN_RUNS) {
    reasons.push(`Only ${totalRuns} of ${MIN_RUNS} required runs collected.`)
  } else {
    const qualityCloseEnough =
      b.escalationRate <= a.escalationRate + 2 &&
      b.loopRate <= a.loopRate &&
      b.hitMaxRate <= a.hitMaxRate
    const qualityWorse =
      b.escalationRate > a.escalationRate + 2 ||
      b.loopRate > a.loopRate + 2

    if (qualityCloseEnough && b.avgCostPerRun < a.avgCostPerRun) {
      verdict = 'B'
      reasons.push(
        `Variant B (${exp.modelB}) hits the same quality bar at ${(((a.avgCostPerRun - b.avgCostPerRun) / a.avgCostPerRun) * 100).toFixed(1)}% lower cost.`,
      )
    } else if (qualityWorse) {
      verdict = 'A'
      reasons.push(
        `Variant B (${exp.modelB}) regressed on quality signals — keep ${exp.modelA}.`,
      )
    } else if (b.avgCostPerRun >= a.avgCostPerRun && qualityCloseEnough) {
      verdict = 'A'
      reasons.push(`Variant B is no cheaper than A; no reason to switch.`)
    } else {
      verdict = 'tie'
      reasons.push(`Mixed signals — quality close but cost or latency unclear.`)
    }
  }

  return {
    experiment: exp,
    a,
    b,
    verdict,
    reasons,
  }
}

// ============================================================================
// 6. Subagent Model Overrides — user control over built-in sub-agent models
//    (Phase 1 — answers boss concern #2)
// ============================================================================

function isAnalyticsTableUnavailable(error: unknown): boolean {
  const code = (error as any)?.code
  const message = String((error as any)?.message ?? '')
  return (
    code === 'P2021' ||
    code === 'P2022' ||
    message.includes('does not exist') ||
    message.includes('no such table')
  )
}

function subagentOverrideDelegate() {
  return (prisma as any).subagentModelOverride as typeof prisma.subagentModelOverride | undefined
}

export interface ResolvedSubagentModel {
  model: string
  provider: string | null
  /** Where the resolved value came from, for debugging / UI. */
  source: 'project' | 'workspace' | 'builtin'
}

/**
 * Resolve the effective model for a built-in sub-agent given workspace +
 * optional project. Resolution order:
 *
 *   1. project-level override   (workspaceId, projectId, agentType)
 *   2. workspace-level override (workspaceId, projectId=NULL, agentType)
 *   3. null  → caller falls back to the built-in default
 */
export async function resolveSubagentModelOverride(
  workspaceId: string,
  agentType: string,
  projectId?: string | null,
): Promise<ResolvedSubagentModel | null> {
  const overrides = subagentOverrideDelegate()
  if (!overrides) return null

  if (projectId) {
    const projectOverride = await overrides.findFirst({
      where: { workspaceId, projectId, agentType },
    })
    if (projectOverride) {
      return { model: projectOverride.model, provider: projectOverride.provider, source: 'project' }
    }
  }
  const wsOverride = await overrides.findFirst({
    where: { workspaceId, projectId: null, agentType },
  })
  if (wsOverride) {
    return { model: wsOverride.model, provider: wsOverride.provider, source: 'workspace' }
  }
  return null
}

export async function listSubagentOverrides(workspaceId: string) {
  const overrides = subagentOverrideDelegate()
  if (!overrides) return []

  try {
    return await overrides.findMany({
      where: { workspaceId },
      orderBy: [{ projectId: 'asc' }, { agentType: 'asc' }],
    })
  } catch (error) {
    if (isAnalyticsTableUnavailable(error)) return []
    throw error
  }
}

export async function upsertSubagentOverride(
  workspaceId: string,
  data: {
    agentType: string
    model: string
    provider?: string | null
    projectId?: string | null
    updatedBy?: string | null
  },
) {
  const overrides = subagentOverrideDelegate()
  if (!overrides) throw new Error('Sub-agent model overrides are not available in this local database yet')

  // Prisma's compound-unique upsert refuses `projectId: null` in TS types, so we
  // do a manual find-or-create-or-update gated by the underlying NULLS NOT
  // DISTINCT unique index (defined in the migration).
  const projectId = data.projectId ?? null
  const existing = await overrides.findFirst({
    where: { workspaceId, projectId, agentType: data.agentType },
  })
  if (existing) {
    return overrides.update({
      where: { id: existing.id },
      data: {
        model: data.model,
        provider: data.provider ?? null,
        updatedBy: data.updatedBy ?? null,
      },
    })
  }
  return overrides.create({
    data: {
      workspaceId,
      projectId,
      agentType: data.agentType,
      model: data.model,
      provider: data.provider ?? null,
      updatedBy: data.updatedBy ?? null,
    },
  })
}

export async function deleteSubagentOverride(
  workspaceId: string,
  agentType: string,
  projectId?: string | null,
) {
  const overrides = subagentOverrideDelegate()
  if (!overrides) return null

  const target = await overrides.findFirst({
    where: { workspaceId, projectId: projectId ?? null, agentType },
  })
  if (!target) return null
  return overrides.delete({ where: { id: target.id } })
}

// ============================================================================
// 7. Agent Eval Results (Phase 3.1 — eval-anchored ground truth)
// ============================================================================

export async function recordAgentEvalResult(data: {
  workspaceId?: string | null
  agentType: string
  model: string
  provider?: string | null
  suite: string
  totalCases: number
  passedCases: number
  avgWallTimeMs?: number
  avgCreditCost?: number
  commitSha?: string | null
  metadata?: Record<string, unknown>
}) {
  const passRate = data.totalCases > 0 ? data.passedCases / data.totalCases : 0
  return prisma.agentEvalResult.create({
    data: {
      workspaceId: data.workspaceId ?? null,
      agentType: data.agentType,
      model: data.model,
      provider: data.provider ?? null,
      suite: data.suite,
      totalCases: data.totalCases,
      passedCases: data.passedCases,
      passRate,
      avgWallTimeMs: data.avgWallTimeMs ?? 0,
      avgCreditCost: data.avgCreditCost ?? 0,
      commitSha: data.commitSha ?? null,
      metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : undefined,
    },
  })
}

export async function listAgentEvalResults(opts: {
  agentType?: string
  workspaceId?: string
  limit?: number
}) {
  return prisma.agentEvalResult.findMany({
    where: {
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
      ...(opts.workspaceId
        ? { OR: [{ workspaceId: null }, { workspaceId: opts.workspaceId }] }
        : { workspaceId: null }),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  })
}

// ============================================================================
// 7b. Optimizer in Action Report (Phase 3.3)
// ----------------------------------------------------------------------------
// One-stop dataset for the "show this to the boss" surface in the UI: every
// override the workspace has applied, the before/after monthly cost on each
// of those agents, the latest eval pass-rate per (agent, model), and any
// active shadow A/Bs with their multi-signal verdict.
// ============================================================================

export interface OptimizerInActionReport {
  workspaceId: string
  generatedAt: string
  /** One row per override currently in effect for this workspace. */
  overrides: Array<{
    id: string
    agentType: string
    projectId: string | null
    fromModel: string | null  // best-guess builtin default — null when unknown
    toModel: string
    appliedAt: string
    updatedBy: string | null
    /** 30-day pre-override avg cost-per-run (null if no data). */
    avgCostBefore: number | null
    /** Avg cost-per-run since the override (null if no data yet). */
    avgCostAfter: number | null
    /** Multi-signal quality success rate before override (null if no data). */
    qualitySuccessBefore: number | null
    qualitySuccessAfter: number | null
    /** Number of runs in each window. */
    runsBefore: number
    runsAfter: number
  }>
  /** Latest eval pass-rate per (agentType, model) — global rows + workspace rows. */
  evalScores: Array<{
    agentType: string
    model: string
    suite: string
    passRate: number
    totalCases: number
    capturedAt: string
  }>
  /** Active or recently-completed shadow experiments. */
  experiments: Array<{
    id: string
    name: string
    agentType: string
    modelA: string
    modelB: string
    status: string
    expectedEndAt: string | null
    runsA: number
    runsB: number
    verdict: 'inconclusive' | 'A' | 'B' | 'tie'
    reasons: string[]
  }>
  /** Aggregate $ saved per month, summed across overrides where we have data. */
  monthlySavingsUSD: number
}

export async function getOptimizerInActionReport(
  workspaceId: string,
): Promise<OptimizerInActionReport> {
  const overrideRows = await listSubagentOverrides(workspaceId)

  // Build before/after windows per override using the override's updatedAt
  // as the cut point. We use a 30-day window on either side.
  const overrides: OptimizerInActionReport['overrides'] = []
  let monthlySavingsUSD = 0
  for (const ov of overrideRows) {
    const cutoff = ov.updatedAt
    const windowStart = new Date(cutoff.getTime() - 30 * 24 * 60 * 60 * 1000)
    const windowEnd = new Date(cutoff.getTime() + 30 * 24 * 60 * 60 * 1000)

    const [before, after] = await Promise.all([
      prisma.agentCostMetric.aggregate({
        where: {
          workspaceId,
          agentType: ov.agentType,
          createdAt: { gte: windowStart, lt: cutoff },
          ...(ov.projectId ? { projectId: ov.projectId } : {}),
        },
        _avg: { creditCost: true },
        _count: { _all: true },
      }),
      prisma.agentCostMetric.aggregate({
        where: {
          workspaceId,
          agentType: ov.agentType,
          createdAt: { gte: cutoff, lte: windowEnd },
          ...(ov.projectId ? { projectId: ov.projectId } : {}),
        },
        _avg: { creditCost: true },
        _count: { _all: true },
      }),
    ])

    // Multi-signal quality success rate per window — count metrics that pass
    // every signal divided by total. Single SQL would be cheaper but findMany
    // with a sane window cap is fine for a report.
    const [beforeRows, afterRows] = await Promise.all([
      prisma.agentCostMetric.findMany({
        where: {
          workspaceId,
          agentType: ov.agentType,
          createdAt: { gte: windowStart, lt: cutoff },
          ...(ov.projectId ? { projectId: ov.projectId } : {}),
        },
        select: {
          success: true,
          hitMaxTurns: true,
          loopDetected: true,
          escalated: true,
          responseEmpty: true,
        },
        take: 5_000,
      }),
      prisma.agentCostMetric.findMany({
        where: {
          workspaceId,
          agentType: ov.agentType,
          createdAt: { gte: cutoff, lte: windowEnd },
          ...(ov.projectId ? { projectId: ov.projectId } : {}),
        },
        select: {
          success: true,
          hitMaxTurns: true,
          loopDetected: true,
          escalated: true,
          responseEmpty: true,
        },
        take: 5_000,
      }),
    ])

    const qualityRate = (rows: typeof beforeRows) => {
      if (rows.length === 0) return null
      const ok = rows.filter(r =>
        r.success &&
        !r.hitMaxTurns &&
        !r.loopDetected &&
        !r.escalated &&
        !r.responseEmpty,
      ).length
      return Math.round((ok / rows.length) * 1000) / 10  // one decimal
    }

    const avgBefore = before._avg.creditCost ?? null
    const avgAfter = after._avg.creditCost ?? null
    if (avgBefore != null && avgAfter != null) {
      // Approximate monthly run count from the after window.
      const dailyRuns = after._count._all / 30
      const savingsPerRun = Math.max(0, avgBefore - avgAfter)
      monthlySavingsUSD += savingsPerRun * dailyRuns * 30
    }

    overrides.push({
      id: ov.id,
      agentType: ov.agentType,
      projectId: ov.projectId,
      fromModel: null,  // We don't store the previous default; UI fills in from builtin catalog.
      toModel: ov.model,
      appliedAt: ov.updatedAt.toISOString(),
      updatedBy: ov.updatedBy,
      avgCostBefore: avgBefore,
      avgCostAfter: avgAfter,
      qualitySuccessBefore: qualityRate(beforeRows),
      qualitySuccessAfter: qualityRate(afterRows),
      runsBefore: before._count._all,
      runsAfter: after._count._all,
    })
  }

  // Eval scores — pull the most recent row per (agentType, model). Workspace
  // rows shadow global rows of the same key.
  const evalRows = await prisma.agentEvalResult.findMany({
    where: { OR: [{ workspaceId: null }, { workspaceId }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
  }).catch((error) => {
    if (isAnalyticsTableUnavailable(error)) return []
    throw error
  })
  const seenEval = new Set<string>()
  const evalScores: OptimizerInActionReport['evalScores'] = []
  for (const r of evalRows) {
    const key = `${r.agentType}::${r.model}`
    if (seenEval.has(key)) continue
    seenEval.add(key)
    evalScores.push({
      agentType: r.agentType,
      model: r.model,
      suite: r.suite,
      passRate: r.passRate,
      totalCases: r.totalCases,
      capturedAt: r.createdAt.toISOString(),
    })
  }

  // Experiments — surface verdicts so the UI can render the headline.
  const experimentRows = await prisma.modelExperiment.findMany({
    where: {
      workspaceId,
      OR: [
        { status: 'running' },
        { status: 'shadow' },
        { status: 'completed', updatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  }).catch((error) => {
    if (isAnalyticsTableUnavailable(error)) return []
    throw error
  })
  const experiments: OptimizerInActionReport['experiments'] = []
  for (const exp of experimentRows) {
    const summary = await summarizeExperiment(exp.id, workspaceId)
    experiments.push({
      id: exp.id,
      name: exp.name,
      agentType: exp.agentType,
      modelA: exp.modelA,
      modelB: exp.modelB,
      status: exp.status,
      expectedEndAt: exp.expectedEndAt ? exp.expectedEndAt.toISOString() : null,
      runsA: exp.totalRunsA,
      runsB: exp.totalRunsB,
      verdict: summary?.verdict ?? 'inconclusive',
      reasons: summary?.reasons ?? [],
    })
  }

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    overrides,
    evalScores,
    experiments,
    monthlySavingsUSD: Math.round(monthlySavingsUSD * 100) / 100,
  }
}

// ============================================================================
// 8. Record Agent Cost Metric (called from agent-manager / proxy)
// ----------------------------------------------------------------------------
// Now accepts the multi-signal quality columns (Phase 2.1). Server-side
// recomputes creditCost when the caller passes 0, so subagent runs get real
// numbers (Phase-2.1 fix for the "always-zero credit cost" red bug from PR
// review).
// ============================================================================

export async function recordAgentCostMetric(data: {
  workspaceId: string
  projectId?: string
  agentRunId?: string
  agentType: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  toolCalls: number
  creditCost: number
  wallTimeMs: number
  success: boolean
  hitMaxTurns?: boolean
  loopDetected?: boolean
  escalated?: boolean
  responseEmpty?: boolean
  metadata?: Record<string, unknown>
}) {
  try {
    let creditCost = data.creditCost
    if (creditCost === 0 && (data.inputTokens > 0 || data.outputTokens > 0)) {
      creditCost = serverComputeCreditCost(
        data.model,
        data.inputTokens,
        data.outputTokens,
        data.cachedInputTokens ?? 0,
      )
    }
    await prisma.agentCostMetric.create({
      data: {
        workspaceId: data.workspaceId,
        projectId: data.projectId ?? null,
        agentRunId: data.agentRunId ?? null,
        agentType: data.agentType,
        model: data.model,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cachedInputTokens: data.cachedInputTokens ?? 0,
        toolCalls: data.toolCalls,
        creditCost,
        wallTimeMs: data.wallTimeMs,
        success: data.success,
        hitMaxTurns: data.hitMaxTurns ?? false,
        loopDetected: data.loopDetected ?? false,
        escalated: data.escalated ?? false,
        responseEmpty: data.responseEmpty ?? false,
        metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : undefined,
      },
    })

    // Phase 3.2 — auto-attach to any active shadow A/B for this agent. We
    // map the model that ran to a variant by string match. If the model
    // doesn't match either variant the metric is dropped (someone pinned a
    // model explicitly, so the run isn't part of the experiment).
    await maybeRecordExperimentRun(data, creditCost).catch((err) => {
      console.warn('[CostAnalytics] Failed to record experiment run:', err)
    })
  } catch (err) {
    console.warn('[CostAnalytics] Failed to record agent cost metric:', err)
  }
}

async function maybeRecordExperimentRun(
  data: Parameters<typeof recordAgentCostMetric>[0],
  creditCost: number,
): Promise<void> {
  const exp = await getActiveExperimentForAgent(data.workspaceId, data.agentType)
  if (!exp) return
  const variant: 'A' | 'B' | null =
    data.model === exp.modelA ? 'A'
      : data.model === exp.modelB ? 'B'
        : null
  if (!variant) return

  await recordExperimentResult(exp.id, variant, {
    creditCost,
    tokens: data.inputTokens + data.outputTokens,
    success: data.success,
    latencyMs: data.wallTimeMs,
    hitMaxTurns: data.hitMaxTurns ?? false,
    loopDetected: data.loopDetected ?? false,
    escalated: data.escalated ?? false,
    responseEmpty: data.responseEmpty ?? false,
  })
}

/** Token-cost recomputation in dollar units. Mirrors the catalog used by the
 * proxy billing path so analytics and billing agree on numbers. */
function serverComputeCreditCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  return Math.max(0, calculateDollarCost(model, inputTokens, outputTokens, cachedInputTokens, 0))
}
