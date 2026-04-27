// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Configuration surface for the `OrganicParticles` audio-reactive
 * visualization — a particle-cloud sibling of `OrganicSphere`.
 *
 * Shares the same `BandReactivity` shape and four-band model
 * (volume / medium / high / low) as the sphere, so audio-tuning muscle
 * memory carries over. What changes is the cloud-specific fields:
 *
 *   volume → radial displacement (how far the cloud bursts outward)
 *   medium → particle size boost (how puffy each point renders)
 *   high   → swirl strength (how much the cloud twists)
 *   low    → time evolution speed (noise phase drift)
 *
 * Like `OrganicSphereConfig`, everything is JSON-serializable.
 */

import { type BandReactivity } from './sphereConfig.js'

export interface OrganicParticlesConfig {
  // --- Cloud shape (init-only for `count`, live for the rest) ----------

  /**
   * Number of particles. Changing this rebuilds the scene. Sweet spot
   * for visual density without frame-drop is 20k–80k on a modern GPU.
   */
  count: number
  /**
   * Inner / outer radius of the seeded spawn shell. Particles are
   * uniformly distributed between these two radii so the cloud has
   * perceptible thickness rather than sitting on a single sphere.
   */
  innerRadius: number
  outerRadius: number

  // --- Motion (continuous) --------------------------------------------

  /** Spatial frequency of the Perlin noise warp. */
  noiseFrequency: number
  /** Strength of the noise warp. */
  noiseStrength: number
  /**
   * Constant per-ms Y-axis rotation applied to the whole cloud,
   * independent of audio. `0` (default) means the cloud is perfectly
   * still when no audio plays. Positive = spin right, negative = left.
   */
  rotationBias: number
  /**
   * Rate (per ms) at which `uTime` advances the per-particle swirl
   * angle in the shader, independent of audio. `0` (default) = swirl
   * only responds to audio high-band + particle height.
   */
  swirlTimeRate: number
  /**
   * Rate (per ms) at which `uTime` advances while the cloud is idle
   * (i.e. `active === false`). Lets the Perlin noise field keep
   * shimmering subtly when nothing is playing so the cloud doesn't feel
   * dead. `0` = fully frozen when paused. Default `0.0001` ≈ one full
   * noise period every ~10 s — perceptible but not distracting.
   */
  idleNoiseRate: number

  // --- Rendering ------------------------------------------------------

  /** Base particle size (before audio boost / perspective scaling). */
  sizeBase: number
  /**
   * Edge softness of each particle sprite, in [0, 1]. `0` = hard disc,
   * `1` = heavy feather/plasma. ~0.6 reads as "nebula".
   */
  softness: number
  /** Overall opacity multiplier. */
  opacity: number

  // --- Color ----------------------------------------------------------

  /** Color at the cloud core (low `vHeat`). */
  colorCool: string
  /** Color at the cloud fringe (high `vHeat`). */
  colorHot: string

  // --- Audio reactivity (same shape as sphere bands) -------------------

  /** volume → radial displacement push. */
  volume: BandReactivity
  /** medium → per-particle size boost. */
  medium: BandReactivity
  /** high → swirl / twist amount. */
  high: BandReactivity
  /** low → time evolution speed. */
  low: BandReactivity

  // --- Camera ---------------------------------------------------------

  cameraZ: number
  fov: number

  // --- Determinism ----------------------------------------------------

  /**
   * Seed used to generate the initial particle positions AND the wander
   * phase. Same seed + same audio → same visual across playbacks.
   */
  seed: number

  // --- Init-only ------------------------------------------------------

  /** `null` picks `min(devicePixelRatio, 2)`. */
  maxPixelRatio: number | null
  /** Scene clear color. `null` = transparent. */
  backgroundColor: string | null
}

/**
 * Preset tuned to match the Shogo warm-orange palette used by
 * `DEFAULT_ORGANIC_SPHERE_CONFIG`, so the two modes read as siblings.
 * Count/size defaults target 60fps on mid-tier GPUs.
 */
export const DEFAULT_ORGANIC_PARTICLES_CONFIG: OrganicParticlesConfig = {
  // Cloud shape
  count: 40000,
  innerRadius: 0.6,
  outerRadius: 1.1,

  // Motion. Constant rotation / swirl drift default to 0 so the cloud
  // only spins in response to audio — but `idleNoiseRate` keeps the
  // Perlin field shimmering slightly so the cloud doesn't look frozen
  // while paused.
  noiseFrequency: 1.4,
  noiseStrength: 0.22,
  rotationBias: 0,
  swirlTimeRate: 0,
  idleNoiseRate: 0.0001,

  // Rendering. Additive blending stacks contributions, so keep opacity
  // low (<0.3) or 40k particles will saturate to white. sizeBase ~1
  // renders as tiny dust; crank it higher for softer plasma look.
  sizeBase: 1.0,
  softness: 0.55,
  opacity: 0.18,

  // Color
  colorCool: '#c2410c',
  colorHot: '#fb923c',

  // Audio reactivity
  volume: {
    idle: 0.02,
    gain: 0.4,
    floor: 0,
    attack: 0.03,
    decay: 0.0025,
  },
  medium: {
    idle: 0.0,
    gain: 4,
    floor: 0,
    attack: 0.01,
    decay: 0.004,
  },
  high: {
    idle: 0.2,
    gain: 1.2,
    floor: 0.15,
    attack: 0.015,
    decay: 0.002,
  },
  low: {
    idle: 0.0004,
    gain: 0.004,
    floor: 0.0001,
    attack: 0.005,
    decay: 0.002,
  },

  // Camera
  cameraZ: 3.84,
  fov: 35,

  // Determinism
  seed: 0,

  // Init-only
  maxPixelRatio: null,
  backgroundColor: null,
}

/**
 * Merge a partial override into `DEFAULT_ORGANIC_PARTICLES_CONFIG`,
 * with per-band shallow merges for `volume/medium/high/low`.
 */
export function resolveOrganicParticlesConfig(
  partial?: Partial<OrganicParticlesConfig>,
): OrganicParticlesConfig {
  const base = DEFAULT_ORGANIC_PARTICLES_CONFIG
  if (!partial) {
    return {
      ...base,
      volume: { ...base.volume },
      medium: { ...base.medium },
      high: { ...base.high },
      low: { ...base.low },
    }
  }
  return {
    ...base,
    ...partial,
    volume: { ...base.volume, ...(partial.volume ?? {}) },
    medium: { ...base.medium, ...(partial.medium ?? {}) },
    high: { ...base.high, ...(partial.high ?? {}) },
    low: { ...base.low, ...(partial.low ?? {}) },
  }
}
