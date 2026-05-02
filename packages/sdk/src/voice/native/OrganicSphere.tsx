// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `OrganicSphere` (native) — React Native port of the web sphere in
 * [packages/sdk/src/voice/react/OrganicSphere.tsx]. Renders the same
 * audio-reactive noise-distorted sphere via `expo-gl` + `expo-three`
 * so iOS / Android Expo builds get the same visual as the web sphere.
 *
 * The shaders, the four-band reactivity model, and the configuration
 * surface (`OrganicSphereConfig`, `BandReactivity`) are reused
 * verbatim from the web module — only the GL container and renderer
 * construction changes. See the web file's docblock for the audio
 * mapping and tuning details.
 *
 * Requires `expo-gl`, `expo-three`, and `three` to be installed in the
 * host app (all three are optional peer dependencies of
 * `@shogo-ai/sdk`). Native only; importing this file pulls in
 * `expo-gl`, which is meaningless on web.
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { PixelRatio, type StyleProp, type ViewStyle } from 'react-native'
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl'
import { Renderer } from 'expo-three'
import * as THREE from 'three'
import {
  ORGANIC_SPHERE_VERTEX_SHADER,
  ORGANIC_SPHERE_FRAGMENT_SHADER,
} from '../react/shaders/organicSphereShaders.js'
import {
  resolveOrganicSphereConfig,
  type BandReactivity,
  type OrganicSphereConfig,
} from '../react/sphereConfig.js'

export interface OrganicSphereProps {
  /**
   * Returns the current agent-output frequency buffer (length = fftSize,
   * values 0–255). Typically `useVoiceConversation().getOutputByteFrequencyData`.
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
   * to `DEFAULT_ORGANIC_SPHERE_CONFIG`.
   */
  config?: Partial<OrganicSphereConfig>

  /** Inline style for the wrapping `<GLView>`. Size the parent — the GLView fills it. */
  style?: StyleProp<ViewStyle>
}

interface Variation {
  target: number
  current: number
}

/**
 * Deterministic [0, 1) pseudo-random from an integer seed + salt. A
 * cheap hash-ish mix is good enough for two independent starting
 * phases per seed; we don't need crypto quality here. Duplicated from
 * the web module to keep this component independently shippable.
 */
function seededUnit(seed: number, salt: number): number {
  const s = Math.sin((seed + salt * 7919) * 12.9898 + salt * 78.233) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Audio-reactive organic sphere for React Native (Expo). See the
 * module docblock for usage.
 */
export function OrganicSphere({
  getFrequencyData,
  active = true,
  config: configProp,
  style,
}: OrganicSphereProps) {
  const resolvedConfig = useMemo<OrganicSphereConfig>(
    () => resolveOrganicSphereConfig(configProp),
    [configProp],
  )

  // Everything that can change at runtime flows through a ref so the
  // imperative GL render loop doesn't get torn down per-render.
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

  // Cleanup state owned by the render loop. The render loop sets
  // `disposed = true` when the GL context is lost (e.g. unmount,
  // background → foreground on Android); doing it here means we can
  // also tear down imperatively from a parent on prop change.
  const disposeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => {
      disposeRef.current?.()
      disposeRef.current = null
    }
  }, [])

  // Pull init-only values up so the closure inside `onContextCreate`
  // captures stable values. expo-gl recreates the context (and thus
  // calls `onContextCreate` again) when the GLView remounts; that's
  // the only path that re-runs init.
  const initSubdivisions = resolvedConfig.subdivisions
  const initMaxPixelRatio = resolvedConfig.maxPixelRatio
  const initBackgroundColor = resolvedConfig.backgroundColor

  const onContextCreate = useMemo(
    () => async (gl: ExpoWebGLRenderingContext) => {
      const cfg0 = configRef.current
      const width = gl.drawingBufferWidth
      const height = gl.drawingBufferHeight

      // RN's PixelRatio is the equivalent of `window.devicePixelRatio`
      // for native. Match the web cap (≤2) so the sphere doesn't
      // burn the GPU on a 3x retina screen.
      const pixelRatio = Math.min(initMaxPixelRatio ?? PixelRatio.get(), 2)

      const scene = new THREE.Scene()
      if (initBackgroundColor) scene.background = new THREE.Color(initBackgroundColor)

      const camera = new THREE.PerspectiveCamera(
        cfg0.fov,
        width / height || 1,
        0.1,
        100,
      )
      camera.position.set(0, 0, cfg0.cameraZ)
      scene.add(camera)

      // expo-three's Renderer is a `THREE.WebGLRenderer` configured
      // against an `ExpoWebGLRenderingContext`. Same surface from
      // here on — `setSize`, `setPixelRatio`, `setClearColor`, etc.
      const renderer = new Renderer({
        gl,
        antialias: true,
        alpha: initBackgroundColor === null,
        powerPreference: 'high-performance',
      })
      renderer.setSize(width / pixelRatio, height / pixelRatio, false)
      renderer.setPixelRatio(pixelRatio)
      renderer.setClearColor(0x000000, initBackgroundColor === null ? 0 : 1)

      const geometry = new THREE.SphereGeometry(1, initSubdivisions, initSubdivisions)
      geometry.computeTangents()

      const lightAPos = new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(1, 0.615, 2.049),
      )
      const lightBPos = new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(1, 2.561, -1.844),
      )

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

      // --- Render loop ---------------------------------------------------

      let rafId = 0
      let lastTs = Date.now()
      let disposed = false
      let wasActive = activeRef.current
      let lastSeed = cfg0.seed

      const render = () => {
        if (disposed) return
        const now = Date.now()
        const delta = Math.min(now - lastTs, 100)
        lastTs = now

        const cfg = configRef.current

        lightAColorObj.set(cfg.lightAColor)
        lightBColorObj.set(cfg.lightBColor)
        rimColorObj.set(cfg.rimColor ?? cfg.lightBColor)

        material.uniforms.uLightAIntensity.value = cfg.lightAIntensity
        material.uniforms.uLightBIntensity.value = cfg.lightBIntensity
        material.uniforms.uDistortionFrequency.value = cfg.distortionFrequency
        material.uniforms.uDisplacementFrequency.value = cfg.displacementFrequency
        material.uniforms.uFresnelOffset.value = cfg.fresnelOffset
        material.uniforms.uFresnelPower.value = cfg.fresnelPower
        material.uniforms.uRimThreshold.value = cfg.rimThreshold
        material.uniforms.uRimPower.value = cfg.rimPower

        if (camera.position.z !== cfg.cameraZ) camera.position.z = cfg.cameraZ
        if (camera.fov !== cfg.fov) {
          camera.fov = cfg.fov
          camera.updateProjectionMatrix()
        }

        const isActive = activeRef.current

        if ((isActive && !wasActive) || cfg.seed !== lastSeed) {
          resetAnimationState(cfg)
          lastSeed = cfg.seed
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

          const l0 = levels ? levels[0] || 0 : 0
          const l1 = levels ? levels[1] || 0 : 0
          const l2 = levels ? levels[2] || 0 : 0
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

          material.uniforms.uDisplacementStrength.value = variations.volume.current
          material.uniforms.uDistortionStrength.value = variations.high.current
          material.uniforms.uFresnelMultiplier.value = variations.medium.current

          const offsetTime = (material.uniforms.uTime.value + elapsed) * 0.3
          offsetSpherical.phi =
            (Math.sin(offsetTime * 0.001) * Math.sin(offsetTime * 0.00321) * 0.5 + 0.5) *
            Math.PI
          offsetSpherical.theta =
            (Math.sin(offsetTime * 0.0001) * Math.sin(offsetTime * 0.000321) * 0.5 + 0.5) *
            Math.PI *
            2
          offsetDirection.setFromSpherical(offsetSpherical)
          offsetDirection.multiplyScalar(timeFrequency * 2)
          material.uniforms.uOffset.value.add(offsetDirection)

          material.uniforms.uTime.value += elapsed
        }

        renderer.render(scene, camera)
        // Critical: expo-gl uses double-buffering and won't actually
        // present the frame to the screen until `endFrameEXP()` is
        // called. Forgetting this is the most common reason an
        // expo-three scene renders to a black square.
        gl.endFrameEXP()
        rafId = requestAnimationFrame(render)
      }

      rafId = requestAnimationFrame(render)

      const dispose = () => {
        if (disposed) return
        disposed = true
        cancelAnimationFrame(rafId)
        geometry.dispose()
        material.dispose()
        renderer.dispose()
      }
      disposeRef.current = dispose
    },
    [initSubdivisions, initMaxPixelRatio, initBackgroundColor],
  )

  return (
    <GLView
      style={style}
      onContextCreate={onContextCreate}
      // Re-create the GL context when init-only values change. Without
      // this, changing `subdivisions` etc. would have no effect — the
      // existing context would keep running with the old values.
      key={`${initSubdivisions}-${initMaxPixelRatio ?? 'auto'}-${initBackgroundColor ?? 'transparent'}`}
    />
  )
}
