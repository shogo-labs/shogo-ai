// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * When to ask for browser alert permission inline. The first direct message or
 * mention that arrives while the person is elsewhere arms the nudge; it then
 * shows until the permission is decided or the person says "Not now".
 *
 * Remembered in local storage, so it appears once per browser, not per session.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'shogo.permissionNudge'

interface NudgeState {
  /** A DM or mention has arrived while away. */
  armed: boolean
  /** The person chose "Not now". */
  dismissed: boolean
}

const EMPTY: NudgeState = { armed: false, dismissed: false }
const listeners = new Set<() => void>()
let current: NudgeState | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(): NudgeState {
  if (current) return current
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<NudgeState>) : {}
    current = {
      armed: parsed.armed === true,
      dismissed: parsed.dismissed === true,
    }
  } catch {
    current = { ...EMPTY }
  }
  return current
}

function write(next: NudgeState) {
  current = next
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be full or disabled; the nudge then lasts for this session only.
  }
  listeners.forEach((l) => l())
}

/** Arms the nudge for a direct message or mention, the reasons people expect to hear about. */
export function armPermissionNudge(reason: string | null | undefined): void {
  if (reason !== 'dm' && reason !== 'mention' && reason !== 'broadcast' && reason !== 'keyword') return
  const s = read()
  if (s.armed) return
  write({ ...s, armed: true })
}

export function dismissPermissionNudge(): void {
  write({ ...read(), dismissed: true })
}

/** Whether the nudge should show, given the current browser permission. */
export function shouldShowPermissionNudge(permission: string | null | undefined): boolean {
  const s = read()
  return s.armed && !s.dismissed && permission === 'default'
}

export function usePermissionNudgeState(): NudgeState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
    read,
  )
}

/** Test helper: forget the in-memory state and anything in local storage. */
export function resetPermissionNudgeForTests(): void {
  current = null
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
  listeners.forEach((l) => l())
}
