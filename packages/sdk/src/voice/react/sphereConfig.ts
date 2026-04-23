// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Configuration surface for the `OrganicSphere` audio-reactive
 * visualization. All values are plain numbers / strings / null so the
 * whole object is JSON-serializable — save it, transport it, paste it
 * into a preset library.
 *
 * The sphere renders four eased "variations" driven by frequency bands:
 *
 *   low    → modulates time-evolution speed (drift + noise phase)
 *   volume → drives `uDisplacementStrength` (how far each vertex pushes
 *            out from the sphere surface)
 *   medium → drives `uFresnelMultiplier` (how bright the lighting pass
 *            gets near silhouette edges)
 *   high   → drives `uDistortionStrength` (large-scale warping of the
 *            underlying position field before displacement)
 *
 * Each variation has a resting `idle` value used when audio is off, a
 * `gain` multiplier applied to the band level, a `floor` minimum while
 * audio is playing, and separate attack / decay easing rates.
 *
 * Use `resolveOrganicSphereConfig(partial)` to merge a partial override
 * into the defaults; `OrganicSphere` does this internally so consumers
 * can pass any subset.
 */

export interface BandReactivity {
  /** Resting target used when no audio source is connected. */
  idle: number
  /** Multiplier applied to the normalized band level (0–1) while audio plays. */
  gain: number
  /** Minimum target while audio is playing, before easing. */
  floor: number
  /**
   * Easing rate when the target rises above `current` (snappier attack
   * at higher values; per-ms-of-frame delta, not per-frame).
   */
  attack: number
  /** Easing rate when the target falls below `current` (per-ms). */
  decay: number
}

export interface OrganicSphereConfig {
  // --- Lighting & rim --------------------------------------------------

  /** Color of light A (default is a deep Shogo burnt orange). */
  lightAColor: string
  /** Color of light B (default is a warm Shogo amber). */
  lightBColor: string
  /** Intensity multiplier for light A. Higher = brighter contribution. */
  lightAIntensity: number
  /** Intensity multiplier for light B. */
  lightBIntensity: number
  /**
   * Rim-highlight color. `null` falls back to `lightBColor`, which keeps
   * the silhouette monochromatic and impossible to wash out to white.
   */
  rimColor: string | null
  /**
   * Fresnel value above which the rim starts contributing. Higher →
   * tighter rim; lower → rim bleeds across more of the surface.
   */
  rimThreshold: number
  /** Exponent on the rim falloff curve. Higher → sharper edge. */
  rimPower: number

  // --- Static shape parameters ----------------------------------------

  /** Spatial frequency of the distortion noise (`uDistortionFrequency`). */
  distortionFrequency: number
  /** Spatial frequency of the displacement noise (`uDisplacementFrequency`). */
  displacementFrequency: number
  /** Fresnel offset — shifts where the rim and lighting gradient peak. */
  fresnelOffset: number
  /** Fresnel power — steepens or softens the lighting gradient. */
  fresnelPower: number

  // --- Audio reactivity ------------------------------------------------

  /**
   * Volume variation → `uDisplacementStrength`. Driven by the loudest
   * of the first three bands (`max(l0, l1, l2)`).
   */
  volume: BandReactivity
  /** Mid-band variation → `uFresnelMultiplier`. Driven by `l1`. */
  medium: BandReactivity
  /** High-band variation → `uDistortionStrength`. Driven by `l2`. */
  high: BandReactivity
  /**
   * Low-band variation → time evolution speed (how fast the noise
   * offset scrolls). Driven by `l0`.
   */
  low: BandReactivity

  // --- Camera ----------------------------------------------------------

  /** Camera z-position. Larger = more zoomed out. */
  cameraZ: number
  /** Vertical field-of-view in degrees. */
  fov: number

  // --- Determinism -----------------------------------------------------

  /**
   * Seed used to derive the initial "wander" offset phase, so identical
   * audio produces identical visuals across playbacks. Any integer is
   * fine; change it to roll a different starting pose. When `active`
   * flips from `false` → `true`, the sphere resets to this phase.
   */
  seed: number

  // --- Init-only (changing these remounts the scene) -------------------

  /**
   * Sphere mesh subdivisions. Higher = smoother displacement, more GPU
   * cost. Changing at runtime triggers a scene rebuild.
   */
  subdivisions: number
  /**
   * Device-pixel-ratio cap. `null` picks `min(devicePixelRatio, 2)`.
   * Set to `1` for lower-end devices.
   */
  maxPixelRatio: number | null
  /**
   * Scene clear color. `null` keeps the canvas fully transparent so the
   * sphere blends into the host UI.
   */
  backgroundColor: string | null
}

/**
 * Preset tuned for Shogo's Voice Mode hero — warm Shogo orange palette,
 * rim tied to `lightBColor`, camera zoomed back so the sphere reads
 * "contained" rather than "looming", reactivity values copied from
 * Bruno Simon's upstream `organic-sphere` demo so silhouettes animate
 * faithfully.
 */
export const DEFAULT_ORGANIC_SPHERE_CONFIG: OrganicSphereConfig = {
  // Lighting & rim
  lightAColor: '#c2410c',
  lightBColor: '#fb923c',
  lightAIntensity: 2.13,
  lightBIntensity: 1.61,
  rimColor: null,
  rimThreshold: 0.92,
  rimPower: 5,

  // Static shape
  distortionFrequency: 1.5,
  displacementFrequency: 2.12,
  fresnelOffset: -1.609,
  fresnelPower: 1.793,

  // Audio reactivity
  volume: {
    idle: 0.152,
    gain: 0.3,
    floor: 0,
    attack: 0.03,
    decay: 0.002,
  },
  medium: {
    idle: 3.587,
    gain: 2,
    floor: 3.587,
    attack: 0.008,
    decay: 0.004,
  },
  high: {
    idle: 0.65,
    gain: 5,
    floor: 0.5,
    attack: 0.02,
    decay: 0.001,
  },
  low: {
    idle: 0.0003,
    gain: 0.003,
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
  subdivisions: 512,
  maxPixelRatio: null,
  backgroundColor: null,
}

/**
 * Merge a partial override into `DEFAULT_ORGANIC_SPHERE_CONFIG`, doing a
 * shallow merge on the root + per-band merge on `volume/medium/high/low`
 * so consumers only need to specify what they want to change.
 */
export function resolveOrganicSphereConfig(
  partial?: Partial<OrganicSphereConfig>,
): OrganicSphereConfig {
  const base = DEFAULT_ORGANIC_SPHERE_CONFIG
  if (!partial) return { ...base, volume: { ...base.volume }, medium: { ...base.medium }, high: { ...base.high }, low: { ...base.low } }
  return {
    ...base,
    ...partial,
    volume: { ...base.volume, ...(partial.volume ?? {}) },
    medium: { ...base.medium, ...(partial.medium ?? {}) },
    high: { ...base.high, ...(partial.high ?? {}) },
    low: { ...base.low, ...(partial.low ?? {}) },
  }
}
