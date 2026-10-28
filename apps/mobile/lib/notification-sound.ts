// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Web Audio engine for in-app sounds: chat message cues, huddle rings
 * (`huddle-ringtone.ts`), and island cues. One module-level `AudioContext` is reused for all of them.
 *
 * Browsers only let audio start after a user gesture, so the context is
 * created and resumed on the first `pointerdown` or `keydown`. Until then,
 * message sounds stay silent instead of queueing up. Phones use the system
 * push sound, so the native build uses `notification-sound.native.ts`.
 *
 * Messages play the tone the user picked in Settings > Chat. Soft Knock
 * (`assets/sounds/soft-knock.mp3`) is the default; every tone except Chirp is
 * a recording, decoded once after the first gesture. Until it has loaded, or
 * where it can't be fetched or decoded, the synthesized Chirp cues below play.
 */

export type MessageSoundKind = 'dm' | 'mention' | 'thread' | 'other'
export type MessageSoundLevel = 'default' | 'subtle' | 'off'
export type MessageTone = 'knock' | 'chirp' | 'pristine' | 'definite' | 'juntos' | 'confirmation' | 'question' | 'glass'
type RecordedTone = Exclude<MessageTone, 'chirp'>

export interface Tone {
  frequency: number
  /** Seconds after the start of the cue. */
  start: number
  duration: number
  type?: OscillatorType
}

/** At most one message cue every this many milliseconds; the recording is 2 s long. */
export const MESSAGE_SOUND_THROTTLE_MS = 2_000

const DEFAULT_PEAK = 0.18
const SUBTLE_PEAK = 0.06

/** Playback gain for the recordings, which all peak near -3 dBFS. */
const RECORDING_GAIN = { default: 0.7, subtle: 0.25 } as const

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
let preferredTone: MessageTone = 'knock'
const toneBuffers = new Map<RecordedTone, AudioBuffer>()
const toneLoads = new Map<RecordedTone, Promise<AudioBuffer | null>>()

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
    if (!ctx) return
    if (ctx.state !== 'running') void ctx.resume().catch(() => {})
    void loadTone(ctx, preferredTone)
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

/** True where a recording can be fetched and decoded on this context. */
export function canDecodeSounds(ctx: AudioContext): boolean {
  return typeof fetch === 'function' && typeof ctx.decodeAudioData === 'function'
}

/** Fetches and decodes a recording. Resolves null when the URL is missing or the fetch fails. */
export function fetchAudioBuffer(ctx: AudioContext, url: string | null): Promise<AudioBuffer | null> {
  if (!url) return Promise.resolve(null)
  return fetch(url)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((data) => (data ? ctx.decodeAudioData(data) : null))
}

/** Fetches and decodes a tone's recording once. Resolves null for Chirp or where that isn't possible. */
function loadTone(ctx: AudioContext, tone: MessageTone): Promise<AudioBuffer | null> {
  if (tone === 'chirp') return Promise.resolve(null)
  const cached = toneBuffers.get(tone)
  if (cached) return Promise.resolve(cached)
  const pending = toneLoads.get(tone)
  if (pending) return pending
  if (!canDecodeSounds(ctx)) return Promise.resolve(null)
  const load = import('./notification-sound-asset')
    .then(({ messageSoundUrl }) => fetchAudioBuffer(ctx, messageSoundUrl(tone)))
    .then((buffer) => {
      if (buffer) toneBuffers.set(tone, buffer)
      return buffer
    })
    .catch(() => null)
  toneLoads.set(tone, load)
  return load
}

/**
 * Remembers the user's tone so the first gesture loads that recording, and
 * loads it right away if the context already exists.
 */
export function setPreferredMessageTone(tone: MessageTone): void {
  preferredTone = tone
  if (context) void loadTone(context, tone)
}

function playRecording(ctx: AudioContext, buffer: AudioBuffer, gainValue: number): void {
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  gain.gain.value = gainValue
  source.connect(gain).connect(ctx.destination)
  source.start(ctx.currentTime + 0.01)
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
  tone: MessageTone = 'knock',
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
  const buffer = tone === 'chirp' ? undefined : toneBuffers.get(tone)
  if (buffer) {
    // Every kind of message plays the same recording.
    playRecording(ctx, buffer, RECORDING_GAIN[level])
    return true
  }
  void loadTone(ctx, tone)
  scheduleTones(ctx, MESSAGE_TONES[kind], level === 'subtle' ? SUBTLE_PEAK : DEFAULT_PEAK)
  return true
}

/**
 * Lets one tab per browser profile play the cue for a message. Every open tab
 * of the same account gets the notification, and each would otherwise play its
 * own cue, so a second tab doubled the sound. The first tab to ask holds a Web
 * Lock for the message; the others get `false` and stay quiet. Resolves `true`
 * where Web Locks are missing, so a cue is never lost to the check.
 */
export function claimMessageSound(messageKey: string): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
  if (!locks?.request) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    locks
      .request(`shogo-message-sound:${messageKey}`, { ifAvailable: true }, (lock) => {
        resolve(!!lock)
        // Hold the lock past the throttle window so a late tab can't claim the same message.
        return lock ? new Promise<void>((release) => setTimeout(release, MESSAGE_SOUND_THROTTLE_MS)) : undefined
      })
      .catch(() => resolve(true))
  })
}

/**
 * True while a message cue is still within its throttle window. A second alert
 * in that window plays no cue of its own, but its OS banner must stay silent
 * too: the chosen tone just played, and the system's default alert sound on top
 * of it would be a second, different sound.
 */
export function messageSoundRecentlyPlayed(now: number = Date.now()): boolean {
  return now - lastMessageSoundAt < MESSAGE_SOUND_THROTTLE_MS
}

/**
 * Plays the message cue for the settings preview. It ignores the throttle, and
 * it's only called from a click, so resuming the context here is allowed.
 */
export function previewMessageSound(level: MessageSoundLevel, tone: MessageTone = 'knock'): boolean {
  if (level === 'off') return false
  const ctx = sharedAudioContext()
  if (!ctx) return false
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  void loadTone(ctx, tone).then((buffer) => {
    if (buffer) playRecording(ctx, buffer, RECORDING_GAIN[level])
    else scheduleTones(ctx, MESSAGE_TONES.dm, level === 'subtle' ? SUBTLE_PEAK : DEFAULT_PEAK)
  })
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
  preferredTone = 'knock'
  toneBuffers.clear()
  toneLoads.clear()
}
