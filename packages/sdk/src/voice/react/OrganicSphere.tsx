// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `OrganicSphere` — an audio-reactive Three.js visualization for voice
 * agents, adapted from Bruno Simon's open-source "organic-sphere" demo
 * (https://github.com/brunosimon/organic-sphere).
 *
 * The component renders a noise-distorted sphere whose displacement,
 * distortion, and fresnel falloff are driven by four eased "variations"
 * computed from the agent's frequency bands:
 *
 *   low    → modulates time-evolution speed (noise drift)
 *   volume → `uDisplacementStrength` (how far each vertex pushes out)
 *   medium → `uFresnelMultiplier`    (silhouette lighting intensity)
 *   high   → `uDistortionStrength`   (large-scale warping)
 *
 * Everything that can be tuned at runtime — colors, light intensity,
 * rim, per-band idle / gain / floor / attack / decay, camera — lives on
 * the `config` prop. Values are merged against
 * `DEFAULT_ORGANIC_SPHERE_CONFIG` so callers only pass what they want
 * to override, and the render loop re-reads the resolved config every
 * frame so sliders / live tuning take effect immediately without
 * remounting the scene.
 *
 * Minimal wiring:
 *
 * ```tsx
 * const conversation = useVoiceConversation({ ... })
 *
 * <OrganicSphere
 *   getFrequencyData={conversation.getOutputByteFrequencyData}
 *   active={conversation.status === 'connected'}
 * />
 * ```
 *
 * With a custom preset:
 *
 * ```tsx
 * <OrganicSphere
 *   config={{
 *     lightAColor: '#c2410c',
 *     volume: { gain: 0.4, attack: 0.05 },
 *   }}
 * />
 * ```
 *
 * Requires `three` to be installed in the host app (optional peer
 * dependency of `@shogo-ai/sdk`). Web only; the module imports
 * `three`, which in turn pokes at WebGL / `document` at module load.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  ORGANIC_SPHERE_VERTEX_SHADER,
  ORGANIC_SPHERE_FRAGMENT_SHADER,
} from './shaders/organicSphereShaders.js'
import {
  resolveOrganicSphereConfig,
  type BandReactivity,
  type OrganicSphereConfig,
} from './sphereConfig.js'

export interface OrganicSphereProps {
  /**
   * Returns the current agent-output frequency buffer (length = fftSize,
   * values 0–255). Typically `useVoiceConversation().getOutputByteFrequencyData`.
   *
   * Can also be pointed at `analyserNode.getByteFrequencyData` from any
   * WebAudio graph for non-ElevenLabs callers.
   */
  getFrequencyData?: () => Uint8Array | null

  /**
   * Whether audio is live. When `false` the sphere settles into its
   * idle pose (no pulsing). Purely cosmetic — the component keeps the
   * render loop running either way.
   *
   * @default true
   */
  active?: boolean

  /**
   * Full configuration object (partial). Any unspecified keys fall back
   * to `DEFAULT_ORGANIC_SPHERE_CONFIG`. Individual convenience props
   * below (e.g. `lightAColor`) take precedence over the same key inside
   * `config`, so you can combine a base preset with a single override.
   */
  config?: Partial<OrganicSphereConfig>

  // --- Convenience overrides (back-compat with pre-config callers) ----

  /** Overrides `config.lightAColor`. */
  lightAColor?: string
  /** Overrides `config.lightBColor`. */
  lightBColor?: string
  /** Overrides `config.rimColor`. */
  rimColor?: string
  /** Overrides `config.rimThreshold`. */
  rimThreshold?: number
  /** Overrides `config.rimPower`. */
  rimPower?: number
  /** Overrides `config.backgroundColor`. */
  backgroundColor?: string | null
  /** Overrides `config.subdivisions` (re-init on change). */
  subdivisions?: number
  /** Overrides `config.maxPixelRatio` (re-init on change). */
  maxPixelRatio?: number

  /**
   * Extra classes merged onto the wrapping `<div>`. Size the parent
   * element; the canvas fills it.
   */
  className?: string

  /** Inline style override for the wrapping `<div>`. */
  style?: React.CSSProperties
}

interface Variation {
  target: number
  current: number
}

/**
 * Deterministic [0, 1) pseudo-random from an integer seed + salt. A
 * cheap hash-ish mix is good enough for two independent starting phases
 * per seed; we don't need crypto quality here.
 */
function seededUnit(seed: number, salt: number): number {
  const s = Math.sin((seed + salt * 7919) * 12.9898 + salt * 78.233) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Audio-reactive organic sphere. See the module docblock for usage.
 */
export function OrganicSphere({
  getFrequencyData,
  active = true,
  config: configProp,
  lightAColor,
  lightBColor,
  rimColor,
  rimThreshold,
  rimPower,
  backgroundColor,
  subdivisions,
  maxPixelRatio,
  className,
  style,
}: OrganicSphereProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Merge: defaults → config prop → individual convenience props
  const resolvedConfig = useMemo<OrganicSphereConfig>(() => {
    const base = resolveOrganicSphereConfig(configProp)
    const overrides: Partial<OrganicSphereConfig> = {}
    if (lightAColor !== undefined) overrides.lightAColor = lightAColor
    if (lightBColor !== undefined) overrides.lightBColor = lightBColor
    if (rimColor !== undefined) overrides.rimColor = rimColor
    if (rimThreshold !== undefined) overrides.rimThreshold = rimThreshold
    if (rimPower !== undefined) overrides.rimPower = rimPower
    if (backgroundColor !== undefined) overrides.backgroundColor = backgroundColor
    if (subdivisions !== undefined) overrides.subdivisions = subdivisions
    if (maxPixelRatio !== undefined) overrides.maxPixelRatio = maxPixelRatio
    return { ...base, ...overrides }
  }, [
    configProp,
    lightAColor,
    lightBColor,
    rimColor,
    rimThreshold,
    rimPower,
    backgroundColor,
    subdivisions,
    maxPixelRatio,
  ])

  // Everything that can change at runtime flows through a ref so the
  // imperative render loop doesn't get torn down per-render.
  const configRef = useRef<OrganicSphereConfig>(resolvedConfig)
  useEffect(() => {
    configRef.current = resolvedConfig
  }, [resolvedConfig])

  const getFrequencyDataRef = useRef(getFrequencyData)
  const activeRef = useRef(active)
  useEffect(() => {
    getFrequencyDataRef.current = getFrequencyData
  }, [getFrequencyData])
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // Init-only values. Changing these truly rebuilds the WebGL scene.
  const initSubdivisions = resolvedConfig.subdivisions
  const initMaxPixelRatio = resolvedConfig.maxPixelRatio
  const initBackgroundColor = resolvedConfig.backgroundColor

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cfg0 = configRef.current
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    const pixelRatio = Math.min(
      initMaxPixelRatio ??
        (typeof window !== 'undefined' ? window.devicePixelRatio : 1),
      2,
    )

    const scene = new THREE.Scene()
    if (initBackgroundColor) scene.background = new THREE.Color(initBackgroundColor)

    const camera = new THREE.PerspectiveCamera(cfg0.fov, width / height, 0.1, 100)
    camera.position.set(0, 0, cfg0.cameraZ)
    scene.add(camera)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: initBackgroundColor === null,
      powerPreference: 'high-performance',
    })
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(pixelRatio)
    renderer.setClearColor(0x000000, initBackgroundColor === null ? 0 : 1)
    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    const geometry = new THREE.SphereGeometry(1, initSubdivisions, initSubdivisions)
    geometry.computeTangents()

    // Fixed light positions, matching the upstream lighting setup.
    const lightAPos = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(1, 0.615, 2.049),
    )
    const lightBPos = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(1, 2.561, -1.844),
    )

    // Color instances reused forever; .set() in the render loop to pick up
    // config changes without re-creating uniforms.
    const lightAColorObj = new THREE.Color(cfg0.lightAColor)
    const lightBColorObj = new THREE.Color(cfg0.lightBColor)
    const rimColorObj = new THREE.Color(cfg0.rimColor ?? cfg0.lightBColor)

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uLightAColor: { value: lightAColorObj },
        uLightAPosition: { value: lightAPos },
        uLightAIntensity: { value: cfg0.lightAIntensity },
        uLightBColor: { value: lightBColorObj },
        uLightBPosition: { value: lightBPos },
        uLightBIntensity: { value: cfg0.lightBIntensity },
        uSubdivision: {
          value: new THREE.Vector2(initSubdivisions, initSubdivisions),
        },
        uOffset: { value: new THREE.Vector3() },
        uDistortionFrequency: { value: cfg0.distortionFrequency },
        uDistortionStrength: { value: cfg0.high.idle },
        uDisplacementFrequency: { value: cfg0.displacementFrequency },
        uDisplacementStrength: { value: cfg0.volume.idle },
        uFresnelOffset: { value: cfg0.fresnelOffset },
        uFresnelMultiplier: { value: cfg0.medium.idle },
        uFresnelPower: { value: cfg0.fresnelPower },
        uRimColor: { value: rimColorObj },
        uRimThreshold: { value: cfg0.rimThreshold },
        uRimPower: { value: cfg0.rimPower },
        uTime: { value: 0 },
      },
      defines: { USE_TANGENT: '' },
      vertexShader: ORGANIC_SPHERE_VERTEX_SHADER,
      fragmentShader: ORGANIC_SPHERE_FRAGMENT_SHADER,
    })

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // Wander offset — seeded so identical playbacks produce identical
    // visuals. Reset to this same starting phase every time `active`
    // flips false → true (i.e. every fresh playback).
    const seedInitialPhase = (seed: number) => ({
      phi: seededUnit(seed, 1) * Math.PI,
      theta: seededUnit(seed, 2) * Math.PI * 2,
    })
    const initialPhase = seedInitialPhase(cfg0.seed)
    const offsetSpherical = new THREE.Spherical(1, initialPhase.phi, initialPhase.theta)
    const offsetDirection = new THREE.Vector3().setFromSpherical(offsetSpherical)

    const variations: Record<'volume' | 'medium' | 'high' | 'low', Variation> = {
      volume: { target: 0, current: cfg0.volume.idle },
      medium: { target: 0, current: cfg0.medium.idle },
      high: { target: 0, current: cfg0.high.idle },
      low: { target: 0, current: cfg0.low.idle },
    }

    // Full animation-state reset. Invoked once at construction (already
    // initialized above) and again on every `active` false → true
    // transition so a given audio source always starts from the same
    // pose. Pure function of `cfg.seed` + current idle values.
    const resetAnimationState = (cfg: OrganicSphereConfig) => {
      material.uniforms.uTime.value = 0
      material.uniforms.uOffset.value.set(0, 0, 0)
      const phase = seedInitialPhase(cfg.seed)
      offsetSpherical.radius = 1
      offsetSpherical.phi = phase.phi
      offsetSpherical.theta = phase.theta
      variations.volume.current = cfg.volume.idle
      variations.medium.current = cfg.medium.idle
      variations.high.current = cfg.high.idle
      variations.low.current = cfg.low.idle
      variations.volume.target = cfg.volume.idle
      variations.medium.target = cfg.medium.idle
      variations.high.target = cfg.high.idle
      variations.low.target = cfg.low.idle
    }

    // Split the frequency buffer into 8 averaged bands (we use the first 3).
    const LEVEL_COUNT = 8
    function computeLevels(buf: Uint8Array): number[] {
      const bins = Math.floor(buf.length / LEVEL_COUNT)
      const levels: number[] = new Array(LEVEL_COUNT).fill(0)
      if (bins <= 0) return levels
      for (let i = 0; i < LEVEL_COUNT; i++) {
        let sum = 0
        for (let j = 0; j < bins; j++) sum += buf[i * bins + j]
        levels[i] = sum / bins / 256
      }
      return levels
    }

    // Maps a band reactivity + live levels to a target value.
    // When audio is off (levels === null) the target is the idle pose.
    // When audio is on the target is `floor + gain * level`, clamped
    // (mostly a safety net for negative gains) to at least `floor`.
    function bandTarget(
      reactivity: BandReactivity,
      levels: number[] | null,
      sourceLevel: number,
    ): number {
      if (!levels) return reactivity.idle
      return Math.max(reactivity.floor, reactivity.floor + sourceLevel * reactivity.gain)
    }

    // --- Render loop ------------------------------------------------------

    let rafId = 0
    let lastTs = performance.now()
    let disposed = false
    let wasActive = activeRef.current
    let lastSeed = cfg0.seed

    const render = () => {
      if (disposed) return
      const now = performance.now()
      const delta = Math.min(now - lastTs, 100) // Clamp big hitches.
      lastTs = now

      const cfg = configRef.current

      // Sync colors in place so uniforms keep the same object refs.
      lightAColorObj.set(cfg.lightAColor)
      lightBColorObj.set(cfg.lightBColor)
      rimColorObj.set(cfg.rimColor ?? cfg.lightBColor)

      // Scalar uniforms — cheap to assign, always current.
      material.uniforms.uLightAIntensity.value = cfg.lightAIntensity
      material.uniforms.uLightBIntensity.value = cfg.lightBIntensity
      material.uniforms.uDistortionFrequency.value = cfg.distortionFrequency
      material.uniforms.uDisplacementFrequency.value = cfg.displacementFrequency
      material.uniforms.uFresnelOffset.value = cfg.fresnelOffset
      material.uniforms.uFresnelPower.value = cfg.fresnelPower
      material.uniforms.uRimThreshold.value = cfg.rimThreshold
      material.uniforms.uRimPower.value = cfg.rimPower

      // Camera — guard trivial writes to avoid unnecessary matrix updates.
      if (camera.position.z !== cfg.cameraZ) camera.position.z = cfg.cameraZ
      if (camera.fov !== cfg.fov) {
        camera.fov = cfg.fov
        camera.updateProjectionMatrix()
      }

      const isActive = activeRef.current

      // Fresh playback: reset accumulated animation state so the same
      // audio produces the same visual every time. Also reset when the
      // seed changes, so dragging the seed slider previews the new
      // starting pose without having to stop and restart playback.
      if ((isActive && !wasActive) || cfg.seed !== lastSeed) {
        resetAnimationState(cfg)
        lastSeed = cfg.seed
      }
      wasActive = isActive

      if (isActive) {
        // Pull live audio levels if available.
        let levels: number[] | null = null
        if (getFrequencyDataRef.current) {
          try {
            const buf = getFrequencyDataRef.current()
            if (buf && buf.length > 0) levels = computeLevels(buf)
          } catch {
            levels = null
          }
        }

        // Per-band eased variation update. `volume` is special: it tracks
        // the loudest of the first three bands rather than a single band.
        const l0 = levels ? (levels[0] || 0) : 0
        const l1 = levels ? (levels[1] || 0) : 0
        const l2 = levels ? (levels[2] || 0) : 0
        const loudest = Math.max(l0, l1, l2)

        const update = (
          variation: Variation,
          reactivity: BandReactivity,
          sourceLevel: number,
        ) => {
          variation.target = bandTarget(reactivity, levels, sourceLevel)
          const easing =
            variation.target > variation.current ? reactivity.attack : reactivity.decay
          variation.current += (variation.target - variation.current) * easing * delta
        }

        update(variations.volume, cfg.volume, loudest)
        update(variations.medium, cfg.medium, l1)
        update(variations.high, cfg.high, l2)
        update(variations.low, cfg.low, l0)

        // Time evolves faster when there's bass.
        const timeFrequency = variations.low.current
        const elapsed = delta * timeFrequency

        material.uniforms.uDisplacementStrength.value = variations.volume.current
        material.uniforms.uDistortionStrength.value = variations.high.current
        material.uniforms.uFresnelMultiplier.value = variations.medium.current

        const offsetTime = (material.uniforms.uTime.value + elapsed) * 0.3
        offsetSpherical.phi =
          ((Math.sin(offsetTime * 0.001) * Math.sin(offsetTime * 0.00321)) * 0.5 + 0.5) *
          Math.PI
        offsetSpherical.theta =
          ((Math.sin(offsetTime * 0.0001) * Math.sin(offsetTime * 0.000321)) * 0.5 + 0.5) *
          Math.PI *
          2
        offsetDirection.setFromSpherical(offsetSpherical)
        offsetDirection.multiplyScalar(timeFrequency * 2)
        material.uniforms.uOffset.value.add(offsetDirection)

        material.uniforms.uTime.value += elapsed
      }
      // else: inactive — hold all animation state frozen so the sphere
      // sits perfectly still while paused (no time drift, no eased
      // decay). The canvas is still repainted so size changes / config
      // tweaks still show up.

      renderer.render(scene, camera)
      rafId = requestAnimationFrame(render)
    }

    rafId = requestAnimationFrame(render)

    // --- Resize handling --------------------------------------------------

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const w = container.clientWidth || 1
            const h = container.clientHeight || 1
            camera.aspect = w / h
            camera.updateProjectionMatrix()
            renderer.setSize(w, h, false)
          })
        : null
    resizeObserver?.observe(container)

    // --- Cleanup ----------------------------------------------------------

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
    }
  }, [initSubdivisions, initMaxPixelRatio, initBackgroundColor])

  return <div ref={containerRef} className={className} style={style} />
}
