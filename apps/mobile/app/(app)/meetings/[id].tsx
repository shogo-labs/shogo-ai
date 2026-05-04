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
  Users,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { createHttpClient } from '../../../lib/api'
import { formatDuration } from '../../../lib/use-recording'

interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

interface MeetingDetail {
  id: string
  title: string | null
  audioPath: string
  transcript: string | object | null
  summary: string | null
  duration: number | null
  status: string
  projectId: string | null
  workspaceId: string
  createdAt: string
  updatedAt: string
  project: { id: string; name: string } | null
}

const SPEAKER_COLORS = [
  { bg: 'bg-blue-500/10', border: 'border-l-blue-500', text: 'text-blue-600', label: 'bg-blue-500/15' },
  { bg: 'bg-emerald-500/10', border: 'border-l-emerald-500', text: 'text-emerald-600', label: 'bg-emerald-500/15' },
  { bg: 'bg-purple-500/10', border: 'border-l-purple-500', text: 'text-purple-600', label: 'bg-purple-500/15' },
  { bg: 'bg-orange-500/10', border: 'border-l-orange-500', text: 'text-orange-600', label: 'bg-orange-500/15' },
  { bg: 'bg-pink-500/10', border: 'border-l-pink-500', text: 'text-pink-600', label: 'bg-pink-500/15' },
  { bg: 'bg-cyan-500/10', border: 'border-l-cyan-500', text: 'text-cyan-600', label: 'bg-cyan-500/15' },
  { bg: 'bg-amber-500/10', border: 'border-l-amber-500', text: 'text-amber-600', label: 'bg-amber-500/15' },
  { bg: 'bg-rose-500/10', border: 'border-l-rose-500', text: 'text-rose-600', label: 'bg-rose-500/15' },
]

function getSpeakerColor(speaker: string, speakerMap: Map<string, number>) {
  if (!speakerMap.has(speaker)) {
    speakerMap.set(speaker, speakerMap.size)
  }
  return SPEAKER_COLORS[speakerMap.get(speaker)! % SPEAKER_COLORS.length]
}

function parseTranscript(raw: string | object | null): { text: string; segments: TranscriptSegment[]; numSpeakers?: number; error?: string } | null {
  if (!raw) return null
  if (typeof raw === 'object') {
    const obj = raw as any
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      segments: Array.isArray(obj.segments) ? obj.segments : [],
      numSpeakers: obj.numSpeakers,
      error: typeof obj.error === 'string' ? obj.error : undefined,
    }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { text: String(raw), segments: [] }
  }
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Groups consecutive segments by the same speaker for a cleaner display.
 */
function groupSegmentsBySpeaker(segments: TranscriptSegment[]): {
  speaker: string | undefined
  start: number
  end: number
  lines: string[]
}[] {
  const groups: { speaker: string | undefined; start: number; end: number; lines: string[] }[] = []

  for (const seg of segments) {
    const lastGroup = groups[groups.length - 1]
    if (lastGroup && lastGroup.speaker === seg.speaker && seg.speaker) {
      lastGroup.end = seg.end
      lastGroup.lines.push(seg.text)
    } else {
      groups.push({
        speaker: seg.speaker,
        start: seg.start,
        end: seg.end,
        lines: [seg.text],
      })
    }
  }

  return groups
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
  const hasSpeakers = transcript?.segments.some((s) => s.speaker)

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
          {hasSpeakers && transcript?.numSpeakers && (
            <View className="flex-row items-center gap-1 bg-purple-500/10 rounded px-1.5 py-0.5">
              <Users size={10} className="text-purple-600" />
              <Text className="text-xs text-purple-600 font-medium">
                {transcript.numSpeakers} speaker{transcript.numSpeakers !== 1 ? 's' : ''}
              </Text>
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
            {transcript?.error && (
              <Text className="text-xs text-muted-foreground mb-4 text-center px-8">{transcript.error}</Text>
            )}
            <Pressable
              onPress={handleRetranscribe}
              className="px-4 py-2 bg-primary rounded-lg active:opacity-80"
            >
              <Text className="text-sm text-white font-medium">Try Again</Text>
            </Pressable>
          </View>
        ) : transcript ? (
          <View>
            {transcript.error && transcript.segments.length === 0 && (
              <View className="bg-amber-500/10 rounded-lg p-3 mb-4 flex-row items-center gap-2">
                <Text className="text-xs text-amber-700">{transcript.error}</Text>
              </View>
            )}
            {hasSpeakers ? (
              <SpeakerTranscriptView segments={transcript.segments} />
            ) : transcript.segments.length > 0 ? (
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
            ) : transcript.text ? (
              <Text className="text-sm text-foreground leading-relaxed">
                {transcript.text}
              </Text>
            ) : (
              <View className="items-center justify-center py-16">
                <Text className="text-sm text-muted-foreground">No transcript available</Text>
              </View>
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

function SpeakerTranscriptView({ segments }: { segments: TranscriptSegment[] }) {
  const groups = groupSegmentsBySpeaker(segments)
  const speakerMap = new Map<string, number>()

  return (
    <View className="gap-4">
      {groups.map((group, index) => {
        const color = group.speaker
          ? getSpeakerColor(group.speaker, speakerMap)
          : null

        if (!color) {
          return (
            <View key={index} className="flex-row gap-3">
              <Text className="text-xs text-muted-foreground font-mono w-12 pt-0.5 text-right">
                {formatTimestamp(group.start)}
              </Text>
              <Text className="flex-1 text-sm text-foreground leading-relaxed">
                {group.lines.join(' ')}
              </Text>
            </View>
          )
        }

        return (
          <View
            key={index}
            className={cn('rounded-lg border-l-[3px] pl-3 py-2 pr-2', color.bg, color.border)}
          >
            <View className="flex-row items-center gap-2 mb-1">
              <View className={cn('rounded px-1.5 py-0.5', color.label)}>
                <Text className={cn('text-[10px] font-semibold uppercase', color.text)}>
                  {group.speaker}
                </Text>
              </View>
              <Text className="text-[10px] text-muted-foreground font-mono">
                {formatTimestamp(group.start)}
              </Text>
            </View>
            <Text className="text-sm text-foreground leading-relaxed">
              {group.lines.join(' ')}
            </Text>
          </View>
        )
      })}
    </View>
  )
}
