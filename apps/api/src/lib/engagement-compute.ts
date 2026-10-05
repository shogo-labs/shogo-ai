// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure computation for engagement + work-activity analytics.
 *
 * Everything here takes plain rows (already fetched) and returns plain data,
 * so it can be unit tested without a database. The DB collection lives in
 * `services/engagement-analytics.service.ts`.
 *
 * "Activity" is any recorded action by a person: an agent request, a tool
 * call, a message sent, an approval decided, a task started or finished, or a
 * meeting. Active days, streaks, the heatmap, and peak hour all count every
 * one of those signals, so a person who spent the day reviewing and approving
 * still gets credit.
 */

// ============================================================================
// Raw rows (what the service collects)
// ============================================================================

export interface UsageRow {
  userId: string
  projectId: string | null
  chatSessionId: string | null
  createdAt: Date
  tokens: number
  /** Raw model id from the usage event; the service maps ids to labels. */
  model: string
  costUsd: number
}

export interface ToolRow {
  userId: string
  toolName: string
  status: string
  linesAdded: number
  linesRemoved: number
  chatSessionId: string
  createdAt: Date
}

export interface MessageRow {
  userId: string
  createdAt: Date
}

export interface ApprovalRow {
  userId: string
  decision: 'approved' | 'denied'
  at: Date
  source: 'channel' | 'goal'
  label: string
}

export interface TaskRow {
  userId: string
  projectId: string | null
  title: string
  status: string
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  resultSummary: string | null
}

export interface MeetingRow {
  userId: string
  createdAt: Date
}

export interface RawActivity {
  usage: UsageRow[]
  tools: ToolRow[]
  messages: MessageRow[]
  approvals: ApprovalRow[]
  tasks: TaskRow[]
  meetings: MeetingRow[]
}

export function emptyRaw(): RawActivity {
  return { usage: [], tools: [], messages: [], approvals: [], tasks: [], meetings: [] }
}

// ============================================================================
// Output shapes
// ============================================================================

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

export interface RecentWorkItem {
  kind: 'task_completed' | 'approval'
  at: string
  label: string
  detail?: string
}

export interface DailyModelPoint {
  date: string
  byModel: Record<string, number>
  total: number
}

export interface EngagementStats {
  tz: string
  from: string
  to: string
  totals: WorkTotals
  streak: { current: number; longest: number }
  /** 0-23 in the requested timezone, null when there is no activity. */
  peakHour: number | null
  heatmap: { date: string; count: number; tokens: number }[]
  /** 7 rows (Sunday = 0) by 24 hour columns of activity counts. */
  hourOfWeek: number[][]
  modelShare: { model: string; tokens: number; pct: number }[]
  topTools: { toolName: string; count: number; successRate: number }[]
  daily: { days: DailyModelPoint[]; models: string[] }
  recent: RecentWorkItem[]
}

// ============================================================================
// Timezone helpers
// ============================================================================

const DEFAULT_TZ = 'UTC'
const BUCKET_MS = 15 * 60 * 1000 // every real UTC offset is a multiple of 15 minutes
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Returns `tz` when it is a valid IANA zone, otherwise `UTC`. */
export function normalizeTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TZ
  }
}

export interface ZoneClock {
  tz: string
  dayKey(d: Date): string
  hour(d: Date): number
  weekday(d: Date): number
}

export function makeZoneClock(tzInput: string | null | undefined): ZoneClock {
  const tz = normalizeTimezone(tzInput)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const cache = new Map<number, { day: string; hour: number; weekday: number }>()

  const parts = (d: Date) => {
    const bucket = Math.floor(d.getTime() / BUCKET_MS)
    let hit = cache.get(bucket)
    if (!hit) {
      const p: Record<string, string> = {}
      for (const part of fmt.formatToParts(new Date(bucket * BUCKET_MS))) p[part.type] = part.value
      hit = {
        day: `${p.year}-${p.month}-${p.day}`,
        hour: Number(p.hour) % 24,
        weekday: WEEKDAYS[p.weekday] ?? 0,
      }
      cache.set(bucket, hit)
    }
    return hit
  }

  return {
    tz,
    dayKey: (d) => parts(d).day,
    hour: (d) => parts(d).hour,
    weekday: (d) => parts(d).weekday,
  }
}

/** Add `n` days to a `YYYY-MM-DD` key (calendar arithmetic, timezone independent). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Inclusive list of day keys between two keys. Capped to protect against bad input. */
export function dayRange(fromKey: string, toKey: string, cap = 800): string[] {
  const out: string[] = []
  let cursor = fromKey
  while (cursor <= toKey && out.length < cap) {
    out.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return out
}

/**
 * The instant a calendar day starts in `tz`, `daysAgo` days before the day
 * containing `now`. Handles DST days and half-hour offsets by resolving the
 * zone offset at the candidate instant rather than assuming a fixed one.
 */
export function startOfZonedDay(now: Date, tzInput: string | null | undefined, daysAgo = 0): Date {
  const clock = makeZoneClock(tzInput)
  const [y, m, d] = addDays(clock.dayKey(now), -daysAgo).split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d) // local midnight, read as if it were UTC

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: clock.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const offsetAt = (instant: number) => {
    const p: Record<string, string> = {}
    for (const part of fmt.formatToParts(new Date(instant))) p[part.type] = part.value
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
    return local - instant
  }
  // Two passes settle the offset when midnight and the first guess sit on different sides of a DST change.
  const first = wall - offsetAt(wall)
  return new Date(wall - offsetAt(first))
}

export type ActivityRange = 'today' | 'yesterday' | '7d' | '30d'

/**
 * Resolve a human range ("today", "yesterday", last 7/30 days) or explicit ISO
 * bounds into a window. Explicit bounds win; an unparseable bound is ignored.
 */
export function resolveActivityWindow(
  input: { range?: string | null; since?: string | null; until?: string | null; tz?: string | null },
  now: Date = new Date(),
): { from: Date; to: Date; label: string } {
  const since = input.since ? new Date(input.since) : null
  const until = input.until ? new Date(input.until) : null
  const validSince = since && !isNaN(since.getTime()) ? since : null
  const validUntil = until && !isNaN(until.getTime()) ? until : null

  if (validSince) {
    const to = validUntil && validUntil > validSince ? validUntil : now
    return { from: validSince, to, label: 'custom range' }
  }

  switch (input.range) {
    case 'yesterday':
      return { from: startOfZonedDay(now, input.tz, 1), to: startOfZonedDay(now, input.tz, 0), label: 'yesterday' }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 864e5), to: now, label: 'last 7 days' }
    case '30d':
      return { from: new Date(now.getTime() - 30 * 864e5), to: now, label: 'last 30 days' }
    case 'today':
    default:
      return { from: startOfZonedDay(now, input.tz, 0), to: now, label: 'today' }
  }
}

// ============================================================================
// Streaks
// ============================================================================

/**
 * Current streak counts back from today. If today has no activity yet the
 * streak is still alive as long as yesterday did, so someone who has not
 * opened the app yet today does not see their streak drop to zero.
 */
export function computeStreaks(
  activeDays: Set<string>,
  todayKey: string,
): { current: number; longest: number } {
  let current = 0
  let cursor = activeDays.has(todayKey) ? todayKey : addDays(todayKey, -1)
  while (activeDays.has(cursor)) {
    current++
    cursor = addDays(cursor, -1)
  }

  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const day of [...activeDays].sort()) {
    run = prev && addDays(prev, 1) === day ? run + 1 : 1
    if (run > longest) longest = run
    prev = day
  }
  return { current, longest }
}

// ============================================================================
// Grouping
// ============================================================================

export function groupRawByUser(raw: RawActivity): Map<string, RawActivity> {
  const out = new Map<string, RawActivity>()
  const bucket = (userId: string) => {
    let hit = out.get(userId)
    if (!hit) {
      hit = emptyRaw()
      out.set(userId, hit)
    }
    return hit
  }
  for (const r of raw.usage) bucket(r.userId).usage.push(r)
  for (const r of raw.tools) bucket(r.userId).tools.push(r)
  for (const r of raw.messages) bucket(r.userId).messages.push(r)
  for (const r of raw.approvals) bucket(r.userId).approvals.push(r)
  for (const r of raw.tasks) bucket(r.userId).tasks.push(r)
  for (const r of raw.meetings) bucket(r.userId).meetings.push(r)
  return out
}

/** Every timestamped action in `raw`, flattened, for day/hour bucketing. */
function activityTimes(raw: RawActivity, window?: { from: Date; to: Date }): Date[] {
  const times: Date[] = []
  for (const r of raw.usage) times.push(r.createdAt)
  for (const r of raw.tools) times.push(r.createdAt)
  for (const r of raw.messages) times.push(r.createdAt)
  for (const r of raw.approvals) times.push(r.at)
  for (const r of raw.tasks) {
    times.push(r.startedAt ?? r.createdAt)
    if (r.completedAt) times.push(r.completedAt)
  }
  for (const r of raw.meetings) times.push(r.createdAt)
  return window ? times.filter((t) => t >= window.from && t <= window.to) : times
}

/** Distinct local-date keys on which `raw` has at least one action. */
export function activeDaySet(
  raw: RawActivity,
  clock: ZoneClock,
  window?: { from: Date; to: Date },
): Set<string> {
  const days = new Set<string>()
  for (const t of activityTimes(raw, window)) days.add(clock.dayKey(t))
  return days
}

// ============================================================================
// Work totals
// ============================================================================

const round = (n: number, places = 4) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

export function computeWorkTotals(raw: RawActivity, clock: ZoneClock, window: { from: Date; to: Date }): WorkTotals {
  const inWindow = (d: Date) => d >= window.from && d <= window.to

  const sessions = new Set<string>()
  const projects = new Set<string>()
  let tokens = 0
  let spendUsd = 0
  for (const u of raw.usage) {
    tokens += u.tokens
    spendUsd += u.costUsd
    if (u.chatSessionId) sessions.add(u.chatSessionId)
    if (u.projectId) projects.add(u.projectId)
  }

  let toolCalls = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const t of raw.tools) {
    toolCalls++
    linesAdded += t.linesAdded
    linesRemoved += t.linesRemoved
    sessions.add(t.chatSessionId)
  }

  let tasksStarted = 0
  let tasksCompleted = 0
  for (const t of raw.tasks) {
    if (inWindow(t.startedAt ?? t.createdAt)) tasksStarted++
    if (t.status === 'completed' && t.completedAt && inWindow(t.completedAt)) tasksCompleted++
    if (t.projectId) projects.add(t.projectId)
  }

  const approvalsApproved = raw.approvals.filter((a) => a.decision === 'approved').length
  const approvalsDenied = raw.approvals.length - approvalsApproved

  const times = activityTimes(raw, window)
  const days = new Set<string>()
  let last = 0
  for (const t of times) {
    days.add(clock.dayKey(t))
    if (t.getTime() > last) last = t.getTime()
  }

  return {
    messagesSent: raw.messages.length,
    approvalsDecided: raw.approvals.length,
    approvalsApproved,
    approvalsDenied,
    tasksStarted,
    tasksCompleted,
    toolCalls,
    linesAdded,
    linesRemoved,
    projectsTouched: projects.size,
    meetings: raw.meetings.length,
    agentRequests: raw.usage.length,
    sessions: sessions.size,
    tokens,
    spendUsd: round(spendUsd),
    activeDays: days.size,
    lastActiveAt: last ? new Date(last).toISOString() : null,
  }
}

export function computeRecentWork(raw: RawActivity, limit = 10): RecentWorkItem[] {
  const items: RecentWorkItem[] = []
  for (const t of raw.tasks) {
    if (t.status === 'completed' && t.completedAt) {
      items.push({
        kind: 'task_completed',
        at: t.completedAt.toISOString(),
        label: t.title,
        detail: t.resultSummary ?? undefined,
      })
    }
  }
  for (const a of raw.approvals) {
    items.push({
      kind: 'approval',
      at: a.at.toISOString(),
      label: a.label,
      detail: a.decision === 'approved' ? 'Approved' : 'Denied',
    })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

// ============================================================================
// Engagement stats
// ============================================================================

export interface EngagementOptions {
  /** Maps a raw model id to a display label. Defaults to the id itself. */
  modelLabel?: (model: string) => string
  topModels?: number
}

export function computeEngagement(
  raw: RawActivity,
  window: { from: Date; to: Date },
  tzInput: string | null | undefined,
  options: EngagementOptions = {},
): EngagementStats {
  const clock = makeZoneClock(tzInput)
  const label = options.modelLabel ?? ((m: string) => m)
  const topN = options.topModels ?? 6

  const totals = computeWorkTotals(raw, clock, window)

  // Day / hour / weekday buckets across every signal.
  const countByDay = new Map<string, number>()
  const hours = new Array<number>(24).fill(0)
  const hourOfWeek: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const activeDays = new Set<string>()
  for (const t of activityTimes(raw, window)) {
    const day = clock.dayKey(t)
    const hour = clock.hour(t)
    activeDays.add(day)
    countByDay.set(day, (countByDay.get(day) ?? 0) + 1)
    hours[hour]++
    hourOfWeek[clock.weekday(t)][hour]++
  }

  const tokensByDay = new Map<string, number>()
  const modelTotals = new Map<string, number>()
  const byDayModel = new Map<string, Map<string, number>>()
  for (const u of raw.usage) {
    const day = clock.dayKey(u.createdAt)
    const model = label(u.model || 'unknown')
    tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + u.tokens)
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + u.tokens)
    let dm = byDayModel.get(day)
    if (!dm) byDayModel.set(day, (dm = new Map()))
    dm.set(model, (dm.get(model) ?? 0) + u.tokens)
  }

  const todayKey = clock.dayKey(window.to)
  const days = dayRange(clock.dayKey(window.from), todayKey)

  const heatmap = days.map((date) => ({
    date,
    count: countByDay.get(date) ?? 0,
    tokens: tokensByDay.get(date) ?? 0,
  }))

  // Model share + the stacked daily series use the same top-N cut.
  const rankedModels = [...modelTotals.entries()].sort((a, b) => b[1] - a[1])
  const topSet = new Set(rankedModels.slice(0, topN).map(([m]) => m))
  const hasOther = rankedModels.length > topN
  const modelNames = rankedModels.slice(0, topN).map(([m]) => m)
  if (hasOther) modelNames.push('Other')

  const grandTokens = rankedModels.reduce((s, [, t]) => s + t, 0)
  const shareRows = rankedModels.slice(0, topN).map(([model, tokens]) => ({ model, tokens }))
  if (hasOther) {
    shareRows.push({
      model: 'Other',
      tokens: rankedModels.slice(topN).reduce((s, [, t]) => s + t, 0),
    })
  }
  const modelShare = shareRows.map((r) => ({
    ...r,
    pct: grandTokens > 0 ? round((r.tokens / grandTokens) * 100, 1) : 0,
  }))

  const daily: DailyModelPoint[] = days.map((date) => {
    const byModel: Record<string, number> = {}
    for (const m of modelNames) byModel[m] = 0
    let total = 0
    for (const [model, tokens] of byDayModel.get(date) ?? []) {
      const key = topSet.has(model) ? model : 'Other'
      byModel[key] = (byModel[key] ?? 0) + tokens
      total += tokens
    }
    return { date, byModel, total }
  })

  // Tools
  const toolStats = new Map<string, { count: number; ok: number; done: number }>()
  for (const t of raw.tools) {
    let s = toolStats.get(t.toolName)
    if (!s) toolStats.set(t.toolName, (s = { count: 0, ok: 0, done: 0 }))
    s.count++
    if (t.status === 'complete') {
      s.ok++
      s.done++
    } else if (t.status === 'error') {
      s.done++
    }
  }
  const topTools = [...toolStats.entries()]
    .map(([toolName, s]) => ({
      toolName,
      count: s.count,
      successRate: s.done > 0 ? round(s.ok / s.done, 3) : 1,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  let peakHour: number | null = null
  let peak = 0
  for (let h = 0; h < 24; h++) {
    if (hours[h] > peak) {
      peak = hours[h]
      peakHour = h
    }
  }

  return {
    tz: clock.tz,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    totals,
    streak: computeStreaks(activeDays, todayKey),
    peakHour,
    heatmap,
    hourOfWeek,
    modelShare,
    topTools,
    daily: { days: daily, models: modelNames },
    recent: computeRecentWork(raw),
  }
}
