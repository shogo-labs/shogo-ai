import {
  DEFAULT_ORGANIC_PARTICLES_CONFIG,
  DEFAULT_ORGANIC_SPHERE_CONFIG,
  OrganicParticles,
  OrganicSphere,
  type OrganicParticlesConfig,
  type OrganicSphereConfig,
} from '@shogo-ai/sdk/voice/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Meter } from './components'
import { ParticlesControls } from './ParticlesControls'
import { SphereControls } from './SphereControls'
import { useAudioAnalyser } from './useAudioAnalyser'

type Mode = 'sphere' | 'particles'

export function App() {
  const [mode, setMode] = useState<Mode>('sphere')
  const [sphereConfig, setSphereConfig] = useState<OrganicSphereConfig>(
    DEFAULT_ORGANIC_SPHERE_CONFIG,
  )
  const [particlesConfig, setParticlesConfig] = useState<OrganicParticlesConfig>(
    DEFAULT_ORGANIC_PARTICLES_CONFIG,
  )
  const audio = useAudioAnalyser('/shogo-greeting.mp3')
  const [copied, setCopied] = useState(false)

  // Live meter readings of the first 4 bands so the user can see what
  // the shader is actually receiving while tuning.
  const [liveLevels, setLiveLevels] = useState<[number, number, number, number]>([
    0, 0, 0, 0,
  ])
  const levelsRef = useRef<Uint8Array | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const buf = audio.getFrequencyData()
      if (buf && buf.length > 0) {
        levelsRef.current = buf
        const bins = Math.floor(buf.length / 8)
        const L = [0, 0, 0, 0]
        for (let i = 0; i < 4; i++) {
          let sum = 0
          for (let j = 0; j < bins; j++) sum += buf[i * bins + j]
          L[i] = sum / bins / 256
        }
        setLiveLevels([L[0], L[1], L[2], L[3]])
      } else {
        setLiveLevels([0, 0, 0, 0])
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [audio])

  const activeConfig: OrganicSphereConfig | OrganicParticlesConfig =
    mode === 'sphere' ? sphereConfig : particlesConfig

  const onCopyJson = useCallback(async () => {
    const payload = {
      mode,
      config: activeConfig,
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy config JSON:', JSON.stringify(payload, null, 2))
    }
  }, [mode, activeConfig])

  const onPasteJson = useCallback(() => {
    const raw = window.prompt('Paste config JSON to load:')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as {
        mode?: Mode
        config?: OrganicSphereConfig | OrganicParticlesConfig
      }
      if (parsed.mode === 'particles' && parsed.config) {
        setParticlesConfig({
          ...DEFAULT_ORGANIC_PARTICLES_CONFIG,
          ...(parsed.config as OrganicParticlesConfig),
        })
        setMode('particles')
      } else if (parsed.mode === 'sphere' && parsed.config) {
        setSphereConfig({
          ...DEFAULT_ORGANIC_SPHERE_CONFIG,
          ...(parsed.config as OrganicSphereConfig),
        })
        setMode('sphere')
      } else {
        alert('Payload must be { mode: "sphere" | "particles", config: {...} }')
      }
    } catch (err) {
      alert(`Invalid JSON: ${(err as Error).message}`)
    }
  }, [])

  const onReset = useCallback(() => {
    if (mode === 'sphere') setSphereConfig(DEFAULT_ORGANIC_SPHERE_CONFIG)
    else setParticlesConfig(DEFAULT_ORGANIC_PARTICLES_CONFIG)
  }, [mode])

  const active = audio.playing

  return (
    <div style={styles.layout}>
      <main style={styles.stage}>
        <div style={styles.sphereWrap}>
          {mode === 'sphere' ? (
            <OrganicSphere
              config={sphereConfig}
              getFrequencyData={audio.getFrequencyData}
              active={active}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <OrganicParticles
              config={particlesConfig}
              getFrequencyData={audio.getFrequencyData}
              active={active}
              style={{ width: '100%', height: '100%' }}
            />
          )}
        </div>
        <div style={styles.stageFooter}>
          <button type="button" onClick={audio.toggle} style={styles.playButton}>
            {audio.playing ? '⏸  Pause' : '▶  Play "Hello, I am Shogo"'}
          </button>
          <div style={styles.levelStrip}>
            <Meter label="L[0] (bass)" value={liveLevels[0]} max={1} />
            <Meter label="L[1] (mid)" value={liveLevels[1]} max={1} />
            <Meter label="L[2] (high)" value={liveLevels[2]} max={1} />
            <Meter label="L[3]" value={liveLevels[3]} max={1} />
          </div>
          <div style={styles.statusNote}>
            Status:{' '}
            {audio.ready
              ? audio.playing
                ? 'playing (looping)'
                : 'paused'
              : 'loading audio…'}
          </div>
        </div>
      </main>

      <aside style={styles.sidebar}>
        <header style={styles.header}>
          <h1 style={styles.h1}>Shogo Visualization Playground</h1>
          <ModeSwitcher value={mode} onChange={setMode} />
          <p style={styles.sub}>
            Live-tune every field of the{' '}
            <code>
              Organic{mode === 'sphere' ? 'Sphere' : 'Particles'}Config
            </code>{' '}
            against the looping Shogo greeting. Hit <b>Copy JSON</b> to save a
            preset.
          </p>
          <div style={styles.headerActions}>
            <button type="button" onClick={onCopyJson} style={styles.primaryButton}>
              {copied ? '✓ Copied' : 'Copy config JSON'}
            </button>
            <button type="button" onClick={onPasteJson} style={styles.secondaryButton}>
              Load JSON…
            </button>
            <button type="button" onClick={onReset} style={styles.secondaryButton}>
              Reset to defaults
            </button>
          </div>
        </header>

        {mode === 'sphere' ? (
          <SphereControls config={sphereConfig} setConfig={setSphereConfig} />
        ) : (
          <ParticlesControls
            config={particlesConfig}
            setConfig={setParticlesConfig}
          />
        )}

        <footer style={styles.footer}>
          <details>
            <summary style={styles.summary}>Current config (preview)</summary>
            <pre style={styles.pre}>{JSON.stringify(activeConfig, null, 2)}</pre>
          </details>
        </footer>
      </aside>
    </div>
  )
}

function ModeSwitcher({
  value,
  onChange,
}: {
  value: Mode
  onChange: (v: Mode) => void
}) {
  const tabs: Array<{ id: Mode; label: string }> = [
    { id: 'sphere', label: 'Sphere' },
    { id: 'particles', label: 'Particles' },
  ]
  return (
    <div role="tablist" style={styles.tabs}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          style={{
            ...styles.tab,
            ...(value === t.id ? styles.tabActive : null),
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// --- Styles --------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 480px',
    height: '100vh',
    width: '100vw',
    background: '#000',
    color: '#f5f5f5',
  },
  stage: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    background: 'radial-gradient(ellipse at center, #1a1a1a 0%, #000 60%)',
    minWidth: 0,
  },
  sphereWrap: {
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  stageFooter: {
    flex: '0 0 auto',
    padding: '16px 24px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(0,0,0,0.6)',
  },
  playButton: {
    alignSelf: 'flex-start',
    padding: '10px 18px',
    background: '#c2410c',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  levelStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '8px',
  },
  statusNote: {
    fontSize: 12,
    opacity: 0.6,
  },
  sidebar: {
    overflowY: 'auto',
    borderLeft: '1px solid rgba(255,255,255,0.08)',
    background: '#0b0b0b',
    padding: '20px 18px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  header: {
    marginBottom: 8,
  },
  h1: {
    margin: '0 0 10px',
    fontSize: 18,
    fontWeight: 600,
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: 3,
    background: '#181818',
    borderRadius: 8,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    padding: '7px 10px',
    border: 'none',
    background: 'transparent',
    color: '#aaa',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 100ms, color 100ms',
  },
  tabActive: {
    background: '#c2410c',
    color: '#fff',
  },
  sub: {
    margin: '0 0 14px',
    fontSize: 12,
    opacity: 0.65,
    lineHeight: 1.5,
  },
  headerActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  primaryButton: {
    padding: '7px 12px',
    background: '#fb923c',
    color: '#1b1b1b',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '7px 12px',
    background: 'transparent',
    color: '#fb923c',
    border: '1px solid rgba(251, 146, 60, 0.4)',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
  },
  footer: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  summary: {
    cursor: 'pointer',
    fontSize: 11,
    opacity: 0.65,
    userSelect: 'none',
  },
  pre: {
    fontSize: 10,
    fontFamily: 'ui-monospace, Menlo, monospace',
    background: '#000',
    padding: 10,
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.06)',
    marginTop: 8,
    maxHeight: 240,
    overflow: 'auto',
    whiteSpace: 'pre',
  },
}
