/**
 * AdminAnalytics - Full analytics page with all charts and detailed breakdowns.
 */

import { useState } from 'react'
import { OverviewCards } from '../analytics/OverviewCards'
import { GrowthChart } from '../analytics/GrowthChart'
import { ActiveUsersChart } from '../analytics/ActiveUsersChart'
import { UsageBreakdown } from '../analytics/UsageBreakdown'
import { PeriodSelector, type AnalyticsPeriod } from '../analytics/PeriodSelector'
import {
  useOverviewStats,
  useGrowthData,
  useActiveUsersData,
  useUsageData,
  useAdminFetch,
} from '../hooks/useAdminApi'

export function AdminAnalytics() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')

  const overview = useOverviewStats()
  const growth = useGrowthData(period)
  const activeUsers = useActiveUsersData(period)
  const usage = useUsageData(period)
  const chatAnalytics = useAdminFetch<{
    totalSessions: number
    totalMessages: number
    totalToolCalls: number
    avgMessagesPerSession: number
  }>('/analytics/chat', { period })

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Analytics</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Comprehensive platform analytics and insights
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <OverviewCards data={overview.data} loading={overview.loading} />

      <ActiveUsersChart data={activeUsers.data} loading={activeUsers.loading} />

      {/* Chat Analytics */}
      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold mb-4">Chat Analytics</h3>
        {chatAnalytics.loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 bg-muted/50 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : chatAnalytics.data ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-lg bg-muted/50">
              <div className="text-xl font-bold">{chatAnalytics.data.totalSessions.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Total Sessions</div>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <div className="text-xl font-bold">{chatAnalytics.data.totalMessages.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Total Messages</div>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <div className="text-xl font-bold">{chatAnalytics.data.totalToolCalls.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Tool Calls</div>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <div className="text-xl font-bold">{chatAnalytics.data.avgMessagesPerSession.toFixed(1)}</div>
              <div className="text-xs text-muted-foreground">Avg Messages/Session</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No chat data available</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <GrowthChart data={growth.data} loading={growth.loading} />
        <UsageBreakdown data={usage.data} loading={usage.loading} />
      </div>
    </div>
  )
}
