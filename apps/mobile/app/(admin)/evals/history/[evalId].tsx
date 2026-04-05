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
  CheckCircle2,
  XCircle,
  Clock,
  FlaskConical,
  TrendingUp,
  BarChart3,
  Activity,
  Wrench,
  Zap,
  Hash,
} from 'lucide-react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

interface TokenInfo {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

interface PhaseScores {
  intention: { percentage: number }
  execution: { percentage: number }
}

interface HistoryEntry {
  runId: string
  track: string
  model: string
  timestamp: string
  passed: boolean
  score: number
  maxScore: number
  percentage: number
  durationMs: number
  toolCallCount: number
  failedToolCalls: number
  iterations: number
  tokens: TokenInfo | null
  phaseScores: PhaseScores | null
}

interface EvalHistoryData {
  evalId: string
  name: string
  category: string
  level: number | null
  maxScore: number
  history: HistoryEntry[]
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

function formatTimestampFull(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// ---------------------------------------------------------------------------
// Summary Stats
// ---------------------------------------------------------------------------

function SummaryStats({ history }: { history: HistoryEntry[] }) {
  const totalRuns = history.length
  const passCount = history.filter((h) => h.passed).length
  const passRate = totalRuns > 0 ? (passCount / totalRuns) * 100 : 0
  const avgScore = totalRuns > 0 ? history.reduce((s, h) => s + h.percentage, 0) / totalRuns : 0
  const bestScore = totalRuns > 0 ? Math.max(...history.map((h) => h.percentage)) : 0
  const worstScore = totalRuns > 0 ? Math.min(...history.map((h) => h.percentage)) : 0

  const stats = [
    { label: 'Total Runs', value: totalRuns.toString(), icon: Hash, accent: 'bg-blue-500/10', iconColor: 'text-blue-500' },
    { label: 'Pass Rate', value: `${passRate.toFixed(1)}%`, icon: CheckCircle2, accent: 'bg-emerald-500/10', iconColor: 'text-emerald-500' },
    { label: 'Avg Score', value: `${avgScore.toFixed(1)}%`, icon: TrendingUp, accent: 'bg-primary/10', iconColor: 'text-primary' },
    { label: 'Best', value: `${bestScore.toFixed(1)}%`, icon: Zap, accent: 'bg-amber-500/10', iconColor: 'text-amber-500' },
    { label: 'Worst', value: `${worstScore.toFixed(1)}%`, icon: Activity, accent: 'bg-red-500/10', iconColor: 'text-red-500' },
  ]

  return (
    <View className="flex-row flex-wrap gap-3 mb-6">
      {stats.map((s) => (
        <View key={s.label} className="flex-1 min-w-[100px] rounded-xl border border-border bg-card p-3">
          <View className="flex-row items-center justify-between mb-1.5">
            <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{s.label}</Text>
            <View className={cn('h-6 w-6 rounded-lg items-center justify-center', s.accent)}>
              <s.icon size={12} className={s.iconColor} />
            </View>
          </View>
          <Text className="text-xl font-bold text-foreground">{s.value}</Text>
        </View>
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Pass/Fail Timeline
// ---------------------------------------------------------------------------

function PassFailTimeline({ history }: { history: HistoryEntry[] }) {
  const router = useRouter()
  const sorted = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <Text className="text-sm font-semibold text-foreground mb-3">Pass / Fail Timeline</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row items-center gap-1.5">
          {sorted.map((entry) => (
            <Pressable
              key={entry.runId + entry.timestamp}
              onPress={() => router.push(`/(admin)/evals/${encodeURIComponent(entry.runId)}` as any)}
              className="active:opacity-70"
            >
              <View
                className={cn(
                  'h-7 w-7 rounded-full items-center justify-center',
                  entry.passed ? 'bg-emerald-500' : 'bg-red-500',
                )}
              >
                <Text className="text-[8px] font-bold text-white">
                  {entry.percentage.toFixed(0)}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View className="flex-row items-center justify-between mt-2">
        <Text className="text-[10px] text-muted-foreground">Oldest</Text>
        <Text className="text-[10px] text-muted-foreground">Most Recent</Text>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Score Trend Chart (Views-based)
// ---------------------------------------------------------------------------

const CHART_HEIGHT = 160
const DOT_SIZE = 8

function ScoreTrendChart({ history }: { history: HistoryEntry[] }) {
  const sorted = useMemo(
    () =>
      [...history]
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-30),
    [history],
  )

  const avgScore = useMemo(
    () => (sorted.length > 0 ? sorted.reduce((s, h) => s + h.percentage, 0) / sorted.length : 0),
    [sorted],
  )

  if (sorted.length < 2) return null

  const count = sorted.length
  const step = count > 1 ? 1 / (count - 1) : 0

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <View className="flex-row items-center gap-2 mb-3">
        <TrendingUp size={14} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground">Score Trend</Text>
      </View>

      <View className="flex-row mb-1">
        <View className="w-10 justify-between items-end pr-1" style={{ height: CHART_HEIGHT }}>
          <Text className="text-[9px] text-muted-foreground">100%</Text>
          <Text className="text-[9px] text-muted-foreground">50%</Text>
          <Text className="text-[9px] text-muted-foreground">0%</Text>
        </View>

        <View className="flex-1" style={{ height: CHART_HEIGHT }}>
          <View className="absolute left-0 right-0 top-0 h-px bg-border/40" />
          <View className="absolute left-0 right-0 h-px bg-border/40" style={{ top: CHART_HEIGHT / 2 }} />
          <View className="absolute left-0 right-0 h-px bg-border/40" style={{ top: CHART_HEIGHT }} />

          <View
            className="absolute left-0 right-0 h-px bg-primary/30"
            style={{ top: CHART_HEIGHT - (avgScore / 100) * CHART_HEIGHT }}
          />

          {sorted.map((entry, i) => {
            const x = step * i
            const y = 1 - entry.percentage / 100

            if (i < sorted.length - 1) {
              const nextEntry = sorted[i + 1]
              const nx = step * (i + 1)
              const ny = 1 - nextEntry.percentage / 100

              const dx = nx - x
              const dy = ny - y
              const len = Math.sqrt(dx * dx + dy * dy)
              const angle = Math.atan2(dy * CHART_HEIGHT, dx * 100)

              return (
                <View key={`line-${i}`}>
                  <View
                    className="absolute bg-muted-foreground/30"
                    style={{
                      left: `${x * 100}%`,
                      top: y * CHART_HEIGHT + DOT_SIZE / 2 - 0.5,
                      width: len * 100,
                      height: 1,
                      transformOrigin: 'left center',
                      transform: [{ rotate: `${angle}rad` }],
                    }}
                  />
                  <View
                    className={cn(
                      'absolute rounded-full',
                      entry.passed ? 'bg-emerald-500' : 'bg-red-500',
                    )}
                    style={{
                      width: DOT_SIZE,
                      height: DOT_SIZE,
                      left: `${x * 100}%`,
                      top: y * CHART_HEIGHT,
                      marginLeft: -DOT_SIZE / 2,
                    }}
                  />
                </View>
              )
            }

            return (
              <View
                key={`dot-${i}`}
                className={cn(
                  'absolute rounded-full',
                  entry.passed ? 'bg-emerald-500' : 'bg-red-500',
                )}
                style={{
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  left: `${x * 100}%`,
                  top: y * CHART_HEIGHT,
                  marginLeft: -DOT_SIZE / 2,
                }}
              />
            )
          })}
        </View>
      </View>

      <View className="flex-row items-center gap-4 mt-2">
        <View className="flex-row items-center gap-1">
          <View className="h-2 w-2 rounded-full bg-emerald-500" />
          <Text className="text-[10px] text-muted-foreground">Pass</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <View className="h-2 w-2 rounded-full bg-red-500" />
          <Text className="text-[10px] text-muted-foreground">Fail</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <View className="h-3 w-3 border-t border-primary/30" />
          <Text className="text-[10px] text-muted-foreground">Avg ({avgScore.toFixed(1)}%)</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Phase Score Trend
// ---------------------------------------------------------------------------

function PhaseScoreTrend({ history }: { history: HistoryEntry[] }) {
  const sorted = useMemo(
    () =>
      [...history]
        .filter((h) => h.phaseScores != null)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-30),
    [history],
  )

  if (sorted.length < 2) return null

  const count = sorted.length
  const step = count > 1 ? 1 / (count - 1) : 0

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <View className="flex-row items-center gap-2 mb-3">
        <BarChart3 size={14} className="text-purple-500" />
        <Text className="text-sm font-semibold text-foreground">Phase Scores</Text>
      </View>

      <View className="flex-row mb-1">
        <View className="w-10 justify-between items-end pr-1" style={{ height: CHART_HEIGHT }}>
          <Text className="text-[9px] text-muted-foreground">100%</Text>
          <Text className="text-[9px] text-muted-foreground">50%</Text>
          <Text className="text-[9px] text-muted-foreground">0%</Text>
        </View>

        <View className="flex-1" style={{ height: CHART_HEIGHT }}>
          <View className="absolute left-0 right-0 top-0 h-px bg-border/40" />
          <View className="absolute left-0 right-0 h-px bg-border/40" style={{ top: CHART_HEIGHT / 2 }} />
          <View className="absolute left-0 right-0 h-px bg-border/40" style={{ top: CHART_HEIGHT }} />

          {sorted.map((entry, i) => {
            const x = step * i
            const intentionY = 1 - (entry.phaseScores!.intention.percentage / 100)
            const executionY = 1 - (entry.phaseScores!.execution.percentage / 100)

            return (
              <View key={`phase-${i}`}>
                <View
                  className="absolute rounded-full bg-blue-500"
                  style={{
                    width: 6,
                    height: 6,
                    left: `${x * 100}%`,
                    top: intentionY * CHART_HEIGHT,
                    marginLeft: -3,
                  }}
                />
                <View
                  className="absolute rounded-full bg-orange-500"
                  style={{
                    width: 6,
                    height: 6,
                    left: `${x * 100}%`,
                    top: executionY * CHART_HEIGHT,
                    marginLeft: -3,
                  }}
                />
                {i < sorted.length - 1 && (
                  <>
                    <View
                      className="absolute bg-blue-500/30"
                      style={{
                        left: `${x * 100}%`,
                        top: intentionY * CHART_HEIGHT + 3,
                        width: `${step * 100}%`,
                        height: 1,
                      }}
                    />
                    <View
                      className="absolute bg-orange-500/30"
                      style={{
                        left: `${x * 100}%`,
                        top: executionY * CHART_HEIGHT + 3,
                        width: `${step * 100}%`,
                        height: 1,
                      }}
                    />
                  </>
                )}
              </View>
            )
          })}
        </View>
      </View>

      <View className="flex-row items-center gap-4 mt-2">
        <View className="flex-row items-center gap-1">
          <View className="h-2 w-2 rounded-full bg-blue-500" />
          <Text className="text-[10px] text-muted-foreground">Intention</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <View className="h-2 w-2 rounded-full bg-orange-500" />
          <Text className="text-[10px] text-muted-foreground">Execution</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Token Usage Trend (bar chart)
// ---------------------------------------------------------------------------

function TokenUsageTrend({ history }: { history: HistoryEntry[] }) {
  const sorted = useMemo(
    () =>
      [...history]
        .filter((h) => h.tokens != null)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-30),
    [history],
  )

  const maxTokens = useMemo(
    () => Math.max(...sorted.map((h) => h.tokens!.total), 1),
    [sorted],
  )

  if (sorted.length < 2) return null

  const BAR_HEIGHT = 120

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <View className="flex-row items-center gap-2 mb-3">
        <Activity size={14} className="text-cyan-500" />
        <Text className="text-sm font-semibold text-foreground">Token Usage</Text>
      </View>

      <View className="flex-row mb-1">
        <View className="w-10 justify-between items-end pr-1" style={{ height: BAR_HEIGHT }}>
          <Text className="text-[9px] text-muted-foreground">{fmtTokens(maxTokens)}</Text>
          <Text className="text-[9px] text-muted-foreground">{fmtTokens(Math.round(maxTokens / 2))}</Text>
          <Text className="text-[9px] text-muted-foreground">0</Text>
        </View>

        <View className="flex-1 flex-row items-end gap-px" style={{ height: BAR_HEIGHT }}>
          {sorted.map((entry, i) => {
            const pct = entry.tokens!.total / maxTokens
            return (
              <View
                key={`bar-${i}`}
                className="flex-1 rounded-t bg-cyan-500/70"
                style={{ height: Math.max(pct * BAR_HEIGHT, 2) }}
              />
            )
          })}
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// History Table
// ---------------------------------------------------------------------------

function HistoryTable({ history, evalId }: { history: HistoryEntry[]; evalId: string }) {
  const router = useRouter()
  const sorted = [...history].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  return (
    <View className="rounded-xl border border-border bg-card">
      <View className="flex-row items-center justify-between p-4 border-b border-border">
        <Text className="text-sm font-semibold text-foreground">
          All Runs ({sorted.length})
        </Text>
      </View>

      <View className="flex-row px-4 py-2 border-b border-border/50">
        <Text className="flex-[2] text-[10px] font-semibold text-muted-foreground uppercase">Time</Text>
        <Text className="flex-1 text-[10px] font-semibold text-muted-foreground uppercase">Model</Text>
        <Text className="w-8 text-[10px] font-semibold text-muted-foreground uppercase text-center">P/F</Text>
        <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Score</Text>
        <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Dur.</Text>
        <Text className="w-12 text-right text-[10px] font-semibold text-muted-foreground uppercase">Tools</Text>
        <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Tokens</Text>
      </View>

      {sorted.map((entry) => (
        <Pressable
          key={entry.runId + entry.timestamp}
          onPress={() => router.push(`/(admin)/evals/${encodeURIComponent(entry.runId)}` as any)}
          className="flex-row items-center px-4 py-2.5 border-b border-border/30 last:border-b-0 active:bg-muted/30"
        >
          <Text className="flex-[2] text-[11px] text-foreground" numberOfLines={1}>
            {formatTimestampFull(entry.timestamp)}
          </Text>
          <View className="flex-1">
            <View className="self-start px-1.5 py-0.5 rounded bg-muted">
              <Text className="text-[10px] font-medium text-muted-foreground">{entry.model}</Text>
            </View>
          </View>
          <View className="w-8 items-center">
            {entry.passed ? (
              <CheckCircle2 size={13} className="text-emerald-500" />
            ) : (
              <XCircle size={13} className="text-red-500" />
            )}
          </View>
          <Text
            className={cn(
              'w-16 text-right text-[11px] font-semibold',
              entry.passed ? 'text-emerald-600' : 'text-red-600',
            )}
          >
            {entry.percentage.toFixed(0)}%
          </Text>
          <Text className="w-16 text-right text-[11px] text-muted-foreground">
            {formatDuration(entry.durationMs)}
          </Text>
          <Text className="w-12 text-right text-[11px] text-muted-foreground">
            {entry.toolCallCount}
          </Text>
          <Text className="w-16 text-right text-[11px] text-muted-foreground">
            {entry.tokens ? fmtTokens(entry.tokens.total) : '—'}
          </Text>
        </Pressable>
      ))}

      {sorted.length === 0 && (
        <View className="py-8 items-center">
          <Text className="text-sm text-muted-foreground">No history entries</Text>
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function EvalHistoryPage() {
  const { evalId } = useLocalSearchParams<{ evalId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [data, setData] = useState<EvalHistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async () => {
    if (!evalId) return
    const result = await fetchJson<EvalHistoryData>(
      `/analytics/eval-history/${encodeURIComponent(evalId)}`,
    )
    if (result) setData(result)
    setLoading(false)
  }, [evalId])

  useEffect(() => {
    loadData()
  }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-sm text-muted-foreground mt-3">Loading eval history...</Text>
      </View>
    )
  }

  if (!data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <XCircle size={32} className="text-muted-foreground mb-3" />
        <Text className="text-sm font-medium text-muted-foreground">Eval not found</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-primary">Go back</Text>
        </Pressable>
      </View>
    )
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
      <Pressable
        onPress={() => router.push('/(admin)/evals' as any)}
        className="flex-row items-center gap-1.5 mb-4 active:opacity-70"
      >
        <ArrowLeft size={16} className="text-primary" />
        <Text className="text-sm text-primary">Back to Evals</Text>
      </Pressable>

      <View className="mb-6">
        <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
          {data.name}
        </Text>
        <View className="flex-row items-center gap-2 mt-2">
          <View className="px-2.5 py-1 rounded-full bg-muted">
            <Text className="text-xs font-medium text-muted-foreground">{data.category}</Text>
          </View>
          {data.level != null && (
            <View className="px-2.5 py-1 rounded-full bg-primary/10">
              <Text className="text-xs font-medium text-primary">Level {data.level}</Text>
            </View>
          )}
          <View className="flex-row items-center gap-1">
            <FlaskConical size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Max {data.maxScore} pts</Text>
          </View>
        </View>
      </View>

      <SummaryStats history={data.history} />

      <PassFailTimeline history={data.history} />

      <ScoreTrendChart history={data.history} />

      <PhaseScoreTrend history={data.history} />

      <TokenUsageTrend history={data.history} />

      <HistoryTable history={data.history} evalId={evalId!} />
    </ScrollView>
  )
}
