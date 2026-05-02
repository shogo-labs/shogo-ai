// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Platform,
  Share,
} from 'react-native'
import { ScrollText, Trash2, Search, Download, X, AlertCircle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  formatTime,
  LEVEL_COLORS,
  LEVEL_FILTERS,
  resetParserIdsForTest,
  type LevelFilter,
  type ParsedLogEntry,
} from './log-utils'
import { runtimeEntryToParsed } from './runtime-entry-to-parsed'
import { clearProject } from '../../../lib/runtime-logs/runtime-log-store'
import { useRuntimeLogStream } from '../../../lib/runtime-logs/useRuntimeLogStream'

const ROW_HEIGHT = 24

interface LogsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

/**
 * Monitor's "Logs" panel. Shares the runtime-log stream with the IDE
 * Output tab so both surfaces see the same buffer without double-fetching
 * `/console-log`. The legacy console-log endpoint is still available for
 * older clients but this component no longer talks to it directly.
 */
export function LogsPanel({ projectId, agentUrl, visible }: LogsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchVisible, setSearchVisible] = useState(false)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [cleared, setCleared] = useState(false)

  const flatListRef = useRef<FlatList<ParsedLogEntry>>(null)
  const isNearBottomRef = useRef(true)

  const safeProjectId = projectId || '__no_project__'
  const { entries } = useRuntimeLogStream({
    projectId: safeProjectId,
    agentUrl,
  })

  // Re-parse runtime entries through the shared utilities so the existing
  // row renderer (which expects `ParsedLogEntry`) keeps working.
  const parsedLogs = useMemo(
    () => entries.map(runtimeEntryToParsed),
    [entries],
  )

  const levelCounts = useMemo(() => {
    const counts = { error: 0, warn: 0, info: 0 }
    for (const log of parsedLogs) counts[log.level]++
    return counts
  }, [parsedLogs])

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

  const handleClear = useCallback(() => {
    clearProject(safeProjectId)
    setCleared(true)
    resetParserIdsForTest()
  }, [safeProjectId])

  const handleExport = useCallback(async () => {
    const text = entries.map((e) => `[${e.source}] ${e.text}`).join('\n')
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
      } catch {
        // Best-effort: ignore download failures (popup blocker, etc.).
      }
    } else {
      try {
        await Share.share({ message: text })
      } catch {
        // User cancelled or Share unavailable on this platform.
      }
    }
  }, [entries])

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

      {/* ---- Cleared locally banner ---- */}
      {cleared && entries.length === 0 && (
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
