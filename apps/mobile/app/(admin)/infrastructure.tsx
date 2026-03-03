/**
 * Admin Infrastructure - Warm pool, cluster nodes, promoted pods, and GC status.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  useWindowDimensions,
} from 'react-native'
import {
  Server,
  Cpu,
  Box,
  Trash2,
  RefreshCw,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  HardDrive,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`
const AUTO_REFRESH_INTERVAL = 15_000

// =============================================================================
// Types
// =============================================================================

interface PoolStatus {
  enabled: boolean
  available: { project: number; agent: number }
  assigned: number
  targetSize: { project: number; agent: number }
}

interface ClusterCapacity {
  totalNodes: number
  totalPodSlots: number
  usedPodSlots: number
  availablePodSlots: number
  totalCpuMillis: number
  usedCpuMillis: number
  availableCpuMillis: number
  asgDesired: number
  asgMax: number
}

interface PromotedPod {
  serviceName: string
  type: string
  projectId: string
  projectName: string | null
  url: string
  createdAt: number
  ready: boolean
  idleSeconds: number | null
}

interface GcStats {
  orphansDeleted: number
  idleEvictions: number
  lastGcRun: number | null
}

interface WarmPoolData {
  pool: PoolStatus
  cluster: ClusterCapacity | null
  promotedPods: PromotedPod[]
  gcStats: GcStats
}

interface HistoryPoint {
  time: number
  nodes: number
  availableAgents: number
  promotedCount: number
}

// =============================================================================
// API
// =============================================================================

async function fetchWarmPool(): Promise<WarmPoolData | null> {
  try {
    const res = await fetch(`${API_BASE}/warm-pool`, { credentials: 'include' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function triggerGc(): Promise<{ orphansDeleted: number; idleEvicted: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/warm-pool/gc`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function evictPod(projectId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/warm-pool/evict/${projectId}`, {
      method: 'POST',
      credentials: 'include',
    })
    return res.ok
  } catch {
    return false
  }
}

// =============================================================================
// Helpers
// =============================================================================

function formatAge(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

function formatIdleTime(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function idleColor(seconds: number | null): string {
  if (seconds === null) return 'text-muted-foreground'
  if (seconds > 1800) return 'text-red-400'
  if (seconds > 600) return 'text-yellow-400'
  return 'text-green-400'
}

function idleBg(seconds: number | null): string {
  if (seconds === null) return 'bg-muted/50'
  if (seconds > 1800) return 'bg-red-500/10'
  if (seconds > 600) return 'bg-yellow-500/10'
  return 'bg-green-500/10'
}

// =============================================================================
// Components
// =============================================================================

function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  color = 'text-primary',
}: {
  label: string
  value: string | number
  subtitle?: string
  icon: any
  color?: string
}) {
  return (
    <View className="flex-1 min-w-[140px] bg-card border border-border rounded-xl p-3">
      <View className="flex-row items-center gap-2 mb-1">
        <Icon size={14} className={color} />
        <Text className="text-xs text-muted-foreground">{label}</Text>
      </View>
      <Text className="text-xl font-bold text-foreground">{value}</Text>
      {subtitle && (
        <Text className="text-xs text-muted-foreground mt-0.5">{subtitle}</Text>
      )}
    </View>
  )
}

function UtilizationBar({ label, used, total, unit = '' }: { label: string; used: number; total: number; unit?: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0
  const barColor = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <View className="mb-3">
      <View className="flex-row justify-between mb-1">
        <Text className="text-xs text-muted-foreground">{label}</Text>
        <Text className="text-xs text-foreground">
          {used}{unit} / {total}{unit} ({pct}%)
        </Text>
      </View>
      <View className="h-2 bg-muted rounded-full overflow-hidden">
        <View className={cn('h-full rounded-full', barColor)} style={{ width: `${pct}%` }} />
      </View>
    </View>
  )
}

function MiniTimeline({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) {
    return (
      <View className="bg-card border border-border rounded-xl p-4">
        <Text className="text-sm font-medium text-foreground mb-2">Session Timeline</Text>
        <Text className="text-xs text-muted-foreground">Collecting data points...</Text>
      </View>
    )
  }

  const maxNodes = Math.max(...history.map((h) => h.nodes), 1)
  const maxPromoted = Math.max(...history.map((h) => h.promotedCount), 1)
  const barCount = Math.min(history.length, 20)
  const points = history.slice(-barCount)

  return (
    <View className="bg-card border border-border rounded-xl p-4">
      <Text className="text-sm font-medium text-foreground mb-3">Session Timeline</Text>
      <View className="mb-2">
        <Text className="text-xs text-muted-foreground mb-1">Nodes</Text>
        <View className="flex-row items-end gap-1 h-8">
          {points.map((p, i) => (
            <View
              key={i}
              className="flex-1 bg-blue-500 rounded-sm"
              style={{ height: `${(p.nodes / maxNodes) * 100}%`, minHeight: 2 }}
            />
          ))}
        </View>
      </View>
      <View>
        <Text className="text-xs text-muted-foreground mb-1">Promoted Pods</Text>
        <View className="flex-row items-end gap-1 h-8">
          {points.map((p, i) => (
            <View
              key={i}
              className="flex-1 bg-orange-500 rounded-sm"
              style={{ height: `${(p.promotedCount / maxPromoted) * 100}%`, minHeight: 2 }}
            />
          ))}
        </View>
      </View>
      <View className="flex-row justify-between mt-1">
        <Text className="text-[10px] text-muted-foreground">
          {new Date(points[0].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          {new Date(points[points.length - 1].time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    </View>
  )
}

function GcEventLog({ gcLog }: { gcLog: Array<{ time: number; orphans: number; idle: number }> }) {
  if (gcLog.length === 0) return null

  return (
    <View className="bg-card border border-border rounded-xl p-4">
      <Text className="text-sm font-medium text-foreground mb-2">GC Events</Text>
      {gcLog.map((entry, i) => (
        <View key={i} className="flex-row items-center gap-2 py-1">
          <Text className="text-[10px] text-muted-foreground w-16">
            {new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </Text>
          <Text className="text-xs text-foreground">
            {entry.orphans} orphans, {entry.idle} idle evicted
          </Text>
        </View>
      ))}
    </View>
  )
}

function WarmPoolSummary({
  pool,
  gc,
}: {
  pool: PoolStatus | undefined
  gc: GcStats | undefined
}) {
  return (
    <View className="bg-card border border-border rounded-xl p-4">
      <Text className="text-sm font-medium text-foreground mb-2">Warm Pool Summary</Text>
      <View className="flex-row gap-4">
        <View className="flex-1">
          <Text className="text-xs text-muted-foreground mb-1">Agents</Text>
          <Text className="text-lg font-bold text-green-400">
            {pool?.available.agent ?? 0}
            <Text className="text-xs text-muted-foreground font-normal">
              {' '}/ {pool?.targetSize.agent ?? 0} target
            </Text>
          </Text>
        </View>
        <View className="flex-1">
          <Text className="text-xs text-muted-foreground mb-1">Projects</Text>
          <Text className="text-lg font-bold text-blue-400">
            {pool?.available.project ?? 0}
            <Text className="text-xs text-muted-foreground font-normal">
              {' '}/ {pool?.targetSize.project ?? 0} target
            </Text>
          </Text>
        </View>
      </View>
      {gc?.lastGcRun && (
        <Text className="text-[10px] text-muted-foreground mt-2">
          Last GC: {new Date(gc.lastGcRun).toLocaleTimeString()}
        </Text>
      )}
    </View>
  )
}

function PromotedPodTable({
  promoted,
  idlePods,
  evicting,
  onEvict,
}: {
  promoted: PromotedPod[]
  idlePods: PromotedPod[]
  evicting: string | null
  onEvict: (projectId: string, projectName: string | null) => void
}) {
  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden">
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-sm font-medium text-foreground">
          Promoted Pods ({promoted.length})
        </Text>
      </View>

      {promoted.length === 0 ? (
        <View className="p-4 items-center">
          <CheckCircle size={20} className="text-green-400 mb-2" />
          <Text className="text-xs text-muted-foreground">No promoted pods</Text>
        </View>
      ) : (
        promoted.map((pod) => (
          <View
            key={pod.serviceName}
            className={cn('px-4 py-3 border-b border-border/50', idleBg(pod.idleSeconds))}
          >
            <View className="flex-row items-center justify-between mb-1">
              <View className="flex-1 mr-2">
                <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                  {pod.projectName || pod.projectId.slice(0, 8)}
                </Text>
                <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                  {pod.serviceName}
                </Text>
              </View>
              <Pressable
                onPress={() => onEvict(pod.projectId, pod.projectName)}
                disabled={evicting === pod.projectId}
                className="px-2 py-1 bg-red-500/10 border border-red-500/20 rounded-md"
              >
                {evicting === pod.projectId ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="text-[10px] text-red-400 font-medium">Evict</Text>
                )}
              </Pressable>
            </View>
            <View className="flex-row items-center gap-3">
              <View className="flex-row items-center gap-1">
                <Clock size={10} className={idleColor(pod.idleSeconds)} />
                <Text className={cn('text-[10px]', idleColor(pod.idleSeconds))}>
                  {formatIdleTime(pod.idleSeconds)}
                </Text>
              </View>
              <View className="flex-row items-center gap-1">
                {pod.ready ? (
                  <CheckCircle size={10} className="text-green-400" />
                ) : (
                  <AlertTriangle size={10} className="text-yellow-400" />
                )}
                <Text className="text-[10px] text-muted-foreground">
                  {pod.ready ? 'Ready' : 'Not ready'}
                </Text>
              </View>
              <Text className="text-[10px] text-muted-foreground">
                Age: {formatAge(pod.createdAt)}
              </Text>
            </View>
          </View>
        ))
      )}
    </View>
  )
}

// =============================================================================
// Main Page
// =============================================================================

export default function InfrastructurePage() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [data, setData] = useState<WarmPoolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [gcRunning, setGcRunning] = useState(false)
  const [evicting, setEvicting] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [gcLog, setGcLog] = useState<Array<{ time: number; orphans: number; idle: number }>>([])
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadData = useCallback(async () => {
    const result = await fetchWarmPool()
    if (result) {
      setData(result)
      setHistory((prev) => {
        const point: HistoryPoint = {
          time: Date.now(),
          nodes: result.cluster?.totalNodes ?? 0,
          availableAgents: result.pool.available.agent,
          promotedCount: result.promotedPods.length,
        }
        const next = [...prev, point]
        return next.length > 120 ? next.slice(-120) : next
      })
    }
    return result
  }, [])

  useEffect(() => {
    setLoading(true)
    loadData().finally(() => setLoading(false))
    autoRefreshRef.current = setInterval(loadData, AUTO_REFRESH_INTERVAL)
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    }
  }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  const onRunGc = async () => {
    setGcRunning(true)
    const result = await triggerGc()
    if (result) {
      setGcLog((prev) => [
        { time: Date.now(), orphans: result.orphansDeleted, idle: result.idleEvicted },
        ...prev.slice(0, 19),
      ])
    }
    await loadData()
    setGcRunning(false)
  }

  const onEvict = (projectId: string, projectName: string | null) => {
    Alert.alert(
      'Evict Pod',
      `Evict ${projectName || projectId}? The next access will claim a fresh warm pod.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Evict',
          style: 'destructive',
          onPress: async () => {
            setEvicting(projectId)
            await evictPod(projectId)
            await loadData()
            setEvicting(null)
          },
        },
      ]
    )
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="text-muted-foreground mt-3 text-sm">Loading infrastructure...</Text>
      </View>
    )
  }

  const pool = data?.pool
  const cluster = data?.cluster
  const promoted = data?.promotedPods ?? []
  const gc = data?.gcStats
  const idlePods = promoted.filter((p) => p.idleSeconds !== null && p.idleSeconds > 600)

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        maxWidth: isWide ? 1200 : undefined,
        width: '100%',
        alignSelf: 'center' as const,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4">
        <View className="flex-row items-center gap-2">
          <Server size={isWide ? 22 : 18} className="text-primary" />
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            Infrastructure
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={onRunGc}
            disabled={gcRunning}
            className={cn(
              'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border',
              gcRunning ? 'bg-muted border-border' : 'bg-red-500/10 border-red-500/20'
            )}
          >
            {gcRunning ? (
              <ActivityIndicator size="small" />
            ) : (
              <Trash2 size={13} className="text-red-400" />
            )}
            <Text className={cn('text-xs font-medium', gcRunning ? 'text-muted-foreground' : 'text-red-400')}>
              Run GC
            </Text>
          </Pressable>
          <View className="bg-muted/50 px-2 py-1 rounded-md">
            <Text className="text-[10px] text-muted-foreground">Auto-refresh 15s</Text>
          </View>
        </View>
      </View>

      {/* Stat Cards */}
      <View className="flex-row flex-wrap gap-2 mb-4">
        <StatCard
          label="Nodes"
          value={cluster?.totalNodes ?? '—'}
          subtitle={`ASG ${cluster?.asgDesired ?? '?'}/${cluster?.asgMax ?? '?'}`}
          icon={HardDrive}
          color="text-blue-400"
        />
        <StatCard
          label="Warm Agents"
          value={`${pool?.available.agent ?? 0}/${pool?.targetSize.agent ?? 0}`}
          subtitle={pool?.enabled ? 'Pool active' : 'Pool disabled'}
          icon={Box}
          color="text-green-400"
        />
        <StatCard
          label="Promoted"
          value={promoted.length}
          subtitle={`${idlePods.length} idle >10m`}
          icon={Activity}
          color="text-orange-400"
        />
        <StatCard
          label="GC Total"
          value={(gc?.orphansDeleted ?? 0) + (gc?.idleEvictions ?? 0)}
          subtitle={`${gc?.orphansDeleted ?? 0} orphans, ${gc?.idleEvictions ?? 0} idle`}
          icon={Trash2}
          color="text-red-400"
        />
      </View>

      {/* Utilization */}
      {cluster && (
        <View className="bg-card border border-border rounded-xl p-4 mb-4">
          <Text className="text-sm font-medium text-foreground mb-3">Cluster Utilization</Text>
          <UtilizationBar
            label="Pod Slots"
            used={cluster.usedPodSlots}
            total={cluster.totalPodSlots}
          />
          <UtilizationBar
            label="CPU"
            used={cluster.usedCpuMillis}
            total={cluster.totalCpuMillis}
            unit="m"
          />
        </View>
      )}

      {/* Timeline + GC Events: side-by-side on desktop */}
      <View className={cn('gap-4 mb-4', isWide && 'flex-row')}>
        <View className={cn(isWide && 'flex-1')}>
          <MiniTimeline history={history} />
        </View>
        {gcLog.length > 0 && (
          <View className={cn(isWide && 'flex-1')}>
            <GcEventLog gcLog={gcLog} />
          </View>
        )}
      </View>

      {/* Warm Pool Summary + Promoted Pods: side-by-side on desktop */}
      <View className={cn('gap-4', isWide && 'flex-row')}>
        <View className={cn(isWide && 'w-[340px]')}>
          <WarmPoolSummary pool={pool} gc={gc} />
        </View>
        <View className={cn(isWide && 'flex-1')}>
          <PromotedPodTable
            promoted={promoted}
            idlePods={idlePods}
            evicting={evicting}
            onEvict={onEvict}
          />
        </View>
      </View>
    </ScrollView>
  )
}
