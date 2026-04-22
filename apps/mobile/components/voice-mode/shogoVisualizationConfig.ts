// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Voice Mode visualization preset.
 *
 * Generated from the SDK playground (packages/sdk/playgrounds/sphere)
 * by tuning sliders against the looping Shogo greeting. Load a JSON
 * export from that playground and paste it back here to re-tune.
 *
 * Lives in the app (not the SDK) because it's a product-level
 * design choice, not a library default. Changing this only affects the
 * in-panel Voice Mode hero; the SDK defaults (`DEFAULT_ORGANIC_*_CONFIG`)
 * are independent.
 */

import type { OrganicParticlesConfig } from '@shogo-ai/sdk/voice/react'

export const SHOGO_PARTICLES_CONFIG: OrganicParticlesConfig = {
  count: 18000,
  innerRadius: 0.18,
  outerRadius: 1.94,
  noiseFrequency: 2.88,
  noiseStrength: 0.76,
  rotationBias: 0,
  swirlTimeRate: 0,
  idleNoiseRate: 0.00045,
  sizeBase: 9.55,
  softness: 0.99,
  opacity: 0.30,
  colorCool: '#ffcccc',
  colorHot: '#fb923c',
  volume: {
    idle: 0.00208,
    gain: 1.01,
    floor: 0.067,
    attack: 0.012,
    decay: 0.142,
  },
  medium: {
    idle: 0.00417,
    gain: 4.04,
    floor: 0.351,
    attack: 0.01,
    decay: 0.074,
  },
  high: {
    idle: 0.004,
    gain: 0.11,
    floor: 0.07,
    attack: 0.004,
    decay: 0.002,
  },
  low: {
    idle: 0.00208,
    gain: 0.0001,
    floor: 0.00193,
    attack: 0.005,
    decay: 0.071,
  },
  cameraZ: 12,
  fov: 30,
  seed: 478,
  maxPixelRatio: null,
  backgroundColor: null,
}
