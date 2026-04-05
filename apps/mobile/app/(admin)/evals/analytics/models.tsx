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
  AlertTriangle,
  DollarSign,
  CheckCircle2,
  XCircle,
  Layers,
  FlaskConical,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

interface ModelSummary {
  total: number
  passed: number
  failed: number
  passRate: number
  avgScore: number
  totalPoints: number
  maxPoints: number
}

interface ModelCost {
  totalCost: number
  costPerEval: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
}

interface ModelResult {
  evalId: string
  name: string
  passed: boolean
  score: number
  maxScore: number
  percentage: number
}

interface ModelEntry {
  model: string
  runId: string
  track: string
  timestamp: string
  summary: ModelSummary
  cost: ModelCost
  byCategory: Record<string, any>
  results: ModelResult[]
}

interface ModelComparisonData {
  models: ModelEntry[]
  comparison: Array<Record<string, any>>
  availableTracks: string[]
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

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'px-3 py-1.5 rounded-md border',
        selected
          ? 'bg-primary/10 border-primary/30'
          : 'border-border active:bg-muted/50',
      )}
    >
      <Text className={cn('text-xs font-medium', selected ? 'text-primary' : 'text-foreground')}>
        {label}
      </Text>
    </Pressable>
  )
}

export default function ModelComparisonPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [data, setData] = useState<ModelComparisonData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedTrack, setSelectedTrack] = useState<string>('')

  const loadData = useCallback(async (track: string) => {
    setLoading(true)
    const query = track ? `?track=${encodeURIComponent(track)}` : ''
    const result = await fetchJson<ModelComparisonData>(`/analytics/model-comparison${query}`)
    if (result) {
      setData(result)
      if (!track && result.availableTracks.length > 0) {
        setSelectedTrack(result.availableTracks[0])
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadData(selectedTrack) }, [selectedTrack, loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData(selectedTrack)
    setRefreshing(false)
  }

  const allEvalIds = useMemo(() => {
    if (!data) return []
    const idSet = new Set<string>()
    for (const m of data.models) {
      for (const r of m.results) idSet.add(r.evalId)
    }
    return Array.from(idSet).sort()
  }, [data])

  const allCategories = useMemo(() => {
    if (!data) return [] as string[]
    const catSet = new Set<string>()
    for (const m of data.models) {
      for (const cat of Object.keys(m.byCategory)) catSet.add(cat)
    }
    return Array.from(catSet).sort()
  }, [data])

  const resultsByModel = useMemo(() => {
    if (!data) return new Map<string, Map<string, ModelResult>>()
    const map = new Map<string, Map<string, ModelResult>>()
    for (const m of data.models) {
      const evalMap = new Map<string, ModelResult>()
      for (const r of m.results) evalMap.set(r.evalId, r)
      map.set(m.model, evalMap)
    }
    return map
  }, [data])

  if (loading && !data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-sm text-muted-foreground mt-3">Loading model comparison...</Text>
      </View>
    )
  }

  if (!data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <AlertTriangle size={32} className="text-muted-foreground mb-3" />
        <Text className="text-sm font-medium text-muted-foreground">Failed to load comparison data</Text>
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
        onPress={() => router.push('/(admin)/evals/analytics' as any)}
        className="flex-row items-center gap-1.5 mb-4 active:opacity-70"
      >
        <ArrowLeft size={16} className="text-primary" />
        <Text className="text-sm text-primary">Analytics</Text>
      </Pressable>

      <View className="mb-6">
        <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
          Model Comparison
        </Text>
        <Text className="text-sm text-muted-foreground mt-0.5">
          Side-by-side performance across models
        </Text>
      </View>

      {data.availableTracks.length > 0 && (
        <View className="mb-6 gap-1">
          <Text className="text-xs font-medium text-muted-foreground">Track</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-1.5">
              {data.availableTracks.map((track) => (
                <Chip
                  key={track}
                  label={track}
                  selected={selectedTrack === track}
                  onPress={() => setSelectedTrack(track)}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {loading && (
        <View className="items-center py-8">
          <ActivityIndicator size="small" />
        </View>
      )}

      {!loading && data.models.length === 0 && (
        <View className="items-center justify-center py-20 rounded-xl border border-dashed border-border">
          <FlaskConical size={32} className="text-muted-foreground mb-3" />
          <Text className="text-sm font-medium text-muted-foreground">
            No models to compare for this track
          </Text>
        </View>
      )}

      {!loading && data.models.length > 0 && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-6">
            <View className="flex-row gap-3">
              {data.models.map((m) => {
                const passRate = m.summary.passRate
                const barColor = passRate >= 80 ? 'bg-emerald-500' : passRate >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                return (
                  <View
                    key={m.model}
                    className="w-56 rounded-xl border border-border bg-card p-4"
                  >
                    <View className="flex-row items-center gap-2 mb-3">
                      <View className="px-2 py-0.5 rounded-md bg-muted">
                        <Text className="text-xs font-semibold text-foreground">{m.model}</Text>
                      </View>
                    </View>

                    <View className="gap-2 mb-3">
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[10px] font-medium text-muted-foreground uppercase">
                          Pass Rate
                        </Text>
                        <Text className="text-sm font-bold text-foreground">
                          {passRate.toFixed(1)}%
                        </Text>
                      </View>
                      <View className="h-2 bg-muted rounded-full overflow-hidden">
                        <View
                          className={cn('h-full rounded-full', barColor)}
                          style={{ width: `${Math.min(passRate, 100)}%` }}
                        />
                      </View>
                    </View>

                    <View className="gap-1.5">
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[10px] text-muted-foreground">Avg Score</Text>
                        <Text className="text-xs font-semibold text-foreground">
                          {m.summary.avgScore.toFixed(1)}
                        </Text>
                      </View>
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[10px] text-muted-foreground">Passed</Text>
                        <Text className="text-xs font-semibold text-emerald-600">
                          {m.summary.passed}/{m.summary.total}
                        </Text>
                      </View>
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[10px] text-muted-foreground">Total Cost</Text>
                        <Text className="text-xs font-semibold text-foreground">
                          ${m.cost.totalCost.toFixed(4)}
                        </Text>
                      </View>
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[10px] text-muted-foreground">Cost / Eval</Text>
                        <Text className="text-xs font-semibold text-foreground">
                          ${m.cost.costPerEval.toFixed(4)}
                        </Text>
                      </View>
                    </View>
                  </View>
                )
              })}
            </View>
          </ScrollView>

          {allEvalIds.length > 0 && (
            <View className="rounded-xl border border-border bg-card mb-6">
              <View className="flex-row items-center gap-2 p-4 border-b border-border">
                <FlaskConical size={14} className="text-primary" />
                <Text className="text-sm font-semibold text-foreground">
                  Per-Eval Comparison
                </Text>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                  <View className="flex-row border-b border-border/50 px-3 py-2">
                    <Text className="w-40 text-[10px] font-semibold text-muted-foreground uppercase">
                      Eval
                    </Text>
                    {data.models.map((m) => (
                      <Text
                        key={m.model}
                        className="w-24 text-center text-[10px] font-semibold text-muted-foreground uppercase"
                      >
                        {m.model}
                      </Text>
                    ))}
                  </View>

                  {allEvalIds.map((evalId) => {
                    const results = data.models.map((m) => resultsByModel.get(m.model)?.get(evalId) ?? null)
                    const hasDivergence = results.some((r) => r?.passed === true) && results.some((r) => r?.passed === false)

                    return (
                      <View key={evalId} className="flex-row items-center px-3 py-2 border-b border-border/30">
                        <Text className="w-40 text-xs font-medium text-foreground" numberOfLines={1}>
                          {results.find((r) => r)?.name ?? evalId}
                        </Text>
                        {results.map((r, i) => {
                          if (!r) {
                            return (
                              <View key={data.models[i].model} className="w-24 items-center">
                                <Text className="text-[10px] text-muted-foreground">—</Text>
                              </View>
                            )
                          }
                          const highlight = hasDivergence
                          return (
                            <View
                              key={data.models[i].model}
                              className={cn(
                                'w-24 items-center py-1 rounded-md mx-0.5',
                                highlight
                                  ? r.passed ? 'bg-emerald-500/15' : 'bg-red-500/15'
                                  : r.passed ? 'bg-emerald-500/5' : 'bg-red-500/5',
                              )}
                            >
                              <Text
                                className={cn(
                                  'text-xs font-semibold',
                                  r.passed ? 'text-emerald-600' : 'text-red-600',
                                )}
                              >
                                {r.score}/{r.maxScore}
                              </Text>
                            </View>
                          )
                        })}
                      </View>
                    )
                  })}
                </View>
              </ScrollView>

              {allEvalIds.length === 0 && (
                <View className="py-8 items-center">
                  <Text className="text-sm text-muted-foreground">No eval results to compare</Text>
                </View>
              )}
            </View>
          )}

          {allCategories.length > 0 && (
            <View className="rounded-xl border border-border bg-card">
              <View className="flex-row items-center gap-2 p-4 border-b border-border">
                <Layers size={14} className="text-primary" />
                <Text className="text-sm font-semibold text-foreground">
                  Category Breakdown
                </Text>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                  <View className="flex-row border-b border-border/50 px-3 py-2">
                    <Text className="w-40 text-[10px] font-semibold text-muted-foreground uppercase">
                      Category
                    </Text>
                    {data.models.map((m) => (
                      <Text
                        key={m.model}
                        className="w-24 text-center text-[10px] font-semibold text-muted-foreground uppercase"
                      >
                        {m.model}
                      </Text>
                    ))}
                  </View>

                  {allCategories.map((cat) => (
                    <View key={cat} className="flex-row items-center px-3 py-2 border-b border-border/30">
                      <Text className="w-40 text-xs font-medium text-foreground" numberOfLines={1}>
                        {cat}
                      </Text>
                      {data.models.map((m) => {
                        const catData = m.byCategory[cat]
                        if (!catData) {
                          return (
                            <View key={m.model} className="w-24 items-center">
                              <Text className="text-[10px] text-muted-foreground">—</Text>
                            </View>
                          )
                        }
                        const rate = catData.total > 0
                          ? ((catData.passed ?? 0) / catData.total) * 100
                          : 0
                        return (
                          <View key={m.model} className="w-24 items-center">
                            <Text
                              className={cn(
                                'text-xs font-semibold',
                                rate >= 80 ? 'text-emerald-600' : rate >= 60 ? 'text-yellow-600' : 'text-red-600',
                              )}
                            >
                              {rate.toFixed(0)}%
                            </Text>
                            <Text className="text-[10px] text-muted-foreground">
                              {catData.passed ?? 0}/{catData.total}
                            </Text>
                          </View>
                        )
                      })}
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}
