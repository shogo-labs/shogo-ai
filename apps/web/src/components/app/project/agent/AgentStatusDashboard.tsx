/**
 * AgentStatusDashboard
 *
 * Real-time agent status dashboard that polls /agent/status and displays:
 * - Channels: connected messaging adapters with status
 * - Cron Jobs: scheduled tasks with run history
 * - Memory: file count, size, last modified
 * - Uptime: running duration with heartbeat pulse
 * - Sessions: active conversations with token usage
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Activity,
  Radio,
  Clock,
  Brain,
  Timer,
  RefreshCw,
  CheckCircle,
  XCircle,
  WifiOff,
  Calendar,
  MessageSquare,
  Zap,
  HardDrive,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

const POLL_INTERVAL_MS = 5_000

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
}

interface CronJobInfo {
  name: string
  intervalSeconds: number
  enabled: boolean
  lastRunAt: string | null
}

interface SessionInfo {
  id: string
  messageCount: number
  estimatedTokens: number
  compactedSummary: boolean
  compactionCount: number
  idleSeconds: number
}

interface MemoryInfo {
  fileCount: number
  totalSizeBytes: number
  lastModified: string | null
}

interface AgentStatusData {
  running: boolean
  uptimeSeconds: number
  heartbeat: {
    enabled: boolean
    intervalSeconds: number
    lastTick: string | null
    nextTick: string | null
    quietHours: { start: string; end: string; timezone: string }
  }
  channels: ChannelInfo[]
  skills: Array<{ name: string; trigger: string; description: string; native?: boolean }>
  model: { provider: string; name: string }
  sessions?: SessionInfo[]
  cronJobs?: CronJobInfo[]
  memory?: MemoryInfo
}

interface AgentStatusDashboardProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

const CHANNEL_META: Record<string, { name: string; icon: string }> = {
  telegram: { name: 'Telegram', icon: '📱' },
  discord: { name: 'Discord', icon: '🎮' },
  email: { name: 'Email', icon: '📧' },
  whatsapp: { name: 'WhatsApp', icon: '💬' },
  slack: { name: 'Slack', icon: '💼' },
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0 || !Number.isFinite(seconds)) return '0s'
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function AgentStatusDashboard({ projectId, visible, localAgentUrl }: AgentStatusDashboardProps) {
  const [status, setStatus] = useState<AgentStatusData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const fetchStatus = useCallback(async () => {
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data: AgentStatusData = await res.json()
      setStatus(data)
      setError(null)
      setLastFetchedAt(Date.now())
    } catch (err: any) {
      setError(err.message)
    }
  }, [getAgentUrl])

  const loadInitial = useCallback(async () => {
    setIsLoading(true)
    await fetchStatus()
    setIsLoading(false)
  }, [fetchStatus])

  useEffect(() => {
    if (!visible) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    loadInitial()
    pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [visible, loadInitial, fetchStatus])

  const connectedChannels = status?.channels.filter(c => c.connected).length ?? 0
  const totalChannels = status?.channels.length ?? 0
  const enabledCrons = status?.cronJobs?.filter(j => j.enabled).length ?? 0
  const totalCrons = status?.cronJobs?.length ?? 0
  const totalSessions = status?.sessions?.length ?? 0
  const totalTokens = status?.sessions?.reduce((acc, s) => acc + s.estimatedTokens, 0) ?? 0

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center gap-2 bg-muted/30 shrink-0">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Agent Status</span>
        {status && (
          <div className="flex items-center gap-1.5 ml-2">
            {status.running ? (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Running
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                Stopped
              </span>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {lastFetchedAt && !error && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70 animate-pulse" />
              Live
            </span>
          )}
          <button
            onClick={loadInitial}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
          <WifiOff className="h-3 w-3 shrink-0" />
          {error}
        </div>
      )}

      {/* Dashboard Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && !status ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <RefreshCw className="h-6 w-6 text-muted-foreground animate-spin" />
            <p className="text-sm text-muted-foreground">Loading agent status...</p>
          </div>
        ) : !status ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <Activity className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">Unable to connect to agent</p>
            <p className="text-xs text-muted-foreground/70">Start the agent to see its status</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                icon={<Timer className="h-4 w-4" />}
                label="Uptime"
                value={formatUptime(status.uptimeSeconds)}
                color="text-emerald-500"
              />
              <StatCard
                icon={<Radio className="h-4 w-4" />}
                label="Channels"
                value={`${connectedChannels}/${totalChannels}`}
                color={connectedChannels > 0 ? 'text-blue-500' : 'text-muted-foreground'}
              />
              <StatCard
                icon={<Clock className="h-4 w-4" />}
                label="Cron Jobs"
                value={`${enabledCrons}/${totalCrons}`}
                color={enabledCrons > 0 ? 'text-amber-500' : 'text-muted-foreground'}
              />
              <StatCard
                icon={<Brain className="h-4 w-4" />}
                label="Memory"
                value={status.memory ? `${status.memory.fileCount} files` : '0 files'}
                color="text-purple-500"
              />
            </div>

            {/* Channels Section */}
            <DashboardSection title="Channels" icon={<MessageSquare className="h-3.5 w-3.5" />} badge={`${connectedChannels} connected`}>
              {status.channels.length === 0 ? (
                <EmptyRow text="No channels configured" />
              ) : (
                <div className="space-y-1.5">
                  {status.channels.map((ch) => {
                    const meta = CHANNEL_META[ch.type] || { name: ch.type, icon: '📡' }
                    return (
                      <div key={ch.type} className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/40">
                        <span className="text-base">{meta.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{meta.name}</div>
                          {ch.error && <div className="text-xs text-destructive truncate">{ch.error}</div>}
                        </div>
                        {ch.connected ? (
                          <div className="flex items-center gap-1 text-xs text-emerald-500">
                            <CheckCircle className="h-3.5 w-3.5" />
                            <span>Online</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-xs text-destructive">
                            <XCircle className="h-3.5 w-3.5" />
                            <span>Offline</span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </DashboardSection>

            {/* Cron Jobs Section */}
            <DashboardSection title="Cron Jobs" icon={<Calendar className="h-3.5 w-3.5" />} badge={`${enabledCrons} active`}>
              {!status.cronJobs || status.cronJobs.length === 0 ? (
                <EmptyRow text="No cron jobs scheduled" />
              ) : (
                <div className="space-y-1.5">
                  {status.cronJobs.map((job) => (
                    <div key={job.name} className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/40">
                      <div className={cn(
                        'h-2 w-2 rounded-full shrink-0',
                        job.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{job.name}</div>
                        <div className="text-xs text-muted-foreground">
                          Every {formatInterval(job.intervalSeconds)}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={cn('text-xs', job.enabled ? 'text-emerald-500' : 'text-muted-foreground')}>
                          {job.enabled ? 'Active' : 'Disabled'}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {timeAgo(job.lastRunAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </DashboardSection>

            {/* Memory Section */}
            <DashboardSection title="Memory" icon={<HardDrive className="h-3.5 w-3.5" />}>
              {!status.memory || status.memory.fileCount === 0 ? (
                <EmptyRow text="No memory files yet" />
              ) : (
                <div className="grid grid-cols-3 gap-3 px-3 py-2">
                  <div>
                    <div className="text-xs text-muted-foreground">Files</div>
                    <div className="text-sm font-semibold">{status.memory.fileCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Total Size</div>
                    <div className="text-sm font-semibold">{formatBytes(status.memory.totalSizeBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Last Updated</div>
                    <div className="text-sm font-semibold">{timeAgo(status.memory.lastModified)}</div>
                  </div>
                </div>
              )}
            </DashboardSection>

            {/* Sessions Section */}
            <DashboardSection title="Sessions" icon={<Users className="h-3.5 w-3.5" />} badge={`${totalSessions} active`}>
              {!status.sessions || status.sessions.length === 0 ? (
                <EmptyRow text="No active sessions" />
              ) : (
                <div className="space-y-1.5">
                  {status.sessions.map((session) => (
                    <div key={session.id} className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/40">
                      <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium font-mono truncate">{session.id}</div>
                        <div className="text-xs text-muted-foreground">
                          {session.messageCount} msgs &middot; ~{(session.estimatedTokens / 1000).toFixed(1)}k tokens
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {session.compactedSummary && (
                          <div className="text-[10px] text-blue-500">Compacted x{session.compactionCount}</div>
                        )}
                        <div className="text-[10px] text-muted-foreground">
                          Idle {formatUptime(session.idleSeconds)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
                    <span>Total estimated tokens</span>
                    <span className="font-medium">{(totalTokens / 1000).toFixed(1)}k</span>
                  </div>
                </div>
              )}
            </DashboardSection>

            {/* Heartbeat Section */}
            <DashboardSection title="Heartbeat" icon={<Activity className="h-3.5 w-3.5" />}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-3 py-2">
                <div>
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className={cn('text-sm font-semibold', status.heartbeat.enabled ? 'text-emerald-500' : 'text-muted-foreground')}>
                    {status.heartbeat.enabled ? 'Enabled' : 'Disabled'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Interval</div>
                  <div className="text-sm font-semibold">{formatInterval(status.heartbeat.intervalSeconds)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Last Tick</div>
                  <div className="text-sm font-semibold">{timeAgo(status.heartbeat.lastTick)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Next Tick</div>
                  <div className="text-sm font-semibold">
                    {status.heartbeat.nextTick
                      ? new Date(status.heartbeat.nextTick).toLocaleTimeString()
                      : '-'}
                  </div>
                </div>
              </div>
              {status.heartbeat.quietHours.start && status.heartbeat.quietHours.end && (
                <div className="px-3 pb-2">
                  <div className="text-xs text-muted-foreground">
                    Quiet hours: {status.heartbeat.quietHours.start} - {status.heartbeat.quietHours.end} ({status.heartbeat.quietHours.timezone})
                  </div>
                </div>
              )}
            </DashboardSection>

            {/* Model Info */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/40 bg-muted/20">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Model:</span>
              <span className="text-xs font-medium">{status.model.name}</span>
              <span className="text-xs text-muted-foreground">({status.model.provider})</span>
            </div>
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
  color,
}: {
  icon: React.ReactNode
  label: string
  value: string
  color: string
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border border-border/40 bg-card">
      <div className="flex items-center gap-1.5">
        <span className={cn('shrink-0', color)}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      </div>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
    </div>
  )
}

function DashboardSection({
  title,
  icon,
  badge,
  children,
}: {
  title: string
  icon: React.ReactNode
  badge?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/30">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium">{title}</span>
        {badge && (
          <span className="text-[10px] text-muted-foreground ml-auto">{badge}</span>
        )}
      </div>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-muted-foreground/60">
      {text}
    </div>
  )
}
