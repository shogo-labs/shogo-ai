// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  FlaskConical,
  DollarSign,
  Clock,
  Cpu,
  ChevronDown,
  AlertTriangle,
  FileText,
  X,
  Activity,
  Users,
  Hash,
  User,
  Coins,
  MemoryStick,
  Zap,
  Download,
} from 'lucide-react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalResultItem {
  id: string
  name: string
  category: string
  level?: number
  passed: boolean
  score: number
  maxScore: number
  percentage: number
  durationMs: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  toolCallCount: number
  failedToolCalls: number
  iterations: number
  phaseScores: { intention: { percentage: number }; execution: { percentage: number } } | null
  pipeline: string | null
  pipelinePhase: number | null
  triggeredAntiPatterns: string[]
  errors: string[]
  runtimeWarnings: string[]
  criteriaResults: Array<{
    description: string
    phase: string
    points: number
    pointsEarned: number
    passed: boolean
  }>
}

interface ProgressItem {
  id: string
  score: number
  max: number
  passed: boolean
}

interface RunDetail {
  dirName: string
  id: string
  name: string
  track: string
  model: string
  workers: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
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
  progress?: ProgressItem[]
  totalEvals?: number
  queueRemaining?: number
  workerStatus?: Array<{
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
  }>
  results: EvalResultItem[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function fmtMillicores(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} cores`
  return `${m}m`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon: Icon,
  subtitle,
  accent = 'bg-primary/10',
  iconColor = 'text-primary',
}: {
  label: string
  value: string | number | undefined
  icon: React.ComponentType<{ size?: number; className?: string }>
  subtitle?: string
  accent?: string
  iconColor?: string
}) {
  return (
    <View className="flex-1 min-w-[140px] rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</Text>
        <View className={cn('h-7 w-7 rounded-lg items-center justify-center', accent)}>
          <Icon size={14} className={iconColor} />
        </View>
      </View>
      <Text className="text-2xl font-bold text-foreground">
        {value !== undefined ? (typeof value === 'number' ? value.toLocaleString() : value) : '—'}
      </Text>
      {subtitle && (
        <Text className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</Text>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Run Metadata
// ---------------------------------------------------------------------------

function RunMetadata({ data }: { data: RunDetail }) {
  return (
    <View className="flex-row flex-wrap gap-3 mb-4">
      <View className="flex-row items-center gap-1.5">
        <Clock size={12} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">{formatDuration(data.durationMs)}</Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Users size={12} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">{data.workers} workers</Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <Hash size={12} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground font-mono" numberOfLines={1}>
          {data.id.length > 12 ? data.id.slice(0, 12) + '…' : data.id}
        </Text>
      </View>
      {data.triggeredBy && (
        <View className="flex-row items-center gap-1.5">
          <User size={12} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">{data.triggeredBy}</Text>
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Status Banner
// ---------------------------------------------------------------------------

function StatusBanner({ status, error, data, onStop }: { status: string; error: string | null; data?: RunDetail; onStop?: () => void }) {
  const [stopping, setStopping] = useState(false)

  if (status === 'running') {
    const completed = data?.progress?.length ?? data?.summary.total ?? 0
    const total = data?.totalEvals ?? 0
    const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0
    const ws = data?.workerStatus

    const handleStop = async () => {
      if (!data?.id || stopping) return
      setStopping(true)
      try {
        await fetch(`${API_BASE}/runs/${data.id}/cancel`, {
          method: 'POST',
          credentials: 'include',
        })
        onStop?.()
      } catch { /* ignore */ }
      setStopping(false)
    }

    return (
      <View className="rounded-xl border border-primary/30 bg-primary/5 p-4 mb-4">
        <View className="flex-row items-center gap-3 mb-2">
          <ActivityIndicator size="small" />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Eval Run In Progress</Text>
            {total > 0 ? (
              <Text className="text-xs text-muted-foreground">{completed}/{total} evals completed ({progressPct}%)</Text>
            ) : (
              <Text className="text-xs text-muted-foreground">Results update automatically every 10 seconds</Text>
            )}
          </View>
          <Pressable
            onPress={handleStop}
            disabled={stopping}
            className={cn(
              'px-3 py-1.5 rounded-lg border border-destructive/30 bg-destructive/5 active:bg-destructive/10',
              stopping && 'opacity-50',
            )}
          >
            <Text className="text-xs font-medium text-destructive">
              {stopping ? 'Stopping...' : 'Stop Run'}
            </Text>
          </Pressable>
        </View>

        {total > 0 && (
          <View className="h-1.5 rounded-full bg-primary/10 overflow-hidden mb-3">
            <View className="h-full rounded-full bg-primary" style={{ width: `${progressPct}%` }} />
          </View>
        )}

        {ws && ws.length > 0 && (
          <View>
            <Text className="text-[10px] font-semibold text-muted-foreground mb-2">WORKERS</Text>
            <View className="flex-row flex-wrap gap-2">
              {ws.map((w) => {
                const dotColor = w.status === 'running' ? 'bg-blue-500' : w.status === 'done' ? 'bg-emerald-500' : 'bg-muted-foreground'
                const borderColor = w.status === 'running' ? 'border-blue-500/30' : w.status === 'done' ? 'border-emerald-500/30' : 'border-muted'
                const elapsed = w.startedAt && w.status === 'running'
                  ? Math.round((Date.now() - new Date(w.startedAt).getTime()) / 1000)
                  : null
                return (
                  <View key={w.workerId} className={cn('rounded-lg border p-2 flex-1 min-w-[140px]', borderColor)}>
                    <View className="flex-row items-center gap-1.5 mb-1">
                      <View className={cn('w-2 h-2 rounded-full', dotColor)} />
                      <Text className="text-[10px] font-bold text-muted-foreground">Worker {w.workerId}</Text>
                      <Text className="text-[10px] text-muted-foreground/60 ml-auto">{w.evalsCompleted} done</Text>
                    </View>
                    {w.status === 'running' && w.currentEvalName ? (
                      <View>
                        <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>{w.currentEvalName}</Text>
                        <View className="flex-row items-center gap-2 mt-0.5">
                          {w.pipeline && (
                            <Text className="text-[9px] text-muted-foreground">Pipeline: {w.pipeline} ({w.pipelinePhase}/{w.pipelineTotal})</Text>
                          )}
                          {elapsed !== null && (
                            <Text className="text-[9px] text-muted-foreground">{elapsed}s</Text>
                          )}
                        </View>
                      </View>
                    ) : w.status === 'done' ? (
                      <Text className="text-[10px] text-emerald-600">Finished</Text>
                    ) : (
                      <Text className="text-[10px] text-muted-foreground">Waiting...</Text>
                    )}
                  </View>
                )
              })}
            </View>
          </View>
        )}
      </View>
    )
  }
  if (status === 'failed') {
    return (
      <View className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 mb-4 gap-2">
        <View className="flex-row items-center gap-3">
          <XCircle size={18} className="text-destructive" />
          <Text className="text-sm font-semibold text-destructive">Eval Run Failed</Text>
        </View>
        {error && (
          <Text className="text-xs text-destructive/80 font-mono ml-[30px]">{error}</Text>
        )}
      </View>
    )
  }
  if (status === 'cancelled') {
    return (
      <View className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 mb-4 flex-row items-center gap-3">
        <AlertTriangle size={18} className="text-yellow-600" />
        <Text className="text-sm font-semibold text-yellow-700">Eval Run Cancelled</Text>
      </View>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Export Training Data
// ---------------------------------------------------------------------------

function ExportButton({ runId, filter, label }: { runId: string; filter: 'all' | 'passing' | 'failing'; label: string }) {
  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch(`${API_BASE}/export`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds: [runId], filter, format: 'jsonl' }),
      })
      if (!res.ok) throw new Error('Export failed')
      const text = await res.text()
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const blob = new Blob([text], { type: 'application/x-ndjson' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `eval-export-${filter}-${Date.now()}.jsonl`
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch { /* ignore */ }
    setExporting(false)
  }

  return (
    <Pressable
      onPress={handleExport}
      disabled={exporting}
      className={cn(
        'flex-row items-center gap-1.5 px-3 py-2 rounded-lg border border-border active:bg-muted/30',
        exporting && 'opacity-50'
      )}
    >
      <Download size={12} className="text-muted-foreground" />
      <Text className="text-[11px] font-medium text-foreground">
        {exporting ? 'Exporting...' : label}
      </Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Cost & Token Breakdown
// ---------------------------------------------------------------------------

function CostBreakdown({ cost, total }: { cost: RunDetail['cost']; total: number }) {
  const tokenDenom = cost.totalInputTokens + cost.totalCacheReadTokens + cost.totalCacheWriteTokens
  const cacheHitRate = tokenDenom > 0
    ? (cost.totalCacheReadTokens / tokenDenom) * 100
    : 0

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <View className="flex-row items-center gap-2 mb-3">
        <Coins size={14} className="text-amber-500" />
        <Text className="text-sm font-semibold text-foreground">Cost & Tokens</Text>
      </View>

      <View className="flex-row flex-wrap gap-x-6 gap-y-2">
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Total Cost</Text>
          <Text className="text-lg font-bold text-foreground">${cost.totalCost.toFixed(4)}</Text>
        </View>
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Per Eval</Text>
          <Text className="text-lg font-bold text-foreground">${cost.costPerEval.toFixed(4)}</Text>
          {total > 0 && (
            <Text className="text-[10px] text-muted-foreground">{total} evals</Text>
          )}
        </View>
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Cache Hit Rate</Text>
          <Text className={cn(
            'text-lg font-bold',
            cacheHitRate >= 50 ? 'text-emerald-600' : 'text-foreground',
          )}>
            {cacheHitRate.toFixed(1)}%
          </Text>
        </View>
      </View>

      <View className="h-px bg-border my-3" />

      <View className="flex-row flex-wrap gap-x-6 gap-y-2">
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Input Tokens</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtTokens(cost.totalInputTokens)}</Text>
        </View>
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Output Tokens</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtTokens(cost.totalOutputTokens)}</Text>
        </View>
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Cache Read</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtTokens(cost.totalCacheReadTokens)}</Text>
        </View>
        <View>
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Cache Write</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtTokens(cost.totalCacheWriteTokens)}</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Resource Metrics
// ---------------------------------------------------------------------------

function ResourceMetrics({ resources }: { resources: NonNullable<RunDetail['resources']> }) {
  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-6">
      <View className="flex-row items-center gap-2 mb-3">
        <Cpu size={14} className="text-purple-500" />
        <Text className="text-sm font-semibold text-foreground">Resources</Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        <View className="flex-1 min-w-[100px]">
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Peak CPU</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtMillicores(resources.peakCpuMillicores)}</Text>
        </View>
        <View className="flex-1 min-w-[100px]">
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Avg CPU</Text>
          <Text className="text-sm font-semibold text-foreground">{fmtMillicores(resources.avgCpuMillicores)}</Text>
        </View>
        <View className="flex-1 min-w-[100px]">
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Peak Memory</Text>
          <Text className="text-sm font-semibold text-foreground">{resources.peakMemoryMiB} MiB</Text>
        </View>
        <View className="flex-1 min-w-[100px]">
          <Text className="text-[10px] font-medium text-muted-foreground uppercase">Avg Memory</Text>
          <Text className="text-sm font-semibold text-foreground">{resources.avgMemoryMiB} MiB</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Category Table
// ---------------------------------------------------------------------------

function CategoryTable({ byCategory }: { byCategory: RunDetail['byCategory'] }) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total)
  if (entries.length <= 1) return null

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground mb-3">By Category</Text>
      <View className="gap-0.5">
        <View className="flex-row px-2 pb-2">
          <Text className="flex-1 text-[10px] font-semibold text-muted-foreground uppercase">Category</Text>
          <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Passed</Text>
          <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Rate</Text>
          <Text className="w-16 text-right text-[10px] font-semibold text-muted-foreground uppercase">Avg</Text>
        </View>
        {entries.map(([cat, cs]) => {
          const rate = cs.total > 0 ? (cs.passed / cs.total) * 100 : 0
          return (
            <View key={cat} className="flex-row items-center px-2 py-1.5 rounded-md odd:bg-muted/20">
              <View className="flex-1 flex-row items-center gap-2">
                <View className={cn(
                  'h-2 w-2 rounded-full',
                  rate >= 80 ? 'bg-emerald-500' : rate >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                )} />
                <Text className="text-xs font-medium text-foreground">{cat}</Text>
              </View>
              <Text className="w-16 text-right text-xs text-foreground">{cs.passed}/{cs.total}</Text>
              <Text className={cn(
                'w-16 text-right text-xs font-medium',
                rate >= 80 ? 'text-emerald-600' : rate >= 60 ? 'text-yellow-600' : 'text-red-600'
              )}>
                {rate.toFixed(0)}%
              </Text>
              <Text className="w-16 text-right text-xs text-muted-foreground">{cs.avgScore.toFixed(1)}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Waterfall Bar
// ---------------------------------------------------------------------------

function PipelineWaterfall({ evals }: { evals: EvalResultItem[] }) {
  const sorted = [...evals].sort((a, b) => (a.pipelinePhase ?? 0) - (b.pipelinePhase ?? 0))
  return (
    <View className="flex-row h-3 rounded-full overflow-hidden mb-3">
      {sorted.map((ev) => (
        <View
          key={ev.id}
          className={cn('flex-1', ev.passed ? 'bg-emerald-500' : 'bg-red-500')}
        />
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Group
// ---------------------------------------------------------------------------

function PipelineGroup({ name, evals, runId }: { name: string; evals: EvalResultItem[]; runId: string }) {
  const sorted = [...evals].sort((a, b) => (a.pipelinePhase ?? 0) - (b.pipelinePhase ?? 0))
  const allPassed = sorted.every(e => e.passed)
  const totalScore = sorted.reduce((s, e) => s + e.score, 0)
  const totalMax = sorted.reduce((s, e) => s + e.maxScore, 0)
  const router = useRouter()

  return (
    <View className="rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-2 mb-3">
        {allPassed
          ? <CheckCircle2 size={14} className="text-emerald-500" />
          : <XCircle size={14} className="text-red-500" />
        }
        <Text className="text-sm font-semibold text-foreground">{name}</Text>
        <Text className="text-xs text-muted-foreground">
          {totalScore}/{totalMax} ({totalMax > 0 ? ((totalScore / totalMax) * 100).toFixed(0) : 0}%)
        </Text>
      </View>

      <PipelineWaterfall evals={sorted} />

      <View className="gap-1">
        {sorted.map((ev, i) => (
          <View key={ev.id} className="flex-row items-center gap-2 py-1 px-1">
            <Text className="text-[10px] text-muted-foreground w-5">P{ev.pipelinePhase ?? i + 1}</Text>
            {ev.passed
              ? <CheckCircle2 size={12} className="text-emerald-500" />
              : <XCircle size={12} className="text-red-500" />
            }
            <Pressable
              className="flex-1 active:opacity-70"
              onPress={() => router.push(`/(admin)/evals/${runId}/${ev.id}`)}
            >
              <Text className="text-xs text-primary font-medium" numberOfLines={1}>
                {ev.name.replace(/^[^:]*:\s*/, '')}
              </Text>
            </Pressable>
            <Text className="text-xs font-semibold text-foreground">{ev.score}/{ev.maxScore}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Live Progress Table
// ---------------------------------------------------------------------------

function ProgressTable({ progress }: { progress: ProgressItem[] }) {
  if (progress.length === 0) return null

  return (
    <View className="rounded-xl border border-border bg-card">
      <View className="flex-row items-center justify-between p-4 border-b border-border">
        <View className="flex-row items-center gap-2">
          <Activity size={14} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">
            Live Progress ({progress.length} completed)
          </Text>
        </View>
      </View>
      {progress.map((r) => (
        <View key={r.id} className="flex-row items-center py-2.5 px-4 border-b border-border/30 last:border-b-0">
          {r.passed
            ? <CheckCircle2 size={14} className="text-emerald-500" />
            : <XCircle size={14} className="text-red-500" />
          }
          <Text className="flex-1 text-xs font-medium text-foreground ml-2" numberOfLines={1}>
            {r.id}
          </Text>
          <Text className="text-xs font-semibold text-foreground w-14 text-right">
            {r.score}/{r.max}
          </Text>
          <Text className={cn(
            'text-xs font-medium ml-3 w-12 text-right',
            r.passed ? 'text-emerald-600' : 'text-red-600'
          )}>
            {r.max > 0 ? ((r.score / r.max) * 100).toFixed(0) : 0}%
          </Text>
        </View>
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Individual Eval Row
// ---------------------------------------------------------------------------

function EvalRow({
  ev,
  dirName,
  runId,
}: {
  ev: EvalResultItem
  dirName: string
  runId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [logContent, setLogContent] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const router = useRouter()

  const loadLog = async () => {
    if (logContent) { setShowLog(true); return }
    setLogLoading(true)
    const data = await fetchJson<{ evalId: string; content: string }>(`/runs/${encodeURIComponent(dirName)}/log/${encodeURIComponent(ev.id)}`)
    if (data) setLogContent(data.content)
    setLogLoading(false)
    setShowLog(true)
  }

  const totalIn = ev.tokens.input + ev.tokens.cacheRead + ev.tokens.cacheWrite
  const dur = (ev.durationMs / 1000).toFixed(1)

  return (
    <View className="border-b border-border/50 last:border-b-0">
      <View className="flex-row items-center py-2.5 px-2">
        {ev.passed
          ? <CheckCircle2 size={14} className="text-emerald-500" />
          : <XCircle size={14} className="text-red-500" />
        }
        <Pressable
          className="flex-1 ml-2 active:opacity-70"
          onPress={() => router.push(`/(admin)/evals/${runId}/${ev.id}`)}
        >
          <Text className="text-xs font-medium text-primary" numberOfLines={1}>
            {ev.name}
          </Text>
        </Pressable>
        <Text className="text-xs text-muted-foreground mx-2">{dur}s</Text>
        <Text className="text-xs font-semibold text-foreground w-14 text-right">
          {ev.score}/{ev.maxScore}
        </Text>
        <Pressable
          onPress={() => setExpanded(!expanded)}
          className="ml-2 p-1 active:bg-muted/20 rounded"
          hitSlop={8}
        >
          <ChevronDown
            size={12}
            className="text-muted-foreground"
            style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
          />
        </Pressable>
      </View>

      {expanded && (
        <View className="px-4 pb-3 gap-2">
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            <Text className="text-[10px] text-muted-foreground">
              Category: {ev.category}
            </Text>
            <Text className="text-[10px] text-muted-foreground">
              Tools: {ev.toolCallCount} ({ev.failedToolCalls} failed)
            </Text>
            <Text className="text-[10px] text-muted-foreground">
              Tokens: {fmtTokens(totalIn)} in / {fmtTokens(ev.tokens.output)} out
            </Text>
            <Text className="text-[10px] text-muted-foreground">
              Iterations: {ev.iterations}
            </Text>
            {ev.phaseScores && (
              <>
                <Text className="text-[10px] text-muted-foreground">
                  Intent: {ev.phaseScores.intention.percentage.toFixed(0)}%
                </Text>
                <Text className="text-[10px] text-muted-foreground">
                  Exec: {ev.phaseScores.execution.percentage.toFixed(0)}%
                </Text>
              </>
            )}
            {ev.pipeline && (
              <Text className="text-[10px] text-muted-foreground">
                Pipeline: {ev.pipeline} (phase {ev.pipelinePhase})
              </Text>
            )}
          </View>

          {Array.isArray(ev.criteriaResults) && ev.criteriaResults.length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[10px] font-semibold text-muted-foreground uppercase mt-1">Criteria</Text>
              {ev.criteriaResults.map((cr, i) => (
                <View key={i} className="flex-row items-center gap-1.5 py-0.5">
                  {cr.passed
                    ? <CheckCircle2 size={10} className="text-emerald-500" />
                    : <XCircle size={10} className="text-red-400" />
                  }
                  <Text className="flex-1 text-[10px] text-foreground" numberOfLines={2}>
                    {cr.description}
                  </Text>
                  <Text className="text-[10px] text-muted-foreground">
                    {cr.pointsEarned}/{cr.points}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {Array.isArray(ev.triggeredAntiPatterns) && ev.triggeredAntiPatterns.length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[10px] font-semibold text-orange-500 uppercase mt-1">Anti-Patterns</Text>
              {ev.triggeredAntiPatterns.map((ap, i) => (
                <View key={i} className="flex-row items-center gap-1.5">
                  <AlertTriangle size={10} className="text-orange-500" />
                  <Text className="text-[10px] text-orange-700">{ap}</Text>
                </View>
              ))}
            </View>
          )}

          {Array.isArray(ev.runtimeWarnings) && ev.runtimeWarnings.length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[10px] font-semibold text-yellow-600 uppercase mt-1">Warnings</Text>
              {ev.runtimeWarnings.map((w, i) => (
                <Text key={i} className="text-[10px] text-yellow-700">• {w}</Text>
              ))}
            </View>
          )}
          {Array.isArray(ev.errors) && ev.errors.length > 0 && (
            <View className="gap-0.5">
              <Text className="text-[10px] font-semibold text-red-500 uppercase mt-1">Errors</Text>
              {ev.errors.map((e, i) => (
                <Text key={i} className="text-[10px] text-red-600">• {e}</Text>
              ))}
            </View>
          )}

          <Pressable
            onPress={loadLog}
            disabled={logLoading}
            className="flex-row items-center gap-1.5 mt-1 active:opacity-70"
          >
            {logLoading ? (
              <ActivityIndicator size="small" />
            ) : (
              <FileText size={12} className="text-primary" />
            )}
            <Text className="text-[11px] font-medium text-primary">
              {logLoading ? 'Loading log...' : 'View Full Log'}
            </Text>
          </Pressable>

          {showLog && logContent && (
            <View className="mt-2 rounded-lg bg-muted/30 border border-border p-3 max-h-[400px]">
              <View className="flex-row items-center justify-between mb-2">
                <Text className="text-[10px] font-semibold text-muted-foreground uppercase">Log</Text>
                <Pressable onPress={() => setShowLog(false)}>
                  <X size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
                <Text className="text-[10px] text-foreground font-mono">{logContent}</Text>
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function EvalRunDetail() {
  const { runId } = useLocalSearchParams<{ runId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [data, setData] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadData = useCallback(async () => {
    if (!runId) return
    const detail = await fetchJson<RunDetail>(`/runs/${encodeURIComponent(runId)}`)
    if (detail) setData(detail)
    setLoading(false)
  }, [runId])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (data?.status === 'running') {
      pollRef.current = setInterval(loadData, 10_000)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [data?.status, loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-sm text-muted-foreground mt-3">Loading results...</Text>
      </View>
    )
  }

  if (!data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <XCircle size={32} className="text-muted-foreground mb-3" />
        <Text className="text-sm font-medium text-muted-foreground">Run not found</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-primary">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const isRunning = data.status === 'running'
  const isComplete = data.status === 'completed'
  const s = data.summary
  const passRate = s.total > 0 ? (s.passed / s.total) * 100 : 0

  const pipelineGroups = new Map<string, EvalResultItem[]>()
  const standaloneEvals: EvalResultItem[] = []
  for (const ev of data.results) {
    if (ev.pipeline) {
      const arr = pipelineGroups.get(ev.pipeline) || []
      arr.push(ev)
      pipelineGroups.set(ev.pipeline, arr)
    } else {
      standaloneEvals.push(ev)
    }
  }

  const filteredResults = data.results.filter(ev => {
    if (filter === 'passed') return ev.passed
    if (filter === 'failed') return !ev.passed
    return true
  })

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: isWide ? 32 : 16,
        paddingBottom: 40,
        maxWidth: 1200,
      }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Pressable
        onPress={() => router.back()}
        className="flex-row items-center gap-1.5 mb-4 active:opacity-70"
      >
        <ArrowLeft size={16} className="text-primary" />
        <Text className="text-sm text-primary">Back to Eval Runs</Text>
      </Pressable>

      <View className="mb-2">
        <View className="flex-row items-center gap-2 mb-1">
          <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-xl')}>
            {data.track}
          </Text>
          <View className="px-2 py-0.5 rounded-md bg-muted">
            <Text className="text-xs font-medium text-muted-foreground">{data.model}</Text>
          </View>
          {isRunning && (
            <View className="px-2 py-0.5 rounded-md bg-primary/10">
              <Text className="text-xs font-medium text-primary">Running</Text>
            </View>
          )}
        </View>
        <Text className="text-sm text-muted-foreground">
          {formatTimestamp(data.timestamp)}
        </Text>
      </View>

      <RunMetadata data={data} />

      <StatusBanner status={data.status} error={data.error} data={data} onStop={loadData} />

      {/* Summary Cards */}
      <View className="flex-row flex-wrap gap-3 mb-6">
        <StatCard
          label={isRunning ? 'Completed' : 'Total'}
          value={s.total}
          icon={FlaskConical}
          accent="bg-blue-500/10"
          iconColor="text-blue-500"
        />
        <StatCard
          label="Passed"
          value={s.passed}
          icon={CheckCircle2}
          subtitle={`${passRate.toFixed(1)}% pass rate`}
          accent="bg-emerald-500/10"
          iconColor="text-emerald-500"
        />
        <StatCard
          label="Failed"
          value={s.failed}
          icon={XCircle}
          accent="bg-red-500/10"
          iconColor="text-red-500"
        />
        <StatCard
          label="Avg Score"
          value={s.avgScore.toFixed(1)}
          icon={FlaskConical}
          subtitle={`${s.totalPoints}/${s.maxPoints} total`}
        />
      </View>

      {isComplete && (
        <View className="flex-row gap-2 mb-4">
          <ExportButton runId={data.id} filter="all" label="Export All" />
          <ExportButton runId={data.id} filter="passing" label="Export Passing" />
          <ExportButton runId={data.id} filter="failing" label="Export Failing" />
        </View>
      )}

      {isComplete && <CostBreakdown cost={data.cost} total={s.total} />}

      {data.resources && <ResourceMetrics resources={data.resources} />}

      {isRunning && data.progress && data.progress.length > 0 && data.results.length === 0 && (
        <View className="mb-6">
          <ProgressTable progress={data.progress} />
        </View>
      )}

      {Object.keys(data.byCategory).length > 0 && (
        <View className="mb-6">
          <CategoryTable byCategory={data.byCategory} />
        </View>
      )}

      {pipelineGroups.size > 0 && (
        <View className="mb-6 gap-3">
          <Text className="text-sm font-semibold text-foreground">Pipelines</Text>
          {[...pipelineGroups.entries()].map(([name, evals]) => (
            <PipelineGroup key={name} name={name} evals={evals} runId={runId!} />
          ))}
        </View>
      )}

      {data.results.length > 0 && (
        <View className="rounded-xl border border-border bg-card">
          <View className="flex-row items-center justify-between p-4 border-b border-border">
            <Text className="text-sm font-semibold text-foreground">
              All Results ({filteredResults.length})
            </Text>
            <View className="flex-row gap-1">
              {(['all', 'passed', 'failed'] as const).map((f) => (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  className={cn(
                    'px-2.5 py-1 rounded-md',
                    filter === f ? 'bg-primary/10' : ''
                  )}
                >
                  <Text className={cn(
                    'text-[10px] font-medium capitalize',
                    filter === f ? 'text-primary' : 'text-muted-foreground'
                  )}>
                    {f}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {filteredResults.map((ev) => (
            <EvalRow key={ev.id} ev={ev} dirName={data.dirName} runId={runId!} />
          ))}

          {filteredResults.length === 0 && (
            <View className="py-8 items-center">
              <Text className="text-sm text-muted-foreground">No results match filter</Text>
            </View>
          )}
        </View>
      )}

      {isRunning && (!data.progress || data.progress.length === 0) && data.results.length === 0 && (
        <View className="items-center justify-center py-16 rounded-xl border border-dashed border-border">
          <ActivityIndicator size="large" />
          <Text className="text-sm font-medium text-muted-foreground mt-4">Waiting for first eval to complete...</Text>
          <Text className="text-xs text-muted-foreground mt-1">Docker workers are setting up workspaces</Text>
        </View>
      )}
    </ScrollView>
  )
}
