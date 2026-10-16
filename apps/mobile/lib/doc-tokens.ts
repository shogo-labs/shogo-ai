// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reference tokens embedded in channel doc (and message) markdown:
 *
 *   <@u:USER_ID>          a person
 *   <@a:ws> <@a:p:ID>     the workspace agent / a project's agent
 *   <#c:CONVERSATION_ID>  a channel
 *   <#p:PROJECT_ID>       a project
 *   <!date:2026-10-13>    a calendar date
 *   <!date:2026-10-13T09:30Z>  a moment, shown in each viewer's time zone
 *
 * Plus the date maths for showing them: relative labels ("Today", "Friday"),
 * full labels ("Tuesday, October 13th"), and quick picks for the @ menu.
 * No React Native imports: this also runs inside the doc editor's DOM bundle.
 */

export type DocRef =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; projectId: string | null }
  | { kind: 'channel'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'date'; value: string }

const ID = '[A-Za-z0-9_-]+'
const DATE_VALUE = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}Z)?'

/** Matches any doc token; use with the `g` flag via `docTokenRegex()`. */
export const DOC_TOKEN_SOURCE = `<@u:(${ID})>|<@a:ws>|<@a:p:(${ID})>|<#c:(${ID})>|<#p:(${ID})>|<!date:(${DATE_VALUE})>`

export function docTokenRegex(flags = 'g'): RegExp {
  return new RegExp(DOC_TOKEN_SOURCE, flags)
}

export function parseDocToken(token: string): DocRef | null {
  const m = new RegExp(`^(?:${DOC_TOKEN_SOURCE})$`).exec(token)
  if (!m) return null
  const [, user, project, channel, projectRef, date] = m
  if (user) return { kind: 'user', id: user }
  if (project) return { kind: 'agent', projectId: project }
  if (token === '<@a:ws>') return { kind: 'agent', projectId: null }
  if (channel) return { kind: 'channel', id: channel }
  if (projectRef) return { kind: 'project', id: projectRef }
  if (date && parseDateValue(date)) return { kind: 'date', value: date }
  return null
}

export function docTokenFor(ref: DocRef): string {
  switch (ref.kind) {
    case 'user':
      return `<@u:${ref.id}>`
    case 'agent':
      return ref.projectId ? `<@a:p:${ref.projectId}>` : '<@a:ws>'
    case 'channel':
      return `<#c:${ref.id}>`
    case 'project':
      return `<#p:${ref.id}>`
    case 'date':
      return `<!date:${ref.value}>`
  }
}

/** Stable key for a ref, e.g. for React keys and de-duplication. */
export function docRefKey(ref: DocRef): string {
  return docTokenFor(ref)
}

// ─── Dates ───────────────────────────────────────────────────────────────────

export interface ParsedDate {
  /** Calendar day as YYYY-MM-DD (in UTC for a moment; use `dayIn` to localise). */
  day: string
  /** Set when the value carries a time. */
  instant: Date | null
}

export function parseDateValue(value: string): ParsedDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})Z)?$/.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const probe = new Date(Date.UTC(+y, +mo - 1, +d))
  if (probe.getUTCFullYear() !== +y || probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d) return null
  if (h === undefined) return { day: `${y}-${mo}-${d}`, instant: null }
  if (+h > 23 || +mi > 59) return null
  return { day: `${y}-${mo}-${d}`, instant: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)) }
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function safeZone(tz: string | null | undefined): string {
  if (!tz) return localTimeZone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

function zonedParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The calendar day `at` falls on in `tz`, as YYYY-MM-DD. */
export function dayIn(at: Date, tz?: string | null): string {
  const p = zonedParts(at, safeZone(tz))
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Wall-clock HH:MM of `at` in `tz`. */
export function timeIn(at: Date, tz?: string | null): string {
  const p = zonedParts(at, safeZone(tz))
  return `${pad(p.hour)}:${pad(p.minute)}`
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}

function dayFromNumber(n: number): string {
  const at = new Date(n * 86_400_000)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/** Offset of `tz` from UTC at `at`, in minutes. */
function zoneOffsetMinutes(at: Date, tz: string): number {
  const p = zonedParts(at, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000)
}

/**
 * The value for a date (and optional HH:MM wall time in `tz`). Without a time
 * it is a plain calendar date; with one it is stored as the UTC moment.
 */
export function dateValue(day: string, time?: string | null, tz?: string | null): string {
  if (!time) return day
  const zone = safeZone(tz)
  const [y, m, d] = day.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, h, mi)
  let utc = wall - zoneOffsetMinutes(new Date(wall), zone) * 60_000
  utc = wall - zoneOffsetMinutes(new Date(utc), zone) * 60_000
  const at = new Date(utc)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}Z`
}

/** A value split back into the day and wall time a person in `tz` would pick. */
export function localPartsOf(value: string, tz?: string | null): { day: string; time: string | null } | null {
  const parsed = parseDateValue(value)
  if (!parsed) return null
  if (!parsed.instant) return { day: parsed.day, time: null }
  return { day: dayIn(parsed.instant, tz), time: timeIn(parsed.instant, tz) }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

export function formatClock(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${pad(m)} ${suffix}`
}

function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${MONTHS[m - 1].slice(0, 3)} ${d}${withYear ? `, ${y}` : ''}`
}

/**
 * How a date chip reads to someone in `tz` at `now`: Today, Yesterday,
 * Tomorrow, a weekday within six days, else "Oct 13" (plus the year when it
 * isn't this year). A time is appended for moments: "Today, 3:00 PM".
 */
export function relativeDateLabel(value: string, now: Date = new Date(), tz?: string | null): string {
  const parts = localPartsOf(value, tz)
  if (!parts) return value
  const today = dayIn(now, tz)
  const diff = dayNumber(parts.day) - dayNumber(today)
  let label: string
  if (diff === 0) label = 'Today'
  else if (diff === -1) label = 'Yesterday'
  else if (diff === 1) label = 'Tomorrow'
  else if (Math.abs(diff) <= 6) label = WEEKDAYS[weekdayOf(parts.day)]
  else label = shortDay(parts.day, parts.day.slice(0, 4) !== today.slice(0, 4))
  return parts.time ? `${label}, ${formatClock(parts.time)}` : label
}

/** A short absolute label for inserting a date as text: "Oct 13", "Oct 13, 2027", "Oct 13 3:00 PM". */
export function shortDateLabel(value: string, now: Date = new Date(), tz?: string | null): string {
  const parts = localPartsOf(value, tz)
  if (!parts) return value
  const base = shortDay(parts.day, parts.day.slice(0, 4) !== dayIn(now, tz).slice(0, 4))
  return parts.time ? `${base} ${formatClock(parts.time)}` : base
}

/** "Tuesday, October 13th", with the year when it isn't this year and the time for moments. */
export function fullDateLabel(value: string, now: Date = new Date(), tz?: string | null): string {
  const parts = localPartsOf(value, tz)
  if (!parts) return value
  const [y, m, d] = parts.day.split('-').map(Number)
  const year = String(y) !== dayIn(now, tz).slice(0, 4) ? `, ${y}` : ''
  const base = `${WEEKDAYS[weekdayOf(parts.day)]}, ${MONTHS[m - 1]} ${ordinal(d)}${year}`
  return parts.time ? `${base} at ${formatClock(parts.time)}` : base
}

/** Plain text for agents and notifications: "Tuesday, October 13, 2026" (+ " 09:30 UTC"). */
export function absoluteDateText(value: string): string {
  const parsed = parseDateValue(value)
  if (!parsed) return value
  const [y, m, d] = parsed.day.split('-').map(Number)
  const base = `${WEEKDAYS[weekdayOf(parsed.day)]}, ${MONTHS[m - 1]} ${d}, ${y}`
  return parsed.instant ? `${base} ${pad(parsed.instant.getUTCHours())}:${pad(parsed.instant.getUTCMinutes())} UTC` : base
}

export interface DateQuickPick {
  label: string
  value: string
}

const WEEKDAY_ALIASES: Array<[number, string[]]> = [
  [0, ['sunday', 'sun']],
  [1, ['monday', 'mon']],
  [2, ['tuesday', 'tue', 'tues']],
  [3, ['wednesday', 'wed']],
  [4, ['thursday', 'thu', 'thur', 'thurs']],
  [5, ['friday', 'fri']],
  [6, ['saturday', 'sat']],
]

function monthIndex(word: string): number {
  const w = word.toLowerCase()
  if (w.length < 3) return -1
  return MONTHS.findIndex((m) => m.toLowerCase().startsWith(w))
}

function validDay(y: number, m: number, d: number): string | null {
  const at = new Date(Date.UTC(y, m, d))
  if (at.getUTCMonth() !== m || at.getUTCDate() !== d) return null
  return `${y}-${pad(m + 1)}-${pad(d)}`
}

/**
 * Date suggestions for what follows "@" in the menu: "", "tod", "tomorrow",
 * "fri", "next mon", "oct 19", "19 oct", "10/19", "2026-10-19". Dates are
 * calendar days relative to today in `tz`.
 */
export function parseDateQuickPicks(query: string, now: Date = new Date(), tz?: string | null): DateQuickPick[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const today = dayIn(now, tz)
  const todayN = dayNumber(today)
  const thisYear = Number(today.slice(0, 4))
  const out: DateQuickPick[] = []
  const add = (day: string | null) => {
    if (!day || out.some((p) => p.value === day)) return
    const relativeLabel = relativeDateLabel(day, now, tz)
    const isWord = /^[A-Z][a-z]+$/.test(relativeLabel)
    out.push({ label: isWord ? `${relativeLabel} · ${shortDay(day, day.slice(0, 4) !== today.slice(0, 4))}` : fullDateLabel(day, now, tz), value: day })
  }

  const relative: Array<[string, number]> = [['today', 0], ['tomorrow', 1], ['yesterday', -1]]
  for (const [word, offset] of relative) {
    if (!q || word.startsWith(q)) add(dayFromNumber(todayN + offset))
  }
  if (q === 'tmr' || q === 'tmrw') add(dayFromNumber(todayN + 1))

  // "fri" is the coming Friday (1–7 days out); "next fri" is the one after.
  const next = /^next (\w+)$/.exec(q)
  const weekdayWord = next ? next[1] : q
  if (weekdayWord.length >= 2) {
    for (const [index, aliases] of WEEKDAY_ALIASES) {
      if (!aliases.some((a) => a.startsWith(weekdayWord))) continue
      const coming = (index - weekdayOf(today) + 7) % 7 || 7
      add(dayFromNumber(todayN + coming + (next ? 7 : 0)))
    }
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q)
  if (iso) add(validDay(+iso[1], +iso[2] - 1, +iso[3]))

  const upcoming = (m: number, d: number, year?: number) => {
    if (year) return validDay(year, m, d)
    const candidate = validDay(thisYear, m, d)
    if (candidate && dayNumber(candidate) >= todayN - 30) return candidate
    return validDay(thisYear + 1, m, d)
  }
  const monthFirst = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(q)
  if (monthFirst && monthIndex(monthFirst[1]) >= 0) add(upcoming(monthIndex(monthFirst[1]), +monthFirst[2], monthFirst[3] ? +monthFirst[3] : undefined))
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})(?:,? (\d{4}))?$/.exec(q)
  if (dayFirst && monthIndex(dayFirst[2]) >= 0) add(upcoming(monthIndex(dayFirst[2]), +dayFirst[1], dayFirst[3] ? +dayFirst[3] : undefined))
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(q)
  if (slash) add(upcoming(+slash[1] - 1, +slash[2], slash[3] ? +slash[3] : undefined))
  const monthOnly = /^([a-z]{3,9})$/.exec(q)
  if (monthOnly && monthIndex(monthOnly[1]) >= 0 && !out.length) add(upcoming(monthIndex(monthOnly[1]), 1))

  return out
}

/** Add whole days to a YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  return dayFromNumber(dayNumber(day) + n)
}

export interface ReminderPreset {
  label: string
  at: Date
}

/**
 * When to be reminded about a date chip: around the moment itself, or on
 * the morning of / before a calendar date (9:00 in `tz`). Past times are dropped.
 */
export function reminderPresets(value: string, now: Date = new Date(), tz?: string | null): ReminderPreset[] {
  const parsed = parseDateValue(value)
  if (!parsed) return []
  const out: ReminderPreset[] = []
  if (parsed.instant) {
    const t = parsed.instant.getTime()
    out.push(
      { label: 'At time of event', at: new Date(t) },
      { label: '15 minutes before', at: new Date(t - 15 * 60_000) },
      { label: '1 hour before', at: new Date(t - 60 * 60_000) },
      { label: '1 day before', at: new Date(t - 24 * 60 * 60_000) },
    )
  } else {
    const morning = (day: string) => parseDateValue(dateValue(day, '09:00', tz))!.instant!
    out.push(
      { label: 'Morning of (9:00 AM)', at: morning(parsed.day) },
      { label: 'Day before (9:00 AM)', at: morning(addDays(parsed.day, -1)) },
      { label: 'Week before (9:00 AM)', at: morning(addDays(parsed.day, -7)) },
    )
  }
  return out.filter((p) => p.at.getTime() > now.getTime())
}

/** "3pm", "3:30 PM", "15:30", "9" → "HH:MM"; null when it isn't a time. */
export function parseClockInput(input: string): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*$/i.exec(input)
  if (!m) return null
  let h = +m[1]
  const mi = m[2] ? +m[2] : 0
  const suffix = m[3]?.toLowerCase()
  if (mi > 59) return null
  if (suffix) {
    if (h < 1 || h > 12) return null
    if (suffix.startsWith('p') && h !== 12) h += 12
    if (suffix.startsWith('a') && h === 12) h = 0
  } else if (h > 23) {
    return null
  }
  return `${pad(h)}:${pad(mi)}`
}

/**
 * A month calendar as weeks of YYYY-MM-DD (Sunday first); days outside the
 * month are null. `month` is 0-based.
 */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = `${year}-${String(month + 1).padStart(2, '0')}-01`
  const lead = new Date(Date.UTC(year, month, 1)).getUTCDay()
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))]
  while (cells.length % 7) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}
