// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Check whether the current time falls within the given quiet hours window.
 * Used by both the heartbeat schedulers (API) and the agent gateway (runtime)
 * to skip heartbeat triggers during configured quiet periods.
 */
export function isInQuietHours(
  quietStart: string | null,
  quietEnd: string | null,
  timezone: string | null
): boolean {
  if (!quietStart || !quietEnd) return false

  const now = new Date()
  const tz = timezone || 'UTC'
  let hours: number
  let minutes: number

  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const timeStr = fmt.format(now)
    const [h, m] = timeStr.split(':').map(Number)
    hours = h % 24
    minutes = m
  } catch {
    hours = now.getUTCHours()
    minutes = now.getUTCMinutes()
  }

  const currentTime = hours * 60 + minutes
  const [startH, startM] = quietStart.split(':').map(Number)
  const [endH, endM] = quietEnd.split(':').map(Number)
  const startTime = startH * 60 + startM
  const endTime = endH * 60 + endM

  if (startTime <= endTime) {
    return currentTime >= startTime && currentTime < endTime
  }
  return currentTime >= startTime || currentTime < endTime
}
