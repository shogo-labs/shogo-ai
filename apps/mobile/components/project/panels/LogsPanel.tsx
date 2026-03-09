// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, Switch, ActivityIndicator } from 'react-native'
import { ScrollText, RefreshCw, Trash2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface LogsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function LogsPanel({ projectId, agentUrl, visible }: LogsPanelProps) {
  const [logs, setLogs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const scrollRef = useRef<ScrollView>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadLogs = useCallback(async () => {
    if (!agentUrl) return
    try {
      const res = await fetch(`${agentUrl}/console-log`)
      if (!res.ok) return
      const data = await res.json()
      setLogs(data.logs || [])
      setError(null)
    } catch (err: any) {
      if (!error) setError(err.message)
    }
  }, [agentUrl, error])

  useEffect(() => {
    if (visible && agentUrl) {
      setIsLoading(true)
      loadLogs().finally(() => setIsLoading(false))
    }
  }, [visible, agentUrl])

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

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false })
  }, [logs])

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <ScrollText size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Agent Logs</Text>
        <Text className="text-xs text-muted-foreground">{logs.length} entries</Text>

        <View className="ml-auto flex-row items-center gap-3">
          <View className="flex-row items-center gap-1.5">
            <Text className="text-xs text-muted-foreground">Auto</Text>
            <Switch
              value={autoRefresh}
              onValueChange={setAutoRefresh}
              trackColor={{ true: '#6366f1' }}
              style={{ transform: [{ scale: 0.7 }] }}
            />
          </View>
          <Pressable onPress={() => setLogs([])} className="p-1 rounded-md active:bg-muted">
            <Trash2 size={14} className="text-muted-foreground" />
          </Pressable>
          <Pressable onPress={loadLogs} className="p-1 rounded-md active:bg-muted">
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-zinc-950 p-4"
        contentContainerStyle={{ padding: 16 }}
      >
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
            <Text className="text-zinc-500 text-center mt-2 text-xs">Loading logs...</Text>
          </View>
        ) : logs.length === 0 ? (
          <Text className="text-zinc-500 text-center py-8 text-xs">
            No logs yet. Start the agent to see activity.
          </Text>
        ) : (
          logs.map((log, i) => (
            <Text key={i} className="text-zinc-300 text-xs py-0.5 font-mono">
              {log}
            </Text>
          ))
        )}
      </ScrollView>
    </View>
  )
}
