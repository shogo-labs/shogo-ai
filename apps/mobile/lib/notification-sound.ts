// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Web Audio engine for in-app sounds: chat message cues, huddle rings,
 * and island cues. One module-level `AudioContext` is reused for all of them.
 *
 * Browsers only let audio start after a user gesture, so the context is
 * created and resumed on the first `pointerdown` or `keydown`. Until then,
 * message sounds stay silent instead of queueing up. Phones use the system
 * push sound, so the native build uses `notification-sound.native.ts`.
 */

export type MessageSoundKind = 'dm' | 'mention' | 'thread' | 'other'
export type MessageSoundLevel = 'default' | 'subtle' | 'off'

export interface Tone {
  frequency: number
  /** Seconds after the start of the cue. */
  start: number
  duration: number
  type?: OscillatorType
}

/** At most one message cue every this many milliseconds. */
export const MESSAGE_SOUND_THROTTLE_MS = 1_500

const DEFAULT_PEAK = 0.18
const SUBTLE_PEAK = 0.06

const MESSAGE_TONES: Record<MessageSoundKind, Tone[]> = {
  // A two-note knock: the cue for a direct message or a mention.
  dm: [
    { frequency: 880, start: 0, duration: 0.14 },
    { frequency: 1318.5, start: 0.12, duration: 0.22 },
  ],
  mention: [
    { frequency: 1046.5, start: 0, duration: 0.12 },
    { frequency: 1568, start: 0.1, duration: 0.22 },
  ],
  // One softer note for thread replies and everything else.
  thread: [{ frequency: 740, start: 0, duration: 0.16 }],
  other: [{ frequency: 740, start: 0, duration: 0.12 }],
}

type AudioCtor = typeof AudioContext

let context: AudioContext | null = null
let lastMessageSoundAt = Number.NEGATIVE_INFINITY
let unlockInstalled = false

function audioCtor(): AudioCtor | undefined {
  if (typeof window === 'undefined') return undefined
  return (
    (window as unknown as { AudioContext?: AudioCtor }).AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  )
}

/** The shared context, created on first use. Null where Web Audio is unavailable. */
export function sharedAudioContext(): AudioContext | null {
  if (context) return context
  const Ctor = audioCtor()
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    return null
  }
  return context
}

/**
 * Makes the shared context usable. Call once at startup. The first click or
 * key press creates the context and resumes it, which the browser needs to
 * allow sound later from events that aren't gestures (new messages, rings).
 */
export function unlockNotificationAudio(): void {
  if (unlockInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  unlockInstalled = true
  const unlock = () => {
    const ctx = sharedAudioContext()
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {})
  }
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true })
  window.addEventListener('keydown', unlock, { capture: true })
}

/** True once the browser has let the shared context run. */
export function notificationAudioReady(): boolean {
  return !!context && context.state === 'running'
}

/**
 * Schedules a sequence of tones on the shared context. Callers decide whether
 * the context should be running first.
 */
export function scheduleTones(ctx: AudioContext, tones: Tone[], peak: number): void {
  const now = ctx.currentTime + 0.01
  for (const tone of tones) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = tone.type ?? 'sine'
    osc.frequency.value = tone.frequency
    const start = now + tone.start
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + tone.duration + 0.02)
  }
}

/**
 * Plays the cue for a chat message. Returns true when it played, so the caller
 * can leave the OS notification silent and avoid a double sound.
 *
 * Stays silent when the level is `off`, when the context isn't running yet,
 * and when another message cue played less than `MESSAGE_SOUND_THROTTLE_MS` ago.
 */
export function playMessageSound(
  kind: MessageSoundKind,
  level: MessageSoundLevel,
  now: number = Date.now(),
): boolean {
  if (level === 'off') return false
  if (now - lastMessageSoundAt < MESSAGE_SOUND_THROTTLE_MS) return false
  const ctx = sharedAudioContext()
  if (!ctx) return false
  if (ctx.state !== 'running') {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return false
  }
  lastMessageSoundAt = now
  scheduleTones(ctx, MESSAGE_TONES[kind], level === 'subtle' ? SUBTLE_PEAK : DEFAULT_PEAK)
  return true
}

/**
 * Plays the message cue for the settings preview. It ignores the throttle, and
 * it's only called from a click, so resuming the context here is allowed.
 */
export function previewMessageSound(level: MessageSoundLevel): boolean {
  if (level === 'off') return false
  const ctx = sharedAudioContext()
  if (!ctx) return false
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  scheduleTones(ctx, MESSAGE_TONES.dm, level === 'subtle' ? SUBTLE_PEAK : DEFAULT_PEAK)
  return true
}

/** Maps a server notification reason to the cue that plays for it. */
export function messageSoundKindFor(reason: string | null | undefined): MessageSoundKind {
  switch (reason) {
    case 'dm':
    case 'group_dm':
      return 'dm'
    case 'mention':
    case 'broadcast':
      return 'mention'
    case 'thread':
      return 'thread'
    default:
      return 'other'
  }
}

/** Test hook: forget the throttle and the unlock state. */
export function _resetNotificationAudioForTests(): void {
  context = null
  lastMessageSoundAt = Number.NEGATIVE_INFINITY
  unlockInstalled = false
}
