// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where the notification and ringtone recordings live. Kept apart from the
 * sound engines and loaded lazily, so they (and their tests) never import the
 * audio files or `expo-asset` until a sound is needed.
 */
import { Asset } from 'expo-asset'

const SOFT_KNOCK = require('../assets/sounds/soft-knock.mp3')
const LLAMADA_CLARA = require('../assets/sounds/llamada-clara.mp3')

function assetUrl(moduleId: number): string | null {
  try {
    return Asset.fromModule(moduleId).uri || null
  } catch {
    return null
  }
}

/** URL of the Soft Knock recording, or null when it can't be resolved. */
export function messageSoundUrl(): string | null {
  return assetUrl(SOFT_KNOCK)
}

/** URL of the Llamada Clara huddle ringtone, or null when it can't be resolved. */
export function huddleRingtoneUrl(): string | null {
  return assetUrl(LLAMADA_CLARA)
}
