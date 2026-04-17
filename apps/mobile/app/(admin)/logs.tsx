// SPDX-License-Identifier: AGPL-3.0-or-later
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
} from 'react-native'
import {
  ScrollText,
  Pause,
  Play,
  ArrowDown,
  Trash2,
  RefreshCw,
} from 'lucide-react-native'
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
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logPath, setLogPath] = useState<string | null>(null)
  const [totalLines, setTotalLines] = useState(0)
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<'all' | 'errors' | 'vm'>('all')
  const scrollRef = useRef<ScrollView>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const base = getApiBaseUrl()

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`${base}/api/vm/logs?lines=1000`, {
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

    const es = new EventSource(`${base}/api/vm/logs/stream`)
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
    if (filter === 'vm') return line.includes('[shogo-vm]') || line.includes('[VMWarmPool]') || line.includes('[VM')
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
    <View className="flex-1 bg-background">
      {/* Toolbar */}
      <View className="flex-row items-center px-4 py-2 border-b border-border bg-card gap-3">
        <ScrollText size={16} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground flex-1">
          Desktop Logs
        </Text>

        {/* Filter buttons */}
        <View className="flex-row gap-1">
          {(['all', 'errors', 'vm'] as const).map(f => (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              className={cn(
                'px-2.5 py-1 rounded-md',
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

        <View className="w-px h-5 bg-border" />

        {/* Pause/resume */}
        <Pressable
          onPress={() => setPaused(p => !p)}
          className="p-1.5 rounded-md active:bg-muted"
        >
          {paused ? (
            <Play size={14} className="text-emerald-500" />
          ) : (
            <Pause size={14} className="text-muted-foreground" />
          )}
        </Pressable>

        {/* Auto-scroll toggle */}
        <Pressable
          onPress={() => {
            setAutoScroll(a => !a)
            if (!autoScroll) scrollRef.current?.scrollToEnd({ animated: true })
          }}
          className={cn(
            'p-1.5 rounded-md active:bg-muted',
            autoScroll && 'bg-primary/10',
          )}
        >
          <ArrowDown size={14} className={autoScroll ? 'text-primary' : 'text-muted-foreground'} />
        </Pressable>

        {/* Refresh */}
        <Pressable
          onPress={fetchLogs}
          className="p-1.5 rounded-md active:bg-muted"
        >
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Status bar */}
      <View className="flex-row items-center px-4 py-1.5 border-b border-border bg-card/50 gap-2">
        <View className={cn('h-1.5 w-1.5 rounded-full', paused ? 'bg-yellow-500' : 'bg-emerald-500')} />
        <Text className="text-[11px] text-muted-foreground">
          {paused ? 'Paused' : 'Live'} · {filteredLines.length} lines
          {filter !== 'all' && ` (${lines.length} total)`}
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

      {/* Log content */}
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-[#0d1117]"
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
  )
}
