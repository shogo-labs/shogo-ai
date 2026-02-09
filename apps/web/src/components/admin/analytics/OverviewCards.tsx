/**
 * OverviewCards - Stat cards for key platform metrics.
 */

import { Users, Building2, FolderKanban, MessageSquare, TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface OverviewData {
  totalUsers: number
  totalWorkspaces: number
  totalProjects: number
  totalChatSessions: number
  activeUsersLast30d?: number
  newUsersLast30d?: number
}

interface OverviewCardsProps {
  data: OverviewData | null
  loading?: boolean
}

function StatCard({
  label,
  value,
  icon: Icon,
  subtitle,
}: {
  label: string
  value: number | undefined
  icon: React.ComponentType<{ className?: string }>
  subtitle?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      </div>
      <div className="text-2xl font-bold tracking-tight">
        {value !== undefined ? value.toLocaleString() : '—'}
      </div>
      {subtitle && (
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      )}
    </div>
  )
}

export function OverviewCards({ data, loading }: OverviewCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5 animate-pulse">
            <div className="h-4 w-20 bg-muted rounded mb-3" />
            <div className="h-8 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        label="Total Users"
        value={data?.totalUsers}
        icon={Users}
        subtitle={data?.newUsersLast30d ? `+${data.newUsersLast30d} last 30d` : undefined}
      />
      <StatCard
        label="Workspaces"
        value={data?.totalWorkspaces}
        icon={Building2}
      />
      <StatCard
        label="Projects"
        value={data?.totalProjects}
        icon={FolderKanban}
      />
      <StatCard
        label="Chat Sessions"
        value={data?.totalChatSessions}
        icon={MessageSquare}
        subtitle={data?.activeUsersLast30d ? `${data.activeUsersLast30d} active users` : undefined}
      />
    </div>
  )
}
