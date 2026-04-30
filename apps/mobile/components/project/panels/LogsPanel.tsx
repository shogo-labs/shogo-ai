// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  Switch,
  ActivityIndicator,
  TextInput,
  Platform,
  Share,
} from 'react-native'
import { ScrollText, RefreshCw, Trash2, Search, Download, X, AlertCircle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { agentFetch } from '../../../lib/agent-fetch'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error'
type LogSource = 'agent' | 'vite' | 'system'

interface ParsedLogEntry {
  id: number
  ts: string | null
  level: LogLevel
  source: LogSource
  message: string
  raw: string
}

// ---------------------------------------------------------------------------
// Parser — best-effort, falls back aggressively to info/system
// ---------------------------------------------------------------------------

const ANSI_RE = /[\x1B\x9B]\[[0-9;]*[A-Za-z]/g
const ISO_TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)]\s*/
const TIME12_RE = /^(\d{1,2}:\d{2}:\d{2}\s*[AP]M)\s+/i
const TIME24_RE = /^(\d{1,2}:\d{2}:\d{2})\s+/
const BUNDLER_PREFIX_RE = /^\[(vite|expo|metro)]\s*/i

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

let _nextId = 0

function parseLogLine(raw: string): ParsedLogEntry {
  const id = _nextId++
  let message = stripAnsi(raw).trimStart()
  let ts: string | null = null
  let level: LogLevel = 'info'
  let source: LogSource = 'system'

  const isoMatch = message.match(ISO_TS_RE)
  if (isoMatch) {
    ts = isoMatch[1]
    message = message.slice(isoMatch[0].length)
    source = 'agent'
  } else {
    const t12Match = message.match(TIME12_RE)
    if (t12Match) {
      ts = t12Match[1]
      message = message.slice(t12Match[0].length)
      source = 'agent'
    } else {
      const t24Match = message.match(TIME24_RE)
      if (t24Match) {
        ts = t24Match[1]
        message = message.slice(t24Match[0].length)
        source = 'agent'
      }
    }
  }

  const bundlerMatch = message.match(BUNDLER_PREFIX_RE)
  if (bundlerMatch) {
    source = 'vite'
    message = message.slice(bundlerMatch[0].length)
  }

  if (/\bERROR\b/.test(message) || /\bERR\b/.test(message)) {
    level = 'error'
  } else if (/\bWARN\b/.test(message)) {
    level = 'warn'
  }

  return { id, ts, level, source, message: message.trim(), raw }
}

function formatTime(ts: string | null): string {
  if (!ts) return ''
  if (/^\d{1,2}:\d{2}:\d{2}\s*[AP]M$/i.test(ts)) return ts
  const h24Match = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (h24Match) {
    let h = parseInt(h24Match[1], 10)
    const suffix = h >= 12 ? 'PM' : 'AM'
    if (h === 0) h = 12
    else if (h > 12) h -= 12
    return `${h}:${h24Match[2]}:${h24Match[3]} ${suffix}`
  }
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  } catch {
    return ts
  }
}

// ---------------------------------------------------------------------------
// Level filter config
// ---------------------------------------------------------------------------

type LevelFilter = 'all' | LogLevel

const LEVEL_FILTERS: LevelFilter[] = ['all', 'error', 'warn', 'info']

const LEVEL_COLORS: Record<LogLevel, { badge: string; text: string }> = {
  error: { badge: 'bg-red-900/60', text: 'text-red-400' },
  warn: { badge: 'bg-amber-900/50', text: 'text-amber-400' },
  info: { badge: '', text: 'text-zinc-400' },
}

// ---------------------------------------------------------------------------
// Row height for getItemLayout
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 24

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LogsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function LogsPanel({ projectId: _projectId, agentUrl, visible }: LogsPanelProps) {
  const [rawLogs, setRawLogs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [cleared, setCleared] = useState(false)

  const flatListRef = useRef<FlatList<ParsedLogEntry>>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isNearBottomRef = useRef(true)

  // ---- Parsed logs (memoized) ----
  const parsedLogs = useMemo(() => rawLogs.map(parseLogLine), [rawLogs])

  // ---- Level counts ----
  const levelCounts = useMemo(() => {
    const counts = { error: 0, warn: 0, info: 0 }
    for (const log of parsedLogs) counts[log.level]++
    return counts
  }, [parsedLogs])

  // ---- Filtered logs ----
  const filteredLogs = useMemo(() => {
    let result = parsedLogs
    if (levelFilter !== 'all') {
      result = result.filter((l) => l.level === levelFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter((l) => l.message.toLowerCase().includes(q))
    }
    return result
  }, [parsedLogs, levelFilter, searchQuery])

  // ---- Fetch logs ----
  const loadLogs = useCallback(async () => {
    if (!agentUrl) return
    try {
      const res = await agentFetch(`${agentUrl}/console-log`)
      if (!res.ok) {
        setError(`HTTP ${res.status}: ${res.statusText || 'Request failed'}`)
        return
      }
      let data: any
      try {
        data = await res.json()
      } catch {
        setError('Invalid response from agent')
        return
      }
      setRawLogs(data.logs || [])
      setError(null)
      setCleared(false)
    } catch (err: any) {
      setError(err.message || 'Failed to load logs')
    }
  }, [agentUrl])

  // ---- Initial load ----
  useEffect(() => {
    if (visible && agentUrl) {
      setIsLoading(true)
      loadLogs().finally(() => setIsLoading(false))
    }
  }, [visible, agentUrl, loadLogs])

  // ---- Polling ----
  useEffect(() => {
    if (visible && autoRefresh && agentUrl) {
      intervalRef.current = setInterval(loadLogs, 5000)
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [visible, autoRefresh, loadLogs, agentUrl])

  // ---- Auto-scroll on new data ----
  useEffect(() => {
    if (isNearBottomRef.current && filteredLogs.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: false })
      }, 50)
    }
  }, [filteredLogs.length])

  // ---- Handlers ----
  const handleClear = useCallback(() => {
    setRawLogs([])
    setCleared(true)
    _nextId = 0
  }, [])

  const handleExport = useCallback(async () => {
    const text = rawLogs.join('\n')
    if (!text) return
    if (Platform.OS === 'web') {
      try {
        const blob = new Blob([text], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `agent-logs-${new Date().toISOString().slice(0, 10)}.txt`
        a.click()
        URL.revokeObjectURL(url)
      } catch { /* best effort */ }
    } else {
      try {
        await Share.share({ message: text })
      } catch { /* user cancelled or unavailable */ }
    }
  }, [rawLogs])

  const handleScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y
    isNearBottomRef.current = distanceFromBottom < 50
  }, [])

  const toggleSearch = useCallback(() => {
    setSearchVisible((v) => {
      if (v) setSearchQuery('')
      return !v
    })
  }, [])

  // ---- Render ----
  if (!visible) return null

  const renderLogRow = ({ item }: { item: ParsedLogEntry }) => {
    const time = formatTime(item.ts)
    const colors = LEVEL_COLORS[item.level]
    return (
      <View className="flex-row px-4 py-0.5 items-start" style={{ minHeight: ROW_HEIGHT }}>
        {time ? (
          <Text className="text-zinc-600 text-xs font-mono mr-2 w-[70px]" numberOfLines={1}>
            {time}
          </Text>
        ) : null}
        {item.level !== 'info' && (
          <View className={cn('rounded px-1 mr-2', colors.badge)}>
            <Text className={cn('text-xs font-mono uppercase', colors.text)}>
              {item.level}
            </Text>
          </View>
        )}
        <Text
          className={cn('text-xs font-mono flex-1', item.level === 'error' ? 'text-red-300' : item.level === 'warn' ? 'text-amber-200' : 'text-zinc-300')}
          selectable
        >
          {item.message}
        </Text>
      </View>
    )
  }

  const getItemLayout = (_data: any, index: number) => ({
    length: ROW_HEIGHT,
    offset: ROW_HEIGHT * index,
    index,
  })

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* ---- Header toolbar ---- */}
      <View className="px-4 py-3 border-b border-border flex-col gap-2">
        <View className="flex-row items-center gap-2">
          <ScrollText size={16} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Agent Logs</Text>
          <Text className="text-xs text-muted-foreground">{parsedLogs.length} entries</Text>
          {levelCounts.error > 0 && (
            <Text className="text-xs text-red-400">({levelCounts.error} errors)</Text>
          )}

          <View className="ml-auto flex-row items-center gap-3">
            <Pressable onPress={toggleSearch} className="p-1 rounded-md active:bg-muted">
              <Search size={14} className={searchVisible ? 'text-indigo-400' : 'text-muted-foreground'} />
            </Pressable>
            <Pressable onPress={handleExport} className="p-1 rounded-md active:bg-muted">
              <Download size={14} className="text-muted-foreground" />
            </Pressable>
            <Pressable onPress={handleClear} className="p-1 rounded-md active:bg-muted">
              <Trash2 size={14} className="text-muted-foreground" />
            </Pressable>
            <View className="flex-row items-center gap-1.5">
              <Text className="text-xs text-muted-foreground">Auto</Text>
              <Switch
                value={autoRefresh}
                onValueChange={setAutoRefresh}
                trackColor={{ true: '#6366f1' }}
                style={{ transform: [{ scale: 0.7 }] }}
              />
            </View>
            <Pressable onPress={loadLogs} className="p-1 rounded-md active:bg-muted">
              <RefreshCw size={14} className="text-muted-foreground" />
            </Pressable>
          </View>
        </View>

        {/* ---- Search bar ---- */}
        {searchVisible && (
          <View className="flex-row items-center gap-2 bg-zinc-900 rounded-md px-2 py-1">
            <Search size={12} className="text-zinc-500" />
            <TextInput
              className="flex-1 text-xs text-zinc-200 font-mono py-0"
              placeholder="Filter logs..."
              placeholderTextColor="#71717a"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              style={{ outline: 'none' } as any}
            />
            {searchQuery ? (
              <Pressable onPress={() => setSearchQuery('')}>
                <X size={12} className="text-zinc-500" />
              </Pressable>
            ) : null}
          </View>
        )}

        {/* ---- Level filter pills ---- */}
        <View className="flex-row items-center gap-1.5">
          {LEVEL_FILTERS.map((lf) => {
            const isActive = levelFilter === lf
            const count = lf === 'all' ? parsedLogs.length : levelCounts[lf]
            return (
              <Pressable
                key={lf}
                onPress={() => setLevelFilter(lf)}
                className={cn(
                  'px-2 py-0.5 rounded-full',
                  isActive ? 'bg-zinc-700' : 'bg-zinc-800/50',
                )}
              >
                <Text
                  className={cn(
                    'text-xs capitalize',
                    isActive ? 'text-zinc-100' : 'text-zinc-500',
                    lf === 'error' && count > 0 && 'text-red-400',
                  )}
                >
                  {lf}{count > 0 ? ` (${count})` : ''}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      {/* ---- Error banner ---- */}
      {error && (
        <View className="px-4 py-2 bg-destructive/10 flex-row items-center gap-2">
          <AlertCircle size={12} className="text-destructive" />
          <Text className="text-xs text-destructive flex-1">{error}</Text>
          <Pressable onPress={loadLogs}>
            <Text className="text-xs text-destructive underline">Retry</Text>
          </Pressable>
        </View>
      )}

      {/* ---- Cleared locally banner ---- */}
      {cleared && rawLogs.length === 0 && (
        <View className="px-4 py-1.5 bg-zinc-900">
          <Text className="text-xs text-zinc-500 text-center">Cleared locally — server buffer unchanged</Text>
        </View>
      )}

      {/* ---- Log list ---- */}
      <View className="flex-1 bg-zinc-950">
        {!agentUrl ? (
          <View className="items-center py-8 px-4">
            <AlertCircle size={20} className="text-zinc-600 mb-2" />
            <Text className="text-zinc-500 text-center text-xs">
              Agent not running. Start the agent to see logs.
            </Text>
          </View>
        ) : isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
            <Text className="text-zinc-500 text-center mt-2 text-xs">Loading logs...</Text>
          </View>
        ) : filteredLogs.length === 0 ? (
          <Text className="text-zinc-500 text-center py-8 text-xs">
            {parsedLogs.length === 0
              ? 'No logs yet. Start the agent to see activity.'
              : 'No logs match current filters.'}
          </Text>
        ) : (
          <FlatList
            ref={flatListRef}
            data={filteredLogs}
            renderItem={renderLogRow}
            keyExtractor={(item) => String(item.id)}
            getItemLayout={getItemLayout}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            contentContainerStyle={{ paddingVertical: 8 }}
            initialNumToRender={50}
            maxToRenderPerBatch={30}
            windowSize={10}
          />
        )}
      </View>
    </View>
  )
}
