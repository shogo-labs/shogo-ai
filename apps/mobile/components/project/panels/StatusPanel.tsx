// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import {
  Activity,
  Radio,
  Brain,
  Timer,
  RefreshCw,
  CheckCircle,
  XCircle,
  WifiOff,
  MessageSquare,
  Zap,
  HardDrive,
  Users,
  DollarSign,
  Lock,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Switch } from '@/components/ui/switch'
import { agentFetch } from '../../../lib/agent-fetch'
import { API_URL } from '../../../lib/api'
import { usePlatformConfig } from '../../../lib/platform-config'

const POLL_INTERVAL_MS = 5_000

const CREDIT_MARKUP = 1.3
const ESTIMATED_TOKENS_PER_TICK = 3000
const MODEL_CREDITS: Record<string, { perBatch: number; batchSize: number }> = {
  haiku: { perBatch: 0.025, batchSize: 5000 },
  sonnet: { perBatch: 0.1, batchSize: 5000 },
  opus: { perBatch: 0.5, batchSize: 5000 },
}

function modelNameToBillingTier(modelName: string): string {
  const lower = modelName.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('haiku')) return 'haiku'
  return 'sonnet'
}

function estimateDailyCost(
  intervalSeconds: number,
  modelName: string,
  quietHoursStart?: string | null,
  quietHoursEnd?: string | null,
): { ticksPerDay: number; creditsPerTick: number; creditsPerDay: number } {
  let activeHours = 24
  if (quietHoursStart && quietHoursEnd) {
    const [sh, sm] = quietHoursStart.split(':').map(Number)
    const [eh, em] = quietHoursEnd.split(':').map(Number)
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    const quietMinutes = endMin > startMin ? endMin - startMin : (1440 - startMin) + endMin
    activeHours = Math.max(1, (1440 - quietMinutes) / 60)
  }

  const ticksPerDay = Math.floor((activeHours * 3600) / intervalSeconds)
  const tier = modelNameToBillingTier(modelName)
  const config = MODEL_CREDITS[tier] || MODEL_CREDITS.sonnet
  const creditsPerTick =
    Math.ceil(((ESTIMATED_TOKENS_PER_TICK / config.batchSize) * config.perBatch * CREDIT_MARKUP) * 10) / 10

  return { ticksPerDay, creditsPerTick, creditsPerDay: Math.ceil(ticksPerDay * creditsPerTick * 10) / 10 }
}

interface HeartbeatConfig {
  heartbeatEnabled: boolean
  heartbeatInterval: number
  nextHeartbeatAt: string | null
  lastHeartbeatAt: string | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
  quietHoursTimezone: string | null
  modelName: string
}

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
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
    quietHours: { start: string; end: string; timezone: string }
  }
  channels: ChannelInfo[]
  skills: Array<{ name: string; trigger: string; description: string; native?: boolean }>
  model?: { provider: string; name: string }
  sessions?: SessionInfo[]
  memory?: MemoryInfo
}

interface StatusPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
  isPaidPlan?: boolean
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

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff <= 0) return 'Now'
  if (diff < 60_000) return `${Math.ceil(diff / 1000)}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`
  return `${Math.floor(diff / 86_400_000)}d`
}

export function StatusPanel({ projectId, agentUrl, visible, isPaidPlan }: StatusPanelProps) {
  const { localMode } = usePlatformConfig()
  const [status, setStatus] = useState<AgentStatusData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [hbConfig, setHbConfig] = useState<HeartbeatConfig | null>(null)
  const [hbToggling, setHbToggling] = useState(false)

  const fetchHeartbeatConfig = useCallback(async () => {
    try {
      const res = await agentFetch(`${API_URL}/api/projects/${projectId}/heartbeat`)
      if (res.ok) {
        setHbConfig(await res.json())
      }
    } catch {
      // non-fatal
    }
  }, [projectId])

  const toggleHeartbeat = useCallback(async (enabled: boolean) => {
    setHbToggling(true)
    try {
      const res = await agentFetch(`${API_URL}/api/projects/${projectId}/heartbeat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heartbeatEnabled: enabled }),
      })
      if (res.ok) {
        setHbConfig(await res.json())
      }
    } catch (err: any) {
      console.error('[StatusPanel] Failed to toggle heartbeat:', err.message)
    } finally {
      setHbToggling(false)
    }
  }, [projectId])

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
    await Promise.all([fetchStatus(), fetchHeartbeatConfig()])
    setIsLoading(false)
  }, [fetchStatus, fetchHeartbeatConfig])

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
              badge={
                !localMode && !isPaidPlan
                  ? 'Pro'
                  : hbConfig
                    ? hbConfig.heartbeatEnabled ? 'Active' : 'Off'
                    : status.heartbeat.enabled ? 'Active' : 'Off'
              }
            >
              <View className="px-3 py-2.5 gap-3">
                {!localMode && !isPaidPlan ? (
                  <View className="flex-row items-center gap-3 py-1">
                    <Lock size={16} className="text-muted-foreground" />
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-foreground">
                        Scheduled heartbeats
                      </Text>
                      <Text className="text-xs text-muted-foreground mt-0.5">
                        Upgrade to a paid plan to enable periodic agent check-ins
                      </Text>
                    </View>
                  </View>
                ) : (
                <>
                {/* Toggle row */}
                <View className="flex-row items-center justify-between">
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">
                      Periodic check-ins
                    </Text>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      Agent wakes up on a schedule to check for work
                    </Text>
                  </View>
                  <Switch
                    value={hbConfig?.heartbeatEnabled ?? status.heartbeat.enabled}
                    onValueChange={toggleHeartbeat}
                    disabled={hbToggling}
                    size="sm"
                  />
                </View>

                {/* Stats row (when enabled) */}
                {(hbConfig?.heartbeatEnabled ?? status.heartbeat.enabled) && (
                  <>
                    <View className="flex-row flex-wrap gap-x-6 gap-y-2">
                      <View>
                        <Text className="text-xs text-muted-foreground">Interval</Text>
                        <Text className="text-sm font-semibold text-foreground">
                          {formatInterval(hbConfig?.heartbeatInterval ?? status.heartbeat.intervalSeconds)}
                        </Text>
                      </View>
                      <View>
                        <Text className="text-xs text-muted-foreground">Last Tick</Text>
                        <Text className="text-sm font-semibold text-foreground">
                          {timeAgo(hbConfig?.lastHeartbeatAt ?? status.heartbeat.lastTick)}
                        </Text>
                      </View>
                      {hbConfig?.nextHeartbeatAt && (
                        <View>
                          <Text className="text-xs text-muted-foreground">Next</Text>
                          <Text className="text-sm font-semibold text-foreground">
                            {timeUntil(hbConfig.nextHeartbeatAt)}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Quiet hours */}
                    {(hbConfig?.quietHoursStart || status.heartbeat.quietHours?.start) &&
                     (hbConfig?.quietHoursEnd || status.heartbeat.quietHours?.end) && (
                      <Text className="text-xs text-muted-foreground">
                        Quiet hours:{' '}
                        {hbConfig?.quietHoursStart ?? status.heartbeat.quietHours.start} –{' '}
                        {hbConfig?.quietHoursEnd ?? status.heartbeat.quietHours.end}{' '}
                        ({hbConfig?.quietHoursTimezone ?? status.heartbeat.quietHours.timezone})
                      </Text>
                    )}

                    {/* Cost estimate */}
                    {!localMode && (() => {
                      const modelName = hbConfig?.modelName ?? status.model?.name ?? 'claude-sonnet-4-5'
                      const interval = hbConfig?.heartbeatInterval ?? status.heartbeat.intervalSeconds
                      const cost = estimateDailyCost(
                        interval,
                        modelName,
                        hbConfig?.quietHoursStart,
                        hbConfig?.quietHoursEnd,
                      )
                      return (
                        <View className="flex-row items-center gap-2 px-2.5 py-2 rounded-md bg-muted/50 border border-border/30">
                          <DollarSign size={13} className="text-amber-500" />
                          <View className="flex-1">
                            <Text className="text-xs text-foreground">
                              ~{cost.creditsPerDay} credits/day
                            </Text>
                            <Text className="text-[10px] text-muted-foreground">
                              ~{cost.ticksPerDay} ticks/day × ~{cost.creditsPerTick} credits/tick
                            </Text>
                          </View>
                        </View>
                      )
                    })()}
                  </>
                )}
                </>
                )}
              </View>
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
