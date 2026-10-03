// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turns raw key signals into dictation start/stop/cancel events.
 *
 * - Push to talk: hold the key. A short hold threshold keeps an accidental tap
 *   (or Fn used as a modifier for another key) from starting a recording.
 * - Hands-free: each press of the shortcut toggles recording.
 *
 * Pure and timer-injected so it can be unit tested without Electron.
 */

export type DictationMode = 'push' | 'toggle'
export type DictationEventType = 'start' | 'stop' | 'cancel'

export interface DictationEvent {
  type: DictationEventType
  mode: DictationMode
}

type Phase = 'idle' | 'pending' | 'push' | 'toggle'

export interface DictationControllerOptions {
  emit: (event: DictationEvent) => void
  /** How long the key must be held before push-to-talk starts. */
  holdDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface DictationController {
  pttDown(): void
  pttUp(): void
  /** Another key joined the hold (for example Fn+Arrow): drop this hold. */
  combo(): void
  /** Hands-free shortcut pressed. */
  toggle(): void
  /** Cancel anything in flight (config changed, app quitting). */
  reset(): void
  phase(): Phase
}

export const DEFAULT_HOLD_DELAY_MS = 150

export function createDictationController(opts: DictationControllerOptions): DictationController {
  const holdDelay = opts.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let phase: Phase = 'idle'
  let timer: unknown = null

  const clear = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  return {
    pttDown() {
      if (phase === 'toggle') {
        // Pressing push-to-talk while hands-free is on ends the session.
        phase = 'idle'
        opts.emit({ type: 'stop', mode: 'toggle' })
        return
      }
      if (phase !== 'idle') return
      phase = 'pending'
      timer = setTimer(() => {
        timer = null
        if (phase !== 'pending') return
        phase = 'push'
        opts.emit({ type: 'start', mode: 'push' })
      }, holdDelay)
    },

    pttUp() {
      if (phase === 'pending') {
        clear()
        phase = 'idle'
      } else if (phase === 'push') {
        phase = 'idle'
        opts.emit({ type: 'stop', mode: 'push' })
      }
    },

    combo() {
      if (phase === 'pending') {
        clear()
        phase = 'idle'
      } else if (phase === 'push') {
        phase = 'idle'
        opts.emit({ type: 'cancel', mode: 'push' })
      }
    },

    toggle() {
      if (phase === 'idle') {
        phase = 'toggle'
        opts.emit({ type: 'start', mode: 'toggle' })
      } else if (phase === 'toggle') {
        phase = 'idle'
        opts.emit({ type: 'stop', mode: 'toggle' })
      }
    },

    reset() {
      clear()
      if (phase === 'push' || phase === 'toggle') {
        opts.emit({ type: 'cancel', mode: phase })
      }
      phase = 'idle'
    },

    phase: () => phase,
  }
}

// ---------------------------------------------------------------------------
// shogo-hotkey stdout protocol
// ---------------------------------------------------------------------------

export type HelperEvent =
  | { event: 'ready' }
  | { event: 'waiting'; reason: string }
  | { event: 'listening'; chord: string }
  | { event: 'ptt'; down: boolean }
  | { event: 'combo' }
  | { event: 'pasted' }
  | { event: 'error'; message: string }

/** Parse one stdout line from the helper; null for anything unrecognised. */
export function parseHelperLine(line: string): HelperEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: any
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  switch (raw.event) {
    case 'ready':
    case 'combo':
    case 'pasted':
      return { event: raw.event }
    case 'waiting':
      return { event: 'waiting', reason: String(raw.reason ?? '') }
    case 'listening':
      return { event: 'listening', chord: String(raw.chord ?? '') }
    case 'ptt':
      return typeof raw.down === 'boolean' ? { event: 'ptt', down: raw.down } : null
    case 'error':
      return { event: 'error', message: String(raw.message ?? '') }
    default:
      return null
  }
}
