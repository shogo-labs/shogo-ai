// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasWebView — Canvas v2 renderer.
 *
 * Loads the canvas-runtime SPA shell inside a WebView (native) or iframe (web).
 * The parent owns the SSE connection to the agent and relays events into the
 * iframe/WebView via postMessage, eliminating cross-origin and proxy issues.
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { Platform, View, StyleSheet } from 'react-native'
import { useCanvasThemeOptional } from './CanvasThemeContext'

interface CanvasWebViewProps {
  agentUrl: string | null
  /** Direct runtime URL for the canvas iframe. When set, the iframe loads from
   *  here so fetch('/api/...') resolves same-origin — no proxy needed. */
  canvasBaseUrl?: string | null
  activeSurfaceId?: string | null
  onCanvasError?: (surfaceId: string, phase: 'compile' | 'runtime', error: string) => void
}

interface CanvasEvent {
  type: 'init' | 'renderCode' | 'dataUpdate' | 'removeSurface'
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// SSE hook — connects to the agent canvas stream, returns events for relay
// ---------------------------------------------------------------------------

function useCanvasSSE(agentUrl: string | null) {
  const [connected, setConnected] = useState(false)
  const lastInitRef = useRef<CanvasEvent | null>(null)
  const subscribersRef = useRef<Set<(event: CanvasEvent) => void>>(new Set())

  const subscribe = useCallback((fn: (event: CanvasEvent) => void) => {
    subscribersRef.current.add(fn)
    return () => { subscribersRef.current.delete(fn) }
  }, [])

  const replayInit = useCallback(() => lastInitRef.current, [])

  useEffect(() => {
    if (!agentUrl) return

    let es: EventSource | null = null
    let alive = true
    let reconnectTimer: ReturnType<typeof setTimeout>

    function connect() {
      if (!alive) return

      es = new EventSource(`${agentUrl}/agent/canvas/stream`, { withCredentials: true })

      es.onopen = () => setConnected(true)

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as CanvasEvent
          if (event.type === 'init') lastInitRef.current = event
          for (const fn of subscribersRef.current) fn(event)
        } catch {}
      }

      es.onerror = () => {
        setConnected(false)
        es?.close()
        if (alive) reconnectTimer = setTimeout(connect, 2000)
      }
    }

    connect()

    return () => {
      alive = false
      es?.close()
      clearTimeout(reconnectTimer)
    }
  }, [agentUrl])

  return { connected, subscribe, replayInit }
}

// ---------------------------------------------------------------------------
// Action forwarder — POSTs canvas actions back to the agent
// ---------------------------------------------------------------------------

function postCanvasAction(
  agentUrl: string,
  payload: { surfaceId?: string; name?: string; context?: Record<string, unknown> },
) {
  fetch(`${agentUrl}/agent/canvas/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  }).catch(() => {})
}

function postCanvasError(
  agentUrl: string,
  payload: { surfaceId: string; phase: string; error: string },
) {
  fetch(`${agentUrl}/agent/canvas/error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// CanvasWebView — public component
// ---------------------------------------------------------------------------

export function CanvasWebView({ agentUrl, canvasBaseUrl, activeSurfaceId, onCanvasError }: CanvasWebViewProps) {
  const iframeBase = canvasBaseUrl || agentUrl
  const canvasUrl = iframeBase ? `${iframeBase}/` : null
  const sse = useCanvasSSE(agentUrl)
  const canvasTheme = useCanvasThemeOptional()

  const themeMessage = useMemo(() => {
    if (!canvasTheme) return null
    const vars = canvasTheme.resolvedIsDark
      ? canvasTheme.activePreset.dark
      : canvasTheme.activePreset.light
    return {
      type: 'canvas-theme' as const,
      variables: vars,
      isDark: canvasTheme.resolvedIsDark,
    }
  }, [canvasTheme?.activePreset, canvasTheme?.resolvedIsDark])

  if (!canvasUrl || !agentUrl) {
    return (
      <View style={styles.container}>
        <View style={styles.placeholder} />
      </View>
    )
  }

  if (Platform.OS === 'web') {
    return <CanvasIframe url={canvasUrl} agentUrl={agentUrl} sse={sse} activeSurfaceId={activeSurfaceId} themeMessage={themeMessage} onCanvasError={onCanvasError} />
  }

  return <CanvasNativeWebView url={canvasUrl} agentUrl={agentUrl} sse={sse} activeSurfaceId={activeSurfaceId} themeMessage={themeMessage} onCanvasError={onCanvasError} />
}

// ---------------------------------------------------------------------------
// Web — iframe + postMessage bridge
// ---------------------------------------------------------------------------

interface ThemeMessage {
  type: 'canvas-theme'
  variables: Record<string, string>
  isDark: boolean
}

interface BridgeProps {
  url: string
  agentUrl: string
  sse: ReturnType<typeof useCanvasSSE>
  activeSurfaceId?: string | null
  themeMessage: ThemeMessage | null
  onCanvasError?: (surfaceId: string, phase: 'compile' | 'runtime', error: string) => void
}

function CanvasIframe({ url, agentUrl, sse, activeSurfaceId, themeMessage, onCanvasError }: BridgeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)

  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  // Reload is handled inside the iframe itself (main.tsx listens to the SSE
  // stream on the same origin, avoiding cross-origin issues entirely).

  // Send connected status
  useEffect(() => {
    if (sse.connected) sendToIframe({ type: 'canvas-connected' })
  }, [sse.connected, sendToIframe])

  // Relay active surface selection from parent tabs
  useEffect(() => {
    if (activeSurfaceId && readyRef.current) {
      sendToIframe({ type: 'canvas-set-active-surface', surfaceId: activeSurfaceId })
    }
  }, [activeSurfaceId, sendToIframe])

  // Send theme when it changes
  useEffect(() => {
    if (themeMessage && readyRef.current) sendToIframe(themeMessage)
  }, [themeMessage, sendToIframe])

  // Listen for messages from the iframe
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'canvas-ready') {
        readyRef.current = true
        const init = sse.replayInit()
        if (init) sendToIframe({ type: 'canvas-event', event: init })
        if (sse.connected) sendToIframe({ type: 'canvas-connected' })
        if (themeMessage) sendToIframe(themeMessage)
      } else if (msg.type === 'canvas-action') {
        postCanvasAction(agentUrl, {
          surfaceId: msg.surfaceId,
          name: msg.name,
          context: msg.context,
        })
      } else if (msg.type === 'canvas-error') {
        postCanvasError(agentUrl, { surfaceId: msg.surfaceId as string, phase: msg.phase as string, error: msg.error as string })
        onCanvasError?.(msg.surfaceId as string, msg.phase as 'compile' | 'runtime', msg.error as string)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [agentUrl, sse, sendToIframe, themeMessage, onCanvasError])

  return (
    <View style={styles.container}>
      <iframe
        ref={iframeRef}
        src={url}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: 'transparent',
        } as any}
        allow="clipboard-write"
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Native — react-native-webview + postMessage bridge
// ---------------------------------------------------------------------------

function CanvasNativeWebView({ url, agentUrl, sse, activeSurfaceId, themeMessage, onCanvasError }: BridgeProps) {
  const WebView = require('react-native-webview').default
  const webViewRef = useRef<any>(null)
  const readyRef = useRef(false)

  const sendToWebView = useCallback((msg: Record<string, unknown>) => {
    webViewRef.current?.postMessage(JSON.stringify(msg))
  }, [])

  // Handle SSE events — reload WebView on build complete
  useEffect(() => {
    return sse.subscribe((event) => {
      if (event.type === 'reload') {
        webViewRef.current?.reload()
      }
    })
  }, [sse])

  // Send connected status
  useEffect(() => {
    if (sse.connected) sendToWebView({ type: 'canvas-connected' })
  }, [sse.connected, sendToWebView])

  // Relay active surface selection from parent tabs
  useEffect(() => {
    if (activeSurfaceId && readyRef.current) {
      sendToWebView({ type: 'canvas-set-active-surface', surfaceId: activeSurfaceId })
    }
  }, [activeSurfaceId, sendToWebView])

  // Send theme when it changes
  useEffect(() => {
    if (themeMessage && readyRef.current) sendToWebView(themeMessage)
  }, [themeMessage, sendToWebView])

  const onMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data)

      if (msg.type === 'canvas-ready') {
        readyRef.current = true
        const init = sse.replayInit()
        if (init) sendToWebView({ type: 'canvas-event', event: init })
        if (sse.connected) sendToWebView({ type: 'canvas-connected' })
        if (themeMessage) sendToWebView(themeMessage)
      } else if (msg.type === 'canvas-action') {
        postCanvasAction(agentUrl, {
          surfaceId: msg.surfaceId,
          name: msg.name,
          context: msg.context,
        })
      } else if (msg.type === 'canvas-error') {
        postCanvasError(agentUrl, { surfaceId: msg.surfaceId as string, phase: msg.phase as string, error: msg.error as string })
        onCanvasError?.(msg.surfaceId as string, msg.phase as 'compile' | 'runtime', msg.error as string)
      }
    } catch {}
  }, [agentUrl, sse, sendToWebView, themeMessage, onCanvasError])

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={onMessage}
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  placeholder: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})
