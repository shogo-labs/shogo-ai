// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Heartbeats - Observability + control of the autonomous-agent heartbeat
 * scheduler. Lists every project's AgentConfig with breaker state, lets admins
 * toggle/edit/trigger heartbeats, and pause/resume the in-process scheduler.
 *
 * Note: scheduler controls (pause/resume, stats, breaker) are per-API-instance.
 * Multi-pod production deployments have a scheduler per pod; the UI surfaces
 * this caveat explicitly.
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
  Modal,
  Switch,
  useWindowDimensions,
} from 'react-native'
import {
  Heart,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Pause,
  Play,
  Zap,
  Search,
  RefreshCw,
  Settings,
  X,
  Save,
  Moon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../lib/api'

const API_BASE = `${API_URL}/api/admin`
const AUTO_REFRESH_INTERVAL = 15_000

// =============================================================================
// Types
// =============================================================================

interface SchedulerStats {
  running: boolean
  paused: boolean
  startedAt: string | null
  lastTickAt: string | null
  lastBatchSize: number
  lastTickDurationMs: number
  totalTicks: number
  totalTriggered: number
  totalFailed: number
  totalQuietSkips: number
  pollIntervalMs: number
  batchSize: number
  triggerTimeoutMs: number
  logPrefix: string
}

interface BackoffEntry {
  projectId: string
  projectName: string | null
  workspaceName: string | null
  count: number
  backoffUntil: number
}

interface OverviewData {
  kind: 'cloud' | 'local'
  stats: SchedulerStats
  counts: {
    enabled: number
    total: number
    dueNow: number
    inBackoff: number
  }
  backoff: BackoffEntry[]
}

interface HeartbeatRow {
  id: string
  projectId: string
  heartbeatEnabled: boolean
  heartbeatInterval: number
  nextHeartbeatAt: string | null
  lastHeartbeatAt: string | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
  quietHoursTimezone: string | null
  modelProvider: string
  modelName: string
  updatedAt: string
  project: {
    id: string
    name: string
    workspaceId: string
    workspace: { id: string; name: string; slug: string } | null
  }
  breaker: { count: number; backoffUntil: number } | null
}

interface ListResponse {
  rows: HeartbeatRow[]
  page: number
  pageSize: number
  total: number
}

type SortKey = 'nextHeartbeatAt' | 'lastHeartbeatAt' | 'projectName'

// =============================================================================
// API
// =============================================================================

async function fetchOverview(): Promise<OverviewData | null> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/overview`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function fetchList(params: {
  page: number
  pageSize: number
  search?: string
  enabledOnly?: boolean
  dueWithinSec?: number | null
  inBackoff?: boolean
  sort?: SortKey
}): Promise<ListResponse | null> {
  try {
    const qs = new URLSearchParams()
    qs.set('page', String(params.page))
    qs.set('pageSize', String(params.pageSize))
    if (params.search) qs.set('search', params.search)
    if (params.enabledOnly) qs.set('enabledOnly', 'true')
    if (params.dueWithinSec != null) qs.set('dueWithinSec', String(params.dueWithinSec))
    if (params.inBackoff) qs.set('inBackoff', 'true')
    if (params.sort) qs.set('sort', params.sort)
    const res = await fetch(`${API_BASE}/heartbeats?${qs.toString()}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function pauseScheduler(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/scheduler/pause`, {
      method: 'POST',
      credentials: 'include',
    })
    return res.ok
  } catch {
    return false
  }
}

async function resumeScheduler(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/scheduler/resume`, {
      method: 'POST',
      credentials: 'include',
    })
    return res.ok
  } catch {
    return false
  }
}

async function triggerProject(projectId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/projects/${projectId}/trigger`, {
      method: 'POST',
      credentials: 'include',
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: json?.error?.message || `HTTP ${res.status}` }
    return json.data ?? { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

async function patchProject(
  projectId: string,
  patch: Partial<{
    heartbeatEnabled: boolean
    heartbeatInterval: number
    quietHoursStart: string | null
    quietHoursEnd: string | null
    quietHoursTimezone: string | null
  }>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/projects/${projectId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      return { ok: false, error: json?.error?.message || `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

async function clearFailures(projectId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/heartbeats/projects/${projectId}/clear-failures`, {
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

function relativeTime(iso: string | null | undefined, opts?: { future?: boolean }): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const diffMs = opts?.future ? t - Date.now() : Date.now() - t
  const past = diffMs < 0
  const seconds = Math.floor(Math.abs(diffMs) / 1000)
  let str: string
  if (seconds < 60) str = `${seconds}s`
  else if (seconds < 3600) str = `${Math.floor(seconds / 60)}m`
  else if (seconds < 86400) str = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  else str = `${Math.floor(seconds / 86400)}d`
  if (opts?.future) return past ? `${str} overdue` : `in ${str}`
  return `${str} ago`
}

function relativeTimeFromMs(ms: number, opts?: { future?: boolean }): string {
  return relativeTime(new Date(ms).toISOString(), opts)
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.floor(seconds / 86400)}d`
}

function nextDueColor(row: HeartbeatRow): string {
  if (!row.heartbeatEnabled || !row.nextHeartbeatAt) return 'text-muted-foreground'
  const due = new Date(row.nextHeartbeatAt).getTime()
  const now = Date.now()
  if (due < now - row.heartbeatInterval * 1000) return 'text-red-400'
  if (due < now + 60 * 1000) return 'text-yellow-400'
  return 'text-foreground'
}

function quietHoursLabel(row: HeartbeatRow): string {
  if (!row.quietHoursStart || !row.quietHoursEnd) return '—'
  const tz = row.quietHoursTimezone ? ` ${row.quietHoursTimezone}` : ''
  return `${row.quietHoursStart}–${row.quietHoursEnd}${tz}`
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

function SchedulerCard({
  overview,
  onTogglePause,
  busy,
}: {
  overview: OverviewData
  onTogglePause: () => void
  busy: boolean
}) {
  const { stats, counts, kind } = overview
  const statusBadge = !stats.running
    ? { label: 'Stopped', cls: 'bg-muted text-muted-foreground' }
    : stats.paused
    ? { label: 'Paused', cls: 'bg-yellow-500/15 text-yellow-400' }
    : { label: 'Running', cls: 'bg-green-500/15 text-green-400' }

  return (
    <View className="bg-card border border-border rounded-xl p-4 mb-4">
      <View className="flex-row items-center gap-2 mb-3">
        <Activity size={14} className="text-primary" />
        <Text className="text-sm font-medium text-foreground">Scheduler</Text>
        <View className={cn('px-2 py-0.5 rounded-full', statusBadge.cls)}>
          <Text className={cn('text-[10px] font-semibold', statusBadge.cls)}>
            {statusBadge.label}
          </Text>
        </View>
        <Text className="text-[10px] text-muted-foreground ml-1">
          {kind === 'cloud' ? 'cloud (this API instance only)' : 'local dev'}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2 mb-3">
        <StatCard
          label="Enabled"
          value={counts.enabled}
          subtitle={`${counts.total} total configs`}
          icon={Heart}
          color="text-pink-400"
        />
        <StatCard
          label="Due now"
          value={counts.dueNow}
          subtitle={counts.dueNow > 0 ? 'will fire next tick' : 'caught up'}
          icon={Clock}
          color={counts.dueNow > 0 ? 'text-yellow-400' : 'text-green-400'}
        />
        <StatCard
          label="Triggered"
          value={stats.totalTriggered}
          subtitle={`${stats.totalFailed} failed · ${stats.totalQuietSkips} quiet`}
          icon={Zap}
          color="text-primary"
        />
        <StatCard
          label="In backoff"
          value={counts.inBackoff}
          subtitle={counts.inBackoff > 0 ? 'circuit breaker active' : 'no failures'}
          icon={AlertTriangle}
          color={counts.inBackoff > 0 ? 'text-red-400' : 'text-muted-foreground'}
        />
      </View>

      <View className="flex-row flex-wrap gap-x-6 gap-y-1 mb-3">
        <Text className="text-[11px] text-muted-foreground">
          Started: {stats.startedAt ? relativeTime(stats.startedAt) : '—'}
        </Text>
        <Text className="text-[11px] text-muted-foreground">
          Last tick: {stats.lastTickAt ? relativeTime(stats.lastTickAt) : '—'}
          {stats.lastTickAt ? ` (${stats.lastBatchSize} due, ${stats.lastTickDurationMs}ms)` : ''}
        </Text>
        <Text className="text-[11px] text-muted-foreground">
          Total ticks: {stats.totalTicks}
        </Text>
        <Text className="text-[11px] text-muted-foreground">
          Poll: {Math.round(stats.pollIntervalMs / 1000)}s · batch {stats.batchSize}
        </Text>
      </View>

      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={onTogglePause}
          disabled={busy || !stats.running}
          className={cn(
            'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
            busy || !stats.running
              ? 'bg-muted'
              : stats.paused
              ? 'bg-green-500/15'
              : 'bg-yellow-500/15'
          )}
        >
          {busy ? (
            <ActivityIndicator size="small" />
          ) : stats.paused ? (
            <Play size={13} className="text-green-400" />
          ) : (
            <Pause size={13} className="text-yellow-400" />
          )}
          <Text
            className={cn(
              'text-xs font-medium',
              busy || !stats.running
                ? 'text-muted-foreground'
                : stats.paused
                ? 'text-green-400'
                : 'text-yellow-400'
            )}
          >
            {stats.paused ? 'Resume scheduler' : 'Pause scheduler'}
          </Text>
        </Pressable>
        <Text className="text-[10px] text-muted-foreground flex-1">
          Affects this API instance only.{' '}
          {kind === 'cloud' ? 'Other pods continue scheduling.' : ''}
        </Text>
      </View>
    </View>
  )
}

function FilterRow({
  search,
  onSearchChange,
  enabledOnly,
  onEnabledOnlyChange,
  dueSoon,
  onDueSoonChange,
  inBackoff,
  onInBackoffChange,
  sort,
  onSortChange,
  onRefresh,
}: {
  search: string
  onSearchChange: (v: string) => void
  enabledOnly: boolean
  onEnabledOnlyChange: (v: boolean) => void
  dueSoon: boolean
  onDueSoonChange: (v: boolean) => void
  inBackoff: boolean
  onInBackoffChange: (v: boolean) => void
  sort: SortKey
  onSortChange: (v: SortKey) => void
  onRefresh: () => void
}) {
  const Toggle = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <Pressable
      onPress={() => onChange(!value)}
      className={cn(
        'flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-lg border',
        value ? 'bg-primary/10 border-primary/40' : 'bg-card border-border'
      )}
    >
      <Text className={cn('text-xs font-medium', value ? 'text-primary' : 'text-muted-foreground')}>
        {label}
      </Text>
    </Pressable>
  )

  const SortBtn = ({ label, value }: { label: string; value: SortKey }) => (
    <Pressable
      onPress={() => onSortChange(value)}
      className={cn(
        'px-2.5 py-1 rounded-md',
        sort === value ? 'bg-background shadow-sm' : ''
      )}
    >
      <Text
        className={cn(
          'text-xs font-medium',
          sort === value ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
      </Text>
    </Pressable>
  )

  return (
    <View className="bg-card border border-border rounded-xl p-3 mb-4 gap-2">
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center bg-muted rounded-lg px-2.5">
          <Search size={14} className="text-muted-foreground" />
          <TextInput
            className="flex-1 px-2 py-2 text-sm text-foreground"
            placeholder="Search project or workspace..."
            placeholderTextColor="#888"
            value={search}
            onChangeText={onSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.length > 0 && (
            <Pressable onPress={() => onSearchChange('')} className="p-1">
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
        <Pressable
          onPress={onRefresh}
          className="p-2 rounded-lg bg-muted active:bg-muted/70"
          accessibilityLabel="Refresh list"
        >
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        <Toggle label="Enabled only" value={enabledOnly} onChange={onEnabledOnlyChange} />
        <Toggle label="Due within 5m" value={dueSoon} onChange={onDueSoonChange} />
        <Toggle label="In backoff" value={inBackoff} onChange={onInBackoffChange} />
        <View className="ml-auto flex-row items-center bg-muted rounded-lg p-0.5 gap-0.5">
          <SortBtn label="Next due" value="nextHeartbeatAt" />
          <SortBtn label="Last tick" value="lastHeartbeatAt" />
          <SortBtn label="Project" value="projectName" />
        </View>
      </View>
    </View>
  )
}

function HeartbeatRowItem({
  row,
  busy,
  onToggle,
  onTrigger,
  onEdit,
  onClearFailures,
}: {
  row: HeartbeatRow
  busy: boolean
  onToggle: (next: boolean) => void
  onTrigger: () => void
  onEdit: () => void
  onClearFailures: () => void
}) {
  const projectName = row.project?.name ?? row.projectId
  const wsName = row.project?.workspace?.name ?? '—'

  return (
    <View className="bg-card border border-border rounded-xl p-3 mb-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              {projectName}
            </Text>
            {row.breaker && (
              <View className="flex-row items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500/15">
                <AlertTriangle size={10} className="text-red-400" />
                <Text className="text-[10px] font-medium text-red-400">
                  {row.breaker.count}× · retry {relativeTimeFromMs(row.breaker.backoffUntil, { future: true })}
                </Text>
              </View>
            )}
            {row.quietHoursStart && row.quietHoursEnd && (
              <View className="flex-row items-center gap-1">
                <Moon size={10} className="text-blue-400" />
                <Text className="text-[10px] text-blue-400">{quietHoursLabel(row)}</Text>
              </View>
            )}
          </View>
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {wsName} · {row.modelProvider}/{row.modelName}
          </Text>
        </View>

        <View className="flex-row items-center gap-2">
          <Switch value={row.heartbeatEnabled} onValueChange={onToggle} disabled={busy} />
        </View>
      </View>

      <View className="flex-row flex-wrap gap-x-4 gap-y-1 mt-2">
        <View>
          <Text className="text-[10px] text-muted-foreground">Interval</Text>
          <Text className="text-xs font-medium text-foreground">
            {formatInterval(row.heartbeatInterval)}
          </Text>
        </View>
        <View>
          <Text className="text-[10px] text-muted-foreground">Last tick</Text>
          <Text className="text-xs font-medium text-foreground">
            {relativeTime(row.lastHeartbeatAt)}
          </Text>
        </View>
        <View>
          <Text className="text-[10px] text-muted-foreground">Next tick</Text>
          <Text className={cn('text-xs font-medium', nextDueColor(row))}>
            {row.heartbeatEnabled
              ? relativeTime(row.nextHeartbeatAt, { future: true })
              : 'disabled'}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-2 mt-3">
        <Pressable
          onPress={onTrigger}
          disabled={busy}
          className={cn(
            'flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg',
            busy ? 'bg-muted' : 'bg-primary/10'
          )}
        >
          <Zap size={11} className={busy ? 'text-muted-foreground' : 'text-primary'} />
          <Text
            className={cn('text-[11px] font-medium', busy ? 'text-muted-foreground' : 'text-primary')}
          >
            Trigger now
          </Text>
        </Pressable>
        <Pressable
          onPress={onEdit}
          disabled={busy}
          className={cn(
            'flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg',
            busy ? 'bg-muted' : 'bg-muted/70'
          )}
        >
          <Settings size={11} className="text-muted-foreground" />
          <Text className="text-[11px] font-medium text-muted-foreground">Edit</Text>
        </Pressable>
        {row.breaker && (
          <Pressable
            onPress={onClearFailures}
            disabled={busy}
            className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/10"
          >
            <CheckCircle size={11} className="text-red-400" />
            <Text className="text-[11px] font-medium text-red-400">Clear failures</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

function EditModal({
  visible,
  row,
  onClose,
  onSaved,
}: {
  visible: boolean
  row: HeartbeatRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const [intervalSec, setIntervalSec] = useState('')
  const [qStart, setQStart] = useState('')
  const [qEnd, setQEnd] = useState('')
  const [qTz, setQTz] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (row) {
      setIntervalSec(String(row.heartbeatInterval))
      setQStart(row.quietHoursStart ?? '')
      setQEnd(row.quietHoursEnd ?? '')
      setQTz(row.quietHoursTimezone ?? '')
      setError(null)
    }
  }, [row?.id, visible])

  if (!row) return null

  const onSave = async () => {
    const intervalNum = parseInt(intervalSec, 10)
    if (!Number.isFinite(intervalNum) || intervalNum < 60) {
      setError('Interval must be a number >= 60 seconds.')
      return
    }
    setSaving(true)
    setError(null)
    const result = await patchProject(row.projectId, {
      heartbeatInterval: intervalNum,
      quietHoursStart: qStart.trim() || null,
      quietHoursEnd: qEnd.trim() || null,
      quietHoursTimezone: qTz.trim() || null,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error || 'Save failed')
      return
    }
    onSaved()
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-black/50 items-center justify-center p-4">
        <View className="bg-card border border-border rounded-xl p-4 w-full max-w-md">
          <View className="flex-row items-center mb-3">
            <Settings size={14} className="text-primary mr-2" />
            <Text className="text-sm font-semibold text-foreground flex-1" numberOfLines={1}>
              Edit heartbeat — {row.project?.name ?? row.projectId}
            </Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          <Text className="text-xs font-medium text-foreground mb-1">Interval (seconds)</Text>
          <TextInput
            className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground mb-1"
            value={intervalSec}
            onChangeText={setIntervalSec}
            keyboardType="numeric"
            placeholderTextColor="#666"
          />
          <Text className="text-[10px] text-muted-foreground mb-3">
            Minimum 60. Currently {formatInterval(row.heartbeatInterval)}.
          </Text>

          <Text className="text-xs font-medium text-foreground mb-1">Quiet hours start (HH:MM)</Text>
          <TextInput
            className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground mb-3"
            value={qStart}
            onChangeText={setQStart}
            placeholder="22:00"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text className="text-xs font-medium text-foreground mb-1">Quiet hours end (HH:MM)</Text>
          <TextInput
            className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground mb-3"
            value={qEnd}
            onChangeText={setQEnd}
            placeholder="08:00"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text className="text-xs font-medium text-foreground mb-1">Timezone</Text>
          <TextInput
            className="bg-muted border border-border rounded-lg px-3 py-2 text-sm text-foreground mb-3"
            value={qTz}
            onChangeText={setQTz}
            placeholder="America/Los_Angeles"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {error && (
            <Text className="text-xs text-red-400 mb-2">{error}</Text>
          )}

          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-3 py-2 rounded-lg bg-muted active:bg-muted/70"
            >
              <Text className="text-xs font-medium text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              disabled={saving}
              className={cn(
                'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
                saving ? 'bg-muted' : 'bg-primary'
              )}
            >
              {saving ? (
                <ActivityIndicator size="small" />
              ) : (
                <Save size={12} className="text-primary-foreground" />
              )}
              <Text
                className={cn(
                  'text-xs font-medium',
                  saving ? 'text-muted-foreground' : 'text-primary-foreground'
                )}
              >
                Save
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// =============================================================================
// Main Page
// =============================================================================

export default function HeartbeatsPage() {
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [list, setList] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [search, setSearch] = useState('')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [dueSoon, setDueSoon] = useState(false)
  const [inBackoff, setInBackoff] = useState(false)
  const [sort, setSort] = useState<SortKey>('nextHeartbeatAt')
  const [page, setPage] = useState(1)
  const pageSize = 50

  const [pauseBusy, setPauseBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<HeartbeatRow | null>(null)

  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const debouncedSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    if (debouncedSearchRef.current) clearTimeout(debouncedSearchRef.current)
    debouncedSearchRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => {
      if (debouncedSearchRef.current) clearTimeout(debouncedSearchRef.current)
    }
  }, [search])

  const loadOverview = useCallback(async () => {
    const result = await fetchOverview()
    if (result) setOverview(result)
  }, [])

  const loadList = useCallback(async () => {
    const result = await fetchList({
      page,
      pageSize,
      search: debouncedSearch || undefined,
      enabledOnly,
      dueWithinSec: dueSoon ? 5 * 60 : null,
      inBackoff,
      sort,
    })
    if (result) setList(result)
  }, [page, pageSize, debouncedSearch, enabledOnly, dueSoon, inBackoff, sort])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, enabledOnly, dueSoon, inBackoff, sort])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadOverview(), loadList()]).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    if (editing) return
    autoRefreshRef.current = setInterval(() => {
      loadOverview()
      loadList()
    }, AUTO_REFRESH_INTERVAL)
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    }
  }, [editing, loadOverview, loadList])

  const onRefresh = async () => {
    setRefreshing(true)
    await Promise.all([loadOverview(), loadList()])
    setRefreshing(false)
  }

  const onTogglePause = () => {
    if (!overview) return
    const isPaused = overview.stats.paused
    Alert.alert(
      isPaused ? 'Resume scheduler?' : 'Pause scheduler?',
      isPaused
        ? 'Scheduling will resume on this API instance. Heartbeats will fire again.'
        : 'No heartbeats will be triggered on this API instance until you resume. Other pods (in production) keep running.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isPaused ? 'Resume' : 'Pause',
          style: isPaused ? 'default' : 'destructive',
          onPress: async () => {
            setPauseBusy(true)
            const ok = isPaused ? await resumeScheduler() : await pauseScheduler()
            await loadOverview()
            setPauseBusy(false)
            if (!ok) Alert.alert('Error', 'Failed to update scheduler state.')
          },
        },
      ]
    )
  }

  const onToggleRow = async (row: HeartbeatRow, next: boolean) => {
    setList((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.projectId === row.projectId ? { ...r, heartbeatEnabled: next } : r
            ),
          }
        : prev
    )
    setRowBusy(row.projectId)
    const result = await patchProject(row.projectId, { heartbeatEnabled: next })
    setRowBusy(null)
    if (!result.ok) {
      setList((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) =>
                r.projectId === row.projectId ? { ...r, heartbeatEnabled: !next } : r
              ),
            }
          : prev
      )
      Alert.alert('Error', result.error || 'Failed to update heartbeat')
    } else {
      loadList()
    }
  }

  const onTriggerRow = async (row: HeartbeatRow) => {
    setRowBusy(row.projectId)
    const result = await triggerProject(row.projectId)
    setRowBusy(null)
    if (result.ok) {
      Alert.alert('Triggered', `Heartbeat fired for ${row.project?.name ?? row.projectId}.`)
    } else {
      Alert.alert('Trigger failed', result.error || 'Unknown error')
    }
    loadOverview()
  }

  const onClearRow = async (row: HeartbeatRow) => {
    setRowBusy(row.projectId)
    const ok = await clearFailures(row.projectId)
    setRowBusy(null)
    if (!ok) {
      Alert.alert('Error', 'Failed to clear failures')
      return
    }
    await Promise.all([loadOverview(), loadList()])
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="text-muted-foreground mt-3 text-sm">Loading heartbeats...</Text>
      </View>
    )
  }

  const rows = list?.rows ?? []
  const total = list?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="flex-row items-center gap-2 mb-4">
        <Heart size={20} className="text-pink-400" />
        <Text className="text-2xl font-bold text-foreground">Heartbeats</Text>
        <Text className="text-xs text-muted-foreground ml-2">
          Autonomous-agent scheduler
        </Text>
      </View>

      {overview && (
        <SchedulerCard overview={overview} onTogglePause={onTogglePause} busy={pauseBusy} />
      )}

      <FilterRow
        search={search}
        onSearchChange={setSearch}
        enabledOnly={enabledOnly}
        onEnabledOnlyChange={setEnabledOnly}
        dueSoon={dueSoon}
        onDueSoonChange={setDueSoon}
        inBackoff={inBackoff}
        onInBackoffChange={setInBackoff}
        sort={sort}
        onSortChange={setSort}
        onRefresh={() => {
          loadOverview()
          loadList()
        }}
      />

      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-xs text-muted-foreground">
          {total} {total === 1 ? 'config' : 'configs'} · page {page} of {pageCount}
        </Text>
        <View className="flex-row items-center gap-1">
          <Pressable
            disabled={page <= 1}
            onPress={() => setPage((p) => Math.max(1, p - 1))}
            className={cn(
              'px-2.5 py-1 rounded-md',
              page <= 1 ? 'bg-muted/50' : 'bg-muted active:bg-muted/70'
            )}
          >
            <Text
              className={cn(
                'text-xs font-medium',
                page <= 1 ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              Prev
            </Text>
          </Pressable>
          <Pressable
            disabled={page >= pageCount}
            onPress={() => setPage((p) => Math.min(pageCount, p + 1))}
            className={cn(
              'px-2.5 py-1 rounded-md',
              page >= pageCount ? 'bg-muted/50' : 'bg-muted active:bg-muted/70'
            )}
          >
            <Text
              className={cn(
                'text-xs font-medium',
                page >= pageCount ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              Next
            </Text>
          </Pressable>
        </View>
      </View>

      {rows.length === 0 ? (
        <View className="bg-card border border-border rounded-xl p-6 items-center">
          <Text className="text-sm text-muted-foreground">
            No heartbeat configs match the current filters.
          </Text>
        </View>
      ) : (
        rows.map((row) => (
          <HeartbeatRowItem
            key={row.id}
            row={row}
            busy={rowBusy === row.projectId}
            onToggle={(next) => onToggleRow(row, next)}
            onTrigger={() => onTriggerRow(row)}
            onEdit={() => setEditing(row)}
            onClearFailures={() => onClearRow(row)}
          />
        ))
      )}

      <EditModal
        visible={editing !== null}
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          loadList()
          loadOverview()
        }}
      />
    </ScrollView>
  )
}
