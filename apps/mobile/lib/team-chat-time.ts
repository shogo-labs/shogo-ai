// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Timestamp formats for team chat message rows. */

/** "10:13 PM" */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * "10:13": the time without the AM/PM marker, narrow enough for the avatar
 * gutter. 24-hour locales have no marker, so they are unchanged.
 */
export function formatShortTime(iso: string): string {
  const parts = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(iso))
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
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear()
    ? { weekday: 'long', month: 'long', day: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/** "Today at 10:13:22 PM", "Yesterday at ...", or "Mon, Oct 5 at ...". */
export function formatFullTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`
}
