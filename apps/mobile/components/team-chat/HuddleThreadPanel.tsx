// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat, polls and Q&A for the call you're in. In a two-person call, or in a
 * channel, messages are replies to the huddle's "started a huddle" message and
 * stay in that thread after the call. When more people are added, the chat is
 * the group DM of exactly the people in the call (`useHuddleChat`), so everyone
 * in the call can read and write. A poll or question is an ordinary message
 * with a block, which means votes and upvotes sync live to everyone.
 */
import { useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { BarChart3, HelpCircle, Plus, Send, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useConversationTimeline, useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { teamChatApi, type ChatMessage } from '../../lib/team-chat-api'
import { mentionNames, renderMentionLabels, type MentionNames } from '../../lib/team-chat-state'
import { audienceQuestionOf, pollOf, sortQuestions } from '../../lib/team-chat-kinds'
import { AudienceQuestionCardView, PollCardView } from './PollCard'
import { formatTime } from '../../lib/team-chat-time'
import { HuddleWakeNote, huddleWakeBlockOf } from './HuddleWakeNote'

type Tab = 'chat' | 'qa'

const MAX_OPTIONS = 10

export function HuddleThreadPanel({
  workspaceId,
  huddleConversationId,
  chat,
  canModerate,
  onClose,
}: {
  workspaceId: string
  /** The conversation the call started in: polls and questions are posted through it. */
  huddleConversationId: string
  /** Where this person chats; null until it has been worked out. */
  chat: { conversationId: string; threadRootId: string | null; moved?: boolean; members?: string[] } | null
  canModerate: boolean
  onClose?: () => void
}) {
  const conversationId = chat?.conversationId ?? null
  const threadRootId = chat?.threadRootId ?? null
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const names = useMemo(() => mentionNames(mentionables), [mentionables])
  const timeline = useConversationTimeline(workspaceId, conversationId, threadRootId)
  const [tab, setTab] = useState<Tab>('chat')
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState<'poll' | 'question' | null>(null)
  const scroller = useRef<ScrollView>(null)

  const messages = useMemo(() => timeline.state.messages.filter((m) => !m.deletedAt && m.id !== threadRootId), [timeline.state.messages, threadRootId])
  const questions = useMemo(() => sortQuestions(messages.filter((m) => !!audienceQuestionOf(m))), [messages])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const ok = await timeline.send({ text })
    if (!ok) setDraft(text)
  }

  if (!chat) {
    return (
      <View className="flex-1 items-center justify-center p-4" testID="huddle-thread">
        <Text className="text-center text-xs text-muted-foreground">Chat opens once the call has started.</Text>
      </View>
    )
  }

  return (
    <View className="min-h-0 flex-1" testID="huddle-thread">
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        {(['chat', 'qa'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            className={cn('rounded-md px-2.5 py-1', tab === t ? 'bg-muted' : 'active:bg-muted/60')}
          >
            <Text className={cn('text-xs font-medium', tab === t ? 'text-foreground' : 'text-muted-foreground')}>
              {t === 'chat' ? 'Chat' : `Q&A${questions.length ? ` (${questions.length})` : ''}`}
            </Text>
          </Pressable>
        ))}
        <View className="flex-1" />
        <Pressable onPress={() => setAsking(asking === 'poll' ? null : 'poll')} accessibilityRole="button" accessibilityLabel="Start a poll" className="h-7 w-7 items-center justify-center rounded-md active:bg-muted hover:bg-muted">
          <BarChart3 size={14} className="text-foreground" />
        </Pressable>
        <Pressable onPress={() => { setTab('qa'); setAsking(asking === 'question' ? null : 'question') }} accessibilityRole="button" accessibilityLabel="Ask a question" className="h-7 w-7 items-center justify-center rounded-md active:bg-muted hover:bg-muted">
          <HelpCircle size={14} className="text-foreground" />
        </Pressable>
        {onClose ? (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close chat" className="h-7 w-7 items-center justify-center rounded-md active:bg-muted hover:bg-muted">
            <X size={14} className="text-foreground" />
          </Pressable>
        ) : null}
      </View>

      {chat.moved && chat.members ? (
        <Text className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground" testID="huddle-chat-group-note">
          Chatting with the {chat.members.length} people in this call
        </Text>
      ) : null}

      {asking === 'poll' ? <PollForm conversationId={huddleConversationId} onDone={() => setAsking(null)} /> : null}
      {asking === 'question' ? <QuestionForm conversationId={huddleConversationId} onDone={() => setAsking(null)} /> : null}

      <ScrollView
        ref={scroller}
        className="min-h-0 flex-1"
        contentContainerStyle={{ padding: 10, gap: 8 }}
        onContentSizeChange={() => tab === 'chat' && scroller.current?.scrollToEnd({ animated: false })}
      >
        {timeline.loading && !messages.length ? <ActivityIndicator /> : null}
        {tab === 'chat'
          ? messages.length
            ? messages.map((m) => <ThreadLine key={m.id} message={m} me={me} names={names} canModerate={canModerate} />)
            : !timeline.loading && (
                <Text className="text-xs text-muted-foreground">
                  {threadRootId ? "No messages yet. What you write here stays in the huddle's thread after the call." : 'No messages yet. What you write here goes to everyone in the call.'}
                </Text>
              )
          : questions.length
            ? questions.map((m) => <AudienceQuestionCardView key={m.id} message={m} me={me} canManage={canModerate} />)
            : <Text className="text-xs text-muted-foreground">No questions yet. Ask one and others can upvote it.</Text>}
      </ScrollView>

      {tab === 'chat' ? (
        <View className="flex-row items-end gap-2 border-t border-border p-2">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void send()}
            placeholder="Message the huddle"
            placeholderTextColor="#9ca3af"
            returnKeyType="send"
            blurOnSubmit={false}
            accessibilityLabel="Huddle message"
            className="max-h-24 min-h-9 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
          />
          <Pressable
            onPress={() => void send()}
            disabled={!draft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Send"
            className={cn('h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80', !draft.trim() && 'opacity-40')}
          >
            <Send size={15} color="white" />
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

function ThreadLine({ message, me, names, canModerate }: { message: ChatMessage; me: string | null; names: MentionNames; canModerate: boolean }) {
  if (pollOf(message)) return <PollCardView message={message} me={me} canManage={canModerate} />
  if (audienceQuestionOf(message)) return <AudienceQuestionCardView message={message} me={me} canManage={canModerate} />
  // The wake note's text is the whole transcript — show the card, not the text.
  const wake = huddleWakeBlockOf(message.blocks)
  if (wake) return <HuddleWakeNote block={wake} createdAt={formatTime(message.createdAt)} />
  const text = renderMentionLabels(message.text, names)
  if (message.authorType === 'system') {
    return <Text className="self-center px-2 text-center text-[11px] text-muted-foreground" testID="huddle-thread-line">{text}</Text>
  }
  const mine = !!me && message.authorUserId === me
  return (
    <View className={cn('max-w-[90%] gap-0.5 rounded-lg px-2.5 py-1.5', mine ? 'self-end bg-primary/10' : 'self-start bg-muted', message.pending && 'opacity-60')} testID="huddle-thread-line">
      {mine ? null : <Text className="text-[11px] font-semibold text-foreground">{message.author?.name ?? message.authorAgent?.name ?? 'Someone'}</Text>}
      <Text className="text-sm text-foreground">{text}</Text>
      {message.pending === 'failed' ? <Text className="text-[10px] text-destructive">Not sent</Text> : null}
    </View>
  )
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onDone()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not post that')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

/** The options as typed, trimmed and without blanks or repeats. */
export function pollOptionsFrom(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const option of raw) {
    const text = option.replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(0, MAX_OPTIONS)
}

function PollForm({ conversationId, onDone }: { conversationId: string; onDone: () => void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multiple, setMultiple] = useState(false)
  const { busy, error, submit } = useSubmit(onDone)
  const clean = pollOptionsFrom(options)
  const ready = !!question.trim() && clean.length >= 2

  return (
    <View className="gap-2 border-b border-border bg-muted/40 p-2" testID="huddle-poll-form">
      <TextInput value={question} onChangeText={setQuestion} placeholder="Ask the group…" placeholderTextColor="#9ca3af" accessibilityLabel="Poll question" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground" />
      {options.map((value, i) => (
        <TextInput
          key={i}
          value={value}
          onChangeText={(t) => setOptions((o) => o.map((x, j) => (j === i ? t : x)))}
          placeholder={`Option ${i + 1}`}
          placeholderTextColor="#9ca3af"
          accessibilityLabel={`Poll option ${i + 1}`}
          className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
        />
      ))}
      <View className="flex-row items-center gap-2">
        {options.length < MAX_OPTIONS ? (
          <Pressable onPress={() => setOptions((o) => [...o, ''])} accessibilityRole="button" className="flex-row items-center gap-1 rounded-md px-1.5 py-1 active:bg-muted">
            <Plus size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Add option</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setMultiple((m) => !m)} accessibilityRole="checkbox" accessibilityState={{ checked: multiple }} className="rounded-md px-1.5 py-1 active:bg-muted">
          <Text className={cn('text-xs', multiple ? 'font-medium text-primary' : 'text-muted-foreground')}>{multiple ? '✓ ' : ''}Allow several</Text>
        </Pressable>
        <View className="flex-1" />
        <Pressable
          disabled={!ready || busy}
          onPress={() => void submit(() => teamChatApi().postHuddlePoll(conversationId, { question: question.trim(), options: clean, multiple }))}
          accessibilityRole="button"
          className={cn('rounded-md bg-primary px-3 py-1.5 active:opacity-80', (!ready || busy) && 'opacity-40')}
        >
          <Text className="text-xs font-medium text-primary-foreground">Post poll</Text>
        </Pressable>
      </View>
      {error ? <Text className="text-[11px] text-destructive">{error}</Text> : null}
    </View>
  )
}

function QuestionForm({ conversationId, onDone }: { conversationId: string; onDone: () => void }) {
  const [text, setText] = useState('')
  const { busy, error, submit } = useSubmit(onDone)
  const ready = !!text.trim()
  return (
    <View className="gap-2 border-b border-border bg-muted/40 p-2" testID="huddle-question-form">
      <TextInput value={text} onChangeText={setText} placeholder="Ask a question others can upvote…" placeholderTextColor="#9ca3af" accessibilityLabel="Question" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground" />
      <View className="flex-row items-center">
        <View className="flex-1" />
        <Pressable
          disabled={!ready || busy}
          onPress={() => void submit(() => teamChatApi().postHuddleQuestion(conversationId, text.trim()))}
          accessibilityRole="button"
          className={cn('rounded-md bg-primary px-3 py-1.5 active:opacity-80', (!ready || busy) && 'opacity-40')}
        >
          <Text className="text-xs font-medium text-primary-foreground">Ask</Text>
        </Pressable>
      </View>
      {error ? <Text className="text-[11px] text-destructive">{error}</Text> : null}
    </View>
  )
}
