// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `OrganicParticles` — an audio-reactive Three.js point-sprite cloud,
 * the "cloud" sibling of `OrganicSphere`. Same four-band reactivity
 * model and the same determinism guarantees:
 *
 *   • seeded starting positions + wander phase
 *   • frozen render state while `active` is false
 *   • full state reset on every `active` false → true transition
 *
 * Minimal wiring is identical to `OrganicSphere`:
 *
 * ```tsx
 * const conversation = useVoiceConversation({ ... })
 *
 * <OrganicParticles
 *   getFrequencyData={conversation.getOutputByteFrequencyData}
 *   active={conversation.status === 'connected'}
 * />
 * ```
 *
 * Like the sphere, all tunable knobs live on `config` so a playground
 * or settings UI can round-trip them as JSON.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  ORGANIC_PARTICLES_VERTEX_SHADER,
  ORGANIC_PARTICLES_FRAGMENT_SHADER,
} from './shaders/organicParticlesShaders.js'
import type { BandReactivity } from './sphereConfig.js'
import {
  resolveOrganicParticlesConfig,
  type OrganicParticlesConfig,
} from './particlesConfig.js'

export interface OrganicParticlesProps {
  getFrequencyData?: () => Uint8Array | null
  active?: boolean
  config?: Partial<OrganicParticlesConfig>
  className?: string
  style?: React.CSSProperties
}

interface Variation {
  target: number
  current: number
}

/**
 * Deterministic [0, 1) pseudo-random — cheap hash-ish mix. Shared
 * concept with `OrganicSphere.seededUnit`; duplicated here to keep the
 * two components independently shippable.
 */
function seededUnit(seed: number, salt: number): number {
  const s = Math.sin((seed + salt * 7919) * 12.9898 + salt * 78.233) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Deterministically lays out `count` particles in a spherical shell
 * between `innerRadius` and `outerRadius` using seeded pseudo-random
 * spherical coords. Per-particle `aSeed` in [0, 1] is also returned
 * for the shader's per-particle variation.
 */
function buildParticleAttributes(
  count: number,
  innerRadius: number,
  outerRadius: number,
  seed: number,
): { positions: Float32Array; seeds: Float32Array } {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const u = seededUnit(seed, i * 4 + 1)
    const v = seededUnit(seed, i * 4 + 2)
    const w = seededUnit(seed, i * 4 + 3)
    const s = seededUnit(seed, i * 4 + 4)

    // Uniform on sphere surface + shell thickness.
    const theta = v * Math.PI * 2
    const phi = Math.acos(2 * w - 1)
    const r = innerRadius + u * Math.max(0, outerRadius - innerRadius)
    const sinPhi = Math.sin(phi)

    positions[i * 3 + 0] = r * sinPhi * Math.cos(theta)
    positions[i * 3 + 1] = r * sinPhi * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
    seeds[i] = s
  }
  return { positions, seeds }
}

/**
 * Audio-reactive particle cloud. See the module docblock for usage.
 */
export function OrganicParticles({
  getFrequencyData,
  active = true,
  config: configProp,
  className,
  style,
}: OrganicParticlesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const resolvedConfig = useMemo<OrganicParticlesConfig>(
    () => resolveOrganicParticlesConfig(configProp),
    [configProp],
  )

  const configRef = useRef<OrganicParticlesConfig>(resolvedConfig)
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

  // Init-only values. Changing these rebuilds the scene so the
  // particle buffers can be regenerated at the correct size.
  const initCount = resolvedConfig.count
  const initInnerRadius = resolvedConfig.innerRadius
  const initOuterRadius = resolvedConfig.outerRadius
  const initSeed = resolvedConfig.seed
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

    // --- Geometry: seeded spherical shell --------------------------------

    const { positions, seeds } = buildParticleAttributes(
      initCount,
      initInnerRadius,
      initOuterRadius,
      initSeed,
    )

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('aBasePosition', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    // Three.js expects a `position` attribute to compute a bounding
    // sphere; we reuse the base positions since particles stay roughly
    // within the spawn shell + noise/audio push.
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    // --- Material --------------------------------------------------------

    const colorCoolObj = new THREE.Color(cfg0.colorCool)
    const colorHotObj = new THREE.Color(cfg0.colorHot)

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uNoiseFrequency: { value: cfg0.noiseFrequency },
        uNoiseStrength: { value: cfg0.noiseStrength },
        uDisplacement: { value: cfg0.volume.idle },
        uSwirl: { value: cfg0.high.idle },
        uSwirlTimeRate: { value: cfg0.swirlTimeRate },
        uSizeBase: { value: cfg0.sizeBase },
        uSizeAudio: { value: cfg0.medium.idle },
        uPixelRatio: { value: pixelRatio },
        uColorCool: { value: colorCoolObj },
        uColorHot: { value: colorHotObj },
        uOpacity: { value: cfg0.opacity },
        uSoftness: { value: cfg0.softness },
      },
      vertexShader: ORGANIC_PARTICLES_VERTEX_SHADER,
      fragmentShader: ORGANIC_PARTICLES_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // --- Reactivity variations ------------------------------------------

    const variations: Record<'volume' | 'medium' | 'high' | 'low', Variation> = {
      volume: { target: 0, current: cfg0.volume.idle },
      medium: { target: 0, current: cfg0.medium.idle },
      high: { target: 0, current: cfg0.high.idle },
      low: { target: 0, current: cfg0.low.idle },
    }

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

    function bandTarget(
      reactivity: BandReactivity,
      levels: number[] | null,
      sourceLevel: number,
    ): number {
      if (!levels) return reactivity.idle
      return Math.max(
        reactivity.floor,
        reactivity.floor + sourceLevel * reactivity.gain,
      )
    }

    // Rotate the whole point system around the Y axis slowly; this is on
    // top of the per-particle shader swirl and gives the cloud a subtle
    // "global spin" that scales with the audio-driven high band.
    const rotationState = { y: 0 }
    const resetAnimationState = (cfg: OrganicParticlesConfig) => {
      material.uniforms.uTime.value = 0
      rotationState.y = 0
      points.rotation.set(0, 0, 0)
      variations.volume.current = cfg.volume.idle
      variations.medium.current = cfg.medium.idle
      variations.high.current = cfg.high.idle
      variations.low.current = cfg.low.idle
      variations.volume.target = cfg.volume.idle
      variations.medium.target = cfg.medium.idle
      variations.high.target = cfg.high.idle
      variations.low.target = cfg.low.idle
    }

    // --- Render loop -----------------------------------------------------

    let rafId = 0
    let lastTs = performance.now()
    let disposed = false
    let wasActive = activeRef.current

    const render = () => {
      if (disposed) return
      const now = performance.now()
      const delta = Math.min(now - lastTs, 100)
      lastTs = now

      const cfg = configRef.current

      // Sync uniforms from config each frame (cheap scalar assigns).
      colorCoolObj.set(cfg.colorCool)
      colorHotObj.set(cfg.colorHot)
      material.uniforms.uNoiseFrequency.value = cfg.noiseFrequency
      material.uniforms.uNoiseStrength.value = cfg.noiseStrength
      material.uniforms.uSwirlTimeRate.value = cfg.swirlTimeRate
      material.uniforms.uSizeBase.value = cfg.sizeBase
      material.uniforms.uOpacity.value = cfg.opacity
      material.uniforms.uSoftness.value = cfg.softness

      if (camera.position.z !== cfg.cameraZ) camera.position.z = cfg.cameraZ
      if (camera.fov !== cfg.fov) {
        camera.fov = cfg.fov
        camera.updateProjectionMatrix()
      }

      const isActive = activeRef.current

      // Fresh playback → deterministic reset.
      if (isActive && !wasActive) {
        resetAnimationState(cfg)
      }
      wasActive = isActive

      if (isActive) {
        let levels: number[] | null = null
        if (getFrequencyDataRef.current) {
          try {
            const buf = getFrequencyDataRef.current()
            if (buf && buf.length > 0) levels = computeLevels(buf)
          } catch {
            levels = null
          }
        }

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

        const timeFrequency = variations.low.current
        const elapsed = delta * timeFrequency

        material.uniforms.uDisplacement.value = variations.volume.current
        material.uniforms.uSizeAudio.value = variations.medium.current
        material.uniforms.uSwirl.value = variations.high.current
        material.uniforms.uTime.value += elapsed

        // Global Y rotation. Defaults to 0 (no constant drift) — the
        // cloud is still at rest and only spins in response to the
        // audio high-band. Increase `cfg.rotationBias` for a constant
        // slow drift.
        rotationState.y +=
          delta * cfg.rotationBias + variations.high.current * delta * 0.0008
        points.rotation.y = rotationState.y
      } else {
        // Idle: not actively reacting to audio, but advance uTime at a
        // slow configurable rate so the Perlin noise field keeps
        // shimmering subtly. All eased variations stay pinned at their
        // idle/current values, and rotation doesn't advance. Pure noise
        // drift → reads as a breathing dust cloud at rest.
        material.uniforms.uTime.value += delta * cfg.idleNoiseRate
      }

      renderer.render(scene, camera)
      rafId = requestAnimationFrame(render)
    }

    rafId = requestAnimationFrame(render)

    // --- Resize handling -------------------------------------------------

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

    // --- Cleanup ---------------------------------------------------------

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
  }, [
    initCount,
    initInnerRadius,
    initOuterRadius,
    initSeed,
    initMaxPixelRatio,
    initBackgroundColor,
  ])

  return <div ref={containerRef} className={className} style={style} />
}
