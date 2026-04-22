// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `OrganicSphere` — an audio-reactive Three.js visualization for voice
 * agents, adapted from Bruno Simon's open-source "organic-sphere" demo
 * (https://github.com/brunosimon/organic-sphere).
 *
 * The component renders a noise-distorted sphere whose displacement,
 * distortion, and fresnel falloff are driven by three audio frequency
 * bands (low / medium / high), so it visibly pulses in time with the
 * speaking agent.
 *
 * Wire it up in one line alongside `useVoiceConversation`:
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
 * The component pulls a fresh `Uint8Array` every frame via the supplied
 * getter. When the getter returns `null` (e.g. no live audio), the
 * sphere drifts at rest using the upstream's default idle values —
 * same silhouette, no pulsing.
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
   * Two light sources illuminate the sphere from opposite hemispheres.
   * Defaults are a warm Shogo orange palette (dark / light orange).
   */
  lightAColor?: string
  lightBColor?: string

  /**
   * Color of the fresnel-driven rim highlight along silhouette edges and
   * displacement peaks. Defaults to `lightBColor` so the rim blends
   * naturally into the warmer light and never reads as white. Pass an
   * explicit value (e.g. `'#ffd9a8'`) for a contrasting accent.
   *
   * @default lightBColor
   */
  rimColor?: string

  /**
   * Fresnel value above which the rim highlight begins to appear. Higher
   * values (closer to 1) concentrate the rim to the very edge; lower
   * values bleed it across more of the surface.
   *
   * @default 0.92
   */
  rimThreshold?: number

  /**
   * Exponent applied to the rim falloff curve. Higher values produce a
   * sharper, softer rim that only peaks at the extreme silhouette.
   *
   * @default 5
   */
  rimPower?: number

  /**
   * Scene clear color. Defaults to fully transparent so the canvas
   * blends into the host UI.
   */
  backgroundColor?: string | null

  /**
   * Extra classes merged onto the wrapping `<div>`. Size the parent
   * element; the canvas fills it.
   */
  className?: string

  /** Inline style override for the wrapping `<div>`. */
  style?: React.CSSProperties

  /**
   * Sphere mesh subdivisions. Higher = smoother displacement, more
   * GPU cost. Defaults to the upstream demo's 512.
   */
  subdivisions?: number

  /**
   * Device-pixel-ratio cap. Defaults to `min(devicePixelRatio, 2)`.
   * Set to `1` for lower-end devices.
   */
  maxPixelRatio?: number
}

interface Variation {
  target: number
  current: number
  upEasing: number
  downEasing: number
  getValue: (levels: number[]) => number
  getDefault: () => number
}

/**
 * Audio-reactive organic sphere. See the module docblock for usage.
 */
export function OrganicSphere({
  getFrequencyData,
  active = true,
  lightAColor = '#c2410c',
  lightBColor = '#fb923c',
  rimColor,
  rimThreshold = 0.92,
  rimPower = 5,
  backgroundColor = null,
  className,
  style,
  subdivisions = 512,
  maxPixelRatio,
}: OrganicSphereProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Props that change at runtime are fed through refs so the imperative
  // render loop doesn't need to be torn down on every re-render.
  const getFrequencyDataRef = useRef(getFrequencyData)
  const activeRef = useRef(active)
  useEffect(() => {
    getFrequencyDataRef.current = getFrequencyData
  }, [getFrequencyData])
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // Stable color instances so the material keeps its reference on re-render.
  const colorA = useMemo(() => new THREE.Color(lightAColor), [lightAColor])
  const colorB = useMemo(() => new THREE.Color(lightBColor), [lightBColor])
  const effectiveRimColor = rimColor ?? lightBColor
  const rimColorObj = useMemo(
    () => new THREE.Color(effectiveRimColor),
    [effectiveRimColor],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    const pixelRatio = Math.min(
      maxPixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1),
      2,
    )

    const scene = new THREE.Scene()
    if (backgroundColor) scene.background = new THREE.Color(backgroundColor)

    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100)
    camera.position.set(0, 0, 3.84)
    scene.add(camera)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: backgroundColor === null,
      powerPreference: 'high-performance',
    })
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(pixelRatio)
    renderer.setClearColor(0x000000, backgroundColor === null ? 0 : 1)
    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    const geometry = new THREE.SphereGeometry(1, subdivisions, subdivisions)
    geometry.computeTangents()

    // Light A and B — fixed positions, computed from spherical coords
    // that reproduce the upstream's lighting setup.
    const lightAPos = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(1, 0.615, 2.049),
    )
    const lightBPos = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(1, 2.561, -1.844),
    )

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uLightAColor: { value: colorA },
        uLightAPosition: { value: lightAPos },
        uLightAIntensity: { value: 2.13 },
        uLightBColor: { value: colorB },
        uLightBPosition: { value: lightBPos },
        uLightBIntensity: { value: 1.61 },
        uSubdivision: {
          value: new THREE.Vector2(subdivisions, subdivisions),
        },
        uOffset: { value: new THREE.Vector3() },
        uDistortionFrequency: { value: 1.5 },
        uDistortionStrength: { value: 0.65 },
        uDisplacementFrequency: { value: 2.12 },
        uDisplacementStrength: { value: 0.152 },
        uFresnelOffset: { value: -1.609 },
        uFresnelMultiplier: { value: 3.587 },
        uFresnelPower: { value: 1.793 },
        uRimColor: { value: rimColorObj },
        uRimThreshold: { value: rimThreshold },
        uRimPower: { value: rimPower },
        uTime: { value: 0 },
      },
      defines: { USE_TANGENT: '' },
      vertexShader: ORGANIC_SPHERE_VERTEX_SHADER,
      fragmentShader: ORGANIC_SPHERE_FRAGMENT_SHADER,
    })

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // Random wander offset — gives the sphere a lifelike drift even
    // when the audio is flat.
    const offsetSpherical = new THREE.Spherical(
      1,
      Math.random() * Math.PI,
      Math.random() * Math.PI * 2,
    )
    const offsetDirection = new THREE.Vector3().setFromSpherical(offsetSpherical)

    // Variation system: mirrors the original Sphere.setVariations().
    const variations: Record<'volume' | 'lowLevel' | 'mediumLevel' | 'highLevel', Variation> = {
      volume: {
        target: 0,
        current: 0,
        upEasing: 0.03,
        downEasing: 0.002,
        getValue: (levels) => {
          const l0 = levels[0] || 0
          const l1 = levels[1] || 0
          const l2 = levels[2] || 0
          return Math.max(l0, l1, l2) * 0.3
        },
        getDefault: () => 0.152,
      },
      lowLevel: {
        target: 0,
        current: 0,
        upEasing: 0.005,
        downEasing: 0.002,
        getValue: (levels) => {
          let v = levels[0] || 0
          v *= 0.003
          v += 0.0001
          return Math.max(0, v)
        },
        getDefault: () => 0.0003,
      },
      mediumLevel: {
        target: 0,
        current: 0,
        upEasing: 0.008,
        downEasing: 0.004,
        getValue: (levels) => {
          let v = levels[1] || 0
          v *= 2
          v += 3.587
          return Math.max(3.587, v)
        },
        getDefault: () => 3.587,
      },
      highLevel: {
        target: 0,
        current: 0,
        upEasing: 0.02,
        downEasing: 0.001,
        getValue: (levels) => {
          let v = levels[2] || 0
          v *= 5
          v += 0.5
          return Math.max(0.5, v)
        },
        getDefault: () => 0.65,
      },
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

    // --- Render loop ------------------------------------------------------

    let rafId = 0
    let lastTs = performance.now()
    let disposed = false

    const render = () => {
      if (disposed) return
      const now = performance.now()
      const delta = Math.min(now - lastTs, 100) // Clamp big hitches.
      lastTs = now

      // Pull live audio levels if available.
      let levels: number[] | null = null
      if (activeRef.current && getFrequencyDataRef.current) {
        try {
          const buf = getFrequencyDataRef.current()
          if (buf && buf.length > 0) levels = computeLevels(buf)
        } catch {
          levels = null
        }
      }

      // Ease each variation toward its target (live) or resting default.
      for (const name of Object.keys(variations) as (keyof typeof variations)[]) {
        const v = variations[name]
        v.target = levels ? v.getValue(levels) : v.getDefault()
        const easing = v.target > v.current ? v.upEasing : v.downEasing
        v.current += (v.target - v.current) * easing * delta
      }

      // Time evolves faster when there's bass.
      const timeFrequency = variations.lowLevel.current
      const elapsed = delta * timeFrequency

      material.uniforms.uDisplacementStrength.value = variations.volume.current
      material.uniforms.uDistortionStrength.value = variations.highLevel.current
      material.uniforms.uFresnelMultiplier.value = variations.mediumLevel.current

      const offsetTime = (material.uniforms.uTime.value + elapsed) * 0.3
      offsetSpherical.phi =
        ((Math.sin(offsetTime * 0.001) * Math.sin(offsetTime * 0.00321)) * 0.5 + 0.5) * Math.PI
      offsetSpherical.theta =
        ((Math.sin(offsetTime * 0.0001) * Math.sin(offsetTime * 0.000321)) * 0.5 + 0.5) *
        Math.PI *
        2
      offsetDirection.setFromSpherical(offsetSpherical)
      offsetDirection.multiplyScalar(timeFrequency * 2)
      material.uniforms.uOffset.value.add(offsetDirection)

      material.uniforms.uTime.value += elapsed

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
  }, [
    colorA,
    colorB,
    rimColorObj,
    rimThreshold,
    rimPower,
    backgroundColor,
    subdivisions,
    maxPixelRatio,
  ])

  return <div ref={containerRef} className={className} style={style} />
}
