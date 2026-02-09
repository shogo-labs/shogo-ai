/**
 * AdminDashboard - Main admin overview page with key metrics and charts.
 */

import { useState } from 'react'
import { OverviewCards } from '../analytics/OverviewCards'
import { GrowthChart } from '../analytics/GrowthChart'
import { ActiveUsersChart } from '../analytics/ActiveUsersChart'
import { UsageBreakdown } from '../analytics/UsageBreakdown'
import { PeriodSelector, type AnalyticsPeriod } from '../analytics/PeriodSelector'
import { useOverviewStats, useGrowthData, useActiveUsersData, useUsageData } from '../hooks/useAdminApi'

export function AdminDashboard() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')

  const overview = useOverviewStats()
  const growth = useGrowthData(period)
  const activeUsers = useActiveUsersData(period)
  const usage = useUsageData(period)

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Dashboard</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Platform overview and key metrics
          </p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      <OverviewCards data={overview.data} loading={overview.loading} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <GrowthChart data={growth.data} loading={growth.loading} />
        <UsageBreakdown data={usage.data} loading={usage.loading} />
      </div>

      <ActiveUsersChart data={activeUsers.data} loading={activeUsers.loading} />
    </div>
  )
}
