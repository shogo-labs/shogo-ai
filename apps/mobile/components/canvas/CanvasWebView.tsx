// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasWebView — Canvas v2 renderer.
 *
 * Loads the canvas-runtime SPA shell inside a WebView (native) or iframe (web).
 * The iframe handles its own same-origin SSE for live reload via canvas-bridge.js;
 * this parent only relays theme messages and forwards canvas actions / errors
 * back to the agent over HTTP.
 */

import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { Platform, View, StyleSheet, ActivityIndicator, Text, TouchableOpacity } from 'react-native'
import { useCanvasThemeOptional } from './CanvasThemeContext'

interface CanvasCapabilities {
  supportsTheme: boolean
}

/** Recent user-interaction breadcrumb captured by canvas-bridge.js. */
export interface CanvasErrorAction {
  ts: number
  kind: string
  target?: string
  route?: string
}

export interface CanvasErrorContext {
  /** Iframe's current `pathname + search + hash` when the error fired. */
  route?: string
  /** Last ~10 user actions in the iframe, oldest first. */
  recentActions?: CanvasErrorAction[]
}

interface CanvasWebViewProps {
  agentUrl: string | null
  /** Direct runtime URL for the canvas iframe. When set, the iframe loads from
   *  here so fetch('/api/...') resolves same-origin — no proxy needed. */
  canvasBaseUrl?: string | null
  onCanvasError?: (
    phase: 'compile' | 'runtime',
    error: string,
    context?: CanvasErrorContext,
  ) => void
  onCanvasCapabilities?: (caps: CanvasCapabilities) => void
  /** Incremented externally to force the iframe to reload. */
  refreshKey?: number
}

function postCanvasError(
  agentUrl: string,
  payload: {
    phase: string
    error: string
    route?: string
    recentActions?: CanvasErrorAction[]
  },
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

export function CanvasWebView({ agentUrl, canvasBaseUrl, onCanvasError, onCanvasCapabilities, refreshKey }: CanvasWebViewProps) {
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
    return <CanvasIframe key={refreshKey} url={canvasUrl} agentUrl={agentUrl} themeMessage={themeMessage} onCanvasError={onCanvasError} onCanvasCapabilities={onCanvasCapabilities} />
  }

  return <CanvasNativeWebView url={canvasUrl} agentUrl={agentUrl} themeMessage={themeMessage} onCanvasError={onCanvasError} onCanvasCapabilities={onCanvasCapabilities} />
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
  themeMessage: ThemeMessage | null
  onCanvasError?: (
    phase: 'compile' | 'runtime',
    error: string,
    context?: CanvasErrorContext,
  ) => void
  onCanvasCapabilities?: (caps: CanvasCapabilities) => void
}

function CanvasIframe({ url, agentUrl, themeMessage, onCanvasError, onCanvasCapabilities }: BridgeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ phase: string; message: string } | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)

  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  // Reload is handled inside the iframe itself (main.tsx listens to the SSE
  // stream on the same origin, avoiding cross-origin issues entirely).

  // Send theme when it changes
  useEffect(() => {
    if (themeMessage && readyRef.current) sendToIframe(themeMessage)
  }, [themeMessage, sendToIframe])

  // Reset loading state when refreshKey changes (external reload trigger)
  useEffect(() => {
    setLoading(true)
    setError(null)
  }, [refreshCount])

  // Listen for messages from the iframe
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'canvas-ready') {
        readyRef.current = true
        setLoading(false)
        if (themeMessage) sendToIframe(themeMessage)
      } else if (msg.type === 'canvas-capabilities') {
        onCanvasCapabilities?.({ supportsTheme: !!msg.supportsTheme })
      } else if (msg.type === 'canvas-error') {
        const route = typeof msg.route === 'string' ? (msg.route as string) : undefined
        const recentActions = Array.isArray(msg.recentActions)
          ? (msg.recentActions as CanvasErrorAction[])
          : undefined
        const errorMsg = msg.error as string
        postCanvasError(agentUrl, {
          phase: msg.phase as string,
          error: errorMsg,
          route,
          recentActions,
        })
        setError({ phase: msg.phase as string, message: errorMsg })
        onCanvasError?.(
          msg.phase as 'compile' | 'runtime',
          errorMsg,
          { route, recentActions },
        )
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [agentUrl, sendToIframe, themeMessage, onCanvasError, onCanvasCapabilities])

  const handleRetry = useCallback(() => {
    setError(null)
    setLoading(true)
    readyRef.current = false
    setRefreshCount((c) => c + 1)
  }, [])

  return (
    <View style={styles.container}>
      {loading && !error && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#888" />
          <Text style={styles.loadingText}>Loading preview…</Text>
        </View>
      )}
      {error && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>
            {error.phase === 'compile' ? 'Build Error' : 'Runtime Error'}
          </Text>
          <Text style={styles.errorMessage} numberOfLines={4}>
            {error.message}
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      <iframe
        ref={iframeRef}
        src={`${url}${url.includes('?') ? '&' : '?'}_v=${refreshCount}`}
        data-testid="canvas-preview-iframe"
        title="Project preview"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: 'transparent',
          opacity: loading || error ? 0 : 1,
        } as any}
        allow="clipboard-write; clipboard-read; microphone; camera; display-capture; autoplay; fullscreen; geolocation; midi; encrypted-media; accelerometer; gyroscope; magnetometer; xr-spatial-tracking"
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Native — react-native-webview + postMessage bridge
// ---------------------------------------------------------------------------

function CanvasNativeWebView({ url, agentUrl, themeMessage, onCanvasError, onCanvasCapabilities }: BridgeProps) {
  const WebView = require('react-native-webview').default
  const webViewRef = useRef<any>(null)
  const readyRef = useRef(false)

  const sendToWebView = useCallback((msg: Record<string, unknown>) => {
    webViewRef.current?.postMessage(JSON.stringify(msg))
  }, [])

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
      } else if (msg.type === 'canvas-error') {
        const route = typeof msg.route === 'string' ? (msg.route as string) : undefined
        const recentActions = Array.isArray(msg.recentActions)
          ? (msg.recentActions as CanvasErrorAction[])
          : undefined
        postCanvasError(agentUrl, {
          phase: msg.phase as string,
          error: msg.error as string,
          route,
          recentActions,
        })
        onCanvasError?.(
          msg.phase as 'compile' | 'runtime',
          msg.error as string,
          { route, recentActions },
        )
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
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    zIndex: 10,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 13,
    color: '#888',
  },
  errorOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.03)',
    zIndex: 10,
    padding: 24,
  },
  errorIcon: {
    fontSize: 32,
    marginBottom: 12,
  },
  errorTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#e74c3c',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    maxWidth: 400,
    marginBottom: 16,
    fontFamily: 'monospace',
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#333',
  },
  retryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },
})
