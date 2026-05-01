// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasWebView — Canvas v2 renderer.
 *
 * Loads the canvas-runtime SPA shell inside a WebView (native) or iframe (web).
 * The iframe handles its own same-origin SSE for live reload via canvas-bridge.js;
 * this parent only relays theme + active-surface messages and forwards canvas
 * actions / errors back to the agent over HTTP.
 */

import { useCallback, useEffect, useRef, useMemo } from 'react'
import { Platform, View, StyleSheet } from 'react-native'
import { useCanvasThemeOptional } from './CanvasThemeContext'

interface CanvasCapabilities {
  supportsTheme: boolean
}

interface CanvasWebViewProps {
  agentUrl: string | null
  /** Direct runtime URL for the canvas iframe. When set, the iframe loads from
   *  here so fetch('/api/...') resolves same-origin — no proxy needed. */
  canvasBaseUrl?: string | null
  activeSurfaceId?: string | null
  onCanvasError?: (surfaceId: string, phase: 'compile' | 'runtime', error: string) => void
  onCanvasCapabilities?: (caps: CanvasCapabilities) => void
  /** Incremented externally to force the iframe to reload. */
  refreshKey?: number
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

export function CanvasWebView({ agentUrl, canvasBaseUrl, activeSurfaceId, onCanvasError, onCanvasCapabilities, refreshKey }: CanvasWebViewProps) {
  const iframeBase = canvasBaseUrl || agentUrl
  const canvasUrl = iframeBase ? `${iframeBase}/` : null
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
    return <CanvasIframe key={refreshKey} url={canvasUrl} agentUrl={agentUrl} activeSurfaceId={activeSurfaceId} themeMessage={themeMessage} onCanvasError={onCanvasError} onCanvasCapabilities={onCanvasCapabilities} />
  }

  return <CanvasNativeWebView url={canvasUrl} agentUrl={agentUrl} activeSurfaceId={activeSurfaceId} themeMessage={themeMessage} onCanvasError={onCanvasError} onCanvasCapabilities={onCanvasCapabilities} />
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
  activeSurfaceId?: string | null
  themeMessage: ThemeMessage | null
  onCanvasError?: (surfaceId: string, phase: 'compile' | 'runtime', error: string) => void
  onCanvasCapabilities?: (caps: CanvasCapabilities) => void
}

function CanvasIframe({ url, agentUrl, activeSurfaceId, themeMessage, onCanvasError, onCanvasCapabilities }: BridgeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)

  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  // Reload is handled inside the iframe itself (main.tsx listens to the SSE
  // stream on the same origin, avoiding cross-origin issues entirely).

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
        if (themeMessage) sendToIframe(themeMessage)
      } else if (msg.type === 'canvas-capabilities') {
        onCanvasCapabilities?.({ supportsTheme: !!msg.supportsTheme })
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
  }, [agentUrl, sendToIframe, themeMessage, onCanvasError, onCanvasCapabilities])

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
        allow="clipboard-write; clipboard-read; microphone; camera; display-capture; autoplay; fullscreen; geolocation; midi; encrypted-media; accelerometer; gyroscope; magnetometer; xr-spatial-tracking"
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Native — react-native-webview + postMessage bridge
// ---------------------------------------------------------------------------

function CanvasNativeWebView({ url, agentUrl, activeSurfaceId, themeMessage, onCanvasError, onCanvasCapabilities }: BridgeProps) {
  const WebView = require('react-native-webview').default
  const webViewRef = useRef<any>(null)
  const readyRef = useRef(false)

  const sendToWebView = useCallback((msg: Record<string, unknown>) => {
    webViewRef.current?.postMessage(JSON.stringify(msg))
  }, [])

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
        if (themeMessage) sendToWebView(themeMessage)
      } else if (msg.type === 'canvas-capabilities') {
        onCanvasCapabilities?.({ supportsTheme: !!msg.supportsTheme })
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
  }, [agentUrl, sendToWebView, themeMessage, onCanvasError, onCanvasCapabilities])

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
