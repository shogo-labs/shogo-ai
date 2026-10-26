// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where the notification and ringtone recordings live. Kept apart from the
 * sound engines and loaded lazily, so they (and their tests) never import the
 * audio files or `expo-asset` until a sound is needed.
 */
import { Asset } from 'expo-asset'

const MESSAGE_RECORDINGS = {
  knock: require('../assets/sounds/soft-knock.mp3'),
  pristine: require('../assets/sounds/pristine.mp3'),
  definite: require('../assets/sounds/definite.mp3'),
  juntos: require('../assets/sounds/juntos.mp3'),
  confirmation: require('../assets/sounds/confirmation.mp3'),
  question: require('../assets/sounds/question.mp3'),
  glass: require('../assets/sounds/glass.mp3'),
} as const
const LLAMADA_CLARA = require('../assets/sounds/llamada-clara.mp3')

export type RecordedMessageTone = keyof typeof MESSAGE_RECORDINGS

function assetUrl(moduleId: number): string | null {
  try {
    return Asset.fromModule(moduleId).uri || null
  } catch {
    return null
  }
}

/** URL of a message tone recording (Soft Knock by default), or null when it can't be resolved. */
export function messageSoundUrl(tone: RecordedMessageTone = 'knock'): string | null {
  const moduleId = MESSAGE_RECORDINGS[tone]
  return moduleId ? assetUrl(moduleId) : null
}

/** URL of the Llamada Clara huddle ringtone, or null when it can't be resolved. */
export function huddleRingtoneUrl(): string | null {
  return assetUrl(LLAMADA_CLARA)
}
