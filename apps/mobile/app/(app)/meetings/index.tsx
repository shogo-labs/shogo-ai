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
  TextInput,
} from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Mic, Square, Clock, AlertCircle, CheckCircle, Loader2, Search, Sparkles, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useRecording, formatDuration } from '../../../lib/use-recording'
import {
  isMeetingInFlight,
  meetingsApi,
  onMeetingsChanged,
  type MeetingSearchHit,
  type MeetingSummary,
} from '../../../lib/meetings-api'
import { LiveTranscript } from '../../../components/meetings/LiveTranscript'

function StatusBadge({ meeting }: { meeting: MeetingSummary }) {
  if (meeting.status === 'ready' && meeting.enhanceStatus === 'running') {
    return (
      <View className="flex-row items-center gap-1 bg-orange-500/10 rounded-full px-2 py-0.5">
        <Sparkles size={10} className="text-orange-600" />
        <Text className="text-xs text-orange-600 font-medium">Writing notes</Text>
      </View>
    )
  }
  switch (meeting.status) {
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

function formatDate(dateStr: string) {
  const date = new Date(dateStr)
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function MeetingsScreen() {
  const router = useRouter()
  const {
    isRecording,
    duration,
    startRecording,
    stopRecording,
    canRecord,
    isUploading,
    notes,
    setNotes,
    liveTranscript,
    isNative,
    error,
    clearError,
    workspaceId,
  } = useRecording()
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MeetingSearchHit[] | null>(null)

  const fetchMeetings = useCallback(async () => {
    if (!workspaceId) return
    try {
      setMeetings(await meetingsApi(workspaceId).list())
    } catch (err) {
      console.error('Failed to fetch meetings:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [workspaceId])

  useEffect(() => {
    fetchMeetings()
  }, [fetchMeetings])

  useEffect(() => onMeetingsChanged(fetchMeetings), [fetchMeetings])

  const anyInFlight = meetings.some(isMeetingInFlight)
  useEffect(() => {
    if (!anyInFlight) return
    const interval = setInterval(fetchMeetings, 4000)
    return () => clearInterval(interval)
  }, [anyInFlight, fetchMeetings])

  useEffect(() => {
    const q = query.trim()
    if (!workspaceId || q.length < 2) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      meetingsApi(workspaceId)
        .search(q)
        .then((hits) => !cancelled && setResults(hits))
        .catch(() => !cancelled && setResults([]))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, workspaceId])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    fetchMeetings()
  }, [fetchMeetings])

  const openMeeting = (id: string) => router.push(`/(app)/meetings/${id}` as any)

  const renderMeeting = ({ item }: { item: MeetingSummary }) => (
    <Pressable
      onPress={() => openMeeting(item.id)}
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
              <Text className="text-xs text-muted-foreground">{formatDuration(item.duration)}</Text>
            </View>
          )}
          <Text className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</Text>
        </View>
      </View>
      <StatusBadge meeting={item} />
    </Pressable>
  )

  const renderHit = ({ item }: { item: MeetingSearchHit }) => (
    <Pressable
      onPress={() => openMeeting(item.id)}
      accessibilityRole="button"
      className="mb-2 rounded-2xl border border-border/70 bg-card px-4 py-3.5 active:bg-muted/50"
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {item.title || 'Untitled Meeting'}
        </Text>
        <Text className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</Text>
      </View>
      {!!item.snippet && (
        <Text className="mt-1 text-xs leading-5 text-muted-foreground" numberOfLines={3}>
          {item.snippet}
        </Text>
      )}
    </Pressable>
  )

  const recordButton = canRecord && (
    <Pressable
      onPress={isUploading ? undefined : isRecording ? stopRecording : startRecording}
      disabled={isUploading}
      accessibilityLabel={isUploading ? 'Uploading recording' : isRecording ? 'Stop recording' : 'Start recording'}
      className={cn(
        'min-h-11 flex-row items-center gap-2 rounded-xl px-4',
        isUploading ? 'bg-muted' : isRecording ? 'bg-red-600 active:bg-red-700' : 'bg-orange-500 active:bg-orange-600',
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
          <Text className="text-sm font-medium text-white">Stop · {formatDuration(duration)}</Text>
        </>
      ) : (
        <>
          <Mic size={14} color="white" />
          <Text className="text-sm font-medium text-white">Record</Text>
        </>
      )}
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
              Jot a few notes while you talk. Shogo writes up the rest.
            </Text>
          </View>
          {recordButton}
        </View>

        {isRecording && (
          <View className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/5 p-3">
            <View className="mb-2 flex-row items-center justify-between gap-2">
              <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-red-600">Your notes</Text>
              <Text className="text-[11px] text-muted-foreground">Let everyone know you're recording</Text>
            </View>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Type anything worth remembering. It gets merged with the transcript."
              placeholderTextColor="#9ca3af"
              className="min-h-[96px] text-sm leading-5 text-foreground"
              textAlignVertical="top"
              accessibilityLabel="Meeting notes"
            />
            {!isNative && <LiveTranscript state={liveTranscript} />}
          </View>
        )}

        {!!error && (
          <View className="mt-3 flex-row items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2">
            <AlertCircle size={14} className="text-red-600" />
            <Text className="flex-1 text-xs text-red-700 dark:text-red-300">{error}</Text>
            <Pressable onPress={clearError} accessibilityLabel="Dismiss">
              <X size={14} className="text-red-600" />
            </Pressable>
          </View>
        )}

        <View className="mt-4 flex-row items-center gap-2 rounded-xl border border-border/70 bg-background px-3">
          <Search size={14} className="text-muted-foreground" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search notes and transcripts"
            placeholderTextColor="#9ca3af"
            className="min-h-10 flex-1 text-sm text-foreground"
            accessibilityLabel="Search meetings"
            returnKeyType="search"
          />
          {!!query && (
            <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search">
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      </View>

      {results ? (
        <FlatList
          data={results}
          renderItem={renderHit}
          keyExtractor={(item) => item.id}
          contentContainerClassName="px-4 pb-8 pt-4"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text className="mt-8 text-center text-sm text-muted-foreground">No meetings mention that.</Text>
          }
        />
      ) : loading || !workspaceId ? (
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
            Record a meeting and Shogo transcribes it, then turns your notes into a clean write-up with action items.
          </Text>
          {canRecord && !isRecording && (
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}
    </SafeAreaView>
  )
}
