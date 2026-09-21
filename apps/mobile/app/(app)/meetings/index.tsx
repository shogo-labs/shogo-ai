// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Mic, Square, Clock, AlertCircle, CheckCircle, Loader2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useRecording, formatDuration } from '../../../lib/use-recording'
import { createHttpClient } from '../../../lib/api'

interface Meeting {
  id: string
  title: string | null
  duration: number | null
  status: 'recording' | 'transcribing' | 'ready' | 'error'
  projectId: string | null
  createdAt: string
}

function StatusBadge({ status }: { status: Meeting['status'] }) {
  switch (status) {
    case 'recording':
      return (
        <View className="flex-row items-center gap-1 bg-red-500/10 rounded-full px-2 py-0.5">
          <View className="w-1.5 h-1.5 rounded-full bg-red-500" />
          <Text className="text-xs text-red-600 font-medium">Recording</Text>
        </View>
      )
    case 'transcribing':
      return (
        <View className="flex-row items-center gap-1 bg-yellow-500/10 rounded-full px-2 py-0.5">
          <Loader2 size={10} className="text-yellow-600" />
          <Text className="text-xs text-yellow-600 font-medium">Transcribing</Text>
        </View>
      )
    case 'ready':
      return (
        <View className="flex-row items-center gap-1 bg-green-500/10 rounded-full px-2 py-0.5">
          <CheckCircle size={10} className="text-green-600" />
          <Text className="text-xs text-green-600 font-medium">Ready</Text>
        </View>
      )
    case 'error':
      return (
        <View className="flex-row items-center gap-1 bg-red-500/10 rounded-full px-2 py-0.5">
          <AlertCircle size={10} className="text-red-600" />
          <Text className="text-xs text-red-600 font-medium">Error</Text>
        </View>
      )
  }
}

export default function MeetingsScreen() {
  const router = useRouter()
  const { isRecording, startRecording, stopRecording, isDesktop, isLocal, isUploading } = useRecording()
  const canRecord = isDesktop || isLocal
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchMeetings = useCallback(async () => {
    try {
      const http = createHttpClient()
      const res = await http.get<{ meetings: Meeting[] }>('/api/local/meetings')
      setMeetings(res.data.meetings || [])
    } catch (err) {
      console.error('Failed to fetch meetings:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchMeetings()
  }, [fetchMeetings])

  // Refresh list when recording stops or upload finishes
  useEffect(() => {
    if (!isRecording && !isUploading) {
      const timer = setTimeout(fetchMeetings, 2000)
      return () => clearTimeout(timer)
    }
  }, [isRecording, isUploading, fetchMeetings])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    fetchMeetings()
  }, [fetchMeetings])

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (days === 0) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    } else if (days === 1) {
      return 'Yesterday'
    } else if (days < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'short' })
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const renderMeeting = ({ item }: { item: Meeting }) => (
    <Pressable
      onPress={() => router.push(`/(app)/meetings/${item.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title || 'untitled meeting'}`}
      className="mb-2 flex-row items-center rounded-2xl border border-border/70 bg-card px-4 py-3.5 active:bg-muted/50"
    >
      <View className="mr-3 h-10 w-10 items-center justify-center rounded-xl bg-orange-500/10">
        <Mic size={18} className="text-orange-600 dark:text-orange-300" />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {item.title || 'Untitled Meeting'}
        </Text>
        <View className="flex-row items-center gap-2 mt-0.5">
          {item.duration != null && (
            <View className="flex-row items-center gap-1">
              <Clock size={10} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {formatDuration(item.duration)}
              </Text>
            </View>
          )}
          <Text className="text-xs text-muted-foreground">
            {formatDate(item.createdAt)}
          </Text>
        </View>
      </View>
      <StatusBadge status={item.status} />
    </Pressable>
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'left', 'right']}>
      <View className="border-b border-border/70 bg-card/70 px-4 pb-4 pt-3">
        <View className="flex-row items-center justify-between">
          <View className="min-w-0 flex-1 pr-3">
            <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-orange-600 dark:text-orange-300">
              Capture
            </Text>
            <Text className="mt-1 text-[28px] font-semibold tracking-[-0.6px] text-foreground">Meetings</Text>
            <Text className="mt-1 text-sm leading-5 text-muted-foreground">
              Record, revisit, and share what matters.
            </Text>
          </View>
          {canRecord && (
            <Pressable
              onPress={isUploading ? undefined : (isRecording ? stopRecording : startRecording)}
              disabled={isUploading}
              accessibilityLabel={isUploading ? 'Uploading recording' : isRecording ? 'Stop recording' : 'Start recording'}
              className={cn(
                'min-h-11 flex-row items-center gap-2 rounded-xl px-4',
                isUploading
                  ? 'bg-muted'
                  : isRecording
                    ? 'bg-red-600 active:bg-red-700'
                    : 'bg-orange-500 active:bg-orange-600'
              )}
            >
              {isUploading ? (
                <>
                  <ActivityIndicator size="small" color="white" />
                  <Text className="text-sm font-medium text-muted-foreground">Uploading...</Text>
                </>
              ) : isRecording ? (
                <>
                  <Square size={14} color="white" fill="white" />
                  <Text className="text-sm font-medium text-white">Stop</Text>
                </>
              ) : (
                <>
                  <Mic size={14} color="white" />
                  <Text className="text-sm font-medium text-white">Record</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      </View>

      {/* Meeting list */}
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#f97316" />
        </View>
      ) : meetings.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <View className="mb-4 h-16 w-16 items-center justify-center rounded-2xl border border-orange-500/20 bg-orange-500/10">
            <Mic size={28} className="text-orange-600 dark:text-orange-300" />
          </View>
          <Text className="text-lg font-semibold text-foreground mb-1">No meetings yet</Text>
          <Text className="text-sm text-muted-foreground text-center mb-4">
            Start recording a meeting to capture and transcribe it automatically.
          </Text>
          {canRecord && (
            <Pressable
              onPress={startRecording}
              className="min-h-11 flex-row items-center gap-2 rounded-xl bg-orange-500 px-4 active:bg-orange-600"
            >
              <Mic size={14} color="white" />
              <Text className="text-sm font-medium text-white">Start Recording</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={meetings}
          renderItem={renderMeeting}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-4 pb-8 pt-4"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      )}
    </SafeAreaView>
  )
}
