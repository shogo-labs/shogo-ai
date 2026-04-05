// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native'
import {
  ArrowLeft,
  BarChart3,
  TrendingUp,
  Grid3X3,
  Zap,
  GitBranch,
  Wrench,
  Cpu,
  ChevronDown,
  ChevronUp,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

interface DifficultyBucket {
  level: number
  total: number
  passed: number
  passRate: number
}

interface HeatmapRow {
  category: string
  levels: Array<{ level: number; total: number; passed: number; passRate: number }>
}

interface IntentionVsExecution {
  evalId: string
  name: string
  category: string
  intention: number
  execution: number
  gap: number
  runCount: number
}

interface PipelinePhase {
  phase: number
  total: number
  passed: number
  passRate: number
}

interface PipelineRow {
  pipeline: string
  phases: PipelinePhase[]
}

interface AnalyticsOverview {
  totalResults: number
  difficultyCurve: DifficultyBucket[]
  heatmap: HeatmapRow[]
  intentionVsExecution: IntentionVsExecution[]
  pipelineAnalysis: PipelineRow[]
}

async function fetchOverview(): Promise<AnalyticsOverview | null> {
  try {
    const res = await fetch(`${API_BASE}/analytics/overview`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

function rateColor(rate: number): string {
  if (rate >= 80) return 'bg-emerald-500'
  if (rate >= 60) return 'bg-yellow-500'
  return 'bg-red-500'
}

function rateBgCell(rate: number, hasData: boolean): string {
  if (!hasData) return 'bg-muted/40'
  if (rate >= 80) return 'bg-emerald-500/20'
  if (rate >= 60) return 'bg-yellow-500/20'
  return 'bg-red-500/20'
}

function rateTextColor(rate: number): string {
  if (rate >= 80) return 'text-emerald-600'
  if (rate >= 60) return 'text-yellow-600'
  return 'text-red-600'
}

function gapColor(gap: number): string {
  if (gap >= 40) return 'text-red-600'
  if (gap >= 20) return 'text-orange-500'
  return 'text-yellow-600'
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string
  subtitle?: string
  icon: React.ComponentType<{ size: number; className: string }>
  children: React.ReactNode
}) {
  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-4">
      <View className="flex-row items-center gap-2 mb-1">
        <Icon size={16} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
      </View>
      {subtitle && (
        <Text className="text-xs text-muted-foreground mb-3">{subtitle}</Text>
      )}
      {!subtitle && <View className="h-2" />}
      {children}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Difficulty Curve (bar chart)
// ---------------------------------------------------------------------------

function DifficultyCurveChart({ data }: { data: DifficultyBucket[] }) {
  const maxHeight = 140

  return (
    <View className="flex-row items-end justify-around" style={{ height: maxHeight + 40 }}>
      {data.map((b) => {
        const barH = Math.max((b.passRate / 100) * maxHeight, 4)
        return (
          <View key={b.level} className="items-center flex-1">
            <Text className={cn('text-xs font-bold mb-1', rateTextColor(b.passRate))}>
              {b.passRate.toFixed(0)}%
            </Text>
            <View
              className={cn('w-8 rounded-t-md', rateColor(b.passRate))}
              style={{ height: barH }}
            />
            <Text className="text-xs font-medium text-foreground mt-1.5">Lvl {b.level}</Text>
            <Text className="text-[10px] text-muted-foreground">({b.total} evals)</Text>
          </View>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

function CategoryHeatmap({ data }: { data: HeatmapRow[] }) {
  const allLevels = useMemo(() => {
    const set = new Set<number>()
    data.forEach((r) => r.levels.forEach((l) => set.add(l.level)))
    return Array.from(set).sort((a, b) => a - b)
  }, [data])

  if (allLevels.length === 0) {
    return <Text className="text-xs text-muted-foreground">No data available</Text>
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View className="flex-row mb-1">
          <View style={{ width: 110 }} />
          {allLevels.map((lvl) => (
            <View key={lvl} className="items-center" style={{ width: 64 }}>
              <Text className="text-[10px] font-semibold text-muted-foreground">Lvl {lvl}</Text>
            </View>
          ))}
        </View>

        {data.map((row) => (
          <View key={row.category} className="flex-row items-center mb-1">
            <View style={{ width: 110 }} className="pr-2">
              <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>
                {row.category}
              </Text>
            </View>
            {allLevels.map((lvl) => {
              const cell = row.levels.find((l) => l.level === lvl)
              const hasData = !!cell && cell.total > 0
              const rate = cell?.passRate ?? 0
              return (
                <View
                  key={lvl}
                  className={cn(
                    'items-center justify-center rounded-md mx-0.5',
                    rateBgCell(rate, hasData),
                  )}
                  style={{ width: 58, height: 32 }}
                >
                  {hasData ? (
                    <Text className={cn('text-[10px] font-semibold', rateTextColor(rate))}>
                      {cell!.passed}/{cell!.total}
                    </Text>
                  ) : (
                    <Text className="text-[10px] text-muted-foreground">—</Text>
                  )}
                </View>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

// ---------------------------------------------------------------------------
// Intention vs Execution table
// ---------------------------------------------------------------------------

function IntentionVsExecutionTable({ data }: { data: IntentionVsExecution[] }) {
  const [showAll, setShowAll] = useState(false)
  const router = useRouter()

  const visible = showAll ? data : data.slice(0, 20)

  return (
    <View>
      <View className="flex-row items-center py-2 border-b border-border/50 mb-1">
        <View style={{ flex: 2.5 }}>
          <Text className="text-[10px] font-semibold text-muted-foreground">EVAL</Text>
        </View>
        <View style={{ flex: 1.2 }}>
          <Text className="text-[10px] font-semibold text-muted-foreground">CATEGORY</Text>
        </View>
        <View style={{ flex: 0.8 }} className="items-end">
          <Text className="text-[10px] font-semibold text-muted-foreground">INTENT</Text>
        </View>
        <View style={{ flex: 0.8 }} className="items-end">
          <Text className="text-[10px] font-semibold text-muted-foreground">EXEC</Text>
        </View>
        <View style={{ flex: 0.7 }} className="items-end">
          <Text className="text-[10px] font-semibold text-muted-foreground">GAP</Text>
        </View>
        <View style={{ flex: 0.5 }} className="items-end">
          <Text className="text-[10px] font-semibold text-muted-foreground">RUNS</Text>
        </View>
      </View>

      {visible.map((item) => (
        <Pressable
          key={item.evalId}
          onPress={() => router.push(`/(admin)/evals/history/${item.evalId}` as any)}
          className="flex-row items-center py-2 border-b border-border/30 active:bg-muted/30"
        >
          <View style={{ flex: 2.5 }}>
            <Text className="text-[11px] font-medium text-primary" numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          <View style={{ flex: 1.2 }}>
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {item.category}
            </Text>
          </View>
          <View style={{ flex: 0.8 }} className="items-end">
            <Text className="text-[11px] text-foreground">{item.intention.toFixed(0)}%</Text>
          </View>
          <View style={{ flex: 0.8 }} className="items-end">
            <Text className="text-[11px] text-foreground">{item.execution.toFixed(0)}%</Text>
          </View>
          <View style={{ flex: 0.7 }} className="items-end">
            <Text className={cn('text-[11px] font-bold', gapColor(item.gap))}>
              {item.gap.toFixed(0)}%
            </Text>
          </View>
          <View style={{ flex: 0.5 }} className="items-end">
            <Text className="text-[10px] text-muted-foreground">{item.runCount}</Text>
          </View>
        </Pressable>
      ))}

      {data.length > 20 && (
        <Pressable
          onPress={() => setShowAll(!showAll)}
          className="flex-row items-center justify-center gap-1 pt-3"
        >
          {showAll ? (
            <ChevronUp size={14} className="text-primary" />
          ) : (
            <ChevronDown size={14} className="text-primary" />
          )}
          <Text className="text-xs font-medium text-primary">
            {showAll ? 'Show Less' : `Show All (${data.length})`}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Failure Analysis
// ---------------------------------------------------------------------------

function PipelineBars({ data }: { data: PipelineRow[] }) {
  if (data.length === 0) {
    return <Text className="text-xs text-muted-foreground">No pipeline data available</Text>
  }

  return (
    <View className="gap-4">
      {data.map((row) => (
        <View key={row.pipeline}>
          <Text className="text-xs font-medium text-foreground mb-1.5">{row.pipeline}</Text>
          <View className="flex-row h-8 rounded-lg overflow-hidden">
            {row.phases.map((p) => (
              <View
                key={p.phase}
                className={cn('items-center justify-center', rateColor(p.passRate))}
                style={{ flex: 1 }}
              >
                <Text className="text-[10px] font-bold text-white">P{p.phase}</Text>
              </View>
            ))}
          </View>
          <View className="flex-row flex-wrap gap-x-3 gap-y-0.5 mt-1">
            {row.phases.map((p) => (
              <Text key={p.phase} className="text-[10px] text-muted-foreground">
                Phase {p.phase}: {p.passRate.toFixed(0)}% ({p.passed}/{p.total})
              </Text>
            ))}
          </View>
        </View>
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function EvalAnalyticsPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [data, setData] = useState<AnalyticsOverview | null>(null)

  const load = useCallback(async () => {
    const overview = await fetchOverview()
    setData(overview)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-1">
        <Pressable
          onPress={() => router.push('/(admin)/evals' as any)}
          className="h-8 w-8 rounded-lg border border-border items-center justify-center active:bg-muted/50"
        >
          <ArrowLeft size={16} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            Eval Analytics
          </Text>
        </View>
        <BarChart3 size={20} className="text-primary" />
      </View>
      <Text className="text-sm text-muted-foreground mb-6 ml-11">
        {data ? `${data.totalResults.toLocaleString()} total eval results` : 'Loading...'}
      </Text>

      {loading ? (
        <View className="items-center justify-center py-20">
          <ActivityIndicator size="large" />
          <Text className="text-sm text-muted-foreground mt-3">Loading analytics...</Text>
        </View>
      ) : !data ? (
        <View className="items-center justify-center py-20 rounded-xl border border-dashed border-border">
          <BarChart3 size={32} className="text-muted-foreground mb-3" />
          <Text className="text-sm font-medium text-muted-foreground">No analytics data</Text>
          <Text className="text-xs text-muted-foreground mt-1">
            Run some evals first to see analytics
          </Text>
        </View>
      ) : (
        <>
          {/* Navigation links */}
          <View className="flex-row gap-3 mb-4">
            <Pressable
              onPress={() => router.push('/(admin)/evals/analytics/tools' as any)}
              className="flex-1 rounded-xl border border-border bg-card p-4 active:bg-muted/30"
            >
              <View className="flex-row items-center gap-2 mb-1">
                <Wrench size={16} className="text-primary" />
                <Text className="text-sm font-semibold text-foreground">Tool Analysis</Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                Tool usage patterns and success rates
              </Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/(admin)/evals/analytics/models' as any)}
              className="flex-1 rounded-xl border border-border bg-card p-4 active:bg-muted/30"
            >
              <View className="flex-row items-center gap-2 mb-1">
                <Cpu size={16} className="text-primary" />
                <Text className="text-sm font-semibold text-foreground">Model Comparison</Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                Compare performance across models
              </Text>
            </Pressable>
          </View>

          {/* Difficulty curve */}
          <Section title="Pass Rate by Difficulty Level" icon={TrendingUp}>
            {data.difficultyCurve.length > 0 ? (
              <DifficultyCurveChart data={data.difficultyCurve} />
            ) : (
              <Text className="text-xs text-muted-foreground">No difficulty data</Text>
            )}
          </Section>

          {/* Category x difficulty heatmap */}
          <Section title="Category x Difficulty Heatmap" icon={Grid3X3}>
            <CategoryHeatmap data={data.heatmap} />
          </Section>

          {/* Intention vs execution */}
          <Section
            title="Intention vs Execution Gap"
            subtitle="Evals where the agent understands the task but fails to execute — sorted by largest gap"
            icon={Zap}
          >
            {data.intentionVsExecution.length > 0 ? (
              <IntentionVsExecutionTable data={data.intentionVsExecution} />
            ) : (
              <Text className="text-xs text-muted-foreground">No gap data available</Text>
            )}
          </Section>

          {/* Pipeline failure analysis */}
          <Section title="Pipeline Phase Pass Rates" icon={GitBranch}>
            <PipelineBars data={data.pipelineAnalysis} />
          </Section>
        </>
      )}
    </ScrollView>
  )
}
