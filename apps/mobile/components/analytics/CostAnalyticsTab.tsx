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
  TextInput,
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
  Plus,
  Trash2,
  ArrowRightLeft,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  type AnalyticsPeriod,
  PeriodSelector,
  formatNumber,
  formatDuration,
  getModelColor,
  getModelTextColor,
  getModelDisplayName,
} from './SharedAnalytics'
import { Card, CardContent, Button, Badge, Separator } from '@shogo/shared-ui/primitives'

// =============================================================================
// Types
// =============================================================================

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

interface TrendsData {
  trends: CostTrendPoint[]
  forecast: {
    nextMonth: number
    trend: 'increasing' | 'decreasing' | 'stable'
    percentChange: number
  }
}

interface BudgetAlertItem {
  id: string
  name: string
  creditLimit: number
  periodType: string
  enabled: boolean
  autoThrottle: boolean
  throttleToModel: string | null
  lastTriggeredAt: string | null
}

interface BudgetStatus {
  breached: Array<{
    alert: { id: string; name: string; creditLimit: number; autoThrottle: boolean; throttleToModel: string | null }
    currentSpend: number
    percentUsed: number
  }>
  throttleModel: string | null
}

interface ExperimentItem {
  id: string
  name: string
  agentType: string
  modelA: string
  modelB: string
  status: string
  splitPercentage: number
  totalRunsA: number
  totalRunsB: number
  totalCostA: number
  totalCostB: number
  successRateA: number
  successRateB: number
  avgLatencyMsA: number
  avgLatencyMsB: number
}

interface CostAnalyticsTabProps {
  workspaceId: string
  fetchCostAnalytics: <T>(endpoint: string, params?: Record<string, string>) => Promise<T>
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
}

// =============================================================================
// Sub-sections
// =============================================================================

type Section = 'breakdown' | 'recommendations' | 'budget' | 'trends' | 'experiments'

const SECTION_CONFIG: Array<{ id: Section; label: string; icon: React.ElementType }> = [
  { id: 'breakdown', label: 'Agents', icon: Cpu },
  { id: 'recommendations', label: 'Optimize', icon: Lightbulb },
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
}: CostAnalyticsTabProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [activeSection, setActiveSection] = useState<Section>('breakdown')

  const [breakdown, setBreakdown] = useState<{ data: BreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [recommendations, setRecommendations] = useState<{ data: CostRecommendation[] | null; loading: boolean }>({ data: null, loading: true })
  const [trends, setTrends] = useState<{ data: TrendsData | null; loading: boolean }>({ data: null, loading: true })
  const [budgetAlerts, setBudgetAlerts] = useState<{ data: BudgetAlertItem[] | null; loading: boolean }>({ data: null, loading: true })
  const [budgetStatus, setBudgetStatus] = useState<{ data: BudgetStatus | null; loading: boolean }>({ data: null, loading: true })
  const [experiments, setExperiments] = useState<{ data: ExperimentItem[] | null; loading: boolean }>({ data: null, loading: true })

  const loadAll = useCallback(async () => {
    const p = { period }
    setBreakdown(s => ({ ...s, loading: true }))
    setRecommendations(s => ({ ...s, loading: true }))
    setTrends(s => ({ ...s, loading: true }))
    setBudgetAlerts(s => ({ ...s, loading: true }))
    setBudgetStatus(s => ({ ...s, loading: true }))
    setExperiments(s => ({ ...s, loading: true }))

    const [bd, rec, tr, ba, bs, exp] = await Promise.all([
      fetchCostAnalytics<BreakdownData>('agent-breakdown', p).catch(() => null),
      fetchCostAnalytics<CostRecommendation[]>('recommendations', p).catch(() => null),
      fetchCostAnalytics<TrendsData>('trends', p).catch(() => null),
      fetchCostAnalytics<BudgetAlertItem[]>('budget-alerts').catch(() => null),
      fetchCostAnalytics<BudgetStatus>('budget-status').catch(() => null),
      fetchCostAnalytics<ExperimentItem[]>('experiments').catch(() => null),
    ])

    setBreakdown({ data: bd, loading: false })
    setRecommendations({ data: rec, loading: false })
    setTrends({ data: tr, loading: false })
    setBudgetAlerts({ data: ba, loading: false })
    setBudgetStatus({ data: bs, loading: false })
    setExperiments({ data: exp, loading: false })
  }, [fetchCostAnalytics, period])

  useEffect(() => { loadAll() }, [loadAll])

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
      <SectionTabs active={activeSection} onChange={setActiveSection} />

      {/* Active Section */}
      {activeSection === 'breakdown' && (
        <AgentBreakdownSection data={breakdown.data} loading={breakdown.loading} />
      )}
      {activeSection === 'recommendations' && (
        <RecommendationsSection data={recommendations.data} loading={recommendations.loading} />
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
        value={`${totalCost.toFixed(1)} cr`}
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
        value={`${avgCost} cr`}
        icon={Zap}
        color="text-emerald-400"
      />
      <MiniCard
        label="Forecast"
        value={forecast ? `${forecast.nextMonth} cr/mo` : '—'}
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

function SectionTabs({ active, onChange }: { active: Section; onChange: (s: Section) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-1 bg-muted rounded-lg p-0.5">
        {SECTION_CONFIG.map(({ id, label, icon: Icon }) => {
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
                      {entry.totalCreditCost.toFixed(1)} cr
                    </Text>
                    <Text className="text-[10px] text-muted-foreground">{costPercent}% of total</Text>
                  </View>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-muted-foreground ml-2" />
                  ) : (
                    <ChevronDown size={14} className="text-muted-foreground ml-2" />
                  )}
                </View>

                {/* Cost bar */}
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
                      <MetricPill icon={CheckCircle2} label="Success" value={`${entry.successRate}%`} color="text-green-400" />
                      <MetricPill icon={XCircle} label="Failures" value={String(entry.failures)} color="text-red-400" />
                      <MetricPill icon={Clock} label="Avg Latency" value={formatDuration(entry.avgLatencyMs)} color="text-blue-400" />
                      <MetricPill icon={DollarSign} label="Avg Cost" value={`${entry.avgCostPerRun} cr`} color="text-orange-400" />
                      <MetricPill icon={Zap} label="Tool Calls" value={formatNumber(entry.totalToolCalls)} color="text-purple-400" />
                    </View>
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
// 2. AI Recommendations
// =============================================================================

function RecommendationsSection({ data, loading }: { data: CostRecommendation[] | null; loading: boolean }) {
  if (loading) return <LoadingCard />

  const recs = data ?? []

  if (recs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <Lightbulb size={24} className="text-muted-foreground mb-2" />
          <Text className="text-sm font-medium text-foreground mb-1">No recommendations yet</Text>
          <Text className="text-xs text-muted-foreground text-center max-w-[280px]">
            Once agents have enough usage data (5+ runs), optimization recommendations will appear here.
          </Text>
        </CardContent>
      </Card>
    )
  }

  return (
    <View className="gap-2">
      {recs.map((rec, i) => {
        const isSavings = rec.estimatedSavingsPercent > 0
        return (
          <Card key={i}>
            <CardContent className="p-3">
              <View className="flex-row items-start gap-2">
                <View className={cn(
                  'h-8 w-8 rounded-lg items-center justify-center mt-0.5',
                  isSavings ? 'bg-green-500/10' : 'bg-amber-500/10',
                )}>
                  {isSavings ? (
                    <TrendingDown size={14} className="text-green-400" />
                  ) : (
                    <TrendingUp size={14} className="text-amber-400" />
                  )}
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2 mb-1">
                    <Text className="text-sm font-semibold text-foreground">{rec.agentType}</Text>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      rec.confidence === 'high' ? 'bg-green-500/15' : rec.confidence === 'medium' ? 'bg-amber-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn(
                        'text-[9px] font-medium',
                        rec.confidence === 'high' ? 'text-green-400' : rec.confidence === 'medium' ? 'text-amber-400' : 'text-muted-foreground',
                      )}>
                        {rec.confidence} confidence
                      </Text>
                    </View>
                  </View>

                  {/* Model switch visual */}
                  {rec.currentModel !== rec.recommendedModel && (
                    <View className="flex-row items-center gap-1.5 mb-2">
                      <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(rec.currentModel))}>
                        <Text className={cn('text-[10px] font-medium', getModelTextColor(rec.currentModel))}>
                          {getModelDisplayName(rec.currentModel)}
                        </Text>
                      </View>
                      <ArrowRightLeft size={10} className="text-muted-foreground" />
                      <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(rec.recommendedModel))}>
                        <Text className={cn('text-[10px] font-medium', getModelTextColor(rec.recommendedModel))}>
                          {getModelDisplayName(rec.recommendedModel)}
                        </Text>
                      </View>
                      {isSavings && (
                        <Text className="text-[10px] font-bold text-green-400 ml-1">
                          Save ~{rec.estimatedSavingsPercent}%
                        </Text>
                      )}
                    </View>
                  )}

                  <Text className="text-xs text-muted-foreground leading-4">{rec.reason}</Text>

                  {rec.estimatedMonthlySavings !== 0 && (
                    <Text className={cn(
                      'text-[10px] font-medium mt-1',
                      isSavings ? 'text-green-400' : 'text-amber-400',
                    )}>
                      {isSavings ? '↓' : '↑'} Est. {Math.abs(rec.estimatedMonthlySavings)} cr/month
                      {rec.currentMonthlyCost > 0 ? ` (current: ${rec.currentMonthlyCost} cr/mo)` : ''}
                    </Text>
                  )}
                </View>
              </View>
            </CardContent>
          </Card>
        )
      })}
    </View>
  )
}

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
          <Text className="text-2xl font-bold text-foreground">{forecast.nextMonth} credits</Text>
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
          <Text className="text-sm font-semibold text-foreground mb-3">Daily Costs</Text>
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
                    {point.totalCost.toFixed(1)} cr
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

function BudgetSection({
  alerts,
  status,
  loading,
  onRefresh,
  postCostAnalytics,
}: {
  alerts: BudgetAlertItem[] | null
  status: BudgetStatus | null
  loading: boolean
  onRefresh: () => void
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLimit, setNewLimit] = useState('')
  const [creating, setCreating] = useState(false)

  if (loading) return <LoadingCard />

  const handleCreate = async () => {
    const limit = parseFloat(newLimit)
    if (!newName.trim() || isNaN(limit) || limit <= 0) return
    setCreating(true)
    try {
      await postCostAnalytics('budget-alerts', { name: newName.trim(), creditLimit: limit })
      setNewName('')
      setNewLimit('')
      setShowCreate(false)
      onRefresh()
    } catch { /* handled */ }
    setCreating(false)
  }

  return (
    <View className="gap-3">
      {/* Active throttle warning */}
      {status?.throttleModel && (
        <Card>
          <CardContent className="p-3 bg-amber-500/5 border-amber-500/20">
            <View className="flex-row items-center gap-2">
              <Bell size={14} className="text-amber-400" />
              <Text className="text-xs font-medium text-amber-400">
                Auto-throttle active — model limited to {getModelDisplayName(status.throttleModel)}
              </Text>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Alert list */}
      {(alerts ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-6 items-center">
            <Bell size={24} className="text-muted-foreground mb-2" />
            <Text className="text-sm font-medium text-foreground mb-1">No budget alerts</Text>
            <Text className="text-xs text-muted-foreground text-center max-w-[280px] mb-3">
              Set spending limits and get notified when costs approach thresholds. Optionally auto-throttle to cheaper models.
            </Text>
            <Button variant="outline" onPress={() => setShowCreate(true)}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={12} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">Create Alert</Text>
              </View>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {(alerts ?? []).map(alert => {
            const breachInfo = status?.breached.find(b => b.alert.id === alert.id)
            const isBreached = breachInfo && breachInfo.percentUsed >= 100
            const isWarning = breachInfo && breachInfo.percentUsed >= 80 && !isBreached

            return (
              <Card key={alert.id}>
                <CardContent className={cn(
                  'p-3',
                  isBreached ? 'border-red-500/30' : isWarning ? 'border-amber-500/30' : '',
                )}>
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center gap-2">
                      <Bell size={14} className={isBreached ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-muted-foreground'} />
                      <Text className="text-sm font-semibold text-foreground">{alert.name}</Text>
                    </View>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      alert.enabled ? 'bg-green-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn('text-[9px] font-medium', alert.enabled ? 'text-green-400' : 'text-muted-foreground')}>
                        {alert.enabled ? 'Active' : 'Disabled'}
                      </Text>
                    </View>
                  </View>

                  <View className="flex-row items-baseline gap-1 mb-1">
                    <Text className="text-lg font-bold text-foreground">
                      {breachInfo ? breachInfo.currentSpend.toFixed(1) : '0'}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      / {alert.creditLimit} cr ({alert.periodType})
                    </Text>
                  </View>

                  {/* Progress bar */}
                  <View className="h-2 bg-muted rounded-full overflow-hidden mb-2">
                    <View
                      className={cn(
                        'h-full rounded-full',
                        isBreached ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-primary',
                      )}
                      style={{ width: `${Math.min(breachInfo?.percentUsed ?? 0, 100)}%` }}
                    />
                  </View>

                  <View className="flex-row items-center gap-3">
                    {alert.autoThrottle && (
                      <Text className="text-[10px] text-muted-foreground">
                        Auto-throttle to {alert.throttleToModel ? getModelDisplayName(alert.throttleToModel) : 'economy'}
                      </Text>
                    )}
                  </View>
                </CardContent>
              </Card>
            )
          })}

          <Button variant="outline" onPress={() => setShowCreate(true)}>
            <View className="flex-row items-center gap-1.5">
              <Plus size={12} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">Add Alert</Text>
            </View>
          </Button>
        </>
      )}

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="p-3 gap-3">
            <Text className="text-sm font-semibold text-foreground">New Budget Alert</Text>
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Alert name (e.g. Monthly spend cap)"
              placeholderTextColor="#888"
              value={newName}
              onChangeText={setNewName}
            />
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Credit limit (e.g. 500)"
              placeholderTextColor="#888"
              value={newLimit}
              onChangeText={setNewLimit}
              keyboardType="numeric"
            />
            <View className="flex-row gap-2">
              <Button variant="outline" onPress={() => setShowCreate(false)} className="flex-1">
                <Text className="text-sm font-medium text-foreground">Cancel</Text>
              </Button>
              <Button onPress={handleCreate} disabled={creating} className="flex-1">
                <Text className="text-sm font-medium text-primary-foreground">
                  {creating ? 'Creating...' : 'Create'}
                </Text>
              </Button>
            </View>
          </CardContent>
        </Card>
      )}
    </View>
  )
}

// =============================================================================
// 5. A/B Experiments
// =============================================================================

function ExperimentsSection({
  data,
  loading,
  onRefresh,
  postCostAnalytics,
}: {
  data: ExperimentItem[] | null
  loading: boolean
  onRefresh: () => void
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [formName, setFormName] = useState('')
  const [formAgent, setFormAgent] = useState('')
  const [formModelA, setFormModelA] = useState('')
  const [formModelB, setFormModelB] = useState('')
  const [creating, setCreating] = useState(false)

  if (loading) return <LoadingCard />

  const handleCreate = async () => {
    if (!formName.trim() || !formAgent.trim() || !formModelA.trim() || !formModelB.trim()) return
    setCreating(true)
    try {
      await postCostAnalytics('experiments', {
        name: formName.trim(),
        agentType: formAgent.trim(),
        modelA: formModelA.trim(),
        modelB: formModelB.trim(),
      })
      setFormName('')
      setFormAgent('')
      setFormModelA('')
      setFormModelB('')
      setShowCreate(false)
      onRefresh()
    } catch { /* handled */ }
    setCreating(false)
  }

  const handleStop = async (id: string) => {
    try {
      await postCostAnalytics(`experiments/${id}/stop`, {})
      onRefresh()
    } catch { /* handled */ }
  }

  const experiments = data ?? []

  return (
    <View className="gap-3">
      {experiments.length === 0 && !showCreate ? (
        <Card>
          <CardContent className="p-6 items-center">
            <FlaskConical size={24} className="text-muted-foreground mb-2" />
            <Text className="text-sm font-medium text-foreground mb-1">No experiments</Text>
            <Text className="text-xs text-muted-foreground text-center max-w-[280px] mb-3">
              A/B test different models on the same agent type. Compare cost, quality, and latency side by side.
            </Text>
            <Button variant="outline" onPress={() => setShowCreate(true)}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={12} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">New Experiment</Text>
              </View>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {experiments.map((exp) => {
            const isRunning = exp.status === 'running'
            const totalRuns = exp.totalRunsA + exp.totalRunsB
            const totalCost = exp.totalCostA + exp.totalCostB
            const costPerRunA = exp.totalRunsA > 0 ? (exp.totalCostA / exp.totalRunsA) : 0
            const costPerRunB = exp.totalRunsB > 0 ? (exp.totalCostB / exp.totalRunsB) : 0

            return (
              <Card key={exp.id}>
                <CardContent className="p-3">
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center gap-2">
                      <FlaskConical size={14} className={isRunning ? 'text-primary' : 'text-muted-foreground'} />
                      <Text className="text-sm font-semibold text-foreground">{exp.name}</Text>
                    </View>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      isRunning ? 'bg-green-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn('text-[9px] font-medium', isRunning ? 'text-green-400' : 'text-muted-foreground')}>
                        {exp.status}
                      </Text>
                    </View>
                  </View>

                  <Text className="text-[10px] text-muted-foreground mb-2">
                    Agent: {exp.agentType} · {totalRuns} total runs · {totalCost.toFixed(1)} credits
                  </Text>

                  {/* Side-by-side comparison */}
                  <View className="flex-row gap-2">
                    <ExperimentVariantCard
                      label="Model A"
                      model={exp.modelA}
                      runs={exp.totalRunsA}
                      cost={exp.totalCostA}
                      costPerRun={costPerRunA}
                      successRate={exp.successRateA}
                      latency={exp.avgLatencyMsA}
                    />
                    <ExperimentVariantCard
                      label="Model B"
                      model={exp.modelB}
                      runs={exp.totalRunsB}
                      cost={exp.totalCostB}
                      costPerRun={costPerRunB}
                      successRate={exp.successRateB}
                      latency={exp.avgLatencyMsB}
                    />
                  </View>

                  {isRunning && (
                    <Button variant="outline" onPress={() => handleStop(exp.id)} className="mt-2">
                      <Text className="text-xs font-medium text-foreground">Stop Experiment</Text>
                    </Button>
                  )}
                </CardContent>
              </Card>
            )
          })}

          <Button variant="outline" onPress={() => setShowCreate(true)}>
            <View className="flex-row items-center gap-1.5">
              <Plus size={12} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">New Experiment</Text>
            </View>
          </Button>
        </>
      )}

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="p-3 gap-3">
            <Text className="text-sm font-semibold text-foreground">New A/B Experiment</Text>
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Experiment name"
              placeholderTextColor="#888"
              value={formName}
              onChangeText={setFormName}
            />
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Agent type (e.g. explore, general-purpose)"
              placeholderTextColor="#888"
              value={formAgent}
              onChangeText={setFormAgent}
            />
            <View className="flex-row gap-2">
              <TextInput
                className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground flex-1"
                placeholder="Model A (e.g. opus)"
                placeholderTextColor="#888"
                value={formModelA}
                onChangeText={setFormModelA}
              />
              <TextInput
                className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground flex-1"
                placeholder="Model B (e.g. sonnet)"
                placeholderTextColor="#888"
                value={formModelB}
                onChangeText={setFormModelB}
              />
            </View>
            <View className="flex-row gap-2">
              <Button variant="outline" onPress={() => setShowCreate(false)} className="flex-1">
                <Text className="text-sm font-medium text-foreground">Cancel</Text>
              </Button>
              <Button onPress={handleCreate} disabled={creating} className="flex-1">
                <Text className="text-sm font-medium text-primary-foreground">
                  {creating ? 'Creating...' : 'Create'}
                </Text>
              </Button>
            </View>
          </CardContent>
        </Card>
      )}
    </View>
  )
}

function ExperimentVariantCard({
  label,
  model,
  runs,
  cost,
  costPerRun,
  successRate,
  latency,
}: {
  label: string
  model: string
  runs: number
  cost: number
  costPerRun: number
  successRate: number
  latency: number
}) {
  return (
    <View className="flex-1 rounded-lg border border-border bg-muted/30 p-2">
      <Text className="text-[9px] font-medium text-muted-foreground mb-1">{label}</Text>
      <View className={cn('px-1.5 py-0.5 rounded border self-start mb-1.5', getModelColor(model))}>
        <Text className={cn('text-[10px] font-medium', getModelTextColor(model))}>
          {getModelDisplayName(model)}
        </Text>
      </View>
      <View className="gap-0.5">
        <Text className="text-[10px] text-foreground">{runs} runs</Text>
        <Text className="text-[10px] text-foreground">{cost.toFixed(1)} cr total</Text>
        <Text className="text-[10px] text-foreground">{costPerRun.toFixed(2)} cr/run</Text>
        <Text className="text-[10px] text-foreground">{successRate.toFixed(1)}% success</Text>
        <Text className="text-[10px] text-foreground">{formatDuration(latency)} avg</Text>
      </View>
    </View>
  )
}

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
