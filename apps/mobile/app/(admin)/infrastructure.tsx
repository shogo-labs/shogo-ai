// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Infrastructure - Warm pool, cluster nodes, promoted pods, GC status,
 * and persistent historical charts backed by InfraSnapshot data.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  useWindowDimensions,
  Switch,
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
  Settings,
  Save,
  Globe,
  ChevronDown,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const LOCAL_API_BASE = `${API_URL}/api/admin`
const AUTO_REFRESH_INTERVAL = 15_000

function regionApiBase(regionId: string | null, currentRegionId: string | null): string {
  if (!regionId || regionId === currentRegionId) return LOCAL_API_BASE
  return `${LOCAL_API_BASE}/regions/${regionId}/api/admin`
}

// =============================================================================
// Types
// =============================================================================

interface PoolStatus {
  enabled: boolean
  available: number
  assigned: number
  targetSize: number
}

interface ClusterCapacity {
  totalNodes: number
  totalPodSlots: number
  usedPodSlots: number
  availablePodSlots: number
  totalCpuMillis: number
  usedCpuMillis: number
  limitCpuMillis: number
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

interface InfraHistoryPoint {
  timestamp: string
  totalNodes: number
  asgDesired: number
  totalPodSlots: number
  usedPodSlots: number
  totalCpuMillis: number
  usedCpuMillis: number
  limitCpuMillis: number
  warmAvailable: number
  warmTarget: number
  warmAssigned: number
  totalProjects: number
  readyProjects: number
  runningProjects: number
  scaledToZero: number
}

interface RegionInfo {
  id: string
  label: string
}

interface RegionsResponse {
  current: RegionInfo
  peers: RegionInfo[]
}

type HistoryPeriod = '1h' | '6h' | '24h' | '7d' | '30d'

const HISTORY_PERIOD_LABELS: Record<HistoryPeriod, string> = {
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
}

// =============================================================================
// API
// =============================================================================

async function fetchRegions(): Promise<RegionsResponse | null> {
  try {
    const res = await fetch(`${LOCAL_API_BASE}/regions`, { credentials: 'include' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchWarmPool(apiBase: string): Promise<WarmPoolData | null> {
  try {
    const res = await fetch(`${apiBase}/warm-pool`, { credentials: 'include' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchInfraHistory(apiBase: string, period: HistoryPeriod): Promise<InfraHistoryPoint[] | null> {
  try {
    const res = await fetch(`${apiBase}/analytics/infra-history?period=${period}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function triggerGc(apiBase: string): Promise<{ orphansDeleted: number; idleEvicted: number } | null> {
  try {
    const res = await fetch(`${apiBase}/warm-pool/gc`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function evictPod(apiBase: string, projectId: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/warm-pool/evict/${projectId}`, {
      method: 'POST',
      credentials: 'include',
    })
    return res.ok
  } catch {
    return false
  }
}

interface InfraSettings {
  warmPoolMinPods: number
  reconcileIntervalMs: number
  maxPodAgeMs: number
  promotedPodIdleTimeoutMs: number
  promotedPodGcEnabled: boolean
}

async function fetchInfraSettings(apiBase: string): Promise<InfraSettings | null> {
  try {
    const res = await fetch(`${apiBase}/settings/infrastructure`, { credentials: 'include' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function saveInfraSettings(apiBase: string, patch: Partial<InfraSettings>): Promise<{ ok: boolean; config?: InfraSettings; error?: string }> {
  try {
    const res = await fetch(`${apiBase}/settings/infrastructure`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const json = await res.json()
    if (!res.ok) return { ok: false, error: json.error || 'Failed to save' }
    return { ok: true, config: json.config }
  } catch (err: any) {
    return { ok: false, error: err.message }
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

function InfraStatCard({
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

function UtilizationBar({ label, used, total, limit, unit = '' }: { label: string; used: number; total: number; limit?: number; unit?: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0
  const limitPct = limit && total > 0 ? Math.min(Math.round((limit / total) * 100), 100) : 0
  const barColor = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <View className="mb-3">
      <View className="flex-row justify-between mb-1">
        <Text className="text-xs text-muted-foreground">{label}</Text>
        <Text className="text-xs text-foreground">
          {used}{unit} / {total}{unit} ({pct}%)
          {limit ? ` · limit ${limit}${unit} (${limitPct}%)` : ''}
        </Text>
      </View>
      <View className="h-2 bg-muted rounded-full overflow-hidden">
        {limit && limitPct > pct ? (
          <View className="h-full flex-row" style={{ width: `${limitPct}%` }}>
            <View className={cn('h-full rounded-l-full', barColor)} style={{ width: `${Math.round((pct / limitPct) * 100)}%` }} />
            <View className="h-full bg-orange-400/40 rounded-r-full" style={{ flex: 1 }} />
          </View>
        ) : (
          <View className={cn('h-full rounded-full', barColor)} style={{ width: `${pct}%` }} />
        )}
      </View>
    </View>
  )
}

function HistoryPeriodSelector({
  value,
  onChange,
}: {
  value: HistoryPeriod
  onChange: (p: HistoryPeriod) => void
}) {
  return (
    <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {(Object.keys(HISTORY_PERIOD_LABELS) as HistoryPeriod[]).map((p) => (
        <Pressable
          key={p}
          onPress={() => onChange(p)}
          className={cn(
            'px-2.5 py-1 rounded-md',
            value === p ? 'bg-background shadow-sm' : ''
          )}
        >
          <Text
            className={cn(
              'text-xs font-medium',
              value === p ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {HISTORY_PERIOD_LABELS[p]}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function RegionSelector({
  regions,
  currentRegionId,
  selectedRegionId,
  onChange,
}: {
  regions: RegionsResponse | null
  currentRegionId: string | null
  selectedRegionId: string | null
  onChange: (regionId: string) => void
}) {
  if (!regions || regions.peers.length === 0) return null

  const allRegions = [regions.current, ...regions.peers]
  const selected = selectedRegionId || regions.current.id
  const isLocal = selected === regions.current.id

  return (
    <View className="flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
      {allRegions.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => onChange(r.id)}
          className={cn(
            'flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md',
            selected === r.id ? 'bg-background shadow-sm' : ''
          )}
        >
          <Globe
            size={11}
            className={cn(
              selected === r.id
                ? r.id === regions.current.id
                  ? 'text-green-400'
                  : 'text-blue-400'
                : 'text-muted-foreground'
            )}
          />
          <Text
            className={cn(
              'text-xs font-medium',
              selected === r.id ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {r.label}
          </Text>
          {r.id === regions.current.id && selected === r.id && (
            <View className="h-1.5 w-1.5 rounded-full bg-green-400" />
          )}
        </Pressable>
      ))}
    </View>
  )
}

function InfraHistoryChart({
  data,
  loading,
}: {
  data: InfraHistoryPoint[] | null
  loading: boolean
}) {
  if (loading) {
    return (
      <View className="h-40 items-center justify-center">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  if (!data || data.length < 2) {
    return (
      <View className="h-32 items-center justify-center">
        <Text className="text-sm text-muted-foreground">
          {data?.length === 1 ? 'Collecting more data points...' : 'No historical data yet — snapshots collected every 60s'}
        </Text>
      </View>
    )
  }

  const barCount = Math.min(data.length, 80)
  const step = Math.max(1, Math.floor(data.length / barCount))
  const sampled = data.filter((_, i) => i % step === 0)

  const maxNodes = Math.max(...sampled.map((d) => d.totalNodes), 1)
  const maxPods = Math.max(...sampled.map((d) => d.runningProjects), 1)
  const maxWarm = Math.max(...sampled.map((d) => d.warmAvailable), 1)
  const maxVal = Math.max(maxNodes, maxPods, maxWarm, 1)

  return (
    <View>
      <View className="flex-row items-end gap-px" style={{ height: 100 }}>
        {sampled.map((point, i) => {
          const nodeH = (point.totalNodes / maxVal) * 100
          const podH = (point.runningProjects / maxVal) * 100
          const warmH = (point.warmAvailable / maxVal) * 100
          return (
            <View key={i} className="flex-1 flex-row items-end gap-px" style={{ height: 100 }}>
              <View className="flex-1 bg-blue-500/70 rounded-t-sm" style={{ height: Math.max(nodeH, 2) }} />
              <View className="flex-1 bg-emerald-500/70 rounded-t-sm" style={{ height: Math.max(podH, 2) }} />
              <View className="flex-1 bg-amber-500/70 rounded-t-sm" style={{ height: Math.max(warmH, 2) }} />
            </View>
          )
        })}
      </View>
      <View className="flex-row justify-between mt-2">
        <Text className="text-[10px] text-muted-foreground">
          {new Date(sampled[0]?.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </Text>
        <Text className="text-[10px] text-muted-foreground">
          {new Date(sampled[sampled.length - 1]?.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
      <View className="flex-row items-center gap-4 mt-3">
        <View className="flex-row items-center gap-1.5">
          <View className="h-2.5 w-2.5 rounded-full bg-blue-500" />
          <Text className="text-[11px] text-muted-foreground">Nodes ({sampled[sampled.length - 1]?.totalNodes})</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <View className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <Text className="text-[11px] text-muted-foreground">Running Pods ({sampled[sampled.length - 1]?.runningProjects})</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <View className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          <Text className="text-[11px] text-muted-foreground">Warm Available ({sampled[sampled.length - 1]?.warmAvailable})</Text>
        </View>
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
          <Text className="text-xs text-muted-foreground mb-1">Available</Text>
          <Text className="text-lg font-bold text-green-400">
            {pool?.available ?? 0}
            <Text className="text-xs text-muted-foreground font-normal">
              {' '}/ {pool?.targetSize ?? 0} target
            </Text>
          </Text>
        </View>
        <View className="flex-1">
          <Text className="text-xs text-muted-foreground mb-1">Assigned</Text>
          <Text className="text-lg font-bold text-blue-400">
            {pool?.assigned ?? 0}
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
// Settings Panel
// =============================================================================

function SettingsField({
  label,
  hint,
  value,
  onChange,
  suffix,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  suffix?: string
}) {
  return (
    <View className="mb-3">
      <Text className="text-xs font-medium text-foreground mb-1">{label}</Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground"
          value={value}
          onChangeText={onChange}
          keyboardType="numeric"
          placeholderTextColor="#666"
        />
        {suffix && <Text className="text-xs text-muted-foreground">{suffix}</Text>}
      </View>
      {hint && <Text className="text-[10px] text-muted-foreground mt-0.5">{hint}</Text>}
    </View>
  )
}

function InfraSettingsPanel({
  settings,
  apiBase,
  onSaved,
}: {
  settings: InfraSettings
  apiBase: string
  onSaved: (config: InfraSettings) => void
}) {
  const [form, setForm] = useState({
    warmPoolMinPods: String(settings.warmPoolMinPods),
    reconcileIntervalMs: String(settings.reconcileIntervalMs / 1000),
    maxPodAgeMs: String(settings.maxPodAgeMs / 60000),
    promotedPodIdleTimeoutMs: String(settings.promotedPodIdleTimeoutMs / 60000),
    promotedPodGcEnabled: settings.promotedPodGcEnabled,
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setForm({
      warmPoolMinPods: String(settings.warmPoolMinPods),
      reconcileIntervalMs: String(settings.reconcileIntervalMs / 1000),
      maxPodAgeMs: String(settings.maxPodAgeMs / 60000),
      promotedPodIdleTimeoutMs: String(settings.promotedPodIdleTimeoutMs / 60000),
      promotedPodGcEnabled: settings.promotedPodGcEnabled,
    })
  }, [settings])

  const onSave = async () => {
    setSaving(true)
    setMessage(null)
    const patch: Partial<InfraSettings> = {
      warmPoolMinPods: parseInt(form.warmPoolMinPods, 10),
      reconcileIntervalMs: Math.round(parseFloat(form.reconcileIntervalMs) * 1000),
      maxPodAgeMs: Math.round(parseFloat(form.maxPodAgeMs) * 60000),
      promotedPodIdleTimeoutMs: Math.round(parseFloat(form.promotedPodIdleTimeoutMs) * 60000),
      promotedPodGcEnabled: form.promotedPodGcEnabled,
    }
    const result = await saveInfraSettings(apiBase, patch)
    setSaving(false)
    if (result.ok && result.config) {
      setMessage({ type: 'ok', text: 'Settings saved and applied' })
      onSaved(result.config)
    } else {
      setMessage({ type: 'error', text: result.error || 'Save failed' })
    }
    setTimeout(() => setMessage(null), 4000)
  }

  return (
    <View className="bg-card border border-border rounded-xl p-4 mb-4">
      <View className="flex-row items-center gap-2 mb-3">
        <Settings size={14} className="text-primary" />
        <Text className="text-sm font-medium text-foreground">Infrastructure Settings</Text>
        <Text className="text-[10px] text-muted-foreground ml-1">Changes apply immediately</Text>
      </View>

      <View className="flex-row flex-wrap gap-x-6">
        <View className="flex-1 min-w-[200px]">
          <Text className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Warm Pool</Text>
          <SettingsField
            label="Min Pods"
            hint="Number of warm pods to keep ready in this region"
            value={form.warmPoolMinPods}
            onChange={(v) => setForm((f) => ({ ...f, warmPoolMinPods: v }))}
          />
          <SettingsField
            label="Max Pod Age"
            value={form.maxPodAgeMs}
            onChange={(v) => setForm((f) => ({ ...f, maxPodAgeMs: v }))}
            suffix="min"
            hint="Warm pods older than this are recycled"
          />
        </View>

        <View className="flex-1 min-w-[200px]">
          <Text className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Lifecycle</Text>
          <SettingsField
            label="Reconcile Interval"
            value={form.reconcileIntervalMs}
            onChange={(v) => setForm((f) => ({ ...f, reconcileIntervalMs: v }))}
            suffix="sec"
            hint="How often the controller checks pool state"
          />
          <SettingsField
            label="Idle Timeout"
            value={form.promotedPodIdleTimeoutMs}
            onChange={(v) => setForm((f) => ({ ...f, promotedPodIdleTimeoutMs: v }))}
            suffix="min"
            hint="Promoted pods idle longer than this are evicted"
          />
          <View className="flex-row items-center justify-between mb-3">
            <View>
              <Text className="text-xs font-medium text-foreground">GC Enabled</Text>
              <Text className="text-[10px] text-muted-foreground">Auto-evict orphaned and idle pods</Text>
            </View>
            <Switch
              value={form.promotedPodGcEnabled}
              onValueChange={(v) => setForm((f) => ({ ...f, promotedPodGcEnabled: v }))}
            />
          </View>
        </View>
      </View>

      <View className="flex-row items-center gap-3 mt-2">
        <Pressable
          onPress={onSave}
          disabled={saving}
          className={cn(
            'flex-row items-center gap-1.5 px-4 py-2 rounded-lg',
            saving ? 'bg-muted' : 'bg-primary'
          )}
        >
          {saving ? (
            <ActivityIndicator size="small" />
          ) : (
            <Save size={13} className="text-primary-foreground" />
          )}
          <Text className={cn('text-xs font-medium', saving ? 'text-muted-foreground' : 'text-primary-foreground')}>
            Save & Apply
          </Text>
        </Pressable>
        {message && (
          <Text className={cn('text-xs', message.type === 'ok' ? 'text-green-400' : 'text-red-400')}>
            {message.text}
          </Text>
        )}
      </View>
    </View>
  )
}

// =============================================================================
// Main Page
// =============================================================================

export default function InfrastructurePage() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [regions, setRegions] = useState<RegionsResponse | null>(null)
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)

  const [data, setData] = useState<WarmPoolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [gcRunning, setGcRunning] = useState(false)
  const [evicting, setEvicting] = useState<string | null>(null)
  const [gcLog, setGcLog] = useState<Array<{ time: number; orphans: number; idle: number }>>([])

  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>('24h')
  const [historyData, setHistoryData] = useState<InfraHistoryPoint[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [infraSettings, setInfraSettings] = useState<InfraSettings | null>(null)

  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const apiBase = regionApiBase(selectedRegionId, regions?.current.id ?? null)
  const isRemoteRegion = selectedRegionId != null && selectedRegionId !== regions?.current.id

  const loadLiveData = useCallback(async () => {
    const base = regionApiBase(selectedRegionId, regions?.current.id ?? null)
    const result = await fetchWarmPool(base)
    if (result) setData(result)
    return result
  }, [selectedRegionId, regions])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    const base = regionApiBase(selectedRegionId, regions?.current.id ?? null)
    const result = await fetchInfraHistory(base, historyPeriod)
    setHistoryData(result)
    setHistoryLoading(false)
  }, [historyPeriod, selectedRegionId, regions])

  const loadSettings = useCallback(async () => {
    const base = regionApiBase(selectedRegionId, regions?.current.id ?? null)
    const result = await fetchInfraSettings(base)
    if (result) setInfraSettings(result)
  }, [selectedRegionId, regions])

  useEffect(() => {
    fetchRegions().then((r) => {
      if (r) {
        setRegions(r)
        setSelectedRegionId(r.current.id)
      }
    })
  }, [])

  useEffect(() => {
    if (!regions) return
    setLoading(true)
    setData(null)
    setInfraSettings(null)
    setHistoryData(null)
    setGcLog([])
    Promise.all([loadLiveData(), loadHistory(), loadSettings()]).finally(() => setLoading(false))

    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    autoRefreshRef.current = setInterval(loadLiveData, AUTO_REFRESH_INTERVAL)
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    }
  }, [selectedRegionId, regions])

  useEffect(() => {
    if (regions) loadHistory()
  }, [historyPeriod])

  const onRefresh = async () => {
    setRefreshing(true)
    await Promise.all([loadLiveData(), loadHistory()])
    setRefreshing(false)
  }

  const onRunGc = async () => {
    setGcRunning(true)
    const result = await triggerGc(apiBase)
    if (result) {
      setGcLog((prev) => [
        { time: Date.now(), orphans: result.orphansDeleted, idle: result.idleEvicted },
        ...prev.slice(0, 19),
      ])
    }
    await loadLiveData()
    setGcRunning(false)
  }

  const onRegionChange = (regionId: string) => {
    setSelectedRegionId(regionId)
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
            await evictPod(apiBase, projectId)
            await loadLiveData()
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
      <View className="flex-row items-center justify-between mb-2">
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

      {/* Region Selector */}
      {regions && regions.peers.length > 0 && (
        <View className="mb-4">
          <RegionSelector
            regions={regions}
            currentRegionId={regions.current.id}
            selectedRegionId={selectedRegionId}
            onChange={onRegionChange}
          />
          {isRemoteRegion && (
            <View className="flex-row items-center gap-1.5 mt-2 px-2">
              <Globe size={11} className="text-blue-400" />
              <Text className="text-[11px] text-blue-400">
                Viewing remote region — changes apply to {regions.peers.find((p) => p.id === selectedRegionId)?.label ?? selectedRegionId}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Stat Cards */}
      <View className="flex-row flex-wrap gap-2 mb-4">
        <InfraStatCard
          label="Nodes"
          value={cluster?.totalNodes ?? '—'}
          subtitle={`ASG ${cluster?.asgDesired ?? '?'}/${cluster?.asgMax ?? '?'}`}
          icon={HardDrive}
          color="text-blue-400"
        />
        <InfraStatCard
          label="Warm Pool"
          value={`${pool?.available ?? 0}/${pool?.targetSize ?? 0}`}
          subtitle={pool?.enabled ? 'Pool active' : 'Pool disabled'}
          icon={Box}
          color="text-green-400"
        />
        <InfraStatCard
          label="Promoted"
          value={promoted.length}
          subtitle={`${idlePods.length} idle >10m`}
          icon={Activity}
          color="text-orange-400"
        />
        <InfraStatCard
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
            label="CPU (requested → limit)"
            used={cluster.usedCpuMillis}
            total={cluster.totalCpuMillis}
            limit={cluster.limitCpuMillis || undefined}
            unit="m"
          />
        </View>
      )}

      {/* Historical Charts (DB-backed) */}
      <View className="bg-card border border-border rounded-xl p-4 mb-4">
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-sm font-medium text-foreground">Historical Metrics</Text>
          <HistoryPeriodSelector value={historyPeriod} onChange={setHistoryPeriod} />
        </View>
        <InfraHistoryChart data={historyData} loading={historyLoading} />
      </View>

      {/* GC Events + Warm Pool Summary: side-by-side on desktop */}
      <View className={cn('gap-4 mb-4', isWide && 'flex-row')}>
        <View className={cn(isWide && 'flex-1')}>
          <WarmPoolSummary pool={pool} gc={gc} />
        </View>
        {gcLog.length > 0 && (
          <View className={cn(isWide && 'flex-1')}>
            <GcEventLog gcLog={gcLog} />
          </View>
        )}
      </View>

      {/* Infrastructure Settings */}
      {infraSettings && (
        <InfraSettingsPanel
          settings={infraSettings}
          apiBase={apiBase}
          onSaved={(config) => {
            setInfraSettings(config)
            loadLiveData()
          }}
        />
      )}

      {/* Promoted Pods */}
      <View>
        <PromotedPodTable
          promoted={promoted}
          idlePods={idlePods}
          evicting={evicting}
          onEvict={onEvict}
        />
      </View>
    </ScrollView>
  )
}
