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
import { usePanelSequence, SUPERSEDED } from './_panel-sequence'

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

  /**
   * One loader per panel, each depending only on the params *it* sends.
   *
   * The page used to fire all eight requests through a single `loadAll` whose
   * dependency list held every param, so paging the tool-call table refetched
   * the spend chart, the quality chart, workspace activity, the usage ledger,
   * the conversation stats and the distribution breakdown as well — eight
   * window scans to render one new page of ten rows. Now a param change only
   * refetches the panel that param belongs to.
   */
  const trackSpendTs = usePanelSequence()
  const loadSpendTs = useCallback(async () => {
    setSpendTs((s) => ({ ...s, loading: true }))
    const data = await trackSpendTs(() => fetchAdminJson<SpendTimeseriesData>('/analytics/spend-timeseries', {
      period,
      excludeInternal: internalParam,
      groupBy: spendGroupBy,
      metric: spendMetric,
    }))
    if (data === SUPERSEDED) return
    setSpendTs({ data, loading: false })
  }, [period, internalParam, spendGroupBy, spendMetric, trackSpendTs])

  const trackQualityTs = usePanelSequence()
  const loadQualityTs = useCallback(async () => {
    setQualityTs((s) => ({ ...s, loading: true }))
    const data = await trackQualityTs(() => fetchAdminJson<QualityTimeseriesPoint[]>('/analytics/quality-timeseries', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setQualityTs({ data, loading: false })
  }, [period, internalParam, trackQualityTs])

  const trackToolCalls = usePanelSequence()
  const loadToolCalls = useCallback(async () => {
    setToolCalls((s) => ({ ...s, loading: true }))
    const data = await trackToolCalls(() => fetchAdminJson<ToolCallAnalyticsData>('/analytics/tool-calls', {
      period,
      excludeInternal: internalParam,
      page: String(toolPage),
      limit: '10',
    }))
    if (data === SUPERSEDED) return
    setToolCalls({ data, loading: false })
  }, [period, internalParam, toolPage, trackToolCalls])

  const trackWorkspaceActivity = usePanelSequence()
  const loadWorkspaceActivity = useCallback(async () => {
    setWorkspaceActivity((s) => ({ ...s, loading: true }))
    const data = await trackWorkspaceActivity(() => fetchAdminJson<WorkspaceActivityData>('/analytics/workspace-activity', {
      period,
      excludeInternal: internalParam,
      page: String(workspacePage),
      limit: '20',
    }))
    if (data === SUPERSEDED) return
    setWorkspaceActivity({ data, loading: false })
  }, [period, internalParam, workspacePage, trackWorkspaceActivity])

  const trackUsage = usePanelSequence()
  const loadUsage = useCallback(async () => {
    setUsage((s) => ({ ...s, loading: true }))
    const data = await trackUsage(() => fetchAdminJson<UsageBreakdownData>('/analytics/usage', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setUsage({ data, loading: false })
  }, [period, internalParam, trackUsage])

  const trackUsageSummary = usePanelSequence()
  const loadUsageSummary = useCallback(async () => {
    setUsageSummary((s) => ({ ...s, loading: true }))
    const data = await trackUsageSummary(() => fetchAdminJson<UsageSummaryData>('/analytics/usage-summary', {
      period,
      excludeInternal: internalParam,
      page: String(summaryPage),
      limit: '25',
    }))
    if (data === SUPERSEDED) return
    setUsageSummary({ data, loading: false })
  }, [period, internalParam, summaryPage, trackUsageSummary])

  const trackUsageLog = usePanelSequence()
  const loadUsageLog = useCallback(async () => {
    setUsageLog((s) => ({ ...s, loading: true }))
    const data = await trackUsageLog(() => fetchAdminJson<UsageLogData>('/analytics/usage-log', {
      period,
      excludeInternal: internalParam,
      page: String(logPage),
      limit: '50',
    }))
    if (data === SUPERSEDED) return
    setUsageLog({ data, loading: false })
  }, [period, internalParam, logPage, trackUsageLog])

  const trackChatStats = usePanelSequence()
  const loadChatStats = useCallback(async () => {
    setChatStats((s) => ({ ...s, loading: true }))
    const data = await trackChatStats(() => fetchAdminJson<ChatAnalyticsData>('/analytics/chat', {
      period,
      excludeInternal: internalParam,
    }))
    if (data === SUPERSEDED) return
    setChatStats({ data, loading: false })
  }, [period, internalParam, trackChatStats])

  const loadAll = useCallback(async () => {
    await Promise.all([
      loadSpendTs(),
      loadQualityTs(),
      loadToolCalls(),
      loadWorkspaceActivity(),
      loadUsage(),
      loadUsageSummary(),
      loadUsageLog(),
      loadChatStats(),
    ])
  }, [
    loadSpendTs,
    loadQualityTs,
    loadToolCalls,
    loadWorkspaceActivity,
    loadUsage,
    loadUsageSummary,
    loadUsageLog,
    loadChatStats,
  ])

  useEffect(() => {
    void loadSpendTs()
  }, [loadSpendTs])

  useEffect(() => {
    void loadQualityTs()
  }, [loadQualityTs])

  useEffect(() => {
    void loadToolCalls()
  }, [loadToolCalls])

  useEffect(() => {
    void loadWorkspaceActivity()
  }, [loadWorkspaceActivity])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  useEffect(() => {
    void loadUsageSummary()
  }, [loadUsageSummary])

  useEffect(() => {
    void loadUsageLog()
  }, [loadUsageLog])

  useEffect(() => {
    void loadChatStats()
  }, [loadChatStats])

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
