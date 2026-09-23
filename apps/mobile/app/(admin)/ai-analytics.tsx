// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin AI / Engineering Analytics - model spend, quality, and usage.
 *
 * The engineering-facing half of the split analytics surface (see
 * analytics.tsx for the Marketing half). Focuses on consumption/spend,
 * quality & efficiency, tool calls, workspace activity, raw usage logs, and
 * chat metrics.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BrainCircuit, Gauge, Sparkles } from 'lucide-react-native'
import {
  type AnalyticsPeriod,
  type UsageSummaryData,
  type UsageLogData,
  type ChatAnalyticsData,
  type UsageBreakdownData,
  type SpendTimeseriesData,
  type SpendGroupBy,
  type SpendMetric,
  type QualityTimeseriesPoint,
  type ToolCallAnalyticsData,
  type WorkspaceActivityData,
  UsageTableSection,
  ChatAnalyticsSection,
  UsageBreakdownSection,
  UsageTimeseriesChart,
  QualityTimeseriesChart,
  ToolCallAnalyticsPanel,
  WorkspaceActivityTable,
} from '../../components/analytics/SharedAnalytics'
import { fetchAdminJson, AnalyticsHeader } from './_analytics-shared'

// =============================================================================
// Main Page
// =============================================================================

export default function AdminAIAnalyticsPage() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const isWide = width >= 900
  const pagePadding = isWide ? 32 : 16

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [logPage, setLogPage] = useState(1)
  const [summaryPage, setSummaryPage] = useState(1)
  const [workspacePage, setWorkspacePage] = useState(1)
  const [toolPage, setToolPage] = useState(1)
  const [spendGroupBy, setSpendGroupBy] = useState<SpendGroupBy>('model')
  const [spendMetric, setSpendMetric] = useState<SpendMetric>('spend')
  const [refreshing, setRefreshing] = useState(false)
  const [excludeInternal, setExcludeInternal] = useState(true)

  const [spendTs, setSpendTs] = useState<{ data: SpendTimeseriesData | null; loading: boolean }>({ data: null, loading: true })
  const [qualityTs, setQualityTs] = useState<{ data: QualityTimeseriesPoint[] | null; loading: boolean }>({ data: null, loading: true })
  const [toolCalls, setToolCalls] = useState<{ data: ToolCallAnalyticsData | null; loading: boolean }>({ data: null, loading: true })
  const [workspaceActivity, setWorkspaceActivity] = useState<{ data: WorkspaceActivityData | null; loading: boolean }>({ data: null, loading: true })
  const [usage, setUsage] = useState<{ data: UsageBreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [usageSummary, setUsageSummary] = useState<{ data: UsageSummaryData | null; loading: boolean }>({ data: null, loading: true })
  const [usageLog, setUsageLog] = useState<{ data: UsageLogData | null; loading: boolean }>({ data: null, loading: true })
  const [chatStats, setChatStats] = useState<{ data: ChatAnalyticsData | null; loading: boolean }>({ data: null, loading: true })

  const internalParam = excludeInternal ? 'true' : 'false'

  const loadAll = useCallback(async () => {
    const pParams = { period, excludeInternal: internalParam }

    setSpendTs((s) => ({ ...s, loading: true }))
    setQualityTs((s) => ({ ...s, loading: true }))
    setToolCalls((s) => ({ ...s, loading: true }))
    setWorkspaceActivity((s) => ({ ...s, loading: true }))
    setUsage((s) => ({ ...s, loading: true }))
    setUsageSummary((s) => ({ ...s, loading: true }))
    setUsageLog((s) => ({ ...s, loading: true }))
    setChatStats((s) => ({ ...s, loading: true }))

    const [sp, qual, tc, wsAct, us, uSum, uLog, ch] = await Promise.all([
      fetchAdminJson<SpendTimeseriesData>('/analytics/spend-timeseries', { ...pParams, groupBy: spendGroupBy, metric: spendMetric }),
      fetchAdminJson<QualityTimeseriesPoint[]>('/analytics/quality-timeseries', pParams),
      fetchAdminJson<ToolCallAnalyticsData>('/analytics/tool-calls', { ...pParams, page: String(toolPage), limit: '10' }),
      fetchAdminJson<WorkspaceActivityData>('/analytics/workspace-activity', { ...pParams, page: String(workspacePage), limit: '20' }),
      fetchAdminJson<UsageBreakdownData>('/analytics/usage', pParams),
      fetchAdminJson<UsageSummaryData>('/analytics/usage-summary', { ...pParams, page: String(summaryPage), limit: '25' }),
      fetchAdminJson<UsageLogData>('/analytics/usage-log', { ...pParams, page: String(logPage), limit: '50' }),
      fetchAdminJson<ChatAnalyticsData>('/analytics/chat', pParams),
    ])

    setSpendTs({ data: sp, loading: false })
    setQualityTs({ data: qual, loading: false })
    setToolCalls({ data: tc, loading: false })
    setWorkspaceActivity({ data: wsAct, loading: false })
    setUsage({ data: us, loading: false })
    setUsageSummary({ data: uSum, loading: false })
    setUsageLog({ data: uLog, loading: false })
    setChatStats({ data: ch, loading: false })
  }, [period, logPage, summaryPage, workspacePage, toolPage, spendGroupBy, spendMetric, internalParam])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadAll()
    setRefreshing(false)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, 12) + 12,
        paddingHorizontal: pagePadding,
        paddingBottom: Math.max(insets.bottom, 16) + 32,
        width: '100%',
        alignSelf: 'center' as const,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="w-full max-w-[1320px] self-center">
        <View className="rounded-2xl border border-border bg-card px-4 py-4 mb-5 overflow-hidden">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="h-7 w-7 rounded-lg bg-primary/10 items-center justify-center">
              <BrainCircuit size={15} className="text-primary" />
            </View>
            <Text className="text-[11px] font-semibold tracking-[1.2px] text-primary uppercase">
              AI operations
            </Text>
            <View className="ml-auto flex-row items-center gap-1 rounded-full bg-muted px-2 py-1">
              <Sparkles size={11} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">Usage intelligence</Text>
            </View>
          </View>
          <AnalyticsHeader
            title="AI Analytics"
            subtitle="Model spend, quality, and usage signals for confident operations"
            isWide={isWide}
            period={period}
            onPeriodChange={setPeriod}
            excludeInternal={excludeInternal}
            onExcludeInternalChange={setExcludeInternal}
          />
        </View>

        {/* Consumption by model / workspace */}
        <View className="mb-5">
          <SectionLabel title="Spend trajectory" detail="Consumption by model, workspace, user, or source" />
          <UsageTimeseriesChart
            data={spendTs.data}
            loading={spendTs.loading}
            groupBy={spendGroupBy}
            metric={spendMetric}
            onGroupByChange={setSpendGroupBy}
            onMetricChange={setSpendMetric}
            title="Consumption Over Time"
            subtitle="Daily usage by model, workspace, user, or source"
          />
        </View>

        {/* Quality & efficiency trend */}
        <View className="mb-5">
          <SectionLabel title="Quality watch" detail="Efficiency and quality trends" />
          <QualityTimeseriesChart data={qualityTs.data} loading={qualityTs.loading} />
        </View>

        {/* Workspace Activity Table */}
        <View className="mb-5">
          <SectionLabel title="Workspace activity" detail="Where AI work is happening" />
          <WorkspaceActivityTable
            data={workspaceActivity.data}
            loading={workspaceActivity.loading}
            page={workspacePage}
            onPageChange={setWorkspacePage}
          />
        </View>

        {/* Tool call analytics */}
        <View className="mb-5">
          <SectionLabel title="Tools" detail="Invocation volume and reliability" />
          <ToolCallAnalyticsPanel
            data={toolCalls.data}
            loading={toolCalls.loading}
            page={toolPage}
            onPageChange={setToolPage}
          />
        </View>

        {/* Usage table (summary + event log) */}
        <View className="mb-5">
          <SectionLabel title="Usage ledger" detail="Aggregate and raw model events" />
          <UsageTableSection
            summaryData={usageSummary.data}
            logData={usageLog.data}
            summaryLoading={usageSummary.loading}
            logLoading={usageLog.loading}
            onLogPageChange={setLogPage}
            logPage={logPage}
            onSummaryPageChange={setSummaryPage}
            summaryPage={summaryPage}
          />
        </View>

        {/* Chat analytics */}
        <View className="mb-5">
          <SectionLabel title="Conversation health" detail="Chat usage and outcomes" />
          <ChatAnalyticsSection data={chatStats.data} loading={chatStats.loading} />
        </View>

        {/* Usage breakdown */}
        <View>
          <SectionLabel title="Distribution" detail="Usage across the stack" />
          <UsageBreakdownSection data={usage.data} loading={usage.loading} />
        </View>
      </View>
    </ScrollView>
  )
}

function SectionLabel({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="flex-row items-baseline justify-between mb-2 px-1">
      <View className="flex-row items-center gap-1.5">
        <Gauge size={13} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground">{detail}</Text>
    </View>
  )
}
