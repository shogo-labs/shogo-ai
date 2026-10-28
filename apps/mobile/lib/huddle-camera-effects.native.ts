// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Camera effects need browser video processing, so phones don't have them.
 * Same exports as `huddle-camera-effects.ts`, reporting "unsupported".
 */
import type { BackgroundEffect } from './huddle-prefs'

export interface CameraEffectsConfig {
  background: BackgroundEffect
  autoFraming: boolean
  lowLight: boolean
}

export const cameraEffectsSupported = false

export function hasCameraEffects(config: CameraEffectsConfig): boolean {
  return config.background.kind !== 'none' || config.autoFraming || config.lowLight
}

export function targetCrop(): { cx: number; cy: number; zoom: number } {
  return { cx: 0.5, cy: 0.5, zoom: 1 }
}

export function lowLightGain(): number {
  return 1
}

export class CameraEffectsProcessor {
  name = 'shogo-camera-effects'
  onFramingUnavailable?: () => void
  constructor(_config: CameraEffectsConfig) {}
}
