import type {
  BandReactivity,
  OrganicParticlesConfig,
} from '@shogo-ai/sdk/voice/react'
import {
  BandControls,
  ColorInput,
  NumberSlider,
  Section,
  styles,
} from './components'

type BandKey = 'volume' | 'medium' | 'high' | 'low'

const BAND_RANGES: Record<
  BandKey,
  Record<keyof BandReactivity, { min: number; max: number; step: number }>
> = {
  volume: {
    idle: { min: 0, max: 2, step: 0.001 },
    gain: { min: 0, max: 3, step: 0.01 },
    floor: { min: 0, max: 2, step: 0.001 },
    attack: { min: 0, max: 0.2, step: 0.001 },
    decay: { min: 0, max: 0.2, step: 0.001 },
  },
  medium: {
    idle: { min: 0, max: 5, step: 0.001 },
    gain: { min: 0, max: 10, step: 0.01 },
    floor: { min: 0, max: 5, step: 0.001 },
    attack: { min: 0, max: 0.2, step: 0.001 },
    decay: { min: 0, max: 0.2, step: 0.001 },
  },
  high: {
    idle: { min: 0, max: 3, step: 0.001 },
    gain: { min: 0, max: 10, step: 0.01 },
    floor: { min: 0, max: 3, step: 0.001 },
    attack: { min: 0, max: 0.2, step: 0.001 },
    decay: { min: 0, max: 0.2, step: 0.001 },
  },
  low: {
    idle: { min: 0, max: 0.01, step: 0.00001 },
    gain: { min: 0, max: 0.05, step: 0.0001 },
    floor: { min: 0, max: 0.01, step: 0.00001 },
    attack: { min: 0, max: 0.05, step: 0.0001 },
    decay: { min: 0, max: 0.05, step: 0.0001 },
  },
}

export function ParticlesControls({
  config,
  setConfig,
}: {
  config: OrganicParticlesConfig
  setConfig: (
    updater: (prev: OrganicParticlesConfig) => OrganicParticlesConfig,
  ) => void
}) {
  const set = <K extends keyof OrganicParticlesConfig>(
    key: K,
    value: OrganicParticlesConfig[K],
  ) => setConfig((prev) => ({ ...prev, [key]: value }))

  const setBand = (
    band: BandKey,
    key: keyof BandReactivity,
    value: number,
  ) => setConfig((prev) => ({ ...prev, [band]: { ...prev[band], [key]: value } }))

  return (
    <>
      <Section title="Cloud shape (init-only; remount on change)">
        <NumberSlider
          label="count"
          value={config.count}
          onChange={(v) => set('count', Math.round(v))}
          min={1000}
          max={150000}
          step={1000}
        />
        <NumberSlider
          label="innerRadius"
          value={config.innerRadius}
          onChange={(v) => set('innerRadius', v)}
          min={0}
          max={2}
          step={0.01}
        />
        <NumberSlider
          label="outerRadius"
          value={config.outerRadius}
          onChange={(v) => set('outerRadius', v)}
          min={0}
          max={3}
          step={0.01}
        />
        <div style={styles.note}>
          Changing any of these three (or seed) regenerates the particle
          buffers — expect a brief flash as the scene rebuilds.
        </div>
      </Section>

      <Section title="Motion">
        <NumberSlider
          label="noiseFrequency"
          value={config.noiseFrequency}
          onChange={(v) => set('noiseFrequency', v)}
          min={0}
          max={10}
          step={0.01}
        />
        <NumberSlider
          label="noiseStrength"
          value={config.noiseStrength}
          onChange={(v) => set('noiseStrength', v)}
          min={0}
          max={2}
          step={0.01}
        />
        <NumberSlider
          label="rotationBias (Y/ms)"
          value={config.rotationBias}
          onChange={(v) => set('rotationBias', v)}
          min={-0.002}
          max={0.002}
          step={0.00001}
        />
        <NumberSlider
          label="swirlTimeRate"
          value={config.swirlTimeRate}
          onChange={(v) => set('swirlTimeRate', v)}
          min={-0.5}
          max={0.5}
          step={0.001}
        />
        <NumberSlider
          label="idleNoiseRate"
          value={config.idleNoiseRate}
          onChange={(v) => set('idleNoiseRate', v)}
          min={0}
          max={0.001}
          step={0.00001}
        />
        <div style={styles.note}>
          rotationBias / swirlTimeRate default to 0 — positive = constant
          right-spin, negative = left. idleNoiseRate keeps the Perlin field
          shimmering while paused (set to 0 to fully freeze).
        </div>
      </Section>

      <Section title="Rendering">
        <NumberSlider
          label="sizeBase"
          value={config.sizeBase}
          onChange={(v) => set('sizeBase', v)}
          min={0.1}
          max={10}
          step={0.05}
        />
        <NumberSlider
          label="softness"
          value={config.softness}
          onChange={(v) => set('softness', v)}
          min={0}
          max={1}
          step={0.01}
        />
        <NumberSlider
          label="opacity"
          value={config.opacity}
          onChange={(v) => set('opacity', v)}
          min={0}
          max={1}
          step={0.01}
        />
      </Section>

      <Section title="Color">
        <ColorInput
          label="colorCool (core)"
          value={config.colorCool}
          onChange={(v) => set('colorCool', v ?? '#c2410c')}
        />
        <ColorInput
          label="colorHot (fringe)"
          value={config.colorHot}
          onChange={(v) => set('colorHot', v ?? '#fb923c')}
        />
      </Section>

      <BandControls
        name="volume → radial displacement"
        band={config.volume}
        onChange={(k, v) => setBand('volume', k, v)}
        ranges={BAND_RANGES.volume}
      />
      <BandControls
        name="medium → particle size"
        band={config.medium}
        onChange={(k, v) => setBand('medium', k, v)}
        ranges={BAND_RANGES.medium}
      />
      <BandControls
        name="high → swirl strength"
        band={config.high}
        onChange={(k, v) => setBand('high', k, v)}
        ranges={BAND_RANGES.high}
      />
      <BandControls
        name="low → time evolution speed"
        band={config.low}
        onChange={(k, v) => setBand('low', k, v)}
        ranges={BAND_RANGES.low}
      />

      <Section title="Camera">
        <NumberSlider
          label="cameraZ"
          value={config.cameraZ}
          onChange={(v) => set('cameraZ', v)}
          min={1}
          max={12}
          step={0.01}
        />
        <NumberSlider
          label="fov"
          value={config.fov}
          onChange={(v) => set('fov', v)}
          min={10}
          max={90}
          step={0.5}
        />
      </Section>

      <Section title="Determinism">
        <NumberSlider
          label="seed"
          value={config.seed}
          onChange={(v) => set('seed', Math.round(v))}
          min={0}
          max={999}
          step={1}
        />
        <div style={styles.note}>
          Seed drives both initial particle positions AND wander phase, so
          same audio + same seed → same visual. Changing seed rebuilds the
          scene.
        </div>
      </Section>
    </>
  )
}
