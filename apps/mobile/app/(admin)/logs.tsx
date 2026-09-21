// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Logs - Live tail of the desktop main.log file.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native'
import {
  ScrollText,
  Pause,
  Play,
  ArrowDown,
  RefreshCw,
} from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { cn } from '@shogo/shared-ui/primitives'

function getApiBaseUrl(): string {
  const port = process.env.EXPO_PUBLIC_API_PORT ?? '8002'
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const desktop = (window as any).shogoDesktop as { apiUrl?: string } | undefined
    if (desktop?.apiUrl) return desktop.apiUrl
    const envUrl = process.env.EXPO_PUBLIC_API_URL
    if (envUrl) return envUrl
    return `http://localhost:${port}`
  }
  return process.env.EXPO_PUBLIC_API_URL || `http://localhost:${port}`
}

type LogLevel = 'INFO' | 'ERROR' | 'WARN' | 'DEBUG'

function parseLogLevel(line: string): LogLevel {
  if (line.includes('[ERROR]')) return 'ERROR'
  if (line.includes('[WARN]')) return 'WARN'
  if (line.includes('[DEBUG]')) return 'DEBUG'
  return 'INFO'
}

function LogLine({ line, index }: { line: string; index: number }) {
  const level = parseLogLevel(line)
  const levelColor = {
    INFO: 'text-muted-foreground',
    ERROR: 'text-red-400',
    WARN: 'text-yellow-400',
    DEBUG: 'text-blue-400',
  }[level]

  return (
    <Text
      className={cn('text-xs font-mono leading-5 px-3', levelColor)}
      selectable
    >
      {line}
    </Text>
  )
}

export default function AdminLogsPage() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const isWide = width >= 900
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [totalLines, setTotalLines] = useState(0)
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<'all' | 'errors'>('all')
  const scrollRef = useRef<ScrollView>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const base = getApiBaseUrl()

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${base}/api/local/logs?lines=1000`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setLines(data.lines || [])
      setLogPath(data.path || null)
      setTotalLines(data.total || 0)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // SSE live tail
  useEffect(() => {
    if (paused) {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      return
    }

    const es = new EventSource(`${base}/api/local/logs/stream`)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      if (event.data) {
        setLines(prev => {
          const next = [...prev, event.data]
          if (next.length > 2000) return next.slice(-1500)
          return next
        })
        setTotalLines(prev => prev + 1)
      }
    }

    es.onerror = () => {
      // Reconnect handled by browser EventSource
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [base, paused])

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScroll && !paused && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: false })
      })
    }
  }, [lines.length, autoScroll, paused])

  const filteredLines = lines.filter(line => {
    if (filter === 'errors') return line.includes('[ERROR]') || line.includes('[WARN]')
    return true
  })

  if (loading && lines.length === 0) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="text-muted-foreground mt-3 text-sm">Loading logs...</Text>
      </View>
    )
  }

  return (
    <View
      className={cn('flex-1 bg-background', isWide ? 'px-8 pt-8' : 'px-4 pt-4')}
      style={{ paddingBottom: Math.max(insets.bottom, 16) }}
    >
      <View className="flex-1 w-full self-center max-w-[1180px] overflow-hidden rounded-2xl border border-border/70 bg-card">
        <View className={cn('border-b border-border/70', isWide ? 'px-5 py-4' : 'p-4')}>
          <View className={cn(isWide ? 'flex-row items-center justify-between' : 'gap-3')}>
            <View className="flex-row items-center gap-3">
              <View className="h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                <ScrollText size={17} className="text-primary" />
              </View>
              <View className="gap-0.5">
                <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  System observability
                </Text>
                <Text className="text-base font-semibold tracking-tight text-foreground">
                  Desktop logs
                </Text>
              </View>
            </View>
            <View className="flex-row items-center gap-2">
              <View className={cn('h-2 w-2 rounded-full', paused ? 'bg-yellow-500' : 'bg-emerald-500')} />
              <Text className="text-xs text-muted-foreground">
                {paused ? 'Paused' : 'Live stream'} · {filteredLines.length} lines
              </Text>
            </View>
          </View>
        </View>

        <View className={cn('flex-row items-center gap-3 border-b border-border/70 px-4 py-2.5', !isWide && 'flex-wrap')}>
          <View className="flex-row gap-1 rounded-lg border border-border/70 bg-muted/30 p-0.5">
          {(['all', 'errors'] as const).map(f => (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityLabel={`Show ${f} logs`}
              className={cn(
                'min-h-8 justify-center px-2.5 rounded-md',
                filter === f ? 'bg-primary/15' : 'active:bg-muted',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium capitalize',
                  filter === f ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {f}
              </Text>
            </Pressable>
          ))}
          </View>
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={() => setPaused(p => !p)}
              accessibilityLabel={paused ? 'Resume live log stream' : 'Pause live log stream'}
              className="h-8 w-8 items-center justify-center rounded-lg border border-border/70 active:bg-muted"
            >
              {paused ? (
                <Play size={14} className="text-emerald-500" />
              ) : (
                <Pause size={14} className="text-muted-foreground" />
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setAutoScroll(a => !a)
                if (!autoScroll) scrollRef.current?.scrollToEnd({ animated: true })
              }}
              accessibilityLabel={autoScroll ? 'Disable automatic log scrolling' : 'Enable automatic log scrolling'}
              className={cn(
                'h-8 w-8 items-center justify-center rounded-lg border border-border/70 active:bg-muted',
                autoScroll && 'bg-primary/10 border-primary/20',
              )}
            >
              <ArrowDown size={14} className={autoScroll ? 'text-primary' : 'text-muted-foreground'} />
            </Pressable>
            <Pressable
              onPress={fetchLogs}
              accessibilityLabel="Refresh logs"
              className="h-8 w-8 items-center justify-center rounded-lg border border-border/70 active:bg-muted"
            >
              <RefreshCw size={14} className="text-muted-foreground" />
            </Pressable>
          </View>
        </View>

        <View className="flex-row items-center gap-2 border-b border-border/70 bg-muted/20 px-4 py-2">
        <Text className="text-[11px] text-muted-foreground">
          Showing {filter === 'errors' ? 'warnings and errors' : 'all entries'}
          {filter !== 'all' && ` · ${lines.length} total`}
        </Text>
        {logPath && (
          <Text className="text-[11px] text-muted-foreground/60 ml-auto" numberOfLines={1}>
            {logPath}
          </Text>
        )}
      </View>

      {error && (
        <View className="px-4 py-2 bg-red-500/10 border-b border-red-500/20">
          <Text className="text-xs text-red-400">{error}</Text>
        </View>
      )}

        <ScrollView
          ref={scrollRef}
          className="flex-1 bg-[#0d1117]"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 12) }}
          onScrollBeginDrag={() => setAutoScroll(false)}
        >
          <View className="py-2">
            {filteredLines.map((line, i) => (
              <LogLine key={i} line={line} index={i} />
            ))}
            {filteredLines.length === 0 && (
              <Text className="text-xs text-muted-foreground px-3 py-8 text-center">
                No log lines to display
              </Text>
            )}
          </View>
        </ScrollView>
      </View>
    </View>
  )
}
