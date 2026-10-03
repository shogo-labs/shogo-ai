// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Parse `/remind me …` commands into what and when.
 *
 * Understands "in 10 minutes", "in 2h", "at 3pm", "at 15:30", "tomorrow",
 * "tomorrow at 9am", "today at 5pm", and weekday names ("on monday",
 * "friday at 10am"), before or after the reminder text.
 */

export interface ParsedReminder {
  text: string
  remindAt: Date
}

const UNITS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DEFAULT_HOUR = 9

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

export function zoned(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday').toLowerCase()),
  }
}

/** The instant when the wall clock in `timezone` reads the given local time. */
export function fromZoned(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const p = zoned(new Date(guess), timezone)
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess
  return new Date(guess - offset)
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim())
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const ampm = m[3]?.toLowerCase()
  if (minute > 59) return null
  if (ampm) {
    if (hour < 1 || hour > 12) return null
    if (ampm === 'pm' && hour !== 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
  }
  if (hour > 23) return null
  return { hour, minute }
}

export function safeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

const CLOCK = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`
const PATTERNS: Array<{ re: RegExp; resolve: (m: RegExpExecArray, now: Date, tz: string) => Date | null }> = [
  {
    re: new RegExp(String.raw`\bin\s+(\d+(?:\.\d+)?)\s*([a-z]+)\b`, 'i'),
    resolve: (m, now) => {
      const unit = UNITS[m[2].toLowerCase()]
      return unit ? new Date(now.getTime() + Number(m[1]) * unit) : null
    },
  },
  {
    re: new RegExp(String.raw`\b(today|tonight|tomorrow)(?:\s+at\s+${CLOCK})?`, 'i'),
    resolve: (m, now, tz) => {
      const p = zoned(now, tz)
      const clock = m[2] ? parseClock(m[2]) : { hour: m[1].toLowerCase() === 'tonight' ? 20 : DEFAULT_HOUR, minute: 0 }
      if (!clock) return null
      const addDays = m[1].toLowerCase() === 'tomorrow' ? 1 : 0
      const base = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays))
      return fromZoned(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), clock.hour, clock.minute, tz)
    },
  },
  {
    re: new RegExp(String.raw`\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+${CLOCK})?`, 'i'),
    resolve: (m, now, tz) => {
      const p = zoned(now, tz)
      const target = WEEKDAYS.indexOf(m[1].toLowerCase())
      const clock = m[2] ? parseClock(m[2]) : { hour: DEFAULT_HOUR, minute: 0 }
      if (!clock) return null
      let delta = (target - p.weekday + 7) % 7
      if (delta === 0) delta = 7
      const base = new Date(Date.UTC(p.year, p.month - 1, p.day + delta))
      return fromZoned(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), clock.hour, clock.minute, tz)
    },
  },
  {
    re: new RegExp(String.raw`\bat\s+${CLOCK}`, 'i'),
    resolve: (m, now, tz) => {
      const clock = parseClock(m[1])
      if (!clock) return null
      const p = zoned(now, tz)
      let at = fromZoned(p.year, p.month, p.day, clock.hour, clock.minute, tz)
      if (at.getTime() <= now.getTime()) {
        const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
        at = fromZoned(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), clock.hour, clock.minute, tz)
      }
      return at
    },
  },
]

function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*(?:to|about|that)\s+/i, '')
    .replace(/\s+(?:to|about|that)\s*$/i, '')
    .replace(/^["“]|["”]$/g, '')
    .trim()
}

/**
 * Parse "/remind me to X in 10 minutes" (or the text after "/remind").
 * Returns null when there's no recognizable time.
 */
export function parseRemindCommand(input: string, now = new Date(), timezone?: string | null): ParsedReminder | null {
  const tz = safeZone(timezone)
  let rest = input.trim().replace(/^\/remind\b\s*/i, '').replace(/^me\b\s*/i, '')
  if (!rest) return null
  for (const { re, resolve } of PATTERNS) {
    const m = re.exec(rest)
    if (!m) continue
    const at = resolve(m, now, tz)
    if (!at || Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) continue
    rest = tidy(rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length))
    if (!rest) return null
    return { text: rest, remindAt: at }
  }
  return null
}
