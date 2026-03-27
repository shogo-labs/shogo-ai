import './styles/globals.css'
import React, { useState, useCallback, useEffect, useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getGlobals } from './globals'

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
// Code Executor — wraps agent code in a React component
// ---------------------------------------------------------------------------

function createAgentComponent(
  code: string,
  surfaceData: Record<string, unknown>,
  onAction: (name: string, context?: Record<string, unknown>) => void,
): React.FC {
  const { names, values } = getGlobals(surfaceData, onAction)

  let factory: Function
  try {
    factory = new Function(...names, code)
  } catch (err) {
    const errorMsg = String(err)
    return function ErrorComponent() {
      return React.createElement('div', { className: 'p-4 text-red-500 font-mono text-sm' },
        React.createElement('p', { className: 'font-bold' }, 'Syntax Error'),
        React.createElement('pre', { className: 'mt-2 whitespace-pre-wrap' }, errorMsg),
      )
    }
  }

  const capturedFactory = factory
  const capturedValues = values

  return function AgentComponent() {
    try {
      return capturedFactory(...capturedValues) as ReactElement
    } catch (err) {
      return React.createElement('div', { className: 'p-4 text-red-500 font-mono text-sm' },
        React.createElement('p', { className: 'font-bold' }, 'Render Error'),
        React.createElement('pre', { className: 'mt-2 whitespace-pre-wrap' }, String(err)),
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Surface Tab Bar
// ---------------------------------------------------------------------------

function SurfaceTabBar({ surfaces, activeId, onSelect }: {
  surfaces: SurfaceState[]
  activeId: string
  onSelect: (id: string) => void
}) {
  if (surfaces.length <= 1) return null

  return (
    <div className="flex border-b border-border bg-background sticky top-0 z-10">
      {surfaces.map((s) => (
        <button
          key={s.surfaceId}
          onClick={() => onSelect(s.surfaceId)}
          className={`px-4 py-2.5 text-sm font-medium transition-colors ${
            s.surfaceId === activeId
              ? 'border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {s.title || s.surfaceId}
        </button>
      ))}
    </div>
  )
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

  // postMessage bridge — when embedded in an iframe/WebView, the parent owns
  // the SSE connection and relays events here.
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
      }
    }

    window.addEventListener('message', onMessage)
    sendToParent({ type: 'canvas-ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [applyEvent])

  // SSE fallback — standalone mode (test-server, direct browser access)
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
      <SurfaceTabBar
        surfaces={surfaceList}
        activeId={activeId}
        onSelect={setActiveId}
      />
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
    () => createAgentComponent(surface.code, surface.data, onAction),
    [surface.code, surface.data, onAction],
  )

  return <Component />
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const rootEl = document.getElementById('root')!
const root: Root = createRoot(rootEl)
root.render(React.createElement(React.StrictMode, null, React.createElement(CanvasApp)))
