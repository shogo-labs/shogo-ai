/**
 * AgentAnalyticsPanel
 *
 * Displays project-scoped analytics for an agent project by consuming
 * the existing scoped analytics API endpoints:
 * - /api/projects/:projectId/analytics/overview
 * - /api/projects/:projectId/analytics/usage
 * - /api/projects/:projectId/analytics/chat
 *
 * Reuses the same Prisma-backed analytics infrastructure as the admin dashboard.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart3, TrendingUp, Zap, MessageSquare, Wrench,
  Clock, RefreshCw, AlertTriangle, DollarSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Period = '7d' | '30d' | '90d'

interface OverviewData {
  chatSessions: number
  usageEvents: number
  messages: number
}

interface UsageData {
  totalEvents: number
  totalCreditsConsumed: number
  byActionType: Record<string, { count: number; totalCredits: number }>
  dailyUsage: Array<{ date: string; count: number }>
}

interface ChatData {
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
  avgMessagesPerSession: number
  dailySessions: Array<{ date: string; count: number }>
}

interface AgentAnalyticsPanelProps {
  projectId: string
  visible: boolean
}

function useProjectAnalytics<T>(projectId: string, endpoint: string, period: Period, visible: boolean) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/analytics/${endpoint}?period=${period}`)
      if (!res.ok) throw new Error(`Failed to load analytics`)
      const json = await res.json()
      setData(json.data || json)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [projectId, endpoint, period])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  return { data, loading, error, reload: load }
}

export function AgentAnalyticsPanel({ projectId, visible }: AgentAnalyticsPanelProps) {
  const [period, setPeriod] = useState<Period>('7d')

  const overview = useProjectAnalytics<OverviewData>(projectId, 'overview', period, visible)
  const usage = useProjectAnalytics<UsageData>(projectId, 'usage', period, visible)
  const chat = useProjectAnalytics<ChatData>(projectId, 'chat', period, visible)

  const handleRefresh = () => {
    overview.reload()
    usage.reload()
    chat.reload()
  }

  const isLoading = overview.loading || usage.loading || chat.loading
  const hasError = overview.error || usage.error || chat.error

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Analytics</span>
        <div className="ml-auto flex items-center gap-2">
          {/* Period selector */}
          <div className="flex rounded-md border text-xs">
            {(['7d', '30d', '90d'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-2 py-1 transition-colors',
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground'
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <button onClick={handleRefresh} className="p-1 rounded hover:bg-muted text-muted-foreground" title="Refresh">
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {hasError && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {overview.error || usage.error || chat.error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Overview Cards */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            icon={<MessageSquare className="h-4 w-4" />}
            label="Messages"
            value={overview.data?.messages}
            loading={overview.loading}
          />
          <StatCard
            icon={<Zap className="h-4 w-4" />}
            label="Usage Events"
            value={overview.data?.usageEvents}
            loading={overview.loading}
          />
          <StatCard
            icon={<Wrench className="h-4 w-4" />}
            label="Tool Calls"
            value={chat.data?.totalToolCalls}
            loading={chat.loading}
          />
          <StatCard
            icon={<Clock className="h-4 w-4" />}
            label="Sessions"
            value={chat.data?.totalSessions}
            loading={chat.loading}
          />
        </div>

        {/* Credit Usage */}
        {usage.data && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
              Credit Usage
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold">
                {usage.data.totalCreditsConsumed.toFixed(1)}
              </span>
              <span className="text-xs text-muted-foreground">credits consumed</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {usage.data.totalEvents} total events
            </div>
          </div>
        )}

        {/* Chat Stats */}
        {chat.data && chat.data.totalMessages > 0 && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              Conversation Stats
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">Avg msgs/session</div>
                <div className="font-medium text-sm">{chat.data.avgMessagesPerSession}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Tool call rate</div>
                <div className="font-medium text-sm">
                  {chat.data.totalMessages > 0
                    ? (chat.data.totalToolCalls / chat.data.totalMessages * 100).toFixed(0)
                    : 0}%
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Usage by Action Type */}
        {usage.data && Object.keys(usage.data.byActionType).length > 0 && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="text-xs font-medium">Usage by Type</div>
            <div className="space-y-1.5">
              {Object.entries(usage.data.byActionType)
                .sort(([, a], [, b]) => b.count - a.count)
                .map(([type, data]) => {
                  const maxCount = Math.max(
                    ...Object.values(usage.data!.byActionType).map((d) => d.count)
                  )
                  return (
                    <div key={type} className="text-xs">
                      <div className="flex justify-between mb-0.5">
                        <span className="text-muted-foreground truncate">{type.replace(/_/g, ' ')}</span>
                        <span className="font-medium ml-2 shrink-0">{data.count}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${(data.count / maxCount) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        )}

        {/* Daily Activity Sparkline */}
        {usage.data && usage.data.dailyUsage.length > 0 && (
          <div className="border rounded-lg p-3 space-y-2">
            <div className="text-xs font-medium">Daily Activity</div>
            <div className="flex items-end gap-px h-16">
              {usage.data.dailyUsage.map((d, i) => {
                const maxCount = Math.max(...usage.data!.dailyUsage.map((p) => p.count))
                const height = maxCount > 0 ? (d.count / maxCount) * 100 : 0
                return (
                  <div
                    key={i}
                    className="flex-1 bg-primary/60 rounded-t-sm hover:bg-primary transition-colors"
                    style={{ height: `${Math.max(height, 2)}%` }}
                    title={`${d.date}: ${d.count} events`}
                  />
                )
              })}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{usage.data.dailyUsage[0]?.date}</span>
              <span>{usage.data.dailyUsage[usage.data.dailyUsage.length - 1]?.date}</span>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !hasError && overview.data?.messages === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No activity yet</p>
            <p className="text-xs mt-1">Analytics will appear once the agent starts processing messages.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  loading,
}: {
  icon: React.ReactNode
  label: string
  value?: number
  loading: boolean
}) {
  return (
    <div className="border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-xl font-bold">
        {loading ? (
          <span className="text-muted-foreground">...</span>
        ) : (
          value?.toLocaleString() ?? 0
        )}
      </div>
    </div>
  )
}
