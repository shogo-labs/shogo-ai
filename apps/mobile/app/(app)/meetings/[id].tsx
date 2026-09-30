// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, Modal } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import {
  ArrowLeft,
  Clock,
  Trash2,
  RefreshCw,
  Copy,
  Check,
  Users,
  Sparkles,
  Link2,
  LayoutTemplate,
  Square,
  CheckSquare,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { createHttpClient } from '../../../lib/api'
import { formatDuration } from '../../../lib/format-duration'
import { usePlatformConfig } from '../../../lib/platform-config'
import {
  isMeetingInFlight,
  meetingShareUrl,
  meetingsApi,
  notifyMeetingsChanged,
  usePersonalMeetingsWorkspaceId,
  type MeetingActionItem,
  type MeetingDetail,
  type MeetingTemplate,
} from '../../../lib/meetings-api'
import { notesForClipboard, parseTranscript, stripActionItemsSection } from '../../../lib/meeting-notes'
import { MarkdownText } from '../../../components/chat/MarkdownText'
import { MeetingTranscript } from '../../../components/meetings/MeetingTranscript'

type Tab = 'notes' | 'mine' | 'transcript'

function ActionButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  tone = 'default',
}: {
  icon: typeof Copy
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'default' | 'danger' | 'primary'
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      className={cn(
        'min-h-10 flex-row items-center gap-1.5 rounded-xl border px-3',
        tone === 'danger' ? 'border-red-200 active:bg-red-50' : 'border-border/70 active:bg-muted/70',
        tone === 'primary' && 'border-orange-500/40 bg-orange-500/10',
        disabled && 'opacity-40',
      )}
    >
      <Icon
        size={14}
        className={tone === 'danger' ? 'text-red-500' : tone === 'primary' ? 'text-orange-600' : 'text-muted-foreground'}
      />
      <Text
        className={cn(
          'text-xs',
          tone === 'danger' ? 'text-red-500' : tone === 'primary' ? 'text-orange-700 dark:text-orange-300' : 'text-muted-foreground',
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export default function MeetingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const workspaceId = usePersonalMeetingsWorkspaceId()
  const { localMode } = usePlatformConfig()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('notes')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const [copied, setCopied] = useState<'notes' | 'link' | null>(null)
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const initialTabChosen = useRef(false)

  const api = workspaceId ? meetingsApi(workspaceId) : null

  const fetchMeeting = useCallback(async () => {
    if (!workspaceId) return
    try {
      const next = await meetingsApi(workspaceId).get(id)
      setMeeting(next)
      if (!initialTabChosen.current) {
        initialTabChosen.current = true
        if (!next.enhancedNotes && next.enhanceStatus !== 'running') setTab(next.notes ? 'mine' : 'transcript')
      }
    } catch (err) {
      console.error('Failed to fetch meeting:', err)
    } finally {
      setLoading(false)
    }
  }, [id, workspaceId])

  useEffect(() => {
    fetchMeeting()
  }, [fetchMeeting])

  useEffect(() => {
    if (!workspaceId) return
    meetingsApi(workspaceId).templates().then(setTemplates).catch(() => {})
  }, [workspaceId])

  const inFlight = isMeetingInFlight(meeting)
  useEffect(() => {
    if (!inFlight) return
    const interval = setInterval(fetchMeeting, 3000)
    return () => clearInterval(interval)
  }, [inFlight, fetchMeeting])

  const flashCopied = (what: 'notes' | 'link') => {
    setCopied(what)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleSaveTitle = async () => {
    if (!api || !meeting || !titleDraft.trim()) return setEditingTitle(false)
    const updated = await api.update(meeting.id, { title: titleDraft.trim() }).catch(() => null)
    if (updated) setMeeting(updated)
    setEditingTitle(false)
  }

  const saveNotes = async () => {
    if (!api || !meeting || notesDraft === null || notesDraft === (meeting.notes ?? '')) return
    const updated = await api.update(meeting.id, { notes: notesDraft }).catch(() => null)
    if (updated) setMeeting(updated)
  }

  const enhance = async (templateId?: string) => {
    if (!api || !meeting) return
    setShowTemplates(false)
    setActionError(null)
    await saveNotes()
    try {
      await api.enhance(meeting.id, templateId)
      setMeeting({ ...meeting, enhanceStatus: 'running', templateId: templateId ?? meeting.templateId })
      setTab('notes')
    } catch (err: any) {
      setActionError(err?.message || 'Could not regenerate notes')
    }
  }

  const toggleActionItem = async (index: number) => {
    if (!api || !meeting) return
    const actionItems: MeetingActionItem[] = meeting.actionItems.map((item, i) =>
      i === index ? { ...item, done: !item.done } : item,
    )
    setMeeting({ ...meeting, actionItems })
    await api.update(meeting.id, { actionItems }).catch(() => fetchMeeting())
  }

  const copyNotes = async () => {
    if (!meeting) return
    await Clipboard.setStringAsync(notesForClipboard(meeting))
    flashCopied('notes')
  }

  const share = async () => {
    if (!api || !meeting) return
    setActionError(null)
    try {
      const token = meeting.shareToken ?? (await api.share(meeting.id))
      setMeeting({ ...meeting, shareToken: token })
      await Clipboard.setStringAsync(meetingShareUrl(token))
      flashCopied('link')
    } catch (err: any) {
      setActionError(err?.message || 'Could not create a share link')
    }
  }

  const stopSharing = async () => {
    if (!api || !meeting) return
    await api.unshare(meeting.id).catch(() => {})
    setMeeting({ ...meeting, shareToken: null })
  }

  const retranscribe = async () => {
    if (!meeting) return
    await createHttpClient().post(`/api/local/meetings/${meeting.id}/transcribe`, {}).catch(() => {})
    setMeeting({ ...meeting, status: 'transcribing' })
  }

  const confirmDelete = async () => {
    setShowDeleteConfirm(false)
    if (!api || !meeting) return
    await api.remove(meeting.id).catch((err) => console.error('Failed to delete meeting:', err))
    setMeeting(null)
    notifyMeetingsChanged()
    backToMeetings()
  }

  // Opened from a link or after a reload there is no in-app history to pop.
  const backToMeetings = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/meetings' as any)
  }

  if (loading || !workspaceId) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color="#f97316" />
      </SafeAreaView>
    )
  }

  if (!meeting) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground">Meeting not found</Text>
      </SafeAreaView>
    )
  }

  const transcript = parseTranscript(meeting.transcript)
  const meetingDate = new Date(meeting.createdAt)
  const templateName = templates.find((t) => t.id === (meeting.templateId ?? 'builtin:general'))?.name ?? 'General'
  const notesBody = meeting.enhancedNotes ? stripActionItemsSection(meeting.enhancedNotes) : ''
  const busy = meeting.status === 'recording' || meeting.status === 'transcribing'

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'left', 'right']}>
      <View className="border-b border-border/70 bg-card/70 px-4 pb-3 pt-3">
        <View className="flex-row items-center gap-3 mb-2">
          <Pressable
            onPress={backToMeetings}
            accessibilityLabel="Back to meetings"
            className="-ml-1.5 rounded-xl p-2 active:bg-muted"
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
              className="flex-1 border-b border-orange-500 pb-0.5 text-lg font-semibold text-foreground"
            />
          ) : (
            <Pressable
              onPress={() => {
                setTitleDraft(meeting.title || '')
                setEditingTitle(true)
              }}
              className="flex-1"
            >
              <Text className="text-xl font-semibold tracking-[-0.25px] text-foreground" numberOfLines={1}>
                {meeting.title || 'Untitled Meeting'}
              </Text>
            </Pressable>
          )}
        </View>

        <View className="flex-row flex-wrap items-center gap-3 ml-8">
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
          {!!transcript?.numSpeakers && (
            <View className="flex-row items-center gap-1 bg-purple-500/10 rounded px-1.5 py-0.5">
              <Users size={10} className="text-purple-600" />
              <Text className="text-xs text-purple-600 font-medium">
                {transcript.numSpeakers} speaker{transcript.numSpeakers !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>

        <View className="ml-8 mt-3 flex-row flex-wrap items-center gap-2">
          <ActionButton
            icon={LayoutTemplate}
            label={templateName}
            onPress={() => setShowTemplates(true)}
            disabled={busy}
          />
          <ActionButton
            icon={Sparkles}
            label={meeting.enhanceStatus === 'running' ? 'Writing…' : meeting.enhancedNotes ? 'Regenerate' : 'Write notes'}
            onPress={() => enhance()}
            disabled={busy || meeting.enhanceStatus === 'running'}
            tone="primary"
          />
          <ActionButton
            icon={copied === 'notes' ? Check : Copy}
            label={copied === 'notes' ? 'Copied' : 'Copy notes'}
            onPress={copyNotes}
            disabled={!meeting.enhancedNotes && !meeting.notes}
          />
          {!localMode && (
            <ActionButton
              icon={copied === 'link' ? Check : Link2}
              label={copied === 'link' ? 'Link copied' : meeting.shareToken ? 'Copy link' : 'Share'}
              onPress={share}
              disabled={!meeting.enhancedNotes}
            />
          )}
          {!localMode && meeting.shareToken && (
            <ActionButton icon={Link2} label="Stop sharing" onPress={stopSharing} />
          )}
          {localMode && meeting.hasAudio && (
            <ActionButton icon={RefreshCw} label="Re-transcribe" onPress={retranscribe} disabled={busy} />
          )}
          <ActionButton icon={Trash2} label="Delete" onPress={() => setShowDeleteConfirm(true)} tone="danger" />
        </View>

        {!!actionError && <Text className="ml-8 mt-2 text-xs text-red-600">{actionError}</Text>}

        <View className="ml-8 mt-4 flex-row gap-1 self-start rounded-xl bg-muted/60 p-1">
          {(
            [
              ['notes', 'Notes'],
              ['mine', 'My notes'],
              ['transcript', 'Transcript'],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              accessibilityRole="tab"
              aria-selected={tab === key}
              className={cn('rounded-lg border px-3 py-1.5', tab === key ? 'border-border/70 bg-card' : 'border-transparent')}
            >
              <Text className={cn('text-xs font-medium', tab === key ? 'text-foreground' : 'text-muted-foreground')}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
        {tab === 'notes' && (
          <View className="gap-4">
            {meeting.enhanceStatus === 'error' && meeting.enhancedNotes && (
              <View className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5">
                <Text className="text-xs leading-5 text-red-700 dark:text-red-300">
                  Couldn&apos;t regenerate notes. {meeting.enhanceError || 'Try again.'} Your previous notes are still shown.
                </Text>
              </View>
            )}
            {busy ? (
              <View className="items-center justify-center rounded-2xl border border-border/70 bg-card py-16">
                <ActivityIndicator size="large" color="#f97316" className="mb-4" />
                <Text className="text-sm text-muted-foreground">
                  {meeting.status === 'recording' ? 'Recording in progress' : 'Transcribing…'}
                </Text>
                <Text className="text-xs text-muted-foreground mt-1">Notes are written once the transcript is ready</Text>
              </View>
            ) : meeting.enhanceStatus === 'running' && !meeting.enhancedNotes ? (
              <View className="items-center justify-center rounded-2xl border border-border/70 bg-card py-16">
                <ActivityIndicator size="large" color="#f97316" className="mb-4" />
                <Text className="text-sm text-muted-foreground">Writing your notes…</Text>
              </View>
            ) : meeting.enhancedNotes ? (
              <>
                <View className="rounded-2xl border border-border/70 bg-card p-4">
                  <MarkdownText>{notesBody}</MarkdownText>
                </View>
                {meeting.actionItems.length > 0 && (
                  <View className="rounded-2xl border border-border/70 bg-card p-4">
                    <Text className="mb-3 text-[11px] font-semibold uppercase tracking-[1.2px] text-orange-600 dark:text-orange-300">
                      Action items
                    </Text>
                    {meeting.actionItems.map((item, index) => (
                      <Pressable
                        key={index}
                        onPress={() => toggleActionItem(index)}
                        accessibilityRole="checkbox"
                        aria-checked={item.done}
                        className="mb-2 flex-row items-start gap-2.5"
                      >
                        {item.done ? (
                          <CheckSquare size={16} className="mt-0.5 text-green-600" />
                        ) : (
                          <Square size={16} className="mt-0.5 text-muted-foreground" />
                        )}
                        <Text
                          className={cn(
                            'flex-1 text-sm leading-5',
                            item.done ? 'text-muted-foreground line-through' : 'text-foreground',
                          )}
                        >
                          {item.text}
                          {item.owner ? <Text className="text-muted-foreground"> — {item.owner}</Text> : null}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <View className="items-center justify-center rounded-2xl border border-border/70 bg-card px-6 py-16">
                <Text className="text-sm text-muted-foreground text-center">
                  {meeting.enhanceStatus === 'error'
                    ? `Couldn't write notes. ${meeting.enhanceError || 'Try again.'}`
                    : meeting.enhanceStatus === 'skipped'
                      ? 'Nothing to write up yet. Add notes or a transcript.'
                      : 'No notes yet.'}
                </Text>
                <Pressable
                  onPress={() => enhance()}
                  className="mt-4 rounded-xl bg-orange-500 px-4 py-2.5 active:bg-orange-600"
                >
                  <Text className="text-sm text-white font-medium">Write notes</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {tab === 'mine' && (
          <View className="rounded-2xl border border-border/70 bg-card p-4">
            <Text className="mb-2 text-xs text-muted-foreground">
              Your rough notes steer the write-up. Edit them, then regenerate.
            </Text>
            <TextInput
              value={notesDraft ?? meeting.notes ?? ''}
              onChangeText={setNotesDraft}
              onBlur={saveNotes}
              multiline
              placeholder="Nothing typed during this meeting."
              placeholderTextColor="#9ca3af"
              textAlignVertical="top"
              className="min-h-[200px] text-sm leading-6 text-foreground"
              accessibilityLabel="My notes"
            />
          </View>
        )}

        {tab === 'transcript' && (
          <View className="min-h-[180px] rounded-2xl border border-border/70 bg-card p-4">
            {meeting.status === 'transcribing' ? (
              <View className="items-center justify-center py-16">
                <ActivityIndicator size="large" color="#f97316" className="mb-4" />
                <Text className="text-sm text-muted-foreground">Transcribing...</Text>
                <Text className="text-xs text-muted-foreground mt-1">This may take a few minutes</Text>
              </View>
            ) : meeting.status === 'error' ? (
              <View className="items-center justify-center py-16">
                <Text className="text-sm text-red-500 mb-2">Transcription failed</Text>
                {transcript?.error && (
                  <Text className="text-xs text-muted-foreground mb-4 text-center px-8">{transcript.error}</Text>
                )}
                {localMode && meeting.hasAudio && (
                  <Pressable onPress={retranscribe} className="rounded-xl bg-orange-500 px-4 py-2.5 active:bg-orange-600">
                    <Text className="text-sm text-white font-medium">Try Again</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <MeetingTranscript transcript={transcript} live={meeting.status === 'recording'} />
            )}
          </View>
        )}
      </ScrollView>

      <Modal visible={showTemplates} transparent animationType="fade" onRequestClose={() => setShowTemplates(false)}>
        <Pressable className="flex-1 bg-black/50 items-center justify-center" onPress={() => setShowTemplates(false)}>
          <Pressable
            className="bg-card rounded-xl p-4 w-[340px] max-w-[92%] border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <Text className="mb-1 text-base font-semibold text-foreground">Note template</Text>
            <Text className="mb-3 text-xs text-muted-foreground">Rewrites the notes with this structure.</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {templates.map((template) => {
                const selected = template.id === (meeting.templateId ?? 'builtin:general')
                return (
                  <Pressable
                    key={template.id}
                    onPress={() => enhance(template.id)}
                    className={cn(
                      'mb-1.5 rounded-lg border px-3 py-2.5 active:bg-muted',
                      selected ? 'border-orange-500/60 bg-orange-500/5' : 'border-border/70',
                    )}
                  >
                    <Text className="text-sm font-medium text-foreground">{template.name}</Text>
                    {!!template.description && (
                      <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={2}>
                        {template.description}
                      </Text>
                    )}
                  </Pressable>
                )
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showDeleteConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeleteConfirm(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setShowDeleteConfirm(false)}
        >
          <Pressable className="bg-card rounded-xl p-6 w-80 border border-border" onPress={(e) => e.stopPropagation()}>
            <View className="flex-row items-center gap-3 mb-3">
              <View className="w-10 h-10 rounded-full bg-destructive/10 items-center justify-center">
                <Trash2 size={20} className="text-destructive" />
              </View>
              <Text className="text-base font-semibold text-foreground">Delete meeting</Text>
            </View>
            <Text className="text-sm text-muted-foreground mb-5">
              This permanently deletes the recording, transcript and notes, and turns off any share link.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable onPress={confirmDelete} className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80">
                <Text className="text-sm text-white font-medium">Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  )
}
