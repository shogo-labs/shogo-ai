// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Clock,
  Trash2,
  RefreshCw,
  FolderPlus,
  ChevronDown,
  Copy,
  Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { createHttpClient } from '../../../lib/api'
import { formatDuration } from '../../../lib/use-recording'

interface TranscriptSegment {
  start: number
  end: number
  text: string
}

interface MeetingDetail {
  id: string
  title: string | null
  audioPath: string
  transcript: string | null
  summary: string | null
  duration: number | null
  status: string
  projectId: string | null
  workspaceId: string
  createdAt: string
  updatedAt: string
  project: { id: string; name: string } | null
}

function parseTranscript(raw: string | null): { text: string; segments: TranscriptSegment[] } | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return { text: raw, segments: [] }
  }
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function MeetingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [retranscribing, setRetranscribing] = useState(false)

  const fetchMeeting = useCallback(async () => {
    try {
      const http = createHttpClient()
      const res = await http.get<{ meeting: any }>(`/api/local/meetings/${id}`)
      setMeeting(res.data.meeting)
    } catch (err) {
      console.error('Failed to fetch meeting:', err)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchMeeting()
  }, [fetchMeeting])

  // Poll while transcribing
  useEffect(() => {
    if (meeting?.status !== 'transcribing') return
    const interval = setInterval(fetchMeeting, 3000)
    return () => clearInterval(interval)
  }, [meeting?.status, fetchMeeting])

  const handleSaveTitle = async () => {
    if (!meeting || !titleDraft.trim()) return
    try {
      const http = createHttpClient()
      await http.put(`/api/local/meetings/${id}`, { title: titleDraft.trim() })
      setMeeting({ ...meeting, title: titleDraft.trim() })
      setEditingTitle(false)
    } catch (err) {
      console.error('Failed to update title:', err)
    }
  }

  const handleDelete = () => {
    Alert.alert('Delete Meeting', 'This will permanently delete the recording and transcript.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const http = createHttpClient()
            await http.delete(`/api/local/meetings/${id}`)
            router.back()
          } catch (err) {
            console.error('Failed to delete meeting:', err)
          }
        },
      },
    ])
  }

  const handleRetranscribe = async () => {
    setRetranscribing(true)
    try {
      const http = createHttpClient()
      await http.post(`/api/local/meetings/${id}/transcribe`, {})
      setMeeting((prev) => prev ? { ...prev, status: 'transcribing' } : null)
    } catch (err) {
      console.error('Failed to retranscribe:', err)
    } finally {
      setRetranscribing(false)
    }
  }

  const handleCopyTranscript = () => {
    const transcript = parseTranscript(meeting?.transcript ?? null)
    if (!transcript) return
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(transcript.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleAttachToProject = async (projectId: string) => {
    if (!meeting) return
    try {
      const http = createHttpClient()
      await http.post(`/api/local/meetings/${id}/attach`, { projectId })
      fetchMeeting()
    } catch (err) {
      console.error('Failed to attach to project:', err)
    }
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  if (!meeting) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">Meeting not found</Text>
      </View>
    )
  }

  const transcript = parseTranscript(meeting.transcript)
  const meetingDate = new Date(meeting.createdAt)

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 py-3 border-b border-border">
        <View className="flex-row items-center gap-3 mb-2">
          <Pressable
            onPress={() => router.back()}
            className="p-1.5 -ml-1.5 rounded-md active:bg-muted"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>

          {editingTitle ? (
            <TextInput
              value={titleDraft}
              onChangeText={setTitleDraft}
              onBlur={handleSaveTitle}
              onSubmitEditing={handleSaveTitle}
              autoFocus
              className="flex-1 text-lg font-semibold text-foreground border-b border-primary pb-0.5"
            />
          ) : (
            <Pressable
              onPress={() => {
                setTitleDraft(meeting.title || '')
                setEditingTitle(true)
              }}
              className="flex-1"
            >
              <Text className="text-lg font-semibold text-foreground" numberOfLines={1}>
                {meeting.title || 'Untitled Meeting'}
              </Text>
            </Pressable>
          )}
        </View>

        <View className="flex-row items-center gap-3 ml-8">
          <View className="flex-row items-center gap-1">
            <Clock size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {meeting.duration != null ? formatDuration(meeting.duration) : '--:--'}
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {meetingDate.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </Text>
          {meeting.project && (
            <View className="flex-row items-center gap-1 bg-primary/10 rounded px-1.5 py-0.5">
              <Text className="text-xs text-primary font-medium">{meeting.project.name}</Text>
            </View>
          )}
        </View>

        {/* Actions */}
        <View className="flex-row items-center gap-2 mt-3 ml-8">
          <Pressable
            onPress={handleCopyTranscript}
            disabled={!transcript}
            className={cn(
              'flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-border',
              !transcript ? 'opacity-40' : 'active:bg-muted'
            )}
          >
            {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-muted-foreground" />}
            <Text className="text-xs text-muted-foreground">{copied ? 'Copied' : 'Copy'}</Text>
          </Pressable>

          <Pressable
            onPress={handleRetranscribe}
            disabled={retranscribing || meeting.status === 'transcribing'}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-border active:bg-muted"
          >
            <RefreshCw size={14} className={cn('text-muted-foreground', retranscribing && 'animate-spin')} />
            <Text className="text-xs text-muted-foreground">Re-transcribe</Text>
          </Pressable>

          <Pressable
            onPress={handleDelete}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 active:bg-red-50"
          >
            <Trash2 size={14} className="text-red-500" />
            <Text className="text-xs text-red-500">Delete</Text>
          </Pressable>
        </View>
      </View>

      {/* Transcript */}
      <ScrollView className="flex-1 px-4 py-4">
        {meeting.status === 'transcribing' ? (
          <View className="items-center justify-center py-16">
            <ActivityIndicator size="large" className="mb-4" />
            <Text className="text-sm text-muted-foreground">Transcribing...</Text>
            <Text className="text-xs text-muted-foreground mt-1">This may take a few minutes</Text>
          </View>
        ) : meeting.status === 'error' ? (
          <View className="items-center justify-center py-16">
            <Text className="text-sm text-red-500 mb-2">Transcription failed</Text>
            <Pressable
              onPress={handleRetranscribe}
              className="px-4 py-2 bg-primary rounded-lg active:opacity-80"
            >
              <Text className="text-sm text-white font-medium">Try Again</Text>
            </Pressable>
          </View>
        ) : transcript ? (
          <View>
            {transcript.segments.length > 0 ? (
              transcript.segments.map((segment, index) => (
                <View key={index} className="flex-row gap-3 mb-3">
                  <Text className="text-xs text-muted-foreground font-mono w-12 pt-0.5 text-right">
                    {formatTimestamp(segment.start)}
                  </Text>
                  <Text className="flex-1 text-sm text-foreground leading-relaxed">
                    {segment.text}
                  </Text>
                </View>
              ))
            ) : (
              <Text className="text-sm text-foreground leading-relaxed">
                {transcript.text}
              </Text>
            )}
          </View>
        ) : (
          <View className="items-center justify-center py-16">
            <Text className="text-sm text-muted-foreground">No transcript available</Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
