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

// ---------------------------------------------------------------------------
// CanvasWebView — public component
// ---------------------------------------------------------------------------

export function CanvasWebView({ agentUrl }: CanvasWebViewProps) {
  const canvasUrl = agentUrl ? `${agentUrl}/canvas/` : null
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
    return <CanvasIframe url={canvasUrl} agentUrl={agentUrl} sse={sse} themeMessage={themeMessage} />
  }

  return <CanvasNativeWebView url={canvasUrl} agentUrl={agentUrl} sse={sse} themeMessage={themeMessage} />
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
  themeMessage: ThemeMessage | null
}

function CanvasIframe({ url, agentUrl, sse, themeMessage }: BridgeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)

  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  // Relay SSE events into the iframe
  useEffect(() => {
    return sse.subscribe((event) => {
      sendToIframe({ type: 'canvas-event', event })
    })
  }, [sse, sendToIframe])

  // Send connected status
  useEffect(() => {
    if (sse.connected) sendToIframe({ type: 'canvas-connected' })
  }, [sse.connected, sendToIframe])

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
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [agentUrl, sse, sendToIframe, themeMessage])

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

function CanvasNativeWebView({ url, agentUrl, sse, themeMessage }: BridgeProps) {
  const WebView = require('react-native-webview').default
  const webViewRef = useRef<any>(null)
  const readyRef = useRef(false)

  const sendToWebView = useCallback((msg: Record<string, unknown>) => {
    webViewRef.current?.postMessage(JSON.stringify(msg))
  }, [])

  // Relay SSE events into the WebView
  useEffect(() => {
    return sse.subscribe((event) => {
      sendToWebView({ type: 'canvas-event', event })
    })
  }, [sse, sendToWebView])

  // Send connected status
  useEffect(() => {
    if (sse.connected) sendToWebView({ type: 'canvas-connected' })
  }, [sse.connected, sendToWebView])

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
      }
    } catch {}
  }, [agentUrl, sse, sendToWebView, themeMessage])

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
