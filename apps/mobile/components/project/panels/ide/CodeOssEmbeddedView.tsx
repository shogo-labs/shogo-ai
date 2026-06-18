// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native'
import { Code2 } from 'lucide-react-native'

interface IdeViewBridge {
  open: (projectId: string, opts?: { workspacePath?: string }) => Promise<{ ok: boolean; url?: string; error?: string }>
  close: (projectId: string) => Promise<{ ok: boolean }>
  setBounds: (projectId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
  setVisible: (projectId: string, visible: boolean) => Promise<{ ok: boolean }>
}

function getIdeViewBridge(): IdeViewBridge | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const desktop = (window as unknown as { shogoDesktop?: { ideView?: IdeViewBridge } }).shogoDesktop
  return desktop?.ideView ?? null
}

export interface CodeOssEmbeddedViewProps {
  projectId: string
  visible: boolean
  workspacePath?: string | null
}

export function CodeOssEmbeddedView({ projectId, visible, workspacePath }: CodeOssEmbeddedViewProps) {
  const bridge = useMemo(getIdeViewBridge, [])
  const placeholderRef = useRef<View | null>(null)
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const pushBounds = useCallback(() => {
    if (!bridge) return
    const node = placeholderRef.current as unknown as { measureInWindow?: Function } | null
    if (!node?.measureInWindow) return
    node.measureInWindow((x: number, y: number, width: number, height: number) => {
      const next = { x, y, width, height }
      const prev = lastBoundsRef.current
      if (
        prev &&
        Math.abs(prev.x - next.x) < 0.5 &&
        Math.abs(prev.y - next.y) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5 &&
        Math.abs(prev.height - next.height) < 0.5
      ) {
        return
      }
      lastBoundsRef.current = next
      void bridge.setBounds(projectId, next)
    })
  }, [bridge, projectId])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    if (workspacePath === undefined) {
      setLoading(true)
      setError(null)
      return
    }
    if (!workspacePath) {
      setLoading(false)
      setError('Project workspace path is not available yet.')
      return
    }
    setLoading(true)
    setError(null)
    void bridge.open(projectId, { workspacePath }).then((res) => {
      if (cancelled) return
      if (!res?.ok) {
        setError(res?.error ?? 'Failed to open embedded Code OSS workbench')
      }
      setLoading(false)
      void bridge.setVisible(projectId, visible)
      if (visible) pushBounds()
    })
    return () => {
      cancelled = true
    }
  }, [bridge, projectId, pushBounds, visible, workspacePath])

  useEffect(() => {
    if (!bridge) return
    void bridge.setVisible(projectId, visible)
    if (visible) pushBounds()
  }, [bridge, projectId, pushBounds, visible])

  useEffect(() => {
    if (!bridge || typeof window === 'undefined') return
    const handler = () => pushBounds()
    window.addEventListener('resize', handler)
    const interval = setInterval(pushBounds, 250)
    return () => {
      window.removeEventListener('resize', handler)
      clearInterval(interval)
    }
  }, [bridge, pushBounds])

  useEffect(() => {
    return () => {
      if (!bridge) return
      void bridge.close(projectId)
    }
  }, [bridge, projectId])

  if (!bridge) return null

  return (
    <View
      ref={placeholderRef}
      onLayout={pushBounds}
      style={[styles.host, { display: visible ? 'flex' : 'none' }]}
    >
      {(loading || error) && (
        <View style={styles.overlay}>
          {loading ? <ActivityIndicator /> : <Code2 size={32} color="#f97316" />}
          <Text style={styles.title}>
            {loading ? 'Opening Code OSS workbench…' : 'Could not open Code OSS workbench'}
          </Text>
          {error ? (
            <Text style={styles.errorText}>
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    minHeight: 0,
    backgroundColor: '#0b0b0f',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b0b0f',
    paddingHorizontal: 24,
  },
  title: {
    marginTop: 12,
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    marginTop: 6,
    maxWidth: 520,
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 12,
  },
})
