/**
 * UsageBreakdown - Bar chart and table showing usage distribution.
 */

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

interface UsageData {
  totalCreditsConsumed: number
  actionBreakdown: Array<{ action: string; _count: number }>
  topConsumers: Array<{ workspaceId: string; _sum: { creditsUsed: number | null } }>
}

interface UsageBreakdownProps {
  data: UsageData | null
  loading?: boolean
}

export function UsageBreakdown({ data, loading }: UsageBreakdownProps) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="h-4 w-32 bg-muted rounded mb-6 animate-pulse" />
        <div className="h-64 bg-muted/50 rounded animate-pulse" />
      </div>
    )
  }

  const actionData = data?.actionBreakdown?.map((item) => ({
    name: item.action || 'unknown',
    count: item._count,
  })) ?? []

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold">Usage Breakdown</h3>
        {data && (
          <span className="text-xs text-muted-foreground">
            {data.totalCreditsConsumed.toLocaleString()} total credits
          </span>
        )}
      </div>
      {actionData.length > 0 ? (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={actionData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11 }}
              className="text-muted-foreground"
            />
            <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            />
            <Bar
              dataKey="count"
              fill="hsl(var(--primary))"
              radius={[4, 4, 0, 0]}
              name="Events"
            />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
          No usage data available
        </div>
      )}
    </div>
  )
}
