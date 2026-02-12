/**
 * GrowthChart - Line chart showing growth trends over time.
 */

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

interface GrowthDataPoint {
  date: string
  users: number
  workspaces: number
  projects: number
}

interface GrowthChartProps {
  data: GrowthDataPoint[] | null
  loading?: boolean
}

export function GrowthChart({ data, loading }: GrowthChartProps) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="h-4 w-32 bg-muted rounded mb-6 animate-pulse" />
        <div className="h-64 bg-muted/50 rounded animate-pulse" />
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="text-sm font-semibold mb-4">Growth Trends</h3>
      {data && data.length > 0 ? (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              className="text-muted-foreground"
              tickFormatter={(v) => {
                const d = new Date(v)
                return `${d.getMonth() + 1}/${d.getDate()}`
              }}
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
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Line
              type="monotone"
              dataKey="users"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              name="Users"
            />
            <Line
              type="monotone"
              dataKey="workspaces"
              stroke="hsl(210 80% 60%)"
              strokeWidth={2}
              dot={false}
              name="Workspaces"
            />
            <Line
              type="monotone"
              dataKey="projects"
              stroke="hsl(150 60% 50%)"
              strokeWidth={2}
              dot={false}
              name="Projects"
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
          No growth data available
        </div>
      )}
    </div>
  )
}
