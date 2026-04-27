import type {
  BandReactivity,
  OrganicSphereConfig,
} from '@shogo-ai/sdk/voice/react'
import { DEFAULT_ORGANIC_SPHERE_CONFIG } from '@shogo-ai/sdk/voice/react'
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
    gain: { min: 0, max: 5, step: 0.01 },
    floor: { min: 0, max: 2, step: 0.001 },
    attack: { min: 0, max: 0.2, step: 0.001 },
    decay: { min: 0, max: 0.2, step: 0.001 },
  },
  medium: {
    idle: { min: 0, max: 10, step: 0.001 },
    gain: { min: 0, max: 10, step: 0.01 },
    floor: { min: 0, max: 10, step: 0.001 },
    attack: { min: 0, max: 0.2, step: 0.001 },
    decay: { min: 0, max: 0.2, step: 0.001 },
  },
  high: {
    idle: { min: 0, max: 5, step: 0.001 },
    gain: { min: 0, max: 20, step: 0.01 },
    floor: { min: 0, max: 5, step: 0.001 },
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

export function SphereControls({
  config,
  setConfig,
}: {
  config: OrganicSphereConfig
  setConfig: (updater: (prev: OrganicSphereConfig) => OrganicSphereConfig) => void
}) {
  const set = <K extends keyof OrganicSphereConfig>(
    key: K,
    value: OrganicSphereConfig[K],
  ) => setConfig((prev) => ({ ...prev, [key]: value }))

  const setBand = (
    band: BandKey,
    key: keyof BandReactivity,
    value: number,
  ) => setConfig((prev) => ({ ...prev, [band]: { ...prev[band], [key]: value } }))

  return (
    <>
      <Section title="Lighting">
        <ColorInput
          label="lightAColor"
          value={config.lightAColor}
          onChange={(v) =>
            set('lightAColor', v ?? DEFAULT_ORGANIC_SPHERE_CONFIG.lightAColor)
          }
        />
        <ColorInput
          label="lightBColor"
          value={config.lightBColor}
          onChange={(v) =>
            set('lightBColor', v ?? DEFAULT_ORGANIC_SPHERE_CONFIG.lightBColor)
          }
        />
        <NumberSlider
          label="lightAIntensity"
          value={config.lightAIntensity}
          onChange={(v) => set('lightAIntensity', v)}
          min={0}
          max={5}
          step={0.01}
        />
        <NumberSlider
          label="lightBIntensity"
          value={config.lightBIntensity}
          onChange={(v) => set('lightBIntensity', v)}
          min={0}
          max={5}
          step={0.01}
        />
      </Section>

      <Section title="Rim">
        <ColorInput
          label="rimColor (null = lightBColor)"
          value={config.rimColor}
          onChange={(v) => set('rimColor', v)}
          nullable
        />
        <NumberSlider
          label="rimThreshold"
          value={config.rimThreshold}
          onChange={(v) => set('rimThreshold', v)}
          min={0}
          max={1}
          step={0.001}
        />
        <NumberSlider
          label="rimPower"
          value={config.rimPower}
          onChange={(v) => set('rimPower', v)}
          min={0}
          max={20}
          step={0.1}
        />
      </Section>

      <Section title="Shape (static)">
        <NumberSlider
          label="distortionFrequency"
          value={config.distortionFrequency}
          onChange={(v) => set('distortionFrequency', v)}
          min={0}
          max={10}
          step={0.01}
        />
        <NumberSlider
          label="displacementFrequency"
          value={config.displacementFrequency}
          onChange={(v) => set('displacementFrequency', v)}
          min={0}
          max={10}
          step={0.01}
        />
        <NumberSlider
          label="fresnelOffset"
          value={config.fresnelOffset}
          onChange={(v) => set('fresnelOffset', v)}
          min={-5}
          max={5}
          step={0.001}
        />
        <NumberSlider
          label="fresnelPower"
          value={config.fresnelPower}
          onChange={(v) => set('fresnelPower', v)}
          min={0}
          max={10}
          step={0.001}
        />
      </Section>

      <BandControls
        name="volume → uDisplacementStrength"
        band={config.volume}
        onChange={(k, v) => setBand('volume', k, v)}
        ranges={BAND_RANGES.volume}
      />
      <BandControls
        name="medium → uFresnelMultiplier"
        band={config.medium}
        onChange={(k, v) => setBand('medium', k, v)}
        ranges={BAND_RANGES.medium}
      />
      <BandControls
        name="high → uDistortionStrength"
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
          State resets (uTime, uOffset, eased bands, wander phase) on every Play
          and on seed change. Same audio + same seed → same visual.
        </div>
      </Section>
    </>
  )
}
