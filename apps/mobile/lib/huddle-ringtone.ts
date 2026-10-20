// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The sound for an incoming huddle, chosen in chat settings:
 *   - `ring`: a soft two-tone chirp, repeated every couple of seconds;
 *   - `chime`: one softer three-note chime, repeated;
 *   - `off`: nothing, and no vibration.
 *
 * Synthesised with Web Audio on the shared notification context, so there is
 * no asset to ship; it is audible once the user has interacted with the page.
 * Phones vibrate instead of playing a sound (the system call screen rings on
 * its own when there is one).
 */
import { Platform, Vibration } from 'react-native'
import { scheduleTones, sharedAudioContext, type Tone } from './notification-sound'
import type { HuddleSound } from './team-chat-api'

interface Cue {
  tones: Tone[]
  peak: number
  /** Milliseconds between repeats while looping. */
  period: number
}

const CUES: Record<Exclude<HuddleSound, 'off'>, Cue> = {
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

const RING_VIBRATION = [0, 400, 300, 400]

export interface RingtoneOptions {
  /** Which sound to play. Defaults to `ring`. */
  sound?: HuddleSound
  /** Repeat until stopped. A direct call loops; a group huddle plays once. Defaults to looping. */
  loop?: boolean
  /** Whether a phone vibrates. Off while the system call screen is already ringing. Defaults to on. */
  vibrate?: boolean
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

  const cue = CUES[sound]
  const ctx = sharedAudioContext()
  if (!ctx) return () => {}

  const ring = () => {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    scheduleTones(ctx, cue.tones, cue.peak)
  }
  ring()
  if (!loop) return () => {}
  const timer = setInterval(ring, cue.period)
  return () => {
    clearInterval(timer)
  }
}

/** Plays one cue for the settings preview. Phones only feel it, as a single buzz. */
export function previewHuddleSound(sound: HuddleSound): void {
  if (sound === 'off') return
  if (Platform.OS !== 'web') {
    Vibration.vibrate(RING_VIBRATION)
    return
  }
  const ctx = sharedAudioContext()
  if (!ctx) return
  if (ctx.state !== 'running') void ctx.resume().catch(() => {})
  scheduleTones(ctx, CUES[sound].tones, CUES[sound].peak)
}
