import type { BandReactivity } from '@shogo-ai/sdk/voice/react'
import type { ReactNode } from 'react'

// --- Layout primitives ---------------------------------------------------

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      <div style={styles.sectionBody}>{children}</div>
    </section>
  )
}

export function NumberSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
}) {
  return (
    <label style={styles.sliderRow}>
      <span style={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={styles.slider}
      />
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={styles.number}
      />
    </label>
  )
}

export function ColorInput({
  label,
  value,
  onChange,
  nullable = false,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  nullable?: boolean
}) {
  const displayed = value ?? '#fb923c'
  return (
    <label style={styles.sliderRow}>
      <span style={styles.sliderLabel}>{label}</span>
      <input
        type="color"
        value={displayed}
        onChange={(e) => onChange(e.target.value)}
        style={styles.color}
      />
      <input
        type="text"
        value={value ?? ''}
        placeholder={nullable ? '(inherit)' : undefined}
        onChange={(e) => onChange(e.target.value || (nullable ? null : displayed))}
        style={styles.colorText}
      />
      {nullable && value !== null ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          style={styles.inlineButton}
          title="Clear (use default)"
        >
          ×
        </button>
      ) : null}
    </label>
  )
}

export function Meter({
  label,
  value,
  max,
}: {
  label: string
  value: number
  max: number
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div style={styles.meter}>
      <div style={styles.meterTrack}>
        <div style={{ ...styles.meterFill, width: `${pct}%` }} />
      </div>
      <span style={styles.meterLabel}>
        {label}: {value.toFixed(3)}
      </span>
    </div>
  )
}

// --- Band reactivity control group --------------------------------------

export function BandControls({
  name,
  band,
  onChange,
  ranges,
}: {
  name: string
  band: BandReactivity
  onChange: (key: keyof BandReactivity, value: number) => void
  ranges: Record<keyof BandReactivity, { min: number; max: number; step: number }>
}) {
  return (
    <Section title={name}>
      <NumberSlider
        label="idle"
        value={band.idle}
        onChange={(v) => onChange('idle', v)}
        {...ranges.idle}
      />
      <NumberSlider
        label="gain"
        value={band.gain}
        onChange={(v) => onChange('gain', v)}
        {...ranges.gain}
      />
      <NumberSlider
        label="floor"
        value={band.floor}
        onChange={(v) => onChange('floor', v)}
        {...ranges.floor}
      />
      <NumberSlider
        label="attack"
        value={band.attack}
        onChange={(v) => onChange('attack', v)}
        {...ranges.attack}
      />
      <NumberSlider
        label="decay"
        value={band.decay}
        onChange={(v) => onChange('decay', v)}
        {...ranges.decay}
      />
    </Section>
  )
}

// --- Styles --------------------------------------------------------------

export const styles: Record<string, React.CSSProperties> = {
  section: {
    padding: '10px 0',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  sectionTitle: {
    margin: '2px 0 8px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#fb923c',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  sliderRow: {
    display: 'grid',
    gridTemplateColumns: '150px 1fr 72px auto',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    padding: '2px 0',
  },
  sliderLabel: {
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 11,
    opacity: 0.85,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  slider: {
    accentColor: '#fb923c',
    width: '100%',
  },
  number: {
    width: 72,
    background: '#181818',
    color: '#eee',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    padding: '3px 6px',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 11,
  },
  color: {
    width: 30,
    height: 22,
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
  },
  colorText: {
    width: 72,
    background: '#181818',
    color: '#eee',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    padding: '3px 6px',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 11,
  },
  inlineButton: {
    background: 'transparent',
    color: '#aaa',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 10,
    cursor: 'pointer',
  },
  meter: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  meterTrack: {
    height: 4,
    borderRadius: 2,
    background: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #c2410c, #fb923c)',
    transition: 'width 40ms linear',
  },
  meterLabel: {
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 10,
    opacity: 0.6,
  },
  note: {
    fontSize: 10,
    opacity: 0.55,
    lineHeight: 1.5,
    padding: '4px 0',
  },
}
