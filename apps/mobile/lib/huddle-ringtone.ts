// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sound for an incoming huddle, chosen in chat settings:
 *   - `ring`: the Llamada Clara recording (`assets/sounds/llamada-clara.mp3`),
 *     looped for a direct call and played through once for a group huddle;
 *   - `chime`: one softer three-note chime, repeated;
 *   - `off`: nothing, and no vibration.
 *
 * Played with Web Audio on the shared notification context; it is audible once
 * the user has interacted with the page. The recording is decoded on the first
 * ring, and a synthesized two-tone chirp stands in until it has loaded or where
 * it can't be fetched or decoded. Phones vibrate instead of playing a sound
 * (the system call screen rings on its own when there is one).
 */
import { Platform, Vibration } from 'react-native'
import { canDecodeSounds, fetchAudioBuffer, scheduleTones, sharedAudioContext, type Tone } from './notification-sound'
import type { HuddleSound } from './team-chat-api'

interface Cue {
  tones: Tone[]
  peak: number
  /** Milliseconds between repeats while looping. */
  period: number
}

const CUES: Record<Exclude<HuddleSound, 'off'>, Cue> = {
  // Fallback for `ring` until the recording is ready.
  ring: {
    tones: [
      { frequency: 880, start: 0, duration: 0.35 },
      { frequency: 660, start: 0.4, duration: 0.35 },
    ],
    peak: 0.12,
    period: 2_400,
  },
  chime: {
    tones: [
      { frequency: 1046.5, start: 0, duration: 0.3 },
      { frequency: 1318.5, start: 0.22, duration: 0.3 },
      { frequency: 1568, start: 0.44, duration: 0.45 },
    ],
    peak: 0.08,
    period: 3_200,
  },
}

/** Playback gain for the recording, which peaks near -1.4 dBFS. */
const RING_GAIN = 0.5
/** The settings preview plays this much of the recording, then fades out. */
const PREVIEW_SECONDS = 6
const PREVIEW_FADE_SECONDS = 0.4

const RING_VIBRATION = [0, 400, 300, 400]

let ringBuffer: AudioBuffer | null = null
let ringLoad: Promise<AudioBuffer | null> | null = null
let previewToken = 0
let stopPreview: (() => void) | null = null

export interface RingtoneOptions {
  /** Which sound to play. Defaults to `ring`. */
  sound?: HuddleSound
  /** Repeat until stopped. A direct call loops; a group huddle plays once. Defaults to looping. */
  loop?: boolean
  /** Whether a phone vibrates. Off while the system call screen is already ringing. Defaults to on. */
  vibrate?: boolean
}

/** Fetches and decodes the recording once. Resolves null where that isn't possible. */
function loadRing(ctx: AudioContext): Promise<AudioBuffer | null> {
  if (ringBuffer) return Promise.resolve(ringBuffer)
  if (ringLoad) return ringLoad
  if (!canDecodeSounds(ctx)) return Promise.resolve(null)
  ringLoad = import('./notification-sound-asset')
    .then(({ huddleRingtoneUrl }) => fetchAudioBuffer(ctx, huddleRingtoneUrl()))
    .then((buffer) => {
      ringBuffer = buffer
      return buffer
    })
    .catch(() => null)
  return ringLoad
}

/** Plays the recording, optionally cut to `seconds` with a fade. Returns the function that stops it. */
function playRing(ctx: AudioContext, buffer: AudioBuffer, loop: boolean, seconds?: number): () => void {
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  source.loop = loop
  gain.gain.value = RING_GAIN
  source.connect(gain).connect(ctx.destination)
  const start = ctx.currentTime + 0.01
  source.start(start)
  if (seconds) {
    gain.gain.setValueAtTime(RING_GAIN, start + seconds - PREVIEW_FADE_SECONDS)
    gain.gain.linearRampToValueAtTime(0.0001, start + seconds)
    source.stop(start + seconds)
  }
  return () => {
    try {
      source.stop()
    } catch {
      // Already stopped.
    }
  }
}

/** Plays a synthesized cue, repeated when looping. Returns the function that stops it. */
function playCue(ctx: AudioContext, cue: Cue, loop: boolean): () => void {
  scheduleTones(ctx, cue.tones, cue.peak)
  if (!loop) return () => {}
  const timer = setInterval(() => {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    scheduleTones(ctx, cue.tones, cue.peak)
  }, cue.period)
  return () => clearInterval(timer)
}

function startRecordedRing(ctx: AudioContext, loop: boolean): () => void {
  if (ringBuffer) return playRing(ctx, ringBuffer, loop)
  let stopped = false
  let stopCurrent = playCue(ctx, CUES.ring, loop)
  void loadRing(ctx).then((buffer) => {
    if (!buffer || stopped || !loop) return
    stopCurrent()
    stopCurrent = playRing(ctx, buffer, true)
  })
  return () => {
    stopped = true
    stopCurrent()
  }
}

/** Starts the ring for an incoming huddle. Returns the function that stops it. */
export function startRingtone(options: RingtoneOptions = {}): () => void {
  const sound = options.sound ?? 'ring'
  if (sound === 'off') return () => {}
  const loop = options.loop ?? true

  if (Platform.OS !== 'web') {
    if (options.vibrate === false) return () => {}
    Vibration.vibrate(RING_VIBRATION, loop)
    return () => Vibration.cancel()
  }

  const ctx = sharedAudioContext()
  if (!ctx) return () => {}
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return sound === 'ring' ? startRecordedRing(ctx, loop) : playCue(ctx, CUES[sound], loop)
}

/** Plays a short sample for the settings preview. Phones only feel it, as a single buzz. */
export function previewHuddleSound(sound: HuddleSound): void {
  if (sound === 'off') return
  if (Platform.OS !== 'web') {
    Vibration.vibrate(RING_VIBRATION)
    return
  }
  const ctx = sharedAudioContext()
  if (!ctx) return
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  stopPreview?.()
  stopPreview = null
  const token = ++previewToken
  if (sound === 'chime') {
    scheduleTones(ctx, CUES.chime.tones, CUES.chime.peak)
    return
  }
  void loadRing(ctx).then((buffer) => {
    if (token !== previewToken) return
    if (buffer) stopPreview = playRing(ctx, buffer, false, PREVIEW_SECONDS)
    else scheduleTones(ctx, CUES.ring.tones, CUES.ring.peak)
  })
}

/** Test hook: forget the decoded recording and any preview. */
export function _resetHuddleRingtoneForTests(): void {
  ringBuffer = null
  ringLoad = null
  previewToken = 0
  stopPreview = null
}
