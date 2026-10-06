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
