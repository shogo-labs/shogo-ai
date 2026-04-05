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
  TextInput,
  Platform,
  useWindowDimensions,
} from 'react-native'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  Wrench,
  RotateCw,
  Zap,
  ChevronDown,
  AlertTriangle,
  Search,
  Copy,
  Download,
  Star,
  History,
} from 'lucide-react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import * as Clipboard from 'expo-clipboard'
import { API_URL } from '../../../../lib/api'

const API_BASE = `${API_URL}/api/admin/evals`

const LOG_NAV_ITEMS = ['Metadata', 'Response', 'Tool Calls', 'Scoring', 'Runtime Checks']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CriteriaResult {
  description: string
  phase: string
  points: number
  pointsEarned: number
  passed: boolean
}

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
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  toolCallCount: number
  failedToolCalls: number
  iterations: number
  phaseScores: {
    intention: { percentage: number }
    execution: { percentage: number }
  } | null
  pipeline: string | null
  pipelinePhase: number | null
  triggeredAntiPatterns: string[]
  errors: string[]
  runtimeWarnings: string[]
  criteriaResults: CriteriaResult[]
}

interface RunDetail {
  dirName: string
  id: string
  name: string
  track: string
  model: string
  workers: number
  status: string
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
  byCategory: Record<
    string,
    { total: number; passed: number; failed: number; passRate: number; avgScore: number }
  >
  resources: {
    peakCpuMillicores: number
    avgCpuMillicores: number
    peakMemoryMiB: number
    avgMemoryMiB: number
  } | null
  results: EvalResultItem[]
}

interface LogSection {
  title: string
  content: string
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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function parseLogSections(markdown: string): LogSection[] {
  const parts = markdown.split(/^## /m)
  const sections: LogSection[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const nl = trimmed.indexOf('\n')
    if (nl === -1) {
      sections.push({ title: trimmed, content: '' })
    } else {
      sections.push({
        title: trimmed.slice(0, nl).trim(),
        content: trimmed.slice(nl + 1).trim(),
      })
    }
  }
  return sections
}

function countMatches(text: string, query: string): number {
  if (!query) return 0
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let count = 0
  let idx = 0
  while ((idx = lower.indexOf(q, idx)) !== -1) {
    count++
    idx += q.length
  }
  return count
}

function downloadAsFile(content: string, filename: string) {
  if (Platform.OS !== 'web') return
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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
        <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </Text>
        <View className={cn('h-7 w-7 rounded-lg items-center justify-center', accent)}>
          <Icon size={14} className={iconColor} />
        </View>
      </View>
      <Text className="text-2xl font-bold text-foreground">
        {value !== undefined
          ? typeof value === 'number'
            ? value.toLocaleString()
            : value
          : '—'}
      </Text>
      {subtitle ? (
        <Text className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</Text>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// LevelBadge
// ---------------------------------------------------------------------------

function LevelBadge({ level }: { level: number }) {
  if (level <= 5) {
    return (
      <View className="flex-row items-center gap-0.5 px-2 py-0.5 rounded-md bg-amber-500/10">
        {Array.from({ length: level }).map((_, i) => (
          <Star key={i} size={10} className="text-amber-500" fill="#f59e0b" />
        ))}
      </View>
    )
  }
  return (
    <View className="px-2 py-0.5 rounded-md bg-amber-500/10">
      <Text className="text-[10px] font-semibold text-amber-600">Lvl {level}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// PhaseBar
// ---------------------------------------------------------------------------

function PhaseBar({ label, percentage }: { label: string; percentage: number }) {
  const barColor =
    percentage >= 80
      ? 'bg-emerald-500'
      : percentage >= 60
        ? 'bg-yellow-500'
        : 'bg-red-500'
  const textColor =
    percentage >= 80
      ? 'text-emerald-600'
      : percentage >= 60
        ? 'text-yellow-600'
        : 'text-red-600'

  return (
    <View className="flex-1 min-w-[120px]">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-xs font-medium text-foreground capitalize">{label}</Text>
        <Text className={cn('text-xs font-bold', textColor)}>
          {percentage.toFixed(0)}%
        </Text>
      </View>
      <View className="h-3 bg-muted rounded-full overflow-hidden">
        <View
          className={cn('h-full rounded-full', barColor)}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// CollapsibleSection
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  icon: IconComp,
  iconColor,
  count,
  defaultExpanded = false,
  children,
}: {
  title: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconColor: string
  count: number
  defaultExpanded?: boolean
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <View className="rounded-xl border border-border bg-card">
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center justify-between p-4 active:bg-muted/20"
      >
        <View className="flex-row items-center gap-2">
          <IconComp size={14} className={iconColor} />
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
          <View className="px-1.5 py-0.5 rounded-md bg-muted">
            <Text className="text-[10px] font-medium text-muted-foreground">{count}</Text>
          </View>
        </View>
        <ChevronDown
          size={14}
          className="text-muted-foreground"
          style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {expanded && <View className="px-4 pb-4 gap-2">{children}</View>}
    </View>
  )
}

// ---------------------------------------------------------------------------
// CriteriaByPhase
// ---------------------------------------------------------------------------

function CriteriaByPhase({ criteria }: { criteria: CriteriaResult[] }) {
  const grouped = useMemo(() => {
    const map = new Map<string, CriteriaResult[]>()
    for (const cr of criteria) {
      const phase = cr.phase || 'general'
      const arr = map.get(phase) || []
      arr.push(cr)
      map.set(phase, arr)
    }
    return map
  }, [criteria])

  return (
    <View className="rounded-xl border border-border bg-card p-4 gap-4">
      <Text className="text-sm font-semibold text-foreground">Scoring Criteria</Text>
      {[...grouped.entries()].map(([phase, items]) => {
        const earned = items.reduce((s, c) => s + c.pointsEarned, 0)
        const max = items.reduce((s, c) => s + c.points, 0)
        return (
          <View key={phase} className="gap-1">
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-xs font-semibold text-muted-foreground uppercase">
                {phase}
              </Text>
              <Text className="text-xs font-medium text-muted-foreground">
                {earned}/{max}
              </Text>
            </View>
            {items.map((cr, i) => (
              <View
                key={i}
                className={cn(
                  'flex-row items-center gap-2 py-1.5 px-2 rounded-md',
                  !cr.passed && 'bg-red-500/5',
                )}
              >
                {cr.passed ? (
                  <CheckCircle2 size={12} className="text-emerald-500" />
                ) : (
                  <XCircle size={12} className="text-red-500" />
                )}
                <Text
                  className={cn(
                    'flex-1 text-xs',
                    cr.passed ? 'text-foreground' : 'text-red-600',
                  )}
                  numberOfLines={3}
                >
                  {cr.description}
                </Text>
                <Text
                  className={cn(
                    'text-xs font-medium',
                    cr.passed ? 'text-muted-foreground' : 'text-red-500',
                  )}
                >
                  {cr.pointsEarned}/{cr.points}
                </Text>
              </View>
            ))}
          </View>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// LogViewer
// ---------------------------------------------------------------------------

function LogViewer({
  logContent,
  evalName,
}: {
  logContent: string
  evalName: string
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const logScrollRef = useRef<ScrollView>(null)
  const sectionOffsets = useRef(new Map<string, number>())

  const sections = useMemo(() => parseLogSections(logContent), [logContent])

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const collapsed = new Set<string>()
    sections.forEach((s) => {
      if (s.title.toLowerCase().includes('tool call')) collapsed.add(s.title)
    })
    return collapsed
  })

  const totalMatches = useMemo(() => {
    if (!searchQuery) return 0
    return sections.reduce(
      (sum, s) =>
        sum + countMatches(s.content, searchQuery) + countMatches(s.title, searchQuery),
      0,
    )
  }, [sections, searchQuery])

  const handleCopy = async () => {
    await Clipboard.setStringAsync(logContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    downloadAsFile(logContent, `${evalName.replace(/[^a-zA-Z0-9\-_]/g, '_')}-log.md`)
  }

  const scrollToSection = (title: string) => {
    const y = sectionOffsets.current.get(title)
    if (y !== undefined) {
      logScrollRef.current?.scrollTo({ y, animated: true })
    }
  }

  const handleSectionLayout = (title: string, y: number) => {
    sectionOffsets.current.set(title, y)
  }

  const toggleSection = (title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const matchedNavItems = useMemo(() => {
    return LOG_NAV_ITEMS.map((nav) => {
      const match = sections.find((s) =>
        s.title.toLowerCase().includes(nav.toLowerCase()),
      )
      return { label: nav, sectionTitle: match?.title ?? null }
    })
  }, [sections])

  return (
    <View className="rounded-xl border border-border bg-card">
      <View className="p-4 border-b border-border gap-3">
        <Text className="text-sm font-semibold text-foreground">Eval Log</Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-1.5">
            {matchedNavItems.map(({ label, sectionTitle }) => (
              <Pressable
                key={label}
                disabled={!sectionTitle}
                onPress={() => sectionTitle && scrollToSection(sectionTitle)}
                className={cn(
                  'px-3 py-1.5 rounded-md border',
                  sectionTitle
                    ? 'border-border active:bg-muted/50'
                    : 'border-border/30 opacity-40',
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    sectionTitle ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View className="flex-row items-center gap-2">
          <View className="flex-1 flex-row items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search log..."
              placeholderTextColor="#9ca3af"
              className="flex-1 text-xs text-foreground"
              style={{ padding: 0 }}
            />
            {searchQuery ? (
              <Text className="text-[10px] font-medium text-muted-foreground">
                {totalMatches} match{totalMatches !== 1 ? 'es' : ''}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={handleCopy}
            className="p-2 rounded-lg border border-border active:bg-muted/50"
          >
            <Copy
              size={14}
              className={copied ? 'text-emerald-500' : 'text-muted-foreground'}
            />
          </Pressable>
          {Platform.OS === 'web' && (
            <Pressable
              onPress={handleDownload}
              className="p-2 rounded-lg border border-border active:bg-muted/50"
            >
              <Download size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        ref={logScrollRef}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ maxHeight: 600 }}
        className="px-4 py-2"
      >
        {sections.map((section) => {
          const isCollapsed = collapsedSections.has(section.title)
          const sectionMatchCount = searchQuery
            ? countMatches(section.content, searchQuery)
            : 0

          return (
            <View
              key={section.title}
              onLayout={(e) =>
                handleSectionLayout(section.title, e.nativeEvent.layout.y)
              }
            >
              <Pressable
                onPress={() => toggleSection(section.title)}
                className="flex-row items-center justify-between py-2.5 active:opacity-70"
              >
                <View className="flex-row items-center gap-2 flex-1">
                  <ChevronDown
                    size={12}
                    className="text-muted-foreground"
                    style={{
                      transform: [{ rotate: isCollapsed ? '-90deg' : '0deg' }],
                    }}
                  />
                  <Text className="text-sm font-bold text-foreground">
                    {section.title}
                  </Text>
                  {searchQuery && sectionMatchCount > 0 ? (
                    <View className="px-1.5 py-0.5 rounded-md bg-yellow-500/20">
                      <Text className="text-[10px] font-medium text-yellow-700">
                        {sectionMatchCount}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Pressable>
              {!isCollapsed && section.content ? (
                <View className="ml-5 mb-3">
                  <Text
                    className="text-[11px] text-foreground font-mono leading-5"
                    selectable
                  >
                    {section.content}
                  </Text>
                </View>
              ) : null}
              <View className="h-px bg-border/50" />
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function EvalDetailPage() {
  const { runId, evalId } = useLocalSearchParams<{
    runId: string
    evalId: string
  }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const [run, setRun] = useState<RunDetail | null>(null)
  const [logContent, setLogContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [logLoading, setLogLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async () => {
    if (!runId || !evalId) return
    const [runData, logData] = await Promise.all([
      fetchJson<RunDetail>(`/runs/${encodeURIComponent(runId)}`),
      fetchJson<{ evalId: string; content: string }>(
        `/runs/${encodeURIComponent(runId)}/log/${encodeURIComponent(evalId)}`,
      ),
    ])
    if (runData) setRun(runData)
    if (logData) setLogContent(logData.content)
    setLoading(false)
    setLogLoading(false)
  }, [runId, evalId])

  useEffect(() => {
    loadData()
  }, [loadData])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  const ev = useMemo(() => {
    if (!run || !evalId) return null
    return run.results.find((r) => r.id === evalId) ?? null
  }, [run, evalId])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-sm text-muted-foreground mt-3">
          Loading eval detail...
        </Text>
      </View>
    )
  }

  if (!run || !ev) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <XCircle size={32} className="text-muted-foreground mb-3" />
        <Text className="text-sm font-medium text-muted-foreground">
          Eval not found
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-primary">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const totalTokenIn = ev.tokens.input + ev.tokens.cacheRead + ev.tokens.cacheWrite
  const cacheHitRate =
    totalTokenIn > 0 ? (ev.tokens.cacheRead / totalTokenIn) * 100 : 0
  const scorePercent =
    ev.maxScore > 0 ? (ev.score / ev.maxScore) * 100 : 0
  const scoreBarColor =
    scorePercent >= 80
      ? 'bg-emerald-500'
      : scorePercent >= 60
        ? 'bg-yellow-500'
        : 'bg-red-500'

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
      {/* Back navigation */}
      <Pressable
        onPress={() =>
          router.push(
            `/(admin)/evals/${encodeURIComponent(runId!)}` as any,
          )
        }
        className="flex-row items-center gap-1.5 mb-4 active:opacity-70"
      >
        <ArrowLeft size={16} className="text-primary" />
        <Text className="text-sm text-primary">Back to Run Detail</Text>
      </Pressable>

      {/* Header */}
      <View className="mb-4">
        <View className="flex-row items-center flex-wrap gap-2 mb-1">
          <Text
            className={cn(
              'font-bold text-foreground',
              isWide ? 'text-2xl' : 'text-xl',
            )}
          >
            {ev.name}
          </Text>
          <View
            className={cn(
              'px-2.5 py-1 rounded-full',
              ev.passed ? 'bg-emerald-500/10' : 'bg-red-500/10',
            )}
          >
            <Text
              className={cn(
                'text-xs font-bold',
                ev.passed ? 'text-emerald-600' : 'text-red-600',
              )}
            >
              {ev.passed ? 'PASS' : 'FAIL'}
            </Text>
          </View>
          <View className="px-2 py-0.5 rounded-md bg-muted">
            <Text className="text-xs font-medium text-muted-foreground">
              {ev.category}
            </Text>
          </View>
          {ev.level != null && <LevelBadge level={ev.level} />}
          {ev.pipeline && (
            <View className="px-2 py-0.5 rounded-md bg-purple-500/10">
              <Text className="text-[10px] font-medium text-purple-600">
                {ev.pipeline} P{ev.pipelinePhase}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Score section */}
      <View className="rounded-xl border border-border bg-card p-5 mb-4">
        <View className="flex-row items-end gap-3 mb-3">
          <Text
            className={cn(
              'font-bold text-foreground',
              isWide ? 'text-4xl' : 'text-3xl',
            )}
          >
            {ev.score}/{ev.maxScore}
          </Text>
          <Text
            className={cn(
              'text-lg font-semibold mb-1',
              scorePercent >= 80
                ? 'text-emerald-600'
                : scorePercent >= 60
                  ? 'text-yellow-600'
                  : 'text-red-600',
            )}
          >
            {scorePercent.toFixed(1)}%
          </Text>
        </View>
        <View className="h-3 bg-muted rounded-full overflow-hidden">
          <View
            className={cn('h-full rounded-full', scoreBarColor)}
            style={{ width: `${Math.min(scorePercent, 100)}%` }}
          />
        </View>
      </View>

      {/* Stats grid — row 1 */}
      <View className="flex-row flex-wrap gap-3 mb-3">
        <StatCard
          label="Duration"
          value={formatDuration(ev.durationMs)}
          icon={Clock}
          accent="bg-blue-500/10"
          iconColor="text-blue-500"
        />
        <StatCard
          label="Tool Calls"
          value={ev.toolCallCount}
          icon={Wrench}
          subtitle={
            ev.failedToolCalls > 0
              ? `${ev.failedToolCalls} failed`
              : undefined
          }
          accent="bg-orange-500/10"
          iconColor="text-orange-500"
        />
        <StatCard
          label="Iterations"
          value={ev.iterations}
          icon={RotateCw}
          accent="bg-purple-500/10"
          iconColor="text-purple-500"
        />
      </View>

      {/* Stats grid — row 2 */}
      <View className="flex-row flex-wrap gap-3 mb-6">
        <StatCard
          label="Tokens In"
          value={fmtTokens(ev.tokens.input)}
          icon={Zap}
          subtitle={`+${fmtTokens(ev.tokens.cacheRead)} cache / ${fmtTokens(ev.tokens.cacheWrite)} write`}
          accent="bg-emerald-500/10"
          iconColor="text-emerald-500"
        />
        <StatCard
          label="Tokens Out"
          value={fmtTokens(ev.tokens.output)}
          icon={Zap}
          accent="bg-teal-500/10"
          iconColor="text-teal-500"
        />
        <StatCard
          label="Cache Hit Rate"
          value={`${cacheHitRate.toFixed(1)}%`}
          icon={Zap}
          accent={cacheHitRate >= 50 ? 'bg-emerald-500/10' : 'bg-muted'}
          iconColor={
            cacheHitRate >= 50 ? 'text-emerald-500' : 'text-muted-foreground'
          }
        />
      </View>

      {/* Phase scores */}
      {ev.phaseScores && (
        <View className="rounded-xl border border-border bg-card p-4 mb-4">
          <Text className="text-sm font-semibold text-foreground mb-3">
            Phase Scores
          </Text>
          <View className="flex-row gap-4">
            <PhaseBar
              label="Intention"
              percentage={ev.phaseScores.intention.percentage}
            />
            <PhaseBar
              label="Execution"
              percentage={ev.phaseScores.execution.percentage}
            />
          </View>
        </View>
      )}

      {/* Criteria table grouped by phase */}
      {ev.criteriaResults.length > 0 && (
        <View className="mb-4">
          <CriteriaByPhase criteria={ev.criteriaResults} />
        </View>
      )}

      {/* Anti-patterns */}
      {ev.triggeredAntiPatterns.length > 0 && (
        <View className="mb-4">
          <CollapsibleSection
            title="Anti-Patterns"
            icon={AlertTriangle}
            iconColor="text-orange-500"
            count={ev.triggeredAntiPatterns.length}
          >
            {ev.triggeredAntiPatterns.map((ap, i) => (
              <View key={i} className="flex-row items-center gap-2 py-1">
                <AlertTriangle size={12} className="text-orange-500" />
                <Text className="flex-1 text-xs text-orange-700">{ap}</Text>
                <Text className="text-xs font-medium text-orange-500">
                  -10 pts
                </Text>
              </View>
            ))}
          </CollapsibleSection>
        </View>
      )}

      {/* Warnings */}
      {ev.runtimeWarnings.length > 0 && (
        <View className="mb-4">
          <CollapsibleSection
            title="Warnings"
            icon={AlertTriangle}
            iconColor="text-yellow-500"
            count={ev.runtimeWarnings.length}
          >
            {ev.runtimeWarnings.map((w, i) => (
              <Text key={i} className="text-xs text-yellow-700 py-0.5">
                • {w}
              </Text>
            ))}
          </CollapsibleSection>
        </View>
      )}

      {/* Errors */}
      {ev.errors.length > 0 && (
        <View className="mb-4">
          <CollapsibleSection
            title="Errors"
            icon={XCircle}
            iconColor="text-red-500"
            count={ev.errors.length}
          >
            {ev.errors.map((e, i) => (
              <Text key={i} className="text-xs text-red-600 font-mono py-0.5">
                • {e}
              </Text>
            ))}
          </CollapsibleSection>
        </View>
      )}

      {/* Eval History link */}
      <Pressable
        onPress={() =>
          router.push(
            `/(admin)/evals/history/${encodeURIComponent(evalId!)}` as any,
          )
        }
        className="flex-row items-center justify-center gap-2 py-3 rounded-xl border border-border bg-card mb-6 active:bg-muted/30"
      >
        <History size={16} className="text-primary" />
        <Text className="text-sm font-semibold text-primary">View History</Text>
      </Pressable>

      {/* Log viewer */}
      {logLoading ? (
        <View className="rounded-xl border border-border bg-card p-8 items-center">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-muted-foreground mt-2">
            Loading log...
          </Text>
        </View>
      ) : logContent ? (
        <LogViewer logContent={logContent} evalName={ev.name} />
      ) : (
        <View className="rounded-xl border border-dashed border-border p-8 items-center">
          <Text className="text-sm text-muted-foreground">
            No log available
          </Text>
        </View>
      )}
    </ScrollView>
  )
}
