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
  ScrollView,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
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
  const isWide = width >= 900

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [logPage, setLogPage] = useState(1)
  const [summaryPage, setSummaryPage] = useState(1)
  const [workspacePage, setWorkspacePage] = useState(1)
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
      fetchAdminJson<ToolCallAnalyticsData>('/analytics/tool-calls', pParams),
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
  }, [period, logPage, summaryPage, workspacePage, spendGroupBy, spendMetric, internalParam])

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
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        width: '100%',
        alignSelf: 'center' as const,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <AnalyticsHeader
        title="AI Analytics"
        subtitle="Model spend, quality, and usage metrics"
        isWide={isWide}
        period={period}
        onPeriodChange={setPeriod}
        excludeInternal={excludeInternal}
        onExcludeInternalChange={setExcludeInternal}
      />

      {/* Consumption by model / workspace */}
      <View className="mb-4">
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
      <View className="mb-4">
        <QualityTimeseriesChart data={qualityTs.data} loading={qualityTs.loading} />
      </View>

      {/* Workspace Activity Table */}
      <View className="mb-4">
        <WorkspaceActivityTable
          data={workspaceActivity.data}
          loading={workspaceActivity.loading}
          page={workspacePage}
          onPageChange={setWorkspacePage}
        />
      </View>

      {/* Tool call analytics */}
      <View className="mb-4">
        <ToolCallAnalyticsPanel data={toolCalls.data} loading={toolCalls.loading} />
      </View>

      {/* Usage table (summary + event log) */}
      <View className="mb-4">
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
      <View className="mb-4">
        <ChatAnalyticsSection data={chatStats.data} loading={chatStats.loading} />
      </View>

      {/* Usage breakdown */}
      <View>
        <UsageBreakdownSection data={usage.data} loading={usage.loading} />
      </View>
    </ScrollView>
  )
}
