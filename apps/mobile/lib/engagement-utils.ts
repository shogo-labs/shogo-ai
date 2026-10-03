// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Types and pure helpers for the usage / work-activity dashboard.
 *
 * The types mirror `apps/api/src/lib/engagement-compute.ts`. The helpers hold
 * the layout math (heatmap grid, donut segments, label formatting) so the
 * components stay thin and the math can be unit tested without rendering.
 */

// ============================================================================
// API shapes
// ============================================================================

export type EngagementPeriod = '7d' | '30d' | '90d' | 'all'

export interface WorkTotals {
  messagesSent: number
  approvalsDecided: number
  approvalsApproved: number
  approvalsDenied: number
  tasksStarted: number
  tasksCompleted: number
  toolCalls: number
  linesAdded: number
  linesRemoved: number
  projectsTouched: number
  meetings: number
  agentRequests: number
  sessions: number
  tokens: number
  spendUsd: number
  activeDays: number
  lastActiveAt: string | null
}

export interface HeatmapCell {
  date: string
  count: number
  tokens: number
}

export interface RecentWorkItem {
  kind: 'task_completed' | 'approval'
  at: string
  label: string
  detail?: string
}

export interface EngagementStats {
  tz: string
  from: string
  to: string
  totals: WorkTotals
  streak: { current: number; longest: number }
  peakHour: number | null
  heatmap: HeatmapCell[]
  hourOfWeek: number[][]
  modelShare: { model: string; tokens: number; pct: number }[]
  topTools: { toolName: string; count: number; successRate: number }[]
  daily: {
    days: { date: string; byModel: Record<string, number>; total: number }[]
    models: string[]
  }
  recent: RecentWorkItem[]
}

export interface TeamWorkRow {
  userId: string
  name: string | null
  email: string | null
  image: string | null
  role: string | null
  totals: WorkTotals
  streak: { current: number; longest: number }
}

export interface TeamWork {
  tz: string
  from: string
  to: string
  team: WorkTotals
  rows: TeamWorkRow[]
}

export const ENGAGEMENT_PERIODS: { id: EngagementPeriod; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
]

/** IANA zone of the device, so streaks and "peak hour" follow the viewer's own day. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ============================================================================
// Formatting
// ============================================================================

export function compactNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

/** 0 -> "12 AM", 9 -> "9 AM", 13 -> "1 PM". */
export function formatHourLabel(hour: number | null | undefined): string {
  if (hour == null || !Number.isInteger(hour) || hour < 0 || hour > 23) return '—'
  const suffix = hour < 12 ? 'AM' : 'PM'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h} ${suffix}`
}

export function pluralDays(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`
}

/** "Today", "Yesterday", "3d ago", or a short date. Compares calendar days in the viewer's zone. */
export function formatLastActive(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'No activity'
  const then = new Date(iso)
  if (isNaN(then.getTime())) return '—'
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 14) return `${days}d ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ============================================================================
// Heatmap
// ============================================================================

/** Weekday of a `YYYY-MM-DD` key, Sunday = 0. Calendar math only, timezone independent. */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export interface HeatmapGrid {
  /** Columns are weeks (Sunday first); null pads days outside the range. */
  weeks: (HeatmapCell | null)[][]
  max: number
  /** Column index where each month label should start. */
  monthLabels: { week: number; label: string }[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function buildHeatmapGrid(cells: HeatmapCell[]): HeatmapGrid {
  if (cells.length === 0) return { weeks: [], max: 0, monthLabels: [] }

  const weeks: (HeatmapCell | null)[][] = []
  let column: (HeatmapCell | null)[] = new Array(weekdayOf(cells[0].date)).fill(null)
  let max = 0
  const monthLabels: { week: number; label: string }[] = []
  let lastMonth = ''

  for (const cell of cells) {
    max = Math.max(max, cell.count)
    const month = cell.date.slice(0, 7)
    if (month !== lastMonth) {
      // Label the column the month starts in, once. A label is about two
      // columns wide, so if the previous month only got a sliver of the grid
      // (e.g. a range starting on the 28th) the new month replaces it rather
      // than drawing on top of it.
      const entry = { week: weeks.length, label: MONTHS[Number(cell.date.slice(5, 7)) - 1] }
      const prev = monthLabels[monthLabels.length - 1]
      if (prev && entry.week - prev.week < 2) monthLabels[monthLabels.length - 1] = entry
      else monthLabels.push(entry)
      lastMonth = month
    }
    column.push(cell)
    if (column.length === 7) {
      weeks.push(column)
      column = []
    }
  }
  if (column.length > 0) {
    while (column.length < 7) column.push(null)
    weeks.push(column)
  }
  return { weeks, max, monthLabels }
}

/** 0 = no activity, 1..4 = increasing intensity relative to the busiest day. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4
}

// ============================================================================
// Donut
// ============================================================================

export interface DonutSegment {
  model: string
  pct: number
  /** Length of the painted arc, in stroke-dasharray units. */
  dash: number
  /** Remaining circumference, completing the dasharray. */
  gap: number
  /** stroke-dashoffset that starts this arc where the previous one ended (12 o'clock start). */
  offset: number
}

/** Segments for a ring drawn as stacked circle strokes. Percentages are normalised, so rounding drift never leaves a gap. */
export function donutSegments(shares: { model: string; pct: number }[], radius: number): DonutSegment[] {
  const circumference = 2 * Math.PI * radius
  const total = shares.reduce((s, r) => s + Math.max(0, r.pct), 0)
  if (total <= 0) return []
  let consumed = 0
  return shares.map((s) => {
    const frac = Math.max(0, s.pct) / total
    const dash = frac * circumference
    const seg: DonutSegment = {
      model: s.model,
      pct: s.pct,
      dash,
      gap: circumference - dash,
      offset: -consumed,
    }
    consumed += dash
    return seg
  })
}

/** Colour for a model series: palette by rank, with "Other" always neutral. */
export function seriesColor(model: string, index: number, palette: readonly string[]): string {
  if (model === 'Other') return '#94a3b8'
  return palette[index % (palette.length - 1)]
}
