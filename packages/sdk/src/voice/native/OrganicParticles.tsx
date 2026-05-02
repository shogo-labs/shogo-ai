// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `OrganicParticles` (native) — React Native port of the web particle
 * cloud in [packages/sdk/src/voice/react/OrganicParticles.tsx]. Renders
 * the same audio-reactive point-sprite cloud via `expo-gl` +
 * `expo-three`, sharing shaders + config with the web module.
 *
 * See the web module's docblock for tuning details. Requires
 * `expo-gl`, `expo-three`, and `three` to be installed in the host
 * app (all optional peer dependencies of `@shogo-ai/sdk`).
 */

import React, { useEffect, useMemo, useRef } from 'react'
import { PixelRatio, type StyleProp, type ViewStyle } from 'react-native'
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl'
import { Renderer } from 'expo-three'
import * as THREE from 'three'
import {
  ORGANIC_PARTICLES_VERTEX_SHADER,
  ORGANIC_PARTICLES_FRAGMENT_SHADER,
} from '../react/shaders/organicParticlesShaders.js'
import type { BandReactivity } from '../react/sphereConfig.js'
import {
  resolveOrganicParticlesConfig,
  type OrganicParticlesConfig,
} from '../react/particlesConfig.js'

export interface OrganicParticlesProps {
  getFrequencyData?: () => Uint8Array | null
  active?: boolean
  config?: Partial<OrganicParticlesConfig>
  style?: StyleProp<ViewStyle>
}

interface Variation {
  target: number
  current: number
}

function seededUnit(seed: number, salt: number): number {
  const s = Math.sin((seed + salt * 7919) * 12.9898 + salt * 78.233) * 43758.5453
  return s - Math.floor(s)
}

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
 * Audio-reactive particle cloud for React Native (Expo). See the
 * module docblock for usage.
 */
export function OrganicParticles({
  getFrequencyData,
  active = true,
  config: configProp,
  style,
}: OrganicParticlesProps) {
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

  const disposeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => {
      disposeRef.current?.()
      disposeRef.current = null
    }
  }, [])

  const initCount = resolvedConfig.count
  const initInnerRadius = resolvedConfig.innerRadius
  const initOuterRadius = resolvedConfig.outerRadius
  const initSeed = resolvedConfig.seed
  const initMaxPixelRatio = resolvedConfig.maxPixelRatio
  const initBackgroundColor = resolvedConfig.backgroundColor

  const onContextCreate = useMemo(
    () => async (gl: ExpoWebGLRenderingContext) => {
      const cfg0 = configRef.current
      const width = gl.drawingBufferWidth
      const height = gl.drawingBufferHeight
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

      const renderer = new Renderer({
        gl,
        antialias: true,
        alpha: initBackgroundColor === null,
        powerPreference: 'high-performance',
      })
      renderer.setSize(width / pixelRatio, height / pixelRatio, false)
      renderer.setPixelRatio(pixelRatio)
      renderer.setClearColor(0x000000, initBackgroundColor === null ? 0 : 1)

      const { positions, seeds } = buildParticleAttributes(
        initCount,
        initInnerRadius,
        initOuterRadius,
        initSeed,
      )

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('aBasePosition', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

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

      let rafId = 0
      let lastTs = Date.now()
      let disposed = false
      let wasActive = activeRef.current

      const render = () => {
        if (disposed) return
        const now = Date.now()
        const delta = Math.min(now - lastTs, 100)
        lastTs = now

        const cfg = configRef.current

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

          material.uniforms.uDisplacement.value = variations.volume.current
          material.uniforms.uSizeAudio.value = variations.medium.current
          material.uniforms.uSwirl.value = variations.high.current
          material.uniforms.uTime.value += elapsed

          rotationState.y +=
            delta * cfg.rotationBias + variations.high.current * delta * 0.0008
          points.rotation.y = rotationState.y
        } else {
          material.uniforms.uTime.value += delta * cfg.idleNoiseRate
        }

        renderer.render(scene, camera)
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
    [initCount, initInnerRadius, initOuterRadius, initSeed, initMaxPixelRatio, initBackgroundColor],
  )

  return (
    <GLView
      style={style}
      onContextCreate={onContextCreate}
      // See OrganicSphere.tsx for why init-only values are encoded in
      // the key — re-init is the only way to apply them.
      key={`${initCount}-${initInnerRadius}-${initOuterRadius}-${initSeed}-${initMaxPixelRatio ?? 'auto'}-${initBackgroundColor ?? 'transparent'}`}
    />
  )
}
