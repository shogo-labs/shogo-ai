// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat composer: Enter to send (Shift+Enter for a newline on web),
 * @-autocomplete for teammates and agents, file attachments, typing
 * signals, and "also send to channel" for thread replies.
 */
import { useMemo, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Bot, Paperclip, SendHorizontal, User, Users, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { Mentionables, MessageAttachment } from '../../lib/team-chat-api'
import { teamChatApi } from '../../lib/team-chat-api'
import { sendTyping } from '../../lib/team-chat-connection'
import {
  activeMentionQuery,
  encodeMentions,
  filterCandidates,
  insertMention,
  mentionCandidates,
  type MentionCandidate,
} from '../../lib/team-chat-state'
import type { SendInput } from '../../hooks/useTeamChat'

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
}

export function Composer(props: ComposerProps) {
  const { workspaceId, conversationId, threadRootId = null, mentionables, me } = props
  const [text, setText] = useState('')
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [picked, setPicked] = useState<MentionCandidate[]>([])
  const [highlight, setHighlight] = useState(0)
  const [alsoToChannel, setAlsoToChannel] = useState(false)
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<TextInput>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isWeb = Platform.OS === 'web'

  const candidates = useMemo(() => mentionCandidates(mentionables, me), [mentionables, me])
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const query = activeMentionQuery(text, selection.start)
  const suggestions = query && query.start !== dismissedAt ? filterCandidates(candidates, query.query) : []

  const onChange = (next: string) => {
    setText(next)
    setHighlight(0)
    if (!next.includes('@')) setDismissedAt(null)
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

  const submit = async () => {
    const trimmed = text.trim()
    if ((!trimmed && !attachments.length) || uploading || props.disabled) return
    const wire = encodeMentions(trimmed, picked)
    const attachmentIds = attachments.map((a) => a.id)
    setText('')
    setPicked([])
    setAttachments([])
    setAlsoToChannel(false)
    setError(null)
    await props.onSend({ text: wire, attachmentIds, alsoSentToChannel: threadRootId ? alsoToChannel : undefined })
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
    if (key === 'Enter' && !e.nativeEvent.shiftKey) {
      e.preventDefault?.()
      void submit()
    }
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
              {c.kind === 'agent' ? <Bot size={14} className="text-primary" /> : c.kind === 'user' ? <User size={14} className="text-muted-foreground" /> : <Users size={14} className="text-muted-foreground" />}
              <Text className="text-sm text-foreground">{c.display}</Text>
              {c.subtitle ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{c.subtitle}</Text> : null}
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
          {threadRootId && (
            <Pressable onPress={() => setAlsoToChannel((v) => !v)} className="flex-row items-center gap-1.5 rounded-md px-1.5 py-1">
              <View className={cn('h-3.5 w-3.5 rounded border', alsoToChannel ? 'border-primary bg-primary' : 'border-border')} />
              <Text className="text-xs text-muted-foreground">Also send to channel</Text>
            </Pressable>
          )}
          <View className="flex-1" />
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
            for (const f of files) {
              if (f.size > MAX_FILE_BYTES) setError(`${f.name} is larger than 50 MB`)
              else void upload(f)
            }
          }}
        />
      )}
    </View>
  )
}
