// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Analytics Tab — Agent Cost Optimizer Dashboard
 *
 * Per-agent cost breakdown, AI recommendations, budget alerts,
 * cost trends, and A/B model experiments.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
} from 'react-native'
import {
  DollarSign,
  TrendingDown,
  TrendingUp,
  Minus,
  Lightbulb,
  Bell,
  FlaskConical,
  Cpu,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Settings as SettingsIcon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  type AnalyticsPeriod,
  PeriodSelector,
  formatNumber,
  formatDuration,
  formatDollarCost,
  getModelColor,
  getModelTextColor,
  getModelDisplayName,
} from './SharedAnalytics'
import { Card, CardContent, Separator } from '@shogo/shared-ui/primitives'
import { SubAgentModelsSection } from './SubAgentModelsSection'
import { OptimizerInActionSection, type OptimizerInActionData } from './OptimizerInActionSection'
import { RecommendationsSection, type CostRecommendation } from './RecommendationsSection'
import { BudgetSection, type BudgetAlertItem, type BudgetStatus } from './BudgetSection'
import { ExperimentsSection, type ExperimentItem } from './ExperimentsSection'

// =============================================================================
// Types
// =============================================================================

interface AgentBreakdownEntry {
  agentType: string
  model: string
  totalRuns: number
  promiseSuccesses?: number
  qualitySuccesses?: number
  hitMaxTurns?: number
  loopDetected?: number
  escalated?: number
  responseEmpty?: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedInputTokens: number
  totalToolCalls: number
  totalCreditCost: number
  totalWallTimeMs: number
  avgCostPerRun: number
  avgLatencyMs: number
  qualitySuccessRate?: number
  escalationRate?: number
  successRate: number
}

interface BreakdownData {
  breakdown: AgentBreakdownEntry[]
  totals: {
    totalCreditCost: number
    totalRuns: number
    totalInputTokens: number
    totalOutputTokens: number
    totalToolCalls: number
    uniqueAgents: number
    uniqueModels: number
  }
}

interface CostTrendPoint {
  date: string
  totalCost: number
  totalRuns: number
  avgCostPerRun: number
  byModel: Record<string, number>
}

interface TrendsData {
  trends: CostTrendPoint[]
  forecast: {
    nextMonth: number
    trend: 'increasing' | 'decreasing' | 'stable'
    percentChange: number
  }
}

interface SubagentOverrideRecord {
  id: string
  workspaceId: string
  projectId: string | null
  agentType: string
  model: string
  provider: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

interface CostAnalyticsTabProps {
  workspaceId: string
  fetchCostAnalytics: <T>(endpoint: string, params?: Record<string, string>) => Promise<T>
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
  /**
   * Phase 1 (boss concern #2): Sub-agent model override CRUD plumbed from the
   * settings page. Optional so consumers that don't yet wire it up degrade
   * gracefully (the Sub-Agents tab and Apply buttons just stay hidden).
   */
  fetchSubagentOverrides?: () => Promise<SubagentOverrideRecord[] | null>
  putSubagentOverride?: (body: {
    agentType: string
    model: string
    provider?: string | null
    projectId?: string | null
  }) => Promise<unknown>
  deleteSubagentOverride?: (agentType: string, projectId?: string | null) => Promise<unknown>
}

// =============================================================================
// Sub-sections
// =============================================================================

type Section = 'breakdown' | 'recommendations' | 'subagents' | 'inaction' | 'budget' | 'trends' | 'experiments'

const SECTION_CONFIG: Array<{ id: Section; label: string; icon: React.ElementType }> = [
  { id: 'breakdown', label: 'Agents', icon: Cpu },
  { id: 'recommendations', label: 'Optimize', icon: Lightbulb },
  { id: 'subagents', label: 'Sub-Agents', icon: SettingsIcon },
  { id: 'inaction', label: 'In Action', icon: TrendingUp },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'budget', label: 'Budgets', icon: Bell },
  { id: 'experiments', label: 'A/B Tests', icon: FlaskConical },
]

// =============================================================================
// Main Component
// =============================================================================

export function CostAnalyticsTab({
  workspaceId,
  fetchCostAnalytics,
  postCostAnalytics,
  fetchSubagentOverrides,
  putSubagentOverride,
  deleteSubagentOverride,
}: CostAnalyticsTabProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [activeSection, setActiveSection] = useState<Section>('breakdown')

  const [breakdown, setBreakdown] = useState<{ data: BreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [recommendations, setRecommendations] = useState<{ data: CostRecommendation[] | null; loading: boolean }>({ data: null, loading: false })
  const [trends, setTrends] = useState<{ data: TrendsData | null; loading: boolean }>({ data: null, loading: true })
  const [budgetAlerts, setBudgetAlerts] = useState<{ data: BudgetAlertItem[] | null; loading: boolean }>({ data: null, loading: true })
  const [budgetStatus, setBudgetStatus] = useState<{ data: BudgetStatus | null; loading: boolean }>({ data: null, loading: true })
  const [experiments, setExperiments] = useState<{ data: ExperimentItem[] | null; loading: boolean }>({ data: null, loading: false })
  // Phase 3.3 — "Optimizer in Action" report. Loaded lazily when the tab is
  // first opened so the rest of the dashboard isn't slowed by the heavier
  // before/after aggregations.
  const [inAction, setInAction] = useState<{
    data: OptimizerInActionData | null
    loading: boolean
    error: string | null
  }>({ data: null, loading: false, error: null })

  const overridesAvailable = !!(fetchSubagentOverrides && putSubagentOverride && deleteSubagentOverride)

  // Phase 4.3 — drop the unsupported Sub-Agents tab when overrides aren't wired
  // up by the parent, so the tab strip never has dead options.
  const visibleSections = overridesAvailable
    ? SECTION_CONFIG
    : SECTION_CONFIG.filter(s => s.id !== 'subagents')

  // Phase 4.3 — per-section loaders. Each section only fetches the data it
  // actually renders and only when it becomes active. The summary cards still
  // need breakdown + budgetStatus + trends, so those three are loaded eagerly
  // on mount and re-loaded when the period changes.
  const loadBreakdown = useCallback(async () => {
    setBreakdown(s => ({ ...s, loading: true }))
    const data = await fetchCostAnalytics<BreakdownData>('agent-breakdown', { period }).catch(() => null)
    setBreakdown({ data, loading: false })
  }, [fetchCostAnalytics, period])

  const loadRecommendations = useCallback(async () => {
    setRecommendations(s => ({ ...s, loading: true }))
    const data = await fetchCostAnalytics<CostRecommendation[]>('recommendations', { period }).catch(() => null)
    setRecommendations({ data, loading: false })
  }, [fetchCostAnalytics, period])

  const loadTrends = useCallback(async () => {
    setTrends(s => ({ ...s, loading: true }))
    const data = await fetchCostAnalytics<TrendsData>('trends', { period }).catch(() => null)
    setTrends({ data, loading: false })
  }, [fetchCostAnalytics, period])

  const loadBudget = useCallback(async () => {
    setBudgetAlerts(s => ({ ...s, loading: true }))
    setBudgetStatus(s => ({ ...s, loading: true }))
    const [ba, bs] = await Promise.all([
      fetchCostAnalytics<BudgetAlertItem[]>('budget-alerts').catch(() => null),
      fetchCostAnalytics<BudgetStatus>('budget-status').catch(() => null),
    ])
    setBudgetAlerts({ data: ba, loading: false })
    setBudgetStatus({ data: bs, loading: false })
  }, [fetchCostAnalytics])

  const loadExperiments = useCallback(async () => {
    setExperiments(s => ({ ...s, loading: true }))
    const data = await fetchCostAnalytics<ExperimentItem[]>('experiments').catch(() => null)
    setExperiments({ data, loading: false })
  }, [fetchCostAnalytics])

  const loadInAction = useCallback(async () => {
    setInAction(s => ({ ...s, loading: true, error: null }))
    try {
      const data = await fetchCostAnalytics<OptimizerInActionData>('optimizer-in-action')
      setInAction({ data, loading: false, error: null })
    } catch (err: any) {
      setInAction({ data: null, loading: false, error: err?.message ?? 'Failed to load' })
    }
  }, [fetchCostAnalytics])

  // Eager loaders — feed the always-visible summary cards + period selector.
  // Budget status feeds the throttle banner that appears regardless of tab.
  useEffect(() => {
    loadBreakdown()
    loadTrends()
    loadBudget()
  }, [loadBreakdown, loadTrends, loadBudget])

  // Lazy loaders — fire only when the tab becomes active and we don't already
  // have data. Keyed on (activeSection, period) so a period change while a
  // tab is open re-loads it; opening a new tab loads it on first activation.
  useEffect(() => {
    switch (activeSection) {
      case 'recommendations':
        if (!recommendations.data && !recommendations.loading) loadRecommendations()
        break
      case 'experiments':
        if (!experiments.data && !experiments.loading) loadExperiments()
        break
      case 'inaction':
        if (!inAction.data && !inAction.loading) loadInAction()
        break
      // 'breakdown', 'trends', 'budget' are eagerly loaded above.
      // 'subagents' fetches via SubAgentModelsSection.
    }
  }, [
    activeSection,
    recommendations.data, recommendations.loading, loadRecommendations,
    experiments.data, experiments.loading, loadExperiments,
    inAction.data, inAction.loading, loadInAction,
  ])

  // Period changes invalidate cached lazy data — clear so the next activation
  // reloads against the new window.
  useEffect(() => {
    setRecommendations({ data: null, loading: false })
  }, [period])

  // Composite refresh used by sub-components that mutate state (apply
  // recommendation, create experiment, …). Reloads everything we already
  // have plus refreshes the lazy tabs by clearing them.
  const refreshAll = useCallback(async () => {
    await Promise.all([loadBreakdown(), loadTrends(), loadBudget()])
    if (recommendations.data) await loadRecommendations()
    if (experiments.data) await loadExperiments()
    setInAction({ data: null, loading: false, error: null })
  }, [
    loadBreakdown, loadTrends, loadBudget, loadRecommendations, loadExperiments,
    recommendations.data, experiments.data,
  ])
  // Back-compat alias for legacy call sites that already use `loadAll`.
  const loadAll = refreshAll

  // Phase 1.3 — applying a recommendation upserts the workspace override so the
  // very next sub-agent spawn picks it up. Refresh the recommendation list after
  // so the row falls off (the gate now sees the user already opted in).
  const handleApplyRecommendation = useCallback(async (rec: CostRecommendation) => {
    if (!putSubagentOverride) return
    await putSubagentOverride({
      agentType: rec.agentType,
      model: rec.recommendedModel,
      projectId: null,
    })
    await loadAll()
    // Refresh the "In Action" report so the boss sees the override land.
    setInAction({ data: null, loading: false, error: null })
  }, [putSubagentOverride, loadAll])

  return (
    <View className="gap-4">
      {/* Header */}
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Agent Cost Optimizer</Text>
        <Text className="text-xs text-muted-foreground mb-3">
          Per-agent cost breakdown, AI recommendations, and budget controls
        </Text>
        <PeriodSelector value={period} onChange={setPeriod} />
      </View>

      {/* Summary Cards */}
      <SummaryCards data={breakdown.data} budgetStatus={budgetStatus.data} trends={trends.data} />

      {/* Section Tabs */}
      <SectionTabs active={activeSection} onChange={setActiveSection} sections={visibleSections} />

      {/* Active Section */}
      {activeSection === 'breakdown' && (
        <AgentBreakdownSection data={breakdown.data} loading={breakdown.loading} />
      )}
      {activeSection === 'recommendations' && (
        <RecommendationsSection
          data={recommendations.data}
          loading={recommendations.loading}
          onApply={overridesAvailable ? handleApplyRecommendation : undefined}
        />
      )}
      {activeSection === 'subagents' && overridesAvailable && (
        <SubAgentModelsSection
          workspaceId={workspaceId}
          fetchOverrides={fetchSubagentOverrides!}
          putOverride={putSubagentOverride!}
          deleteOverride={deleteSubagentOverride!}
          onChange={() => {
            loadAll()
            setInAction({ data: null, loading: false, error: null })
          }}
        />
      )}
      {activeSection === 'inaction' && (
        <OptimizerInActionSection
          data={inAction.data}
          isLoading={inAction.loading}
          error={inAction.error}
        />
      )}
      {activeSection === 'trends' && (
        <TrendsSection data={trends.data} loading={trends.loading} />
      )}
      {activeSection === 'budget' && (
        <BudgetSection
          alerts={budgetAlerts.data}
          status={budgetStatus.data}
          loading={budgetAlerts.loading}
          onRefresh={loadAll}
          postCostAnalytics={postCostAnalytics}
        />
      )}
      {activeSection === 'experiments' && (
        <ExperimentsSection
          data={experiments.data}
          loading={experiments.loading}
          onRefresh={loadAll}
          postCostAnalytics={postCostAnalytics}
        />
      )}
    </View>
  )
}

// =============================================================================
// Summary Cards
// =============================================================================

function SummaryCards({
  data,
  budgetStatus,
  trends,
}: {
  data: BreakdownData | null
  budgetStatus: BudgetStatus | null
  trends: TrendsData | null
}) {
  const totalCost = data?.totals.totalCreditCost ?? 0
  const totalRuns = data?.totals.totalRuns ?? 0
  const avgCost = totalRuns > 0 ? Math.round((totalCost / totalRuns) * 100) / 100 : 0
  const forecast = trends?.forecast

  return (
    <View className="flex-row flex-wrap gap-2">
      <MiniCard
        label="Total Cost"
        value={formatDollarCost(totalCost)}
        icon={DollarSign}
        color="text-orange-400"
      />
      <MiniCard
        label="Agent Runs"
        value={formatNumber(totalRuns)}
        icon={Cpu}
        color="text-blue-400"
      />
      <MiniCard
        label="Avg Cost/Run"
        value={formatDollarCost(avgCost)}
        icon={Zap}
        color="text-emerald-400"
      />
      <MiniCard
        label="Forecast"
        value={forecast ? `${formatDollarCost(forecast.nextMonth)}/mo` : '—'}
        icon={forecast?.trend === 'increasing' ? TrendingUp : forecast?.trend === 'decreasing' ? TrendingDown : Minus}
        color={forecast?.trend === 'increasing' ? 'text-red-400' : forecast?.trend === 'decreasing' ? 'text-green-400' : 'text-muted-foreground'}
        subtitle={forecast ? `${forecast.percentChange > 0 ? '+' : ''}${forecast.percentChange}%` : undefined}
      />
    </View>
  )
}

function MiniCard({
  label,
  value,
  icon: Icon,
  color,
  subtitle,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  color: string
  subtitle?: string
}) {
  return (
    <View className="flex-1 rounded-xl border border-border bg-card p-3 min-w-[140px]">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-[10px] font-medium text-muted-foreground">{label}</Text>
        <View className="h-6 w-6 rounded bg-primary/10 items-center justify-center">
          <Icon size={12} className={color} />
        </View>
      </View>
      <Text className="text-lg font-bold text-foreground">{value}</Text>
      {subtitle && <Text className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</Text>}
    </View>
  )
}

// =============================================================================
// Section Tabs
// =============================================================================

function SectionTabs({
  active,
  onChange,
  sections = SECTION_CONFIG,
}: {
  active: Section
  onChange: (s: Section) => void
  sections?: typeof SECTION_CONFIG
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-1 bg-muted rounded-lg p-0.5">
        {sections.map(({ id, label, icon: Icon }) => {
          const isActive = active === id
          return (
            <Pressable
              key={id}
              onPress={() => onChange(id)}
              className={cn('flex-row items-center gap-1.5 px-3 py-1.5 rounded-md', isActive ? 'bg-background' : '')}
            >
              <Icon size={12} className={isActive ? 'text-foreground' : 'text-muted-foreground'} />
              <Text className={cn('text-xs font-medium', isActive ? 'text-foreground' : 'text-muted-foreground')}>
                {label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </ScrollView>
  )
}

// =============================================================================
// 1. Agent Breakdown
// =============================================================================

function AgentBreakdownSection({ data, loading }: { data: BreakdownData | null; loading: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (loading) return <LoadingCard />

  const entries = data?.breakdown ?? []

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <Cpu size={24} className="text-muted-foreground mb-2" />
          <Text className="text-sm text-muted-foreground text-center">
            No agent cost data yet. Costs will appear here as agents run.
          </Text>
        </CardContent>
      </Card>
    )
  }

  return (
    <View className="gap-2">
      {entries.map((entry, i) => {
        const key = `${entry.agentType}::${entry.model}`
        const isExpanded = expanded === key
        const promiseSuccesses = entry.promiseSuccesses ?? Math.round((entry.successRate / 100) * entry.totalRuns)
        const failures = Math.max(0, entry.totalRuns - promiseSuccesses)
        const qualitySuccessRate = entry.qualitySuccessRate ?? entry.successRate
        const costPercent = data!.totals.totalCreditCost > 0
          ? Math.round((entry.totalCreditCost / data!.totals.totalCreditCost) * 100)
          : 0

        return (
          <Card key={key}>
            <Pressable onPress={() => setExpanded(isExpanded ? null : key)}>
              <CardContent className="p-3">
                {/* Top row */}
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2 flex-1">
                    <View className="h-8 w-8 rounded-lg bg-primary/10 items-center justify-center">
                      <Cpu size={14} className="text-primary" />
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                        {entry.agentType}
                      </Text>
                      <View className="flex-row items-center gap-1.5 mt-0.5">
                        <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(entry.model))}>
                          <Text className={cn('text-[10px] font-medium', getModelTextColor(entry.model))}>
                            {getModelDisplayName(entry.model)}
                          </Text>
                        </View>
                        <Text className="text-[10px] text-muted-foreground">
                          {entry.totalRuns} runs
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View className="items-end">
                    <Text className="text-sm font-bold text-foreground">
                      {formatDollarCost(entry.totalCreditCost)}
                    </Text>
                    <Text className="text-[10px] text-muted-foreground">{costPercent}% of period cost</Text>
                  </View>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-muted-foreground ml-2" />
                  ) : (
                    <ChevronDown size={14} className="text-muted-foreground ml-2" />
                  )}
                </View>

                {/* Cost bar */}
                <Text className="mt-2 text-[9px] text-muted-foreground">
                  Relative share of selected period spend
                </Text>
                <View className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                  <View
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${Math.max(costPercent, 2)}%` }}
                  />
                </View>

                {/* Expanded details */}
                {isExpanded && (
                  <View className="mt-3 pt-3 border-t border-border">
                    <View className="flex-row flex-wrap gap-x-4 gap-y-2">
                      <MetricPill icon={CheckCircle2} label="Quality" value={`${qualitySuccessRate}%`} color="text-green-400" />
                      <MetricPill icon={XCircle} label="Failures" value={String(failures)} color="text-red-400" />
                      <MetricPill icon={Clock} label="Avg Latency" value={formatDuration(entry.avgLatencyMs)} color="text-blue-400" />
                      <MetricPill icon={DollarSign} label="Avg Cost" value={formatDollarCost(entry.avgCostPerRun)} color="text-orange-400" />
                      <MetricPill icon={Zap} label="Tool Calls" value={formatNumber(entry.totalToolCalls)} color="text-purple-400" />
                    </View>
                    {(entry.loopDetected || entry.hitMaxTurns || entry.escalated || entry.responseEmpty) ? (
                      <View className="flex-row flex-wrap gap-x-3 gap-y-1 mt-2">
                        {entry.loopDetected ? <Text className="text-[10px] text-muted-foreground">Loops: {entry.loopDetected}</Text> : null}
                        {entry.hitMaxTurns ? <Text className="text-[10px] text-muted-foreground">Max-turns: {entry.hitMaxTurns}</Text> : null}
                        {entry.escalated ? <Text className="text-[10px] text-muted-foreground">Escalations: {entry.escalated}</Text> : null}
                        {entry.responseEmpty ? <Text className="text-[10px] text-muted-foreground">Empty: {entry.responseEmpty}</Text> : null}
                      </View>
                    ) : null}
                    <Separator className="my-2" />
                    <View className="flex-row justify-between">
                      <Text className="text-[10px] text-muted-foreground">
                        Input: {formatNumber(entry.totalInputTokens)} tokens
                      </Text>
                      <Text className="text-[10px] text-muted-foreground">
                        Output: {formatNumber(entry.totalOutputTokens)} tokens
                      </Text>
                      <Text className="text-[10px] text-muted-foreground">
                        Cached: {formatNumber(entry.totalCachedInputTokens)} tokens
                      </Text>
                    </View>
                  </View>
                )}
              </CardContent>
            </Pressable>
          </Card>
        )
      })}
    </View>
  )
}

function MetricPill({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: string
  color: string
}) {
  return (
    <View className="flex-row items-center gap-1">
      <Icon size={10} className={color} />
      <Text className="text-[10px] text-muted-foreground">{label}:</Text>
      <Text className="text-[10px] font-semibold text-foreground">{value}</Text>
    </View>
  )
}

// =============================================================================
// 2. AI Recommendations — moved to ./RecommendationsSection.tsx (Phase 4.3 split)
// =============================================================================

// =============================================================================
// 3. Cost Trends
// =============================================================================

function TrendsSection({ data, loading }: { data: TrendsData | null; loading: boolean }) {
  if (loading) return <LoadingCard />
  if (!data) return null

  const { trends, forecast } = data

  if (trends.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <TrendingUp size={24} className="text-muted-foreground mb-2" />
          <Text className="text-sm text-muted-foreground text-center">
            No cost history yet. Trends will populate as agents run.
          </Text>
        </CardContent>
      </Card>
    )
  }

  const maxCost = Math.max(...trends.map(t => t.totalCost), 1)
  const maxCostLabel = formatDollarCost(maxCost)

  return (
    <View className="gap-3">
      {/* Forecast card */}
      <Card>
        <CardContent className="p-3">
          <View className="flex-row items-center gap-2 mb-2">
            {forecast.trend === 'increasing' ? (
              <TrendingUp size={16} className="text-red-400" />
            ) : forecast.trend === 'decreasing' ? (
              <TrendingDown size={16} className="text-green-400" />
            ) : (
              <Minus size={16} className="text-muted-foreground" />
            )}
            <Text className="text-sm font-semibold text-foreground">Next Month Forecast</Text>
          </View>
          <Text className="text-2xl font-bold text-foreground">{formatDollarCost(forecast.nextMonth)}</Text>
          <Text className={cn(
            'text-xs mt-0.5',
            forecast.trend === 'increasing' ? 'text-red-400' : forecast.trend === 'decreasing' ? 'text-green-400' : 'text-muted-foreground',
          )}>
            {forecast.trend === 'stable' ? 'Stable spending' :
              `${forecast.trend === 'increasing' ? 'Increasing' : 'Decreasing'} ${Math.abs(forecast.percentChange)}% vs. previous period`}
          </Text>
        </CardContent>
      </Card>

      {/* Daily cost bars */}
      <Card>
        <CardContent className="p-3">
          <View className="mb-3">
            <Text className="text-sm font-semibold text-foreground">Daily Costs</Text>
            <Text className="text-[10px] text-muted-foreground">
              Bars are relative to the highest day in this period ({maxCostLabel}).
            </Text>
          </View>
          <View className="gap-1">
            {trends.slice(-14).map((point) => {
              const barWidth = Math.max((point.totalCost / maxCost) * 100, 2)
              const dateLabel = point.date.slice(5) // MM-DD
              return (
                <View key={point.date} className="flex-row items-center gap-2">
                  <Text className="text-[9px] text-muted-foreground w-10">{dateLabel}</Text>
                  <View className="flex-1 h-4 bg-muted rounded-sm overflow-hidden">
                    <View
                      className="h-full bg-primary/80 rounded-sm"
                      style={{ width: `${barWidth}%` }}
                    />
                  </View>
                  <Text className="text-[9px] font-medium text-foreground w-14 text-right">
                    {formatDollarCost(point.totalCost)}
                  </Text>
                </View>
              )
            })}
          </View>
        </CardContent>
      </Card>
    </View>
  )
}

// =============================================================================
// 4. Budget Alerts
// =============================================================================

// 4. Budget — moved to ./BudgetSection.tsx (Phase 4.3 split)

// =============================================================================
// 5. A/B Experiments — moved to ./ExperimentsSection.tsx (Phase 4.3 split)
// =============================================================================

// =============================================================================
// Shared Loading
// =============================================================================

function LoadingCard() {
  return (
    <Card>
      <CardContent className="p-8 items-center">
        <ActivityIndicator size="small" />
        <Text className="text-xs text-muted-foreground mt-2">Loading...</Text>
      </CardContent>
    </Card>
  )
}
