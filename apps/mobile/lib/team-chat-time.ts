// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Timestamp formats for team chat message rows.
 *
 * Every formatter is built once and reused. `toLocaleTimeString` with an
 * options object constructs an `Intl.DateTimeFormat` per call, which is slow on
 * Hermes and was 118 ms of self time just scrolling one channel (SHO-600).
 */

type TimeOptions = Intl.DateTimeFormatOptions
type DateOptions = Intl.DateTimeFormatOptions

const timeFormat = (options: TimeOptions) => new Intl.DateTimeFormat(undefined, options)
const dateFormat = (options: DateOptions) => new Intl.DateTimeFormat(undefined, options)

const TIME = timeFormat({ hour: 'numeric', minute: '2-digit' })
const SHORT_TIME = TIME
const FULL_TIME = timeFormat({ hour: 'numeric', minute: '2-digit', second: '2-digit' })
const DAY_DIVIDER_THIS_YEAR = dateFormat({ weekday: 'long', month: 'long', day: 'numeric' })
const DAY_DIVIDER = dateFormat({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const SHORT_DATE = dateFormat({ weekday: 'short', month: 'short', day: 'numeric' })

/** "10:13 PM" */
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso))
}

/**
 * "10:13": the time without the AM/PM marker, narrow enough for the avatar
 * gutter. 24-hour locales have no marker, so they are unchanged.
 */
export function formatShortTime(iso: string): string {
  const parts = SHORT_TIME.formatToParts(new Date(iso))
  const out: string[] = []
  parts.forEach((part, i) => {
    if (part.type === 'dayPeriod') return
    // The literal separating the time from the day period (or a leading one).
    if (part.type === 'literal' && (parts[i + 1]?.type === 'dayPeriod' || parts[i - 1]?.type === 'dayPeriod')) return
    out.push(part.value)
  })
  return out.join('').trim()
}

/** The reader's calendar day for an instant, usable for grouping and comparison. */
function dayOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Which calendar day an instant falls on, in the reader's timezone. */
export function dayKey(iso: string): string {
  return dayOf(new Date(iso))
}

/**
 * "Today", "Yesterday", or "Monday, October 12" (with the year once it differs)
 * — the label on a timeline's day divider.
 */
export function formatDayDivider(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (dayOf(d) === dayOf(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayOf(d) === dayOf(yesterday)) return 'Yesterday'
  return (d.getFullYear() === now.getFullYear() ? DAY_DIVIDER_THIS_YEAR : DAY_DIVIDER).format(d)
}

/** "Today at 10:13:22 PM", "Yesterday at ...", or "Mon, Oct 5 at ...". */
export function formatFullTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const time = FULL_TIME.format(d)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`
  return `${SHORT_DATE.format(d)} at ${time}`
}

/**
 * A row's own timestamp label, memoized per instant. A timeline re-renders its
 * rows as messages arrive and as it scrolls, and formatting the same instant
 * again each time is the expensive half of that (SHO-600).
 */
const timeLabels = new Map<string, string>()

export function rowTimeLabel(iso: string): string {
  let label = timeLabels.get(iso)
  if (label === undefined) {
    // Rows are a window over a channel's history, not the whole history: keep
    // the cache bounded so a long-lived session cannot grow it without limit.
    if (timeLabels.size > 512) timeLabels.clear()
    label = formatTime(iso)
    timeLabels.set(iso, label)
  }
  return label
}

const shortTimeLabels = new Map<string, string>()

export function rowShortTimeLabel(iso: string): string {
  let label = shortTimeLabels.get(iso)
  if (label === undefined) {
    if (shortTimeLabels.size > 512) shortTimeLabels.clear()
    label = formatShortTime(iso)
    shortTimeLabels.set(iso, label)
  }
  return label
}
