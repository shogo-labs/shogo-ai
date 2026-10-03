// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat composer: Enter to send (Shift+Enter for a newline on web),
 * @-autocomplete for teammates and agents, file attachments, typing
 * signals, "also send to channel" for thread replies, drafts synced across
 * devices, send later, and `/remind`. On web, pasted files upload, and
 * `:shortcode` suggests emoji.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Image, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { AlarmClock, Bot, Clock, Paperclip, SendHorizontal, Smile, Users, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { Mentionables, MessageAttachment } from '../../lib/team-chat-api'
import { teamChatApi } from '../../lib/team-chat-api'
import { sendTyping } from '../../lib/team-chat-connection'
import {
  activeMentionQuery,
  decodeMentions,
  encodeMentions,
  isRemindCommand,
  scheduleOptions,
  filterCandidates,
  insertMention,
  mentionCandidates,
  type MentionCandidate,
} from '../../lib/team-chat-state'
import type { SendInput } from '../../hooks/useTeamChat'
import { useDraft } from '../../hooks/useChatItems'
import { useCustomEmoji } from '../../hooks/useCustomEmoji'
import { activeEmojiQuery, replaceFinishedShortcode, searchEmoji } from '../../lib/emoji-data'
import { PresenceDot } from './PresenceDot'
import { EmojiPicker, rememberEmoji } from './EmojiPicker'

const api = teamChatApi()
const MAX_ATTACHMENTS = 10
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
}

export interface ComposerHandle {
  /** Upload files dropped elsewhere on the pane. */
  addFiles: (files: File[]) => void
}

interface EmojiSuggestion {
  code: string
  label: string
  imageUrl?: string
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { workspaceId, conversationId, threadRootId = null, mentionables, me } = props
  const [text, setText] = useState('')
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [picked, setPicked] = useState<MentionCandidate[]>([])
  const [highlight, setHighlight] = useState(0)
  const [alsoToChannel, setAlsoToChannel] = useState(false)
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [laterOpen, setLaterOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const customEmoji = useCustomEmoji(workspaceId)
  const inputRef = useRef<TextInput>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isWeb = Platform.OS === 'web'

  const candidates = useMemo(() => mentionCandidates(mentionables, me), [mentionables, me])
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const query = activeMentionQuery(text, selection.start)
  const suggestions = query && query.start !== dismissedAt ? filterCandidates(candidates, query.query) : []
  const emojiQuery = suggestions.length ? null : activeEmojiQuery(text, selection.start)
  const emojiSuggestions = useMemo<EmojiSuggestion[]>(() => {
    if (!emojiQuery || emojiQuery.start === dismissedAt) return []
    const q = emojiQuery.query.toLowerCase()
    const custom = [...customEmoji.values()]
      .filter((e) => e.name.toLowerCase().includes(q))
      .map((e) => ({ code: `:${e.name}:`, label: `:${e.name}:`, imageUrl: e.url }))
    return [...custom, ...searchEmoji(q, 8).map((e) => ({ code: e.emoji, label: `:${e.slug}:` }))].slice(0, 8)
  }, [emojiQuery?.start, emojiQuery?.query, dismissedAt, customEmoji])

  const draft = useDraft(conversationId, threadRootId)
  const restoredFor = useRef<string | null>(null)
  const draftKey = `${conversationId}:${threadRootId ?? ''}`
  // Load the draft when switching conversations, or when a synced draft arrives into an empty box.
  useEffect(() => {
    const switched = restoredFor.current !== draftKey
    restoredFor.current = draftKey
    if (!switched && text) return
    const { text: restored, picked: restoredPicks } = decodeMentions(draft.stored, candidates)
    if (!switched && restored === text) return
    setText(restored)
    setPicked(restoredPicks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, draft.stored, candidates.length])

  const onChange = (raw: string) => {
    const next = replaceFinishedShortcode(raw)
    setText(next)
    draft.save(next.trim() ? encodeMentions(next, picked) : '')
    setNotice(null)
    setHighlight(0)
    if (!next.includes('@') && !next.includes(':')) setDismissedAt(null)
    if (next.trim()) sendTyping(workspaceId, conversationId, threadRootId)
  }

  const choose = (candidate: MentionCandidate) => {
    if (!query) return
    const result = insertMention(text, query, candidate)
    setText(result.text)
    setSelection({ start: result.cursor, end: result.cursor })
    setPicked((p) => [...p, candidate])
    inputRef.current?.focus()
  }

  const chooseEmoji = (s: EmojiSuggestion) => {
    if (!emojiQuery) return
    rememberEmoji(s.code)
    const caret = emojiQuery.start + emojiQuery.query.length + 1
    const next = `${text.slice(0, emojiQuery.start)}${s.code} ${text.slice(caret)}`
    const cursor = emojiQuery.start + s.code.length + 1
    onChange(next)
    setSelection({ start: cursor, end: cursor })
    inputRef.current?.focus()
  }

  const insertAtCursor = (insert: string) => {
    const at = Math.min(selection.start, text.length)
    const before = text.slice(0, at)
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    const next = `${before}${pad}${insert} ${text.slice(at)}`
    const cursor = at + pad.length + insert.length + 1
    onChange(next)
    setSelection({ start: cursor, end: cursor })
    setEmojiOpen(false)
    inputRef.current?.focus()
  }

  const reset = () => {
    setText('')
    setPicked([])
    setAttachments([])
    setAlsoToChannel(false)
    setError(null)
    draft.save('', { immediate: true })
  }

  const remind = async (command: string) => {
    try {
      const r = await api.createReminder(workspaceId, { command })
      reset()
      setNotice(`Okay, I'll remind you “${r.text}” ${formatWhen(r.remindAt)}.`)
    } catch (err: any) {
      setError(err?.message ?? 'Could not set that reminder')
    }
  }

  const submit = async () => {
    const trimmed = text.trim()
    if ((!trimmed && !attachments.length) || uploading || props.disabled) return
    if (isRemindCommand(trimmed) && !attachments.length) return remind(trimmed)
    const wire = encodeMentions(trimmed, picked)
    const attachmentIds = attachments.map((a) => a.id)
    reset()
    setNotice(null)
    await props.onSend({ text: wire, attachmentIds, alsoSentToChannel: threadRootId ? alsoToChannel : undefined })
  }

  const sendLater = async (at: Date) => {
    setLaterOpen(false)
    const trimmed = text.trim()
    if (!trimmed) return
    try {
      await api.schedule(conversationId, {
        text: encodeMentions(trimmed, picked),
        sendAt: at.toISOString(),
        threadRootId,
        alsoSentToChannel: threadRootId ? alsoToChannel : undefined,
      })
      reset()
      setNotice(`Scheduled for ${formatWhen(at.toISOString())}. Manage it in Later.`)
    } catch (err: any) {
      setError(err?.message ?? 'Could not schedule')
    }
  }

  const upload = async (file: File | { uri: string; name: string; type: string }) => {
    setUploading((n) => n + 1)
    try {
      const attachment = await api.upload(conversationId, file)
      setAttachments((a) => [...a, attachment].slice(0, MAX_ATTACHMENTS))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading((n) => n - 1)
    }
  }

  const addFiles = (files: File[]) => {
    for (const f of files.slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length))) {
      if (f.size > MAX_FILE_BYTES) setError(`${f.name} is larger than 50 MB`)
      else void upload(f)
    }
  }
  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles
  useImperativeHandle(ref, () => ({ addFiles: (files) => addFilesRef.current(files) }), [])

  useEffect(() => {
    if (!isWeb || props.disabled) return
    const node = inputRef.current as unknown as HTMLElement | null
    if (!node?.addEventListener) return
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      addFilesRef.current(files)
    }
    node.addEventListener('paste', onPaste as EventListener)
    return () => node.removeEventListener('paste', onPaste as EventListener)
  }, [isWeb, props.disabled])

  const pickFiles = () => {
    if (isWeb) {
      fileInputRef.current?.click()
      return
    }
    void (async () => {
      try {
        const { getDocumentAsync } = await import('expo-document-picker')
        const result = await getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true })
        if (result.canceled) return
        for (const doc of result.assets.slice(0, MAX_ATTACHMENTS - attachments.length)) {
          if ((doc.size ?? 0) > MAX_FILE_BYTES) setError(`${doc.name} is larger than 50 MB`)
          else void upload({ uri: doc.uri, name: doc.name, type: doc.mimeType || 'application/octet-stream' })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the file picker')
      }
    })()
  }

  const onKeyPress = (e: any) => {
    if (!isWeb) return
    const key = e.nativeEvent.key
    if (suggestions.length) {
      if (key === 'ArrowDown') { e.preventDefault?.(); setHighlight((h) => (h + 1) % suggestions.length); return }
      if (key === 'ArrowUp') { e.preventDefault?.(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); return }
      if (key === 'Enter' || key === 'Tab') { e.preventDefault?.(); choose(suggestions[highlight] ?? suggestions[0]!); return }
      if (key === 'Escape') { setDismissedAt(query?.start ?? null); return }
    }
    if (emojiSuggestions.length) {
      if (key === 'ArrowDown') { e.preventDefault?.(); setHighlight((h) => (h + 1) % emojiSuggestions.length); return }
      if (key === 'ArrowUp') { e.preventDefault?.(); setHighlight((h) => (h - 1 + emojiSuggestions.length) % emojiSuggestions.length); return }
      if (key === 'Enter' || key === 'Tab') { e.preventDefault?.(); chooseEmoji(emojiSuggestions[highlight] ?? emojiSuggestions[0]!); return }
      if (key === 'Escape') { setDismissedAt(emojiQuery?.start ?? null); return }
    }
    if (key === 'Enter' && !e.nativeEvent.shiftKey) {
      e.preventDefault?.()
      void submit()
      return
    }
    if (key === 'ArrowUp' && !text && !attachments.length && props.onEditLast?.()) e.preventDefault?.()
  }

  if (props.disabled) {
    return (
      <View className="border-t border-border px-4 py-3">
        <Text className="text-center text-xs text-muted-foreground">{props.disabledReason ?? 'You cannot post here.'}</Text>
      </View>
    )
  }

  return (
    <View className="px-3 pb-3 pt-1">
      {suggestions.length > 0 && (
        <View className="mb-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {suggestions.map((c, i) => (
            <Pressable
              key={c.token}
              onPress={() => choose(c)}
              className={cn('flex-row items-center gap-2 px-3 py-2', i === highlight ? 'bg-muted' : 'active:bg-muted')}
            >
              {c.kind === 'agent' ? (
                <Bot size={14} className="text-primary" />
              ) : c.kind === 'user' ? (
                <View className="w-3.5 items-center">
                  <PresenceDot userId={c.userId} />
                </View>
              ) : (
                <Users size={14} className="text-muted-foreground" />
              )}
              <Text className="text-sm text-foreground">{c.display}</Text>
              {c.subtitle ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{c.subtitle}</Text> : null}
            </Pressable>
          ))}
        </View>
      )}
      {emojiSuggestions.length > 0 && (
        <View className="mb-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm" testID="emoji-suggestions">
          {emojiSuggestions.map((s, i) => (
            <Pressable
              key={s.code}
              onPress={() => chooseEmoji(s)}
              className={cn('flex-row items-center gap-2 px-3 py-1.5', i === highlight ? 'bg-muted' : 'active:bg-muted')}
            >
              {s.imageUrl ? <Image source={{ uri: s.imageUrl }} style={{ width: 18, height: 18 }} /> : <Text className="text-base">{s.code}</Text>}
              <Text className="text-sm text-foreground">{s.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View className="rounded-xl border border-border bg-background">
        {(attachments.length > 0 || uploading > 0) && (
          <ScrollView horizontal className="px-2 pt-2" contentContainerStyle={{ gap: 6 }}>
            {attachments.map((a) => (
              <View key={a.id} className="flex-row items-center gap-1 rounded-md bg-muted px-2 py-1">
                <Text className="max-w-[160px] text-xs text-foreground" numberOfLines={1}>{a.name}</Text>
                <Pressable onPress={() => setAttachments((list) => list.filter((x) => x.id !== a.id))} accessibilityLabel={`Remove ${a.name}`}>
                  <X size={12} className="text-muted-foreground" />
                </Pressable>
              </View>
            ))}
            {uploading > 0 && (
              <View className="rounded-md bg-muted px-2 py-1">
                <Text className="text-xs text-muted-foreground">Uploading…</Text>
              </View>
            )}
          </ScrollView>
        )}
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={onChange}
          onChange={(e: any) => {
            const caret = e?.target?.selectionStart
            if (isWeb && typeof caret === 'number') setSelection({ start: caret, end: caret })
          }}
          onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
          selection={isWeb ? undefined : selection}
          onKeyPress={onKeyPress}
          placeholder={props.placeholder}
          placeholderTextColor="#8a8a8a"
          multiline
          className="max-h-40 min-h-[44px] px-3 py-2.5 text-sm text-foreground"
          accessibilityLabel="Message"
        />
        <View className="flex-row items-center gap-1 px-2 pb-2">
          <Pressable onPress={pickFiles} accessibilityLabel="Attach files" className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
            <Paperclip size={16} className="text-muted-foreground" />
          </Pressable>
          <Pressable onPress={() => setEmojiOpen((v) => !v)} accessibilityLabel="Emoji" className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
            <Smile size={16} className="text-muted-foreground" />
          </Pressable>
          {threadRootId && (
            <Pressable onPress={() => setAlsoToChannel((v) => !v)} className="flex-row items-center gap-1.5 rounded-md px-1.5 py-1">
              <View className={cn('h-3.5 w-3.5 rounded border', alsoToChannel ? 'border-primary bg-primary' : 'border-border')} />
              <Text className="text-xs text-muted-foreground">Also send to channel</Text>
            </Pressable>
          )}
          <View className="flex-1" />
          {text.trim() && !attachments.length && !isRemindCommand(text) ? (
            <Pressable
              onPress={() => setLaterOpen((v) => !v)}
              accessibilityLabel="Send later"
              className="rounded-md p-1.5 active:bg-muted hover:bg-muted"
            >
              <Clock size={16} className="text-muted-foreground" />
            </Pressable>
          ) : null}
          <Pressable
            onPress={submit}
            disabled={(!text.trim() && !attachments.length) || uploading > 0}
            accessibilityLabel="Send"
            className={cn('rounded-lg p-1.5', text.trim() || attachments.length ? 'bg-primary' : 'bg-muted')}
          >
            <SendHorizontal size={16} className={text.trim() || attachments.length ? 'text-primary-foreground' : 'text-muted-foreground'} />
          </Pressable>
        </View>
      </View>
      {emojiOpen && <EmojiPicker workspaceId={workspaceId} onPick={insertAtCursor} className="mt-1" />}
      {laterOpen && (
        <View className="mt-1 self-end overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <Text className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase text-muted-foreground">Send later</Text>
          {scheduleOptions().map((o) => (
            <Pressable key={o.label} onPress={() => void sendLater(o.at)} className="px-3 py-2 active:bg-muted hover:bg-muted">
              <Text className="text-sm text-foreground">{o.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {isRemindCommand(text) && !error ? (
        <View className="mt-1 flex-row items-center gap-1.5">
          <AlarmClock size={12} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">Try “/remind me to review the PR in 2 hours” or “… tomorrow at 9am”. Only you will see this.</Text>
        </View>
      ) : null}
      {notice && !error ? <Text className="mt-1 text-xs text-muted-foreground">{notice}</Text> : null}
      {error && <Text className="mt-1 text-xs text-destructive">{error}</Text>}
      {isWeb && (
        <input
          ref={fileInputRef as any}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ''
            addFiles(files)
          }}
        />
      )}
    </View>
  )
})

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
