/**
 * ActiveUsersChart - Shows active user counts (DAU, WAU, MAU).
 */

import { Users, Calendar, CalendarDays } from 'lucide-react'

interface ActiveUsersData {
  dau: number
  wau: number
  mau: number
}

interface ActiveUsersChartProps {
  data: ActiveUsersData | null
  loading?: boolean
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number | undefined
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div>
        <div className="text-xl font-bold">
          {value !== undefined ? value.toLocaleString() : '—'}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

export function ActiveUsersChart({ data, loading }: ActiveUsersChartProps) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="h-4 w-32 bg-muted rounded mb-6 animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 bg-muted/50 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h3 className="text-sm font-semibold mb-4">Active Users</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard label="Daily Active" value={data?.dau} icon={Users} />
        <MetricCard label="Weekly Active" value={data?.wau} icon={Calendar} />
        <MetricCard label="Monthly Active" value={data?.mau} icon={CalendarDays} />
      </div>
    </div>
  )
}
