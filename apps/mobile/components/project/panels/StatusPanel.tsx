// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
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
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { agentFetch } from '../../../lib/agent-fetch'
import { usePlatformConfig } from '../../../lib/platform-config'

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
  model?: { provider: string; name: string }
  sessions?: SessionInfo[]
  cronJobs?: CronJobInfo[]
  memory?: MemoryInfo
}

interface StatusPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

const CHANNEL_META: Record<string, { name: string; emoji: string }> = {
  telegram: { name: 'Telegram', emoji: '📱' },
  discord: { name: 'Discord', emoji: '🎮' },
  email: { name: 'Email', emoji: '📧' },
  whatsapp: { name: 'WhatsApp', emoji: '💬' },
  slack: { name: 'Slack', emoji: '💼' },
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

export function StatusPanel({ projectId, agentUrl, visible }: StatusPanelProps) {
  const { localMode } = usePlatformConfig()
  const [status, setStatus] = useState<AgentStatusData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async () => {
    if (!agentUrl) return
    try {
      const res = await agentFetch(`${agentUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data: AgentStatusData = await res.json()
      setStatus(data)
      setError(null)
      setLastFetchedAt(Date.now())
    } catch (err: any) {
      setError(err.message)
    }
  }, [agentUrl])

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

  if (!visible) return null

  const connectedChannels = status?.channels.filter((c) => c.connected).length ?? 0
  const totalChannels = status?.channels.length ?? 0
  const enabledCrons = status?.cronJobs?.filter((j) => j.enabled).length ?? 0
  const totalCrons = status?.cronJobs?.length ?? 0
  const totalSessions = status?.sessions?.length ?? 0
  const totalTokens = status?.sessions?.reduce((acc, s) => acc + s.estimatedTokens, 0) ?? 0

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2 bg-muted/30">
        <Activity size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Agent Status</Text>
        {status && (
          <View className="flex-row items-center gap-1.5 ml-2">
            {status.running ? (
              <View className="flex-row items-center gap-1">
                <View className="h-2 w-2 rounded-full bg-emerald-500" />
                <Text className="text-xs text-emerald-500">Running</Text>
              </View>
            ) : (
              <View className="flex-row items-center gap-1">
                <View className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                <Text className="text-xs text-muted-foreground">Stopped</Text>
              </View>
            )}
          </View>
        )}
        <View className="ml-auto flex-row items-center gap-2">
          {lastFetchedAt && !error && (
            <View className="flex-row items-center gap-1">
              <View className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
              <Text className="text-[10px] text-muted-foreground">Live</Text>
            </View>
          )}
          <Pressable onPress={loadInitial} className="p-1 rounded-md active:bg-muted">
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10 flex-row items-center gap-2">
          <WifiOff size={12} className="text-destructive" />
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      {/* Dashboard Content */}
      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading && !status ? (
          <View className="items-center justify-center py-16 gap-3">
            <ActivityIndicator size="large" />
            <Text className="text-sm text-muted-foreground">Loading agent status...</Text>
          </View>
        ) : !status ? (
          <View className="items-center justify-center py-16 gap-4">
            <Activity size={32} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">Unable to connect to agent</Text>
            <Text className="text-xs text-muted-foreground">
              Start the agent to see its status
            </Text>
          </View>
        ) : (
          <View className="gap-4">
            {/* Stats Row */}
            <View className="flex-row flex-wrap gap-3">
              <StatCard
                icon={<Timer size={16} className="text-emerald-500" />}
                label="Uptime"
                value={formatUptime(status.uptimeSeconds)}
              />
              <StatCard
                icon={
                  <Radio
                    size={16}
                    className={connectedChannels > 0 ? 'text-blue-500' : 'text-muted-foreground'}
                  />
                }
                label="Channels"
                value={`${connectedChannels}/${totalChannels}`}
              />
              <StatCard
                icon={
                  <Clock
                    size={16}
                    className={enabledCrons > 0 ? 'text-amber-500' : 'text-muted-foreground'}
                  />
                }
                label="Cron Jobs"
                value={`${enabledCrons}/${totalCrons}`}
              />
              <StatCard
                icon={<Brain size={16} className="text-purple-500" />}
                label="Memory"
                value={status.memory ? `${status.memory.fileCount} files` : '0 files'}
              />
            </View>

            {/* Channels Section */}
            <DashboardSection
              title="Channels"
              icon={<MessageSquare size={14} className="text-muted-foreground" />}
              badge={`${connectedChannels} connected`}
            >
              {status.channels.length === 0 ? (
                <EmptyRow text="No channels configured" />
              ) : (
                <View className="gap-1.5">
                  {status.channels.map((ch) => {
                    const meta = CHANNEL_META[ch.type] || { name: ch.type, emoji: '📡' }
                    return (
                      <View
                        key={ch.type}
                        className="flex-row items-center gap-3 px-3 py-2 rounded-md bg-muted/40"
                      >
                        <Text className="text-base text-foreground">{meta.emoji}</Text>
                        <View className="flex-1">
                          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                            {meta.name}
                          </Text>
                          {ch.error && (
                            <Text className="text-xs text-destructive" numberOfLines={1}>
                              {ch.error}
                            </Text>
                          )}
                        </View>
                        {ch.connected ? (
                          <View className="flex-row items-center gap-1">
                            <CheckCircle size={14} className="text-emerald-500" />
                            <Text className="text-xs text-emerald-500">Online</Text>
                          </View>
                        ) : (
                          <View className="flex-row items-center gap-1">
                            <XCircle size={14} className="text-destructive" />
                            <Text className="text-xs text-destructive">Offline</Text>
                          </View>
                        )}
                      </View>
                    )
                  })}
                </View>
              )}
            </DashboardSection>

            {/* Cron Jobs Section */}
            <DashboardSection
              title="Cron Jobs"
              icon={<Calendar size={14} className="text-muted-foreground" />}
              badge={`${enabledCrons} active`}
            >
              {!status.cronJobs || status.cronJobs.length === 0 ? (
                <EmptyRow text="No cron jobs scheduled" />
              ) : (
                <View className="gap-1.5">
                  {status.cronJobs.map((job) => (
                    <View
                      key={job.name}
                      className="flex-row items-center gap-3 px-3 py-2 rounded-md bg-muted/40"
                    >
                      <View
                        className={cn(
                          'h-2 w-2 rounded-full',
                          job.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                        )}
                      />
                      <View className="flex-1">
                        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                          {job.name}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          Every {formatInterval(job.intervalSeconds)}
                        </Text>
                      </View>
                      <View className="items-end">
                        <Text
                          className={cn(
                            'text-xs',
                            job.enabled ? 'text-emerald-500' : 'text-muted-foreground',
                          )}
                        >
                          {job.enabled ? 'Active' : 'Disabled'}
                        </Text>
                        <Text className="text-[10px] text-muted-foreground">
                          {timeAgo(job.lastRunAt)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </DashboardSection>

            {/* Memory Section */}
            <DashboardSection
              title="Memory"
              icon={<HardDrive size={14} className="text-muted-foreground" />}
            >
              {!status.memory || status.memory.fileCount === 0 ? (
                <EmptyRow text="No memory files yet" />
              ) : (
                <View className="flex-row gap-6 px-3 py-2">
                  <View>
                    <Text className="text-xs text-muted-foreground">Files</Text>
                    <Text className="text-sm font-semibold text-foreground">
                      {status.memory.fileCount}
                    </Text>
                  </View>
                  <View>
                    <Text className="text-xs text-muted-foreground">Total Size</Text>
                    <Text className="text-sm font-semibold text-foreground">
                      {formatBytes(status.memory.totalSizeBytes)}
                    </Text>
                  </View>
                  <View>
                    <Text className="text-xs text-muted-foreground">Last Updated</Text>
                    <Text className="text-sm font-semibold text-foreground">
                      {timeAgo(status.memory.lastModified)}
                    </Text>
                  </View>
                </View>
              )}
            </DashboardSection>

            {/* Sessions Section */}
            <DashboardSection
              title="Sessions"
              icon={<Users size={14} className="text-muted-foreground" />}
              badge={`${totalSessions} active`}
            >
              {!status.sessions || status.sessions.length === 0 ? (
                <EmptyRow text="No active sessions" />
              ) : (
                <View className="gap-1.5">
                  {status.sessions.map((session) => (
                    <View
                      key={session.id}
                      className="flex-row items-center gap-3 px-3 py-2 rounded-md bg-muted/40"
                    >
                      <Zap size={14} className="text-amber-500" />
                      <View className="flex-1">
                        <Text
                          className="text-sm font-medium font-mono text-foreground"
                          numberOfLines={1}
                        >
                          {session.id}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {session.messageCount} msgs · ~
                          {(session.estimatedTokens / 1000).toFixed(1)}k tokens
                        </Text>
                      </View>
                      <View className="items-end">
                        {session.compactedSummary && (
                          <Text className="text-[10px] text-blue-500">
                            Compacted x{session.compactionCount}
                          </Text>
                        )}
                        <Text className="text-[10px] text-muted-foreground">
                          Idle {formatUptime(session.idleSeconds)}
                        </Text>
                      </View>
                    </View>
                  ))}
                  <View className="flex-row items-center justify-between px-3 py-1.5">
                    <Text className="text-xs text-muted-foreground">
                      {localMode ? 'Total estimated tokens' : 'Credits used'}
                    </Text>
                    <Text className="text-xs font-medium text-foreground">
                      {localMode
                        ? `${(totalTokens / 1000).toFixed(1)}k`
                        : `${(totalTokens / 1000).toFixed(1)}`}
                    </Text>
                  </View>
                </View>
              )}
            </DashboardSection>

            {/* Heartbeat Section */}
            <DashboardSection
              title="Heartbeat"
              icon={<Activity size={14} className="text-muted-foreground" />}
            >
              <View className="flex-row flex-wrap gap-x-6 gap-y-2 px-3 py-2">
                <View>
                  <Text className="text-xs text-muted-foreground">Status</Text>
                  <Text
                    className={cn(
                      'text-sm font-semibold',
                      status.heartbeat.enabled ? 'text-emerald-500' : 'text-muted-foreground',
                    )}
                  >
                    {status.heartbeat.enabled ? 'Enabled' : 'Disabled'}
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Interval</Text>
                  <Text className="text-sm font-semibold text-foreground">
                    {formatInterval(status.heartbeat.intervalSeconds)}
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Last Tick</Text>
                  <Text className="text-sm font-semibold text-foreground">
                    {timeAgo(status.heartbeat.lastTick)}
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Next Tick</Text>
                  <Text className="text-sm font-semibold text-foreground">
                    {status.heartbeat.nextTick
                      ? new Date(status.heartbeat.nextTick).toLocaleTimeString()
                      : '-'}
                  </Text>
                </View>
              </View>
              {status.heartbeat.quietHours?.start && status.heartbeat.quietHours?.end && (
                <View className="px-3 pb-2">
                  <Text className="text-xs text-muted-foreground">
                    Quiet hours: {status.heartbeat.quietHours.start} -{' '}
                    {status.heartbeat.quietHours.end} ({status.heartbeat.quietHours.timezone})
                  </Text>
                </View>
              )}
            </DashboardSection>

            {/* Model Info */}
            {status.model && (
              <View className="flex-row items-center gap-2 px-3 py-2 rounded-lg border border-border/40 bg-muted/20">
                <Zap size={14} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">Model:</Text>
                <Text className="text-xs font-medium text-foreground">{status.model.name}</Text>
                <Text className="text-xs text-muted-foreground">({status.model.provider})</Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  )
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <View className="flex-1 min-w-[140px] px-3 py-2.5 rounded-lg border border-border/40 bg-card gap-1.5">
      <View className="flex-row items-center gap-1.5">
        {icon}
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          {label}
        </Text>
      </View>
      <Text className="text-lg font-semibold text-foreground tracking-tight">{value}</Text>
    </View>
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
    <View className="rounded-lg border border-border/40 overflow-hidden">
      <View className="flex-row items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/30">
        {icon}
        <Text className="text-xs font-medium text-foreground">{title}</Text>
        {badge && (
          <Text className="text-[10px] text-muted-foreground ml-auto">{badge}</Text>
        )}
      </View>
      {children}
    </View>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <View className="px-3 py-4 items-center">
      <Text className="text-xs text-muted-foreground">{text}</Text>
    </View>
  )
}
