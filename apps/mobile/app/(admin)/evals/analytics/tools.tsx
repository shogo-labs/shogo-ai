// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
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
  Wrench,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  XCircle,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

interface ToolEntry {
  name: string
  calls: number
  errors: number
  passingEvals: number
  failingEvals: number
  errorRate: number
}

interface ToolUsageData {
  tools: ToolEntry[]
  avgToolCallsPassing: number
  avgToolCallsFailing: number
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

export default function ToolUsageAnalytics() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [data, setData] = useState<ToolUsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async () => {
    const result = await fetchJson<ToolUsageData>('/analytics/tool-usage')
    if (result) setData(result)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-sm text-muted-foreground mt-3">Loading tool usage data...</Text>
      </View>
    )
  }

  if (!data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <AlertTriangle size={32} className="text-muted-foreground mb-3" />
        <Text className="text-sm font-medium text-muted-foreground">Failed to load tool data</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-primary">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const sortedTools = [...data.tools].sort((a, b) => b.calls - a.calls)
  const toolsWithErrors = sortedTools.filter((t) => t.errors > 0)
  const maxErrorRate = Math.max(...toolsWithErrors.map((t) => t.errorRate), 1)

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        maxWidth: 1200,
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
          Tool Usage Analysis
        </Text>
        <Text className="text-sm text-muted-foreground mt-0.5">
          Frequency, errors, and pass/fail correlations across tools
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-3 mb-6">
        <View className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Unique Tools
            </Text>
            <View className="h-7 w-7 rounded-lg items-center justify-center bg-primary/10">
              <Wrench size={14} className="text-primary" />
            </View>
          </View>
          <Text className="text-2xl font-bold text-foreground">{data.tools.length}</Text>
        </View>

        <View className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Avg Calls (Pass)
            </Text>
            <View className="h-7 w-7 rounded-lg items-center justify-center bg-emerald-500/10">
              <CheckCircle2 size={14} className="text-emerald-500" />
            </View>
          </View>
          <Text className="text-2xl font-bold text-foreground">
            {data.avgToolCallsPassing.toFixed(1)}
          </Text>
          <Text className="text-[10px] text-muted-foreground mt-0.5">per passing eval</Text>
        </View>

        <View className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-4">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Avg Calls (Fail)
            </Text>
            <View className="h-7 w-7 rounded-lg items-center justify-center bg-red-500/10">
              <XCircle size={14} className="text-red-500" />
            </View>
          </View>
          <Text className="text-2xl font-bold text-foreground">
            {data.avgToolCallsFailing.toFixed(1)}
          </Text>
          <Text className="text-[10px] text-muted-foreground mt-0.5">per failing eval</Text>
        </View>
      </View>

      <View className="rounded-xl border border-border bg-card mb-6">
        <View className="flex-row items-center gap-2 p-4 border-b border-border">
          <BarChart3 size={14} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">
            Tool Frequency ({sortedTools.length})
          </Text>
        </View>

        <View className="px-4 py-2 flex-row border-b border-border/50">
          <Text className="flex-1 text-[10px] font-semibold text-muted-foreground uppercase">Tool Name</Text>
          <Text className="w-14 text-right text-[10px] font-semibold text-muted-foreground uppercase">Calls</Text>
          <Text className="w-14 text-right text-[10px] font-semibold text-muted-foreground uppercase">Errors</Text>
          <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Err %</Text>
          <Text className="w-20 text-right text-[10px] font-semibold text-muted-foreground uppercase">Pass/Fail</Text>
        </View>

        {sortedTools.map((tool) => (
          <View
            key={tool.name}
            className="flex-row items-center px-4 py-2.5 border-b border-border/30 last:border-b-0"
          >
            <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
              {tool.name}
            </Text>
            <Text className="w-14 text-right text-xs text-foreground">
              {tool.calls.toLocaleString()}
            </Text>
            <Text className="w-14 text-right text-xs text-foreground">
              {tool.errors.toLocaleString()}
            </Text>
            <Text
              className={cn(
                'w-16 text-right text-xs font-medium',
                tool.errorRate > 10 ? 'text-red-600' : 'text-foreground',
              )}
            >
              {tool.errorRate.toFixed(1)}%
            </Text>
            <Text className="w-20 text-right text-xs text-muted-foreground">
              {tool.passingEvals}/{tool.failingEvals}
            </Text>
          </View>
        ))}

        {sortedTools.length === 0 && (
          <View className="py-8 items-center">
            <Text className="text-sm text-muted-foreground">No tool usage data</Text>
          </View>
        )}
      </View>

      {toolsWithErrors.length > 0 && (
        <View className="rounded-xl border border-border bg-card p-4">
          <View className="flex-row items-center gap-2 mb-4">
            <AlertTriangle size={14} className="text-amber-500" />
            <Text className="text-sm font-semibold text-foreground">
              Tool Error Rates
            </Text>
          </View>

          <View className="gap-3">
            {toolsWithErrors
              .sort((a, b) => b.errorRate - a.errorRate)
              .map((tool) => {
                const barWidth = (tool.errorRate / maxErrorRate) * 100
                return (
                  <View key={tool.name} className="gap-1">
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                        {tool.name}
                      </Text>
                      <Text
                        className={cn(
                          'text-xs font-semibold',
                          tool.errorRate > 10 ? 'text-red-600' : 'text-foreground',
                        )}
                      >
                        {tool.errorRate.toFixed(1)}%
                      </Text>
                    </View>
                    <View className="h-3 bg-muted rounded-full overflow-hidden">
                      <View
                        className={cn(
                          'h-full rounded-full',
                          tool.errorRate > 10 ? 'bg-red-500' : 'bg-amber-500',
                        )}
                        style={{ width: `${Math.min(barWidth, 100)}%` }}
                      />
                    </View>
                    <Text className="text-[10px] text-muted-foreground">
                      {tool.errors} errors / {tool.calls} calls
                    </Text>
                  </View>
                )
              })}
          </View>
        </View>
      )}
    </ScrollView>
  )
}
