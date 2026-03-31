import './styles/globals.css'
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { transform } from 'sucrase'
import { getScope, type CanvasScope } from './globals'

interface SurfaceState {
  surfaceId: string
  title: string
  code: string
  data: Record<string, unknown>
}

type CanvasEvent =
  | { type: 'init'; surfaces: SurfaceState[] }
  | { type: 'renderCode'; surfaceId: string; title?: string; code: string }
  | { type: 'dataUpdate'; surfaceId: string; data: Record<string, unknown> }
  | { type: 'removeSurface'; surfaceId: string }

// ---------------------------------------------------------------------------
// Code Transpiler + Evaluator — Sucrase handles JSX, TypeScript, and imports
// ---------------------------------------------------------------------------

const HAS_EXPORT = /\bexport\s+(default\b|function\b|const\b|class\b)/
const HAS_IMPORT = /\bimport\s+/

function transpile(rawCode: string): string {
  const needsImportTransform = HAS_IMPORT.test(rawCode) || HAS_EXPORT.test(rawCode)
  const transforms: Array<'typescript' | 'jsx' | 'imports'> = ['typescript', 'jsx']
  if (needsImportTransform) transforms.push('imports')
  return transform(rawCode, { transforms, jsxRuntime: 'classic', production: true }).code
}

/**
 * Evaluate transpiled module-style code (has import/export).
 * Sucrase converts imports → require(), exports → exports.default.
 */
function evalModule(compiled: string, scope: CanvasScope): React.FC {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const require = (id: string): unknown => {
    const mod = scope.importMap[id]
    if (mod) return mod
    throw new Error(`Module not found: "${id}"`)
  }

  const fn = new Function('require', 'exports', 'module', 'React', compiled)
  fn(require, exports, module, scope.flatScope.React)

  const component = (exports as any).__esModule
    ? (exports as any).default
    : exports.default ?? module.exports
  if (typeof component !== 'function') {
    throw new Error('Module must export a default React component')
  }
  return component as React.FC
}

/**
 * Evaluate inline-style code (no import/export, just a function body).
 * All symbols are injected as function parameters.
 */
function evalInline(compiled: string, scope: CanvasScope): React.FC {
  const names = Object.keys(scope.flatScope)
  const values = Object.values(scope.flatScope)
  const factory = new Function(...names, compiled)
  return function InlineComponent() {
    return factory(...values) as React.ReactElement
  }
}

function reportCanvasError(surfaceId: string, phase: 'compile' | 'runtime', error: string) {
  sendToParent({ type: 'canvas-error', surfaceId, phase, error })
}

function createAgentComponent(
  rawCode: string,
  surfaceId: string,
  surfaceData: Record<string, unknown>,
  onAction: (name: string, context?: Record<string, unknown>) => void,
): React.FC {
  const scope = getScope(surfaceData, onAction)

  try {
    const isModule = HAS_EXPORT.test(rawCode) || HAS_IMPORT.test(rawCode)
    const compiled = transpile(rawCode)
    return isModule ? evalModule(compiled, scope) : evalInline(compiled, scope)
  } catch (err) {
    const errorMsg = String(err)
    reportCanvasError(surfaceId, 'compile', errorMsg)
    return function ErrorComponent() {
      return (
        <div className="p-4 text-red-500 font-mono text-sm">
          <p className="font-bold">Compile Error</p>
          <pre className="mt-2 whitespace-pre-wrap">{errorMsg}</pre>
        </div>
      )
    }
  }
}

class CanvasErrorBoundary extends React.Component<
  { surfaceId: string; children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: Error) {
    return { error: String(error) }
  }

  componentDidCatch(error: Error) {
    reportCanvasError(this.props.surfaceId, 'runtime', String(error))
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-4 text-red-500 font-mono text-sm">
          <p className="font-bold">Runtime Error</p>
          <pre className="mt-2 whitespace-pre-wrap">{this.state.error}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Embedded vs standalone detection
// ---------------------------------------------------------------------------

const isEmbedded = window.parent !== window || !!(window as any).ReactNativeWebView

function sendToParent(message: Record<string, unknown>) {
  const rn = (window as any).ReactNativeWebView
  if (rn) {
    rn.postMessage(JSON.stringify(message))
  } else {
    window.parent.postMessage(message, '*')
  }
}

// ---------------------------------------------------------------------------
// Theme injection — receives CSS variable overrides from the parent frame
// ---------------------------------------------------------------------------

function applyThemeVariables(variables?: Record<string, string>, isDark?: boolean) {
  const root = document.documentElement
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      const cssValue = /^\d+\s+\d+\s+\d+$/.test(value.trim()) ? `rgb(${value})` : value
      root.style.setProperty(key, cssValue)
    }
  }
  if (isDark !== undefined) {
    root.style.colorScheme = isDark ? 'dark' : 'light'
    root.classList.toggle('dark', isDark)
  }
}

// ---------------------------------------------------------------------------
// Canvas App — manages surfaces, SSE connection, rendering
// ---------------------------------------------------------------------------

function CanvasApp() {
  const [surfaces, setSurfaces] = useState<Map<string, SurfaceState>>(new Map())
  const [activeId, setActiveId] = useState<string>('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleAction = useCallback((name: string, context?: Record<string, unknown>) => {
    const activeSurface = activeId
    if (isEmbedded) {
      sendToParent({ type: 'canvas-action', surfaceId: activeSurface, name, context })
    } else {
      fetch('../agent/canvas/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surfaceId: activeSurface, name, context }),
      }).catch(() => {})
    }
  }, [activeId])

  const applyEvent = useCallback((event: CanvasEvent) => {
    setSurfaces((prev) => {
      const next = new Map(prev)

      switch (event.type) {
        case 'init':
          next.clear()
          for (const s of event.surfaces) {
            next.set(s.surfaceId, s)
          }
          if (event.surfaces.length > 0) {
            setActiveId((cur) => cur || event.surfaces[0].surfaceId)
          }
          break

        case 'renderCode': {
          const existing = next.get(event.surfaceId)
          next.set(event.surfaceId, {
            surfaceId: event.surfaceId,
            title: event.title || existing?.title || event.surfaceId,
            code: event.code,
            data: existing?.data || {},
          })
          setActiveId((cur) => cur || event.surfaceId)
          break
        }

        case 'dataUpdate': {
          const existing = next.get(event.surfaceId)
          if (existing) {
            next.set(event.surfaceId, { ...existing, data: { ...existing.data, ...event.data } })
          }
          break
        }

        case 'removeSurface':
          next.delete(event.surfaceId)
          setActiveId((cur) => {
            if (cur === event.surfaceId) {
              const remaining = Array.from(next.keys())
              return remaining[0] || ''
            }
            return cur
          })
          break
      }

      return next
    })
  }, [])

  useEffect(() => {
    if (!isEmbedded) return

    function onMessage(e: MessageEvent) {
      let msg = e.data
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg) } catch { return }
      }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'canvas-event') {
        applyEvent(msg.event as CanvasEvent)
      } else if (msg.type === 'canvas-connected') {
        setConnected(true)
        setError(null)
      } else if (msg.type === 'canvas-set-active-surface') {
        setActiveId(msg.surfaceId as string)
      } else if (msg.type === 'canvas-theme') {
        applyThemeVariables(msg.variables as Record<string, string> | undefined, msg.isDark as boolean | undefined)
      }
    }

    window.addEventListener('message', onMessage)
    sendToParent({ type: 'canvas-ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [applyEvent])

  useEffect(() => {
    if (isEmbedded) return

    let es: EventSource | null = null
    let alive = true

    function connect() {
      if (!alive) return
      setError(null)

      es = new EventSource('../agent/canvas/stream')

      es.onopen = () => {
        setConnected(true)
        setError(null)
      }

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as CanvasEvent
          applyEvent(event)
        } catch {}
      }

      es.onerror = () => {
        setConnected(false)
        es?.close()
        if (alive) {
          reconnectTimer.current = setTimeout(connect, 2000)
        }
      }
    }

    connect()

    return () => {
      alive = false
      es?.close()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }
  }, [applyEvent])

  const surfaceList = Array.from(surfaces.values())
  const activeSurface = surfaces.get(activeId)

  if (surfaceList.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        <div className="text-center">
          <div className="animate-pulse mb-2">
            <div className="w-8 h-8 rounded-full bg-muted mx-auto" />
          </div>
          <p className="text-sm">{connected ? 'Waiting for canvas...' : 'Connecting...'}</p>
          {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-auto p-4">
        {activeSurface && (
          <SurfaceRenderer
            key={activeSurface.surfaceId + ':' + activeSurface.code}
            surface={activeSurface}
            onAction={handleAction}
          />
        )}
      </div>
    </div>
  )
}

function SurfaceRenderer({ surface, onAction }: { surface: SurfaceState; onAction: (name: string, context?: Record<string, unknown>) => void }) {
  const Component = React.useMemo(
    () => createAgentComponent(surface.code, surface.surfaceId, surface.data, onAction),
    [surface.code, surface.surfaceId, surface.data, onAction],
  )

  return (
    <CanvasErrorBoundary key={surface.surfaceId + ':' + surface.code} surfaceId={surface.surfaceId}>
      <Component />
    </CanvasErrorBoundary>
  )
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const rootEl = document.getElementById('root')!
const root: Root = createRoot(rootEl)
root.render(React.createElement(React.StrictMode, null, React.createElement(CanvasApp)))
