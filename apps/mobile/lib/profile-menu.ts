// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Pause-notifications choices and state for the profile menu. */
import type { ClearAfter } from './team-chat-state'

export const PAUSE_OPTIONS: Array<{ label: string; value: ClearAfter }> = [
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: 'Until tomorrow', value: 'tomorrow' },
]

export interface PauseState {
  paused: boolean
  /** "Until 2:00 AM", or "Until Fri 9:00 AM" when it is not today. */
  until: string | null
}

export function pauseState(dndUntil: string | null | undefined, now = new Date()): PauseState {
  const end = dndUntil ? new Date(dndUntil) : null
  if (!end || Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return { paused: false, until: null }
  const sameDay = end.toDateString() === now.toDateString()
  const text = sameDay
    ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : end.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return { paused: true, until: `Until ${text}` }
}
