// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One huddle's notes: the summary the meeting pipeline wrote when the call
 * ended, plus the speaker-labelled transcript every participant's own device
 * contributed to. Readable by anyone who was in the call or can read its
 * conversation; deleting them is for the starter or a workspace admin.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AlertTriangle, ArrowLeft, CheckSquare, NotebookPen, Square, Trash2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { MarkdownText } from '../../../../components/chat/MarkdownText'
import { MeetingTranscript } from '../../../../components/meetings/MeetingTranscript'
import { formatDuration } from '../../../../lib/format-duration'
import { teamChatApi, type HuddleNotesDetail } from '../../../../lib/team-chat-api'

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export default function HuddleNotesScreen() {
  const { huddleId } = useLocalSearchParams<{ huddleId: string }>()
  const router = useRouter()
  const [notes, setNotes] = useState<HuddleNotesDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!huddleId) return
    setLoading(true)
    try {
      setNotes(await teamChatApi().huddleNotes(huddleId))
      setError(null)
    } catch (err) {
      setError(errorText(err, 'Could not open these notes'))
    } finally {
      setLoading(false)
    }
  }, [huddleId])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async () => {
    if (!huddleId) return
    setDeleting(true)
    try {
      await teamChatApi().deleteHuddleNotes(huddleId)
      router.back()
    } catch (err) {
      setError(errorText(err, 'Could not delete these notes'))
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const summary = notes?.meeting.enhancedNotes?.trim() ?? ''
  const failed = !!notes && notes.meeting.enhanceStatus !== 'ready'

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="h-9 w-9 items-center justify-center rounded-md active:bg-muted">
          <ArrowLeft size={18} className="text-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {notes?.meeting.title || 'Huddle notes'}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {notes?.meeting.duration ? `${formatDuration(notes.meeting.duration)} · ` : ''}
            {notes?.transcript.segments.length ?? 0} lines
          </Text>
        </View>
        {notes ? (
          <Pressable
            onPress={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            disabled={deleting}
            accessibilityRole="button"
            accessibilityLabel={confirmDelete ? 'Delete these notes for good' : 'Delete these notes'}
            className={cn('h-9 flex-row items-center gap-1 rounded-md px-2 active:bg-muted', confirmDelete && 'bg-destructive/10')}
          >
            {deleting ? <ActivityIndicator size="small" /> : <Trash2 size={16} className={confirmDelete ? 'text-destructive' : 'text-muted-foreground'} />}
            {confirmDelete ? <Text className="text-xs font-medium text-destructive">Delete?</Text> : null}
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center gap-2 px-6">
          <AlertTriangle size={20} className="text-amber-500" />
          <Text className="text-center text-sm text-muted-foreground">{error}</Text>
        </View>
      ) : notes ? (
        <ScrollView contentContainerClassName="gap-4 px-4 py-4 pb-12">
          <View className="flex-row items-center gap-1.5">
            <NotebookPen size={13} className="text-emerald-600" />
            <Text className="text-[11px] uppercase tracking-wide text-muted-foreground">Auto summary</Text>
          </View>
          {failed ? (
            <Text className="text-sm text-amber-600">
              The transcript is saved, but the summary could not be written{notes.meeting.enhanceError ? `: ${String(notes.meeting.enhanceError)}` : '.'}
            </Text>
          ) : summary ? (
            <MarkdownText>{summary}</MarkdownText>
          ) : (
            <Text className="text-sm text-muted-foreground">No summary was written for this call.</Text>
          )}

          {notes.actionItems.length ? (
            <View className="gap-2">
              <Text className="text-[11px] uppercase tracking-wide text-muted-foreground">Action items</Text>
              {notes.actionItems.map((item, i) => (
                <View key={i} className="flex-row items-start gap-2">
                  {item.done ? <CheckSquare size={14} className="mt-0.5 text-emerald-600" /> : <Square size={14} className="mt-0.5 text-muted-foreground" />}
                  <Text className="flex-1 text-sm text-foreground">
                    {item.text}
                    {item.owner ? <Text className="text-muted-foreground"> — {item.owner}</Text> : null}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View className="gap-2">
            <Text className="text-[11px] uppercase tracking-wide text-muted-foreground">Transcript</Text>
            <MeetingTranscript transcript={notes.transcript} />
          </View>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  )
}
