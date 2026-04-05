// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
  TextInput,
  Modal,
} from 'react-native'
import {
  FlaskConical,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  DollarSign,
  ChevronDown,
  Activity,
  BarChart3,
  Users,
  AlertTriangle,
  MoreHorizontal,
  Pencil,
  Tag,
  Trash2,
  X,
  Check,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

const TRACK_OPTIONS = [
  'agentic', 'all', 'persona', 'canvas-v2', 'canvas-v2-lint', 'complex',
  'memory', 'personality', 'multiturn', 'mcp-discovery', 'mcp-orchestration',
  'composio', 'tool-system', 'skill-server', 'skill-server-advanced',
  'edit-file', 'bug-fix', 'coding-discipline', 'subagent', 'subagent-code',
  'subagent-coordination', 'teammate-coordination', 'business-user',
  'startup-cto', 'freelancer', 'content-creator', 'nonprofit', 'event-planner',
]

const MODEL_OPTIONS = ['haiku', 'sonnet', 'opus']

interface RunSummary {
  dirName: string
  id: string
  name: string
  track: string
  model: string
  workers: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  label: string | null
  tags: string[]
  triggeredBy: string | null
  error: string | null
  timestamp: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  summary: {
    total: number
    passed: number
    failed: number
    passRate: number
    avgScore: number
    totalPoints: number
    maxPoints: number
  }
  cost: {
    totalCost: number
    costPerEval: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
  }
  byCategory: Record<string, { total: number; passed: number; failed: number; passRate: number; avgScore: number }>
  resources: { peakCpuMillicores: number; avgCpuMillicores: number; peakMemoryMiB: number; avgMemoryMiB: number } | null
}

interface WorkerStatusData {
  workerId: number
  containerName: string
  status: 'idle' | 'running' | 'done'
  currentEval?: string
  currentEvalName?: string
  pipeline?: string
  pipelinePhase?: number
  pipelineTotal?: number
  evalsCompleted: number
  startedAt?: string
}

interface ActiveRunData {
  running: boolean
  id?: string
  pid?: number
  track?: string
  model?: string
  workers?: number
  completed?: number
  passed?: number
  failed?: number
  totalEvals?: number
  queueRemaining?: number
  workerStatus?: WorkerStatusData[]
  startedAt?: string
}

type StatusFilter = 'all' | 'completed' | 'failed' | 'cancelled'
type SortMode = 'newest' | 'passRate' | 'cost' | 'duration'

const STATUS_BADGE: Record<RunSummary['status'], { label: string; bg: string; text: string }> = {
  completed: { label: 'Completed', bg: 'bg-emerald-500/10', text: 'text-emerald-600' },
  failed: { label: 'Failed', bg: 'bg-red-500/10', text: 'text-red-600' },
  cancelled: { label: 'Cancelled', bg: 'bg-yellow-500/10', text: 'text-yellow-600' },
  running: { label: 'Running', bg: 'bg-blue-500/10', text: 'text-blue-600' },
  pending: { label: 'Pending', bg: 'bg-muted', text: 'text-muted-foreground' },
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return ts
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function patchRun(id: string, body: { label?: string | null; tags?: string[] }): Promise<RunSummary | null> {
  try {
    const res = await fetch(`${API_BASE}/runs/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function deleteRun(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/runs/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const json = await res.json()
    return json.ok === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Select Dropdown (uses Modal to escape z-index stacking issues)
// ---------------------------------------------------------------------------

function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  renderLabel,
  className: extraClass,
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  placeholder?: string
  renderLabel?: (v: T) => string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const triggerRef = useRef<View>(null)
  const label = renderLabel ? renderLabel(value) : value

  const measureAndOpen = () => {
    if (triggerRef.current) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        setLayout({ x, y, width, height })
        setOpen(true)
      })
    } else {
      setOpen(true)
    }
  }

  return (
    <View className={extraClass} ref={triggerRef}>
      <Pressable
        onPress={measureAndOpen}
        className="flex-row items-center justify-between px-3 py-2 rounded-lg border border-border bg-card min-w-[120px]"
      >
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {label || placeholder || 'Select...'}
        </Text>
        <ChevronDown
          size={14}
          className="text-muted-foreground ml-2"
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable
          className="flex-1"
          onPress={() => setOpen(false)}
        >
          <View
            className="bg-card border border-border rounded-lg shadow-lg max-h-64 overflow-hidden"
            style={{
              position: 'absolute',
              top: layout ? layout.y + layout.height + 4 : 100,
              left: layout?.x ?? 16,
              width: layout ? Math.max(layout.width, 160) : 200,
            }}
          >
            <ScrollView nestedScrollEnabled>
              {options.map((opt) => (
                <Pressable
                  key={opt}
                  onPress={() => { onChange(opt); setOpen(false) }}
                  className={cn(
                    'px-3 py-2.5 border-b border-border/30 active:bg-muted',
                    opt === value && 'bg-primary/5',
                  )}
                >
                  <Text className={cn(
                    'text-sm',
                    opt === value ? 'text-primary font-medium' : 'text-foreground',
                  )}>
                    {renderLabel ? renderLabel(opt) : opt}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Filter Bar
// ---------------------------------------------------------------------------

function FilterBar({
  runs,
  trackFilter,
  setTrackFilter,
  statusFilter,
  setStatusFilter,
  sortMode,
  setSortMode,
}: {
  runs: RunSummary[]
  trackFilter: string
  setTrackFilter: (t: string) => void
  statusFilter: StatusFilter
  setStatusFilter: (s: StatusFilter) => void
  sortMode: SortMode
  setSortMode: (s: SortMode) => void
}) {
  const availableTracks = useMemo(() => {
    const set = new Set(runs.map((r) => r.track))
    return ['all', ...Array.from(set).sort()] as string[]
  }, [runs])

  const statusOptions = ['all', 'completed', 'failed', 'cancelled'] as const
  const sortOptions = ['newest', 'passRate', 'cost', 'duration'] as const
  const sortLabels: Record<SortMode, string> = { newest: 'Newest', passRate: 'Pass Rate', cost: 'Cost', duration: 'Duration' }

  return (
    <View className="flex-row flex-wrap gap-3 mb-4 items-end">
      <View className="gap-1">
        <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Track</Text>
        <Select
          value={trackFilter}
          options={availableTracks}
          onChange={setTrackFilter}
          renderLabel={(v) => v === 'all' ? 'All Tracks' : v}
        />
      </View>
      <View className="gap-1">
        <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Status</Text>
        <Select
          value={statusFilter}
          options={statusOptions}
          onChange={setStatusFilter}
          renderLabel={(v) => v === 'all' ? 'All Statuses' : v.charAt(0).toUpperCase() + v.slice(1)}
        />
      </View>
      <View className="gap-1">
        <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Sort</Text>
        <Select
          value={sortMode}
          options={sortOptions}
          onChange={setSortMode}
          renderLabel={(v) => sortLabels[v]}
        />
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Trigger Form
// ---------------------------------------------------------------------------

function TriggerForm({ onTriggered }: { onTriggered: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [track, setTrack] = useState<string>('agentic')
  const [model, setModel] = useState<string>('sonnet')
  const [workers, setWorkers] = useState<string>('2')
  const [localMode, setLocalMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workerOptions = ['1', '2', '3', '4'] as const

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/runs/trigger`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track, model, workers: Number(workers), local: localMode }),
      })
      const json = await res.json()
      if (!json.ok) {
        setError(json.error ?? 'Failed to trigger run')
      } else {
        setExpanded(false)
        onTriggered()
      }
    } catch (e: any) {
      setError(e.message ?? 'Network error')
    }
    setSubmitting(false)
  }

  return (
    <View className="rounded-xl border border-border bg-card mb-4">
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center justify-between p-4"
      >
        <View className="flex-row items-center gap-2">
          <Play size={16} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">Run New Eval</Text>
        </View>
        <ChevronDown
          size={16}
          className="text-muted-foreground"
          style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
        />
      </Pressable>

      {expanded && (
        <View className="px-4 pb-4 gap-3 border-t border-border pt-3">
          <View className="flex-row flex-wrap gap-3">
            <View className="gap-1 flex-1 min-w-[160px]">
              <Text className="text-xs font-medium text-muted-foreground">Track</Text>
              <Select value={track} options={TRACK_OPTIONS} onChange={setTrack} />
            </View>
            <View className="gap-1 min-w-[120px]">
              <Text className="text-xs font-medium text-muted-foreground">Model</Text>
              <Select value={model} options={MODEL_OPTIONS} onChange={setModel} />
            </View>
            <View className="gap-1 min-w-[90px]">
              <Text className="text-xs font-medium text-muted-foreground">Workers</Text>
              <Select value={workers} options={workerOptions} onChange={setWorkers} />
            </View>
          </View>

          <Pressable
            onPress={() => setLocalMode(!localMode)}
            className="flex-row items-center gap-2"
          >
            <View className={cn(
              'h-5 w-5 rounded border items-center justify-center',
              localMode ? 'bg-primary border-primary' : 'border-border'
            )}>
              {localMode && <CheckCircle2 size={12} className="text-primary-foreground" />}
            </View>
            <Text className="text-sm text-foreground">Local mode (no Docker)</Text>
          </Pressable>

          {error && (
            <Text className="text-xs text-destructive">{error}</Text>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            className={cn(
              'flex-row items-center justify-center gap-2 py-2.5 rounded-lg bg-primary',
              submitting && 'opacity-50'
            )}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Play size={14} className="text-primary-foreground" />
            )}
            <Text className="text-sm font-semibold text-primary-foreground">
              {submitting ? 'Starting...' : `Run ${track} (${model})`}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Active Run Banner
// ---------------------------------------------------------------------------

function WorkerCard({ ws }: { ws: WorkerStatusData }) {
  const statusColor = ws.status === 'running' ? 'border-blue-500/40 bg-blue-500/5'
    : ws.status === 'done' ? 'border-emerald-500/40 bg-emerald-500/5'
    : 'border-muted bg-muted/30'
  const dotColor = ws.status === 'running' ? 'bg-blue-500' : ws.status === 'done' ? 'bg-emerald-500' : 'bg-muted-foreground'

  const elapsed = ws.startedAt && ws.status === 'running'
    ? Math.round((Date.now() - new Date(ws.startedAt).getTime()) / 1000)
    : null

  return (
    <View className={cn('rounded-lg border p-2.5 flex-1 min-w-[140px]', statusColor)}>
      <View className="flex-row items-center gap-1.5 mb-1.5">
        <View className={cn('w-2 h-2 rounded-full', dotColor)} />
        <Text className="text-[10px] font-bold text-muted-foreground">Worker {ws.workerId}</Text>
        <Text className="text-[10px] text-muted-foreground/60 ml-auto">{ws.evalsCompleted} done</Text>
      </View>
      {ws.status === 'running' && ws.currentEvalName ? (
        <View>
          <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>{ws.currentEvalName}</Text>
          <View className="flex-row items-center gap-2 mt-1">
            {ws.pipeline && (
              <Text className="text-[9px] text-muted-foreground">{ws.pipeline} ({ws.pipelinePhase}/{ws.pipelineTotal})</Text>
            )}
            {elapsed !== null && (
              <Text className="text-[9px] text-muted-foreground">{elapsed}s</Text>
            )}
          </View>
        </View>
      ) : ws.status === 'done' ? (
        <Text className="text-[10px] text-emerald-600">Finished</Text>
      ) : (
        <Text className="text-[10px] text-muted-foreground">Waiting...</Text>
      )}
    </View>
  )
}

function ActiveRunBanner({ data, onCancel }: { data: ActiveRunData; onCancel: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  const router = useRouter()
  if (!data.running) return null

  const completed = data.completed ?? 0
  const passed = data.passed ?? 0
  const failed = data.failed ?? 0
  const total = data.totalEvals ?? 0
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0

  const handleCancel = async () => {
    if (!data.id || cancelling) return
    setCancelling(true)
    try {
      await fetch(`${API_BASE}/runs/${data.id}/cancel`, {
        method: 'POST',
        credentials: 'include',
      })
      onCancel()
    } catch { /* ignore */ }
    setCancelling(false)
  }

  return (
    <Pressable
      onPress={() => data.id && router.push(`/(admin)/evals/${data.id}`)}
      className="rounded-xl border border-primary/30 bg-primary/5 p-4 mb-4 active:opacity-80"
    >
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" />
          <Text className="text-sm font-semibold text-foreground">Eval Run In Progress</Text>
          {data.track && (
            <View className="px-2 py-0.5 rounded-md bg-muted">
              <Text className="text-[10px] font-medium text-muted-foreground">{data.track}</Text>
            </View>
          )}
          {data.model && (
            <View className="px-2 py-0.5 rounded-md bg-muted">
              <Text className="text-[10px] font-medium text-muted-foreground">{data.model}</Text>
            </View>
          )}
        </View>
        {data.id && (
          <Pressable
            onPress={(e) => { e.stopPropagation(); handleCancel() }}
            disabled={cancelling}
            className="px-3 py-1.5 rounded-lg border border-destructive/30 bg-destructive/5 active:bg-destructive/10"
          >
            <Text className="text-xs font-medium text-destructive">
              {cancelling ? 'Cancelling...' : 'Cancel'}
            </Text>
          </Pressable>
        )}
      </View>

      {total > 0 && (
        <View className="mb-2">
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-[10px] text-muted-foreground">{completed}/{total} evals ({progressPct}%)</Text>
            {data.queueRemaining !== undefined && data.queueRemaining > 0 && (
              <Text className="text-[10px] text-muted-foreground">{data.queueRemaining} work items remaining</Text>
            )}
          </View>
          <View className="h-1.5 rounded-full bg-muted overflow-hidden">
            <View className="h-full rounded-full bg-primary" style={{ width: `${progressPct}%` }} />
          </View>
        </View>
      )}

      <View className="flex-row gap-4 mb-3">
        <View className="flex-row items-center gap-1">
          <Activity size={12} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">{completed} completed</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <CheckCircle2 size={12} className="text-emerald-500" />
          <Text className="text-xs text-emerald-600">{passed} passed</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <XCircle size={12} className="text-red-500" />
          <Text className="text-xs text-red-600">{failed} failed</Text>
        </View>
      </View>

      {data.workerStatus && data.workerStatus.length > 0 && (
        <View>
          <View className="flex-row items-center gap-1 mb-2">
            <Users size={11} className="text-muted-foreground" />
            <Text className="text-[10px] font-semibold text-muted-foreground">Workers</Text>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {data.workerStatus.map((ws) => (
              <WorkerCard key={ws.workerId} ws={ws} />
            ))}
          </View>
        </View>
      )}
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Tag Input
// ---------------------------------------------------------------------------

function TagInput({
  tags,
  onSave,
}: {
  tags: string[]
  onSave: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const addTag = () => {
    const trimmed = draft.trim().toLowerCase()
    if (trimmed && !tags.includes(trimmed)) {
      onSave([...tags, trimmed])
    }
    setDraft('')
  }

  const removeTag = (tag: string) => {
    onSave(tags.filter((t) => t !== tag))
  }

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-1.5">
        {tags.map((tag) => (
          <View key={tag} className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-primary/10 border border-primary/20">
            <Text className="text-[11px] font-medium text-primary">{tag}</Text>
            <Pressable onPress={() => removeTag(tag)} hitSlop={6}>
              <X size={10} className="text-primary/60" />
            </Pressable>
          </View>
        ))}
      </View>
      <View className="flex-row gap-2">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addTag}
          placeholder="Add tag..."
          className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-background text-sm text-foreground"
          placeholderTextColor="#999"
          autoCapitalize="none"
        />
        {draft.trim() && (
          <Pressable onPress={addTag} className="px-2.5 py-1.5 rounded-lg bg-primary/10 items-center justify-center">
            <Check size={14} className="text-primary" />
          </Pressable>
        )}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Delete Confirmation Modal
// ---------------------------------------------------------------------------

function DeleteConfirmModal({
  visible,
  runLabel,
  onConfirm,
  onCancel,
  deleting,
}: {
  visible: boolean
  runLabel: string
  onConfirm: () => void
  onCancel: () => void
  deleting: boolean
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 items-center justify-center bg-black/50 px-6">
        <View className="bg-card rounded-2xl border border-border p-6 w-full max-w-sm">
          <View className="flex-row items-center gap-2 mb-3">
            <Trash2 size={18} className="text-destructive" />
            <Text className="text-base font-semibold text-foreground">Delete Eval Run</Text>
          </View>
          <Text className="text-sm text-muted-foreground mb-5">
            Are you sure you want to delete "{runLabel}"? This will permanently remove the run and all its results.
          </Text>
          <View className="flex-row gap-3 justify-end">
            <Pressable
              onPress={onCancel}
              disabled={deleting}
              className="px-4 py-2 rounded-lg border border-border active:bg-muted/50"
            >
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={deleting}
              className={cn('px-4 py-2 rounded-lg bg-destructive active:opacity-80', deleting && 'opacity-50')}
            >
              <Text className="text-sm font-semibold text-white">
                {deleting ? 'Deleting...' : 'Delete'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Run Card
// ---------------------------------------------------------------------------

function RunCard({
  run,
  onUpdate,
  onDelete,
}: {
  run: RunSummary
  onUpdate: (updated: RunSummary) => void
  onDelete: (id: string) => void
}) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuLayout, setMenuLayout] = useState<{ y: number; height: number } | null>(null)
  const menuAnchorRef = useRef<View>(null)
  const [editingLabel, setEditingLabel] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [labelDraft, setLabelDraft] = useState(run.label ?? '')
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const s = run.summary
  const passRate = s.total > 0 ? (s.passed / s.total) * 100 : 0
  const barColor = passRate >= 80 ? 'bg-emerald-500' : passRate >= 60 ? 'bg-yellow-500' : 'bg-red-500'
  const badge = STATUS_BADGE[run.status] ?? STATUS_BADGE.completed
  const displayTitle = run.label || run.track
  const canManage = run.status !== 'running' && run.status !== 'pending'

  const saveLabel = async () => {
    setEditingLabel(false)
    const trimmed = labelDraft.trim() || null
    if (trimmed === run.label) return
    const updated = await patchRun(run.id, { label: trimmed })
    if (updated) onUpdate(updated)
  }

  const saveTags = async (tags: string[]) => {
    const updated = await patchRun(run.id, { tags })
    if (updated) onUpdate(updated)
  }

  const handleDelete = async () => {
    setDeleting(true)
    const ok = await deleteRun(run.id)
    setDeleting(false)
    setShowDelete(false)
    if (ok) onDelete(run.id)
  }

  return (
    <>
      <Pressable
        onPress={() => router.push(`/(admin)/evals/${encodeURIComponent(run.dirName)}` as any)}
        className="rounded-xl border border-border bg-card p-4 active:bg-muted/30"
      >
        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center gap-2 flex-1">
            <View className={cn(
              'h-2.5 w-2.5 rounded-full',
              passRate >= 80 ? 'bg-emerald-500' : passRate >= 60 ? 'bg-yellow-500' : 'bg-red-500'
            )} />
            {editingLabel ? (
              <TextInput
                value={labelDraft}
                onChangeText={setLabelDraft}
                onBlur={saveLabel}
                onSubmitEditing={saveLabel}
                autoFocus
                className="text-sm font-semibold text-foreground border-b border-primary px-1 py-0 min-w-[100px]"
                placeholder={run.track}
                placeholderTextColor="#999"
              />
            ) : (
              <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                {displayTitle}
              </Text>
            )}
            {run.label && (
              <View className="px-1.5 py-0.5 rounded bg-muted">
                <Text className="text-[9px] font-medium text-muted-foreground">{run.track}</Text>
              </View>
            )}
            <View className="px-2 py-0.5 rounded-md bg-muted">
              <Text className="text-[10px] font-medium text-muted-foreground">{run.model}</Text>
            </View>
            <View className={cn('px-2 py-0.5 rounded-full', badge.bg)}>
              <Text className={cn('text-[10px] font-medium', badge.text)}>{badge.label}</Text>
            </View>
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-muted-foreground">{formatTimestamp(run.timestamp)}</Text>
            {canManage && (
              <View>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation()
                    if (menuOpen) { setMenuOpen(false); return }
                    if (menuAnchorRef.current) {
                      menuAnchorRef.current.measureInWindow((_x, y, _w, h) => {
                        setMenuLayout({ y, height: h })
                        setMenuOpen(true)
                      })
                    } else {
                      setMenuOpen(true)
                    }
                  }}
                  className="p-1.5 rounded-md active:bg-muted/50"
                  hitSlop={4}
                  ref={menuAnchorRef}
                >
                  <MoreHorizontal size={14} className="text-muted-foreground" />
                </Pressable>
                <Modal visible={menuOpen} transparent animationType="none" onRequestClose={() => setMenuOpen(false)}>
                  <Pressable className="flex-1" onPress={() => setMenuOpen(false)}>
                    <View
                      className="bg-card border border-border rounded-lg shadow-lg min-w-[140px] overflow-hidden"
                      style={{
                        position: 'absolute',
                        top: menuLayout ? menuLayout.y + menuLayout.height + 4 : 100,
                        right: 16,
                      }}
                    >
                      <Pressable
                        onPress={() => {
                          setMenuOpen(false)
                          setLabelDraft(run.label ?? '')
                          setEditingLabel(true)
                        }}
                        className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted"
                      >
                        <Pencil size={13} className="text-muted-foreground" />
                        <Text className="text-sm text-foreground">Rename</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setMenuOpen(false)
                          setEditingTags(!editingTags)
                        }}
                        className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted border-t border-border/30"
                      >
                        <Tag size={13} className="text-muted-foreground" />
                        <Text className="text-sm text-foreground">Edit Tags</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setMenuOpen(false)
                          setShowDelete(true)
                        }}
                        className="flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted border-t border-border/30"
                      >
                        <Trash2 size={13} className="text-destructive" />
                        <Text className="text-sm text-destructive">Delete</Text>
                      </Pressable>
                    </View>
                  </Pressable>
                </Modal>
              </View>
            )}
          </View>
        </View>

        {run.tags.length > 0 && !editingTags && (
          <View className="flex-row flex-wrap gap-1 mb-2">
            {run.tags.map((tag) => (
              <View key={tag} className="px-2 py-0.5 rounded-md bg-primary/8 border border-primary/15">
                <Text className="text-[10px] font-medium text-primary">{tag}</Text>
              </View>
            ))}
          </View>
        )}

        {editingTags && (
          <Pressable onPress={(e) => e.stopPropagation()} className="mb-3">
            <TagInput tags={run.tags} onSave={saveTags} />
          </Pressable>
        )}

        {run.status === 'failed' && run.error && (
          <View className="flex-row items-start gap-1.5 mb-3 px-1">
            <AlertTriangle size={12} className="text-destructive mt-0.5" />
            <Text className="text-xs text-destructive flex-1" numberOfLines={2}>
              {run.error}
            </Text>
          </View>
        )}

        <View className="gap-1.5 mb-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-medium text-muted-foreground">Pass Rate</Text>
            <Text className="text-xs font-semibold text-foreground">
              {s.passed}/{s.total} ({passRate.toFixed(1)}%)
            </Text>
          </View>
          <View className="h-2 bg-muted rounded-full overflow-hidden">
            <View className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.min(passRate, 100)}%` }} />
          </View>
        </View>

        <View className="flex-row flex-wrap gap-x-4 gap-y-1">
          <View className="flex-row items-center gap-1">
            <FlaskConical size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              Avg {s.avgScore.toFixed(1)} pts
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <DollarSign size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              ${run.cost.totalCost.toFixed(4)}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Clock size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              {formatDuration(run.durationMs)}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Users size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              {run.workers} worker{run.workers !== 1 ? 's' : ''}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Activity size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              {fmtTokens(run.cost.totalInputTokens + run.cost.totalOutputTokens)} tokens
            </Text>
          </View>
        </View>

        {Object.keys(run.byCategory).length > 1 && (
          <View className="mt-3 pt-3 border-t border-border/50 flex-row flex-wrap gap-x-3 gap-y-1">
            {Object.entries(run.byCategory).slice(0, 6).map(([cat, cs]) => (
              <Text key={cat} className="text-[10px] text-muted-foreground">
                {cat}: {cs.passed}/{cs.total}
              </Text>
            ))}
            {Object.keys(run.byCategory).length > 6 && (
              <Text className="text-[10px] text-muted-foreground">
                +{Object.keys(run.byCategory).length - 6} more
              </Text>
            )}
          </View>
        )}
      </Pressable>

      <DeleteConfirmModal
        visible={showDelete}
        runLabel={displayTitle}
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
        deleting={deleting}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function EvalsPage() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [refreshing, setRefreshing] = useState(false)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeRun, setActiveRun] = useState<ActiveRunData>({ running: false })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [trackFilter, setTrackFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('newest')

  const loadRuns = useCallback(async () => {
    const data = await fetchJson<{ runs: RunSummary[] }>('/runs')
    if (data) setRuns(data.runs)
    setLoading(false)
  }, [])

  const checkActive = useCallback(async () => {
    const data = await fetchJson<ActiveRunData>('/runs/active')
    if (data) setActiveRun(data)
  }, [])

  useEffect(() => {
    loadRuns()
    checkActive()
    pollRef.current = setInterval(checkActive, 10_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [loadRuns, checkActive])

  const prevRunning = useRef(activeRun.running)
  useEffect(() => {
    if (prevRunning.current && !activeRun.running) {
      loadRuns()
    }
    prevRunning.current = activeRun.running
  }, [activeRun.running, loadRuns])

  const onRefresh = async () => {
    setRefreshing(true)
    await Promise.all([loadRuns(), checkActive()])
    setRefreshing(false)
  }

  const handleRunUpdate = useCallback((updated: RunSummary) => {
    setRuns((prev) => prev.map((r) => r.id === updated.id ? updated : r))
  }, [])

  const handleRunDelete = useCallback((id: string) => {
    setRuns((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const filteredRuns = useMemo(() => {
    let result = runs

    if (trackFilter !== 'all') {
      result = result.filter((r) => r.track === trackFilter)
    }
    if (statusFilter !== 'all') {
      result = result.filter((r) => r.status === statusFilter)
    }

    const sorted = [...result]
    switch (sortMode) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        break
      case 'passRate':
        sorted.sort((a, b) => b.summary.passRate - a.summary.passRate)
        break
      case 'cost':
        sorted.sort((a, b) => b.cost.totalCost - a.cost.totalCost)
        break
      case 'duration':
        sorted.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
        break
    }
    return sorted
  }, [runs, trackFilter, statusFilter, sortMode])

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <View className="flex-row items-center justify-between mb-6">
        <View>
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            Eval Runs
          </Text>
          <Text className="text-sm text-muted-foreground mt-0.5">
            Run agent evals and view performance results
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <Pressable
            onPress={() => router.push('/(admin)/evals/analytics' as any)}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border active:bg-muted/50"
          >
            <BarChart3 size={14} className="text-primary" />
            <Text className="text-xs font-medium text-foreground">Analytics</Text>
          </Pressable>
          <View className="flex-row items-center gap-2">
            <FlaskConical size={20} className="text-primary" />
            <Text className="text-sm font-medium text-muted-foreground">
              {runs.length} run{runs.length !== 1 ? 's' : ''}
            </Text>
          </View>
        </View>
      </View>

      <TriggerForm onTriggered={() => { checkActive(); loadRuns() }} />

      <ActiveRunBanner data={activeRun} onCancel={() => { checkActive(); loadRuns() }} />

      {loading ? (
        <View className="items-center justify-center py-20">
          <ActivityIndicator size="large" />
          <Text className="text-sm text-muted-foreground mt-3">Loading eval runs...</Text>
        </View>
      ) : runs.length === 0 ? (
        <View className="items-center justify-center py-20 rounded-xl border border-dashed border-border">
          <FlaskConical size={32} className="text-muted-foreground mb-3" />
          <Text className="text-sm font-medium text-muted-foreground">No eval runs yet</Text>
          <Text className="text-xs text-muted-foreground mt-1">
            Trigger a new run above to get started
          </Text>
        </View>
      ) : (
        <>
          <FilterBar
            runs={runs}
            trackFilter={trackFilter}
            setTrackFilter={setTrackFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            sortMode={sortMode}
            setSortMode={setSortMode}
          />
          {filteredRuns.length === 0 ? (
            <View className="items-center justify-center py-16 rounded-xl border border-dashed border-border">
              <Text className="text-sm text-muted-foreground">No runs match the current filters</Text>
            </View>
          ) : (
            <View className="gap-3">
              {filteredRuns.map((run) => (
                <RunCard
                  key={run.dirName}
                  run={run}
                  onUpdate={handleRunUpdate}
                  onDelete={handleRunDelete}
                />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}
