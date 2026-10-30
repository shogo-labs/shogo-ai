// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat composer: the shared `ChatInput` with messaging behavior on top —
 * @-mentions for teammates and agents (sent as wire tokens), `:shortcode`
 * emoji, typing signals, drafts synced across devices, "also send to
 * channel" for thread replies, send later, `/remind`, and file uploads.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Image, Platform, Pressable, Text, View } from 'react-native'
import { AlarmClock, AudioLines, Check, Clock, Hash, Smile, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  ChatInput,
  type ChatInputHandle,
  type ChatReference,
  type ComposerCompletionSource,
  type FileAttachment,
  type RestoreDraftRequest,
} from '../chat/ChatInput'
import { ComposerPlusSection } from '../chat/ComposerPlusMenu'
import { useComposerLayoutMode } from '../chat/composer'
import { nativePhoneComposerRestPad } from '../../lib/native-phone-layout'
import { usePhoneChromeOverlay } from '../layout/PhoneChromeOverlay'
import { PHONE_DENSITY } from '../../lib/phone-density'
import type { Mentionables } from '../../lib/team-chat-api'
import { teamChatApi } from '../../lib/team-chat-api'
import { sendTyping } from '../../lib/team-chat-connection'
import { bytesPart, localFilePart, type UploadPart } from '../../lib/upload-part'
import { useVoiceNoteRecorder } from '../../lib/use-voice-note'
import { RecordingBar } from './RecordingBar'
import {
  activeChannelQuery,
  activeMentionQuery,
  channelCandidates,
  decodeMentions,
  encodeMentions,
  filterCandidates,
  isRemindCommand,
  mentionCandidates,
  scheduleOptions,
  type ChannelCandidateSource,
  type MentionCandidate,
} from '../../lib/team-chat-state'
import type { SendInput } from '../../hooks/useTeamChat'
import { resolveLinkPreviewOptOuts } from '../../lib/link-preview-consent'
import { useDraft } from '../../hooks/useChatItems'
import { useCustomEmoji } from '../../hooks/useCustomEmoji'
import { activeEmojiQuery, replaceFinishedShortcode, searchEmoji } from '../../lib/emoji-data'
import { AgentAvatar } from './AgentAvatar'
import { PresenceDot } from './PresenceDot'
import { EmojiPicker, rememberEmoji } from './EmojiPicker'

const api = teamChatApi()
const MAX_FILE_BYTES = 50 * 1024 * 1024

export interface ComposerProps {
  workspaceId: string
  conversationId: string
  threadRootId?: string | null
  placeholder: string
  mentionables: Mentionables | null
  me: string | null
  disabled?: boolean
  disabledReason?: string
  onSend: (input: SendInput) => Promise<void> | void
  /** ↑ in an empty composer; return true if a message was opened for editing. */
  onEditLast?: () => boolean
  /** This conversation's members, for a channel only: flags @-mention candidates who aren't in it. */
  channelMemberIds?: Set<string> | null
  /** Channels this reader can see, for typing `#` to reference one. */
  channels?: ChannelCandidateSource[] | null
}

export interface ComposerHandle {
  /** Stage files dropped elsewhere on the pane. */
  addFiles: (files: File[]) => void
  /** Put the caret in the message box, e.g. when a channel opens. */
  focus: () => void
}

function mentionReference(c: MentionCandidate): ChatReference {
  const label = c.kind === 'channel' ? `#${c.display}` : `@${c.display}`
  return { type: 'mention', id: c.token, name: c.display, label }
}

function MentionIcon({ candidate, workspaceId }: { candidate: MentionCandidate; workspaceId: string }) {
  if (candidate.kind === 'agent') return <AgentAvatar name={candidate.display} projectId={candidate.projectId ?? null} workspaceId={workspaceId} size={20} />
  if (candidate.kind === 'user') return <PresenceDot userId={candidate.userId} />
  if (candidate.kind === 'channel') return <Hash size={14} className="text-muted-foreground" />
  return <Users size={14} className="text-muted-foreground" />
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { workspaceId, conversationId, threadRootId = null, mentionables, me, onSend, onEditLast } = props
  const inputRef = useRef<ChatInputHandle>(null)
  const phoneLayout = useComposerLayoutMode({ prominent: true }).useProminentComposer
  const chrome = usePhoneChromeOverlay()
  const [text, setText] = useState('')
  const textRef = useRef('')
  const [alsoToChannel, setAlsoToChannel] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [laterOpen, setLaterOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [restore, setRestore] = useState<(RestoreDraftRequest & { draftKey: string }) | null>(null)
  const sendAtRef = useRef<Date | null>(null)
  const customEmoji = useCustomEmoji(workspaceId)

  const candidates = useMemo(
    () => mentionCandidates(mentionables, me, props.channelMemberIds),
    [mentionables, me, props.channelMemberIds],
  )
  /** `#` references: only channels this reader can see, never the one they're in. */
  const channelChoices = useMemo(
    () => channelCandidates(props.channels, conversationId),
    [props.channels, conversationId],
  )
  // Draft restore re-encodes whatever tokens it decoded, so both kinds resolve here.
  const byAnyToken = useMemo(
    () => new Map([...candidates, ...channelChoices].map((c) => [c.token, c])),
    [candidates, channelChoices],
  )
  const picksFrom = useCallback(
    (refs: ChatReference[] | undefined) =>
      (refs ?? []).flatMap((r) => (r.type === 'mention' && byAnyToken.has(r.id) ? [byAnyToken.get(r.id)!] : [])),
    [byAnyToken],
  )

  const completions = useMemo<ComposerCompletionSource[]>(
    () => [
      {
        id: 'mentions',
        detect: activeMentionQuery,
        items: (query) =>
          filterCandidates(candidates, query).map((c) => ({
            key: c.token,
            label: c.display,
            subtitle: c.subtitle,
            trailing: c.kind === 'user' && c.inChannel === false ? 'Not in channel' : undefined,
            icon: <MentionIcon candidate={c} workspaceId={workspaceId} />,
            insert: `@${c.display}`,
            reference: mentionReference(c),
          })),
      },
      {
        id: 'channels',
        detect: activeChannelQuery,
        items: (query) =>
          filterCandidates(channelChoices, query).map((c) => ({
            key: c.token,
            label: c.display,
            subtitle: c.subtitle,
            icon: <MentionIcon candidate={c} workspaceId={workspaceId} />,
            insert: `#${c.display}`,
            reference: mentionReference(c),
          })),
      },
      {
        id: 'emoji',
        detect: activeEmojiQuery,
        items: (query) => {
          const q = query.toLowerCase()
          const custom = [...customEmoji.values()]
            .filter((e) => e.name.toLowerCase().includes(q))
            .map((e) => ({ code: `:${e.name}:`, label: `:${e.name}:`, imageUrl: e.url as string | undefined }))
          const standard = searchEmoji(q, 8).map((e) => ({ code: e.emoji, label: `:${e.slug}:`, imageUrl: undefined }))
          return [...custom, ...standard].slice(0, 8).map((s) => ({
            key: s.code,
            label: s.label,
            icon: s.imageUrl ? (
              <Image source={{ uri: s.imageUrl }} style={{ width: 18, height: 18 }} />
            ) : (
              <Text className="text-base">{s.code}</Text>
            ),
            insert: s.code,
            onSelect: () => rememberEmoji(s.code),
          }))
        },
      },
    ],
    [candidates, customEmoji, channelChoices, workspaceId],
  )

  const draft = useDraft(conversationId, threadRootId)
  const saveDraft = draft.save
  const draftKey = `${conversationId}:${threadRootId ?? ''}`
  const restoredFor = useRef<string | null>(null)
  // Load the draft when switching conversations, or when a synced draft arrives into an empty box.
  useEffect(() => {
    const switched = restoredFor.current !== draftKey
    restoredFor.current = draftKey
    if (switched) {
      textRef.current = ''
      setText('')
    } else if (textRef.current) {
      return
    }
    const { text: restored, picked } = decodeMentions(draft.stored, candidates)
    if (!restored || restored === textRef.current) return
    textRef.current = restored
    setText(restored)
    setRestore({ draftKey, nonce: Date.now(), content: restored, references: picked.map(mentionReference), focus: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, draft.stored, candidates.length])

  const onTextChange = useCallback(
    (next: string, refs: ChatReference[]) => {
      textRef.current = next
      setText(next)
      saveDraft(next.trim() ? encodeMentions(next, picksFrom(refs)) : '')
      setNotice(null)
      if (next.trim()) sendTyping(workspaceId, conversationId, threadRootId)
    },
    [saveDraft, picksFrom, workspaceId, conversationId, threadRootId],
  )

  const onSubmit = useCallback(
    (content: string, files?: FileAttachment[], _model?: string, refs?: ChatReference[]) => {
      const sendAt = sendAtRef.current
      sendAtRef.current = null
      const wire = encodeMentions(content, picksFrom(refs))
      const toChannel = threadRootId ? alsoToChannel : undefined
      const putBack = () => setRestore({ draftKey, nonce: Date.now(), content, files, references: refs })
      textRef.current = ''
      setText('')
      setAlsoToChannel(false)
      setError(null)
      setNotice(null)
      saveDraft('', { immediate: true })

      void (async () => {
        if (isRemindCommand(content) && !files?.length) {
          try {
            const r = await api.createReminder(workspaceId, { command: content })
            setNotice(`Okay, I'll remind you “${r.text}” ${formatWhen(r.remindAt)}.`)
          } catch (err: any) {
            setError(err?.message ?? 'Could not set that reminder')
            putBack()
          }
          return
        }
        if (sendAt) {
          if (files?.length) {
            setError('Send later works for text only. Remove the attachments to schedule this.')
            putBack()
            return
          }
          try {
            await api.schedule(conversationId, { text: wire, sendAt: sendAt.toISOString(), threadRootId, alsoSentToChannel: toChannel })
            setNotice(`Scheduled for ${formatWhen(sendAt.toISOString())}. Manage it in Later.`)
          } catch (err: any) {
            setError(err?.message ?? 'Could not schedule')
            putBack()
          }
          return
        }
        let attachmentIds: string[] = []
        if (files?.length) {
          setUploading(true)
          try {
            const uploaded = await Promise.all(
              files.map(async (f) =>
                api.upload(conversationId, await uploadable(f), {
                  durationMs: f.durationMs ?? null,
                  peaks: f.peaks ?? null,
                }),
              ),
            )
            attachmentIds = uploaded.map((a) => a.id)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed')
            putBack()
            return
          } finally {
            setUploading(false)
          }
        }
        // Sharing a link out of a closed conversation asks first. Best-effort:
        // a failure here must never stop the message going out.
        let linkPreviewsOff: string[] = []
        try {
          linkPreviewsOff = await resolveLinkPreviewOptOuts(wire, conversationId)
        } catch {}
        // Only carry the field when the sender actually declined something, so
        // an ordinary message keeps the shape it always had.
        await onSend({
          text: wire,
          attachmentIds,
          alsoSentToChannel: toChannel,
          ...(linkPreviewsOff.length ? { linkPreviewsOff } : {}),
        })
      })()
    },
    [picksFrom, threadRootId, alsoToChannel, saveDraft, draftKey, workspaceId, conversationId, onSend],
  )

  const sendLater = useCallback((at: Date) => {
    setLaterOpen(false)
    sendAtRef.current = at
    inputRef.current?.submit()
  }, [])

  // ---- voice notes ----------------------------------------------------------
  const recorder = useVoiceNoteRecorder()
  const [recordingError, setRecordingError] = useState<string | null>(null)
  // Files staged from a recording, so "send" hands them to the shared uploader.
  // Triggered from the left-hand clip button — the mic on the right stays
  // dictation, the same as every other composer in the product.
  const startVoiceNote = useCallback(async () => {
    setError(null)
    setNotice(null)
    setRecordingError(null)
    try {
      await recorder.start()
    } catch (err: any) {
      setRecordingError(err?.message ?? 'Could not start recording')
    }
  }, [recorder])

  const onVoiceCancel = useCallback(() => {
    recorder.cancel()
  }, [recorder])

  const onVoiceStop = useCallback(async () => {
    try {
      const note = await recorder.stop()
      if (!note) return
      inputRef.current?.addAttachment({
        dataUrl: note.dataUrl,
        uri: note.uri,
        name: `Voice note.${note.mimeType === 'audio/mp4' ? 'm4a' : 'webm'}`,
        type: note.mimeType,
        // Base64 is 4/3 of the bytes; only used for the size guard.
        size: note.dataUrl ? Math.round((note.dataUrl.length * 3) / 4) : 0,
        durationMs: note.durationMs,
        peaks: note.peaks,
      })
    } catch (err: any) {
      setRecordingError(err?.message ?? 'Could not finish the recording')
    }
  }, [recorder])

  const insertEmoji = useCallback((code: string) => {
    setEmojiOpen(false)
    inputRef.current?.insertText(code)
  }, [])

  const onKeyPress = useCallback(
    (e: any, current: string) => e?.nativeEvent?.key === 'ArrowUp' && !current && !!onEditLast?.(),
    [onEditLast],
  )

  useImperativeHandle(
    ref,
    () => ({
      addFiles: (files) => inputRef.current?.addFiles(files),
      focus: () => inputRef.current?.focus(),
    }),
    [],
  )

  if (props.disabled) {
    return (
      <View className="border-t border-border px-4 py-3">
        <Text className="text-center text-xs text-muted-foreground">{props.disabledReason ?? 'You cannot post here.'}</Text>
      </View>
    )
  }

  const canSendLater = !!text.trim() && !isRemindCommand(text)

  const alsoToChannelToggle = threadRootId ? (
    <Pressable
      onPress={() => setAlsoToChannel((v) => !v)}
      accessibilityRole="checkbox"
      aria-checked={alsoToChannel}
      className="flex-row items-center gap-1.5 rounded-md px-1.5 py-1"
    >
      <View className={cn('h-3.5 w-3.5 rounded border', alsoToChannel ? 'border-primary bg-primary' : 'border-border')} />
      <Text className="text-xs text-muted-foreground">Also send to channel</Text>
    </Pressable>
  ) : null

  const leadingControls = (
    <View className="flex-row items-center gap-1">
      <Pressable onPress={() => setEmojiOpen((v) => !v)} accessibilityLabel="Emoji" className="rounded-md p-1 active:bg-muted hover:bg-muted">
        <Smile size={14} className="text-muted-foreground" />
      </Pressable>
      <Pressable onPress={() => void startVoiceNote()} accessibilityLabel="Record a voice note" className="rounded-md p-1 active:bg-muted hover:bg-muted">
        <AudioLines size={14} className="text-muted-foreground" />
      </Pressable>
      {alsoToChannelToggle}
    </View>
  )

  const trailingControls = canSendLater ? (
    <Pressable onPress={() => setLaterOpen((v) => !v)} accessibilityLabel="Send later" className="rounded-md p-1 active:bg-muted hover:bg-muted">
      <Clock size={14} className="text-muted-foreground" />
    </Pressable>
  ) : null

  const plusMenuExtras = (
    <>
      <ComposerPlusSection id="emoji" label="Emoji" Icon={Smile}>
        <EmojiPicker workspaceId={workspaceId} onPick={insertEmoji} className="mx-3" />
      </ComposerPlusSection>
      {canSendLater ? (
        <ComposerPlusSection id="later" label="Send later" Icon={Clock}>
          {scheduleOptions().map((o) => (
            <Pressable key={o.label} onPress={() => sendLater(o.at)} className="px-4 py-3 active:bg-muted/50">
              <Text className={cn(PHONE_DENSITY.text.label, 'text-foreground')}>{o.label}</Text>
            </Pressable>
          ))}
        </ComposerPlusSection>
      ) : null}
      {threadRootId ? (
        <Pressable
          onPress={() => setAlsoToChannel((v) => !v)}
          accessibilityRole="checkbox"
          aria-checked={alsoToChannel}
          accessibilityLabel="Also send to channel"
          className="min-h-12 flex-row items-center gap-3 border-b border-border/40 px-3 py-3 active:bg-muted/50"
        >
          <View className="h-10 w-10 items-center justify-center rounded-lg bg-muted/40">
            <View className={cn('h-5 w-5 items-center justify-center rounded border', alsoToChannel ? 'border-primary bg-primary' : 'border-border')}>
              {alsoToChannel ? <Check size={14} className="text-primary-foreground" /> : null}
            </View>
          </View>
          <Text className={cn(PHONE_DENSITY.text.label, 'flex-1 font-medium text-foreground')}>Also send to channel</Text>
        </Pressable>
      ) : null}
    </>
  )

  return (
    <View style={phoneLayout ? { paddingBottom: nativePhoneComposerRestPad(chrome.overlay) } : undefined}>
      {recorder.isRecording ? (
        <RecordingBar
          level={recorder.level}
          elapsedMs={recorder.elapsedMs}
          onCancel={onVoiceCancel}
          onFinish={onVoiceStop}
        />
      ) : (
        <ChatInput
          key={draftKey}
          ref={inputRef}
          onSubmit={onSubmit}
          placeholder={props.placeholder}
          presentation="agent"
          agentControls={false}
          submitting={uploading}
          completions={completions}
          transformText={replaceFinishedShortcode}
          onTextChange={onTextChange}
          onKeyPress={onKeyPress}
          restoreDraftRequest={restore?.draftKey === draftKey ? restore : null}
          maxFileSizeBytes={MAX_FILE_BYTES}
          leadingControls={leadingControls}
          trailingControls={trailingControls}
          plusMenuExtras={plusMenuExtras}
          inputTestID="team-composer-input"
          inputAccessibilityLabel="Message"
        />
      )}
      <View className="px-4">
        {emojiOpen && <EmojiPicker workspaceId={workspaceId} onPick={insertEmoji} className="mb-2" />}
        {laterOpen && canSendLater && (
          <View className="mb-2 self-end overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <Text className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase text-muted-foreground">Send later</Text>
            {scheduleOptions().map((o) => (
              <Pressable key={o.label} onPress={() => sendLater(o.at)} className="px-3 py-2 active:bg-muted hover:bg-muted">
                <Text className="text-sm text-foreground">{o.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {threadRootId && alsoToChannel ? <Text className="mb-1 text-xs text-muted-foreground">Also sending to the channel</Text> : null}
        {isRemindCommand(text) && !error ? (
          <View className="mb-2 flex-row items-center gap-1.5">
            <AlarmClock size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Try “/remind me to review the PR in 2 hours” or “… tomorrow at 9am”. Only you will see this.</Text>
          </View>
        ) : null}
        {uploading ? <Text className="mb-2 text-xs text-muted-foreground">Uploading…</Text> : null}
        {recordingError ? <Text className="mb-2 text-xs text-destructive">{recordingError}</Text> : null}
        {notice && !error ? <Text className="mb-2 text-xs text-muted-foreground">{notice}</Text> : null}
        {error ? <Text className="mb-2 text-xs text-destructive">{error}</Text> : null}
      </View>
    </View>
  )
})

/** Composer attachments are data URLs; the upload endpoint takes a file. */
async function uploadable(file: FileAttachment): Promise<File | UploadPart> {
  const type = file.type || 'application/octet-stream'
  // A voice note recorded on a phone is already a file on disk; streaming it
  // avoids base64ing a few megabytes through the JS thread.
  if (file.uri && Platform.OS !== 'web') return localFilePart(file.uri, file.name, type)
  const base64 = file.dataUrl.slice(file.dataUrl.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (Platform.OS === 'web') return new File([bytes], file.name, { type })
  // Native fetch (expo/fetch) can't encode RN's `{ uri }` parts; hand it the bytes.
  return bytesPart(bytes, file.name, type)
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `today at ${time}`
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`
}
