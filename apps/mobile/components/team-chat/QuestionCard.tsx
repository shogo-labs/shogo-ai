// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An agent's questions as a card on its message, so an ask buried in a long
 * update is the first thing the person it is for sees. Each question answers
 * the way it was asked: tap an option, Approve / Not yet / Discuss, a short
 * answer, a teammate, or a masked secret only the asking agent can read. A
 * person's answers go into the message's thread together, tagging the agent
 * once, after they've closed the rest of the card (or gone idle).
 */
import { useEffect, useMemo, useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import { Check, KeyRound, MessageCircleQuestion, Search, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { ChatMarkdown } from '../chat/ChatMarkdown'
import { GlassCard } from '../ui/GlassCard'
import { answerQuestion, dismissQuestion } from '../../lib/question-answer'
import { renderMentionsMarkdown, type MentionNames } from '../../lib/team-chat-state'
import { teamChatApi } from '../../lib/team-chat-api'
import { isAskedOf, questionOptions, type Question } from '../../lib/team-chat-kinds'

const AMBER = '#f59e0b'

function recipientsLabel(q: Question, names: MentionNames, me: string | null): string {
  if (q.to.anyone) return 'Anyone here can answer'
  const people = q.to.userIds.map((id) => (id === me ? 'you' : names.users.get(id) ?? 'someone'))
  return `For ${people.join(', ')}`
}

function closedLabel(q: Question): string {
  if (q.status === 'answered' && q.answer) return `${q.answer.by.name}: ${q.answer.text}`
  if (q.status === 'superseded') return q.closedReason ? `No longer needed: ${q.closedReason}` : 'No longer needed'
  return q.closedReason ? `Dismissed: ${q.closedReason}` : 'Dismissed'
}

/**
 * A closed question. The person's own answer says where it is: held while
 * their other answers on the card wait to go to the agent together, or sent
 * once they have.
 */
function closedLine(q: Question, me: string | null, waiting: boolean, agentName?: string): string {
  const mine = q.status === 'answered' && !!q.answer && q.answer.by.userId === me
  if (mine && q.answer && !q.answer.relayedAt && waiting) return `${q.answer.text}, sends to ${agentName ?? 'the agent'} when you finish the rest`
  if (mine && q.answer && q.answer.relayedAt) return `${q.answer.text}, sent to ${agentName ?? 'the agent'}`
  return closedLabel(q)
}

export function QuestionCardView({
  questions,
  messageId,
  workspaceId,
  me,
  names,
  canAnswer = true,
  agentName,
  outlined = true,
  onOpen,
}: {
  questions: Question[]
  messageId: string
  workspaceId?: string
  me: string | null
  names: MentionNames
  /** False while the message is still being sent. */
  canAnswer?: boolean
  agentName?: string
  outlined?: boolean
  /** Tapping the question's header or prompt opens the message it was asked in. */
  onOpen?: () => void
}) {
  const open = questions.filter((q) => q.status === 'open')
  // Whether the viewer still has questions open here, so their answers are held rather than sent.
  const waiting = open.some((q) => isAskedOf(q, me))
  const forMe = open.some((q) => isAskedOf(q, me))
  return (
    <GlassCard
      style={{ marginTop: 4, marginBottom: 4, maxWidth: 560 }}
      radius={16}
      accent={forMe && outlined ? `${AMBER}80` : undefined}
      tint={forMe ? `${AMBER}14` : undefined}
      testID="question-card"
    >
      <View className="gap-3 p-3">
        {questions.map((q, i) => (
          <View key={q.id} className={cn('gap-2', i > 0 && 'border-t border-border/60 pt-3')}>
            <QuestionItem q={q} messageId={messageId} workspaceId={workspaceId} me={me} names={names} canAnswer={canAnswer} waiting={waiting} agentName={agentName} onOpen={onOpen} />
          </View>
        ))}
      </View>
    </GlassCard>
  )
}

function QuestionItem({
  q,
  messageId,
  workspaceId,
  me,
  names,
  canAnswer,
  waiting,
  agentName,
  onOpen,
}: {
  q: Question
  messageId: string
  workspaceId?: string
  me: string | null
  names: MentionNames
  canAnswer: boolean
  /** The viewer has other questions open on this card. */
  waiting: boolean
  agentName?: string
  onOpen?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asked = isAskedOf(q, me)
  const isOpen = q.status === 'open'

  const send = async (input: { answer?: string; secret?: string }) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const outcome = await answerQuestion(messageId, q.id, input)
    if (!outcome.ok) setError(outcome.message)
    setBusy(false)
  }
  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const outcome = await dismissQuestion(messageId, q.id)
    if (!outcome.ok) setError(outcome.message)
    setBusy(false)
  }

  const heading = (
    <>
      <View className="flex-row items-center gap-2">
        <View className={cn('flex-row items-center gap-1 rounded px-1.5 py-0.5', isOpen ? 'bg-amber-500/20' : 'bg-muted')}>
          {q.interaction === 'secret' ? <KeyRound size={10} className={isOpen ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'} /> : <MessageCircleQuestion size={10} className={isOpen ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'} />}
          <Text className={cn('text-[10px] font-semibold uppercase', isOpen ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')} numberOfLines={1}>
            {q.header}
          </Text>
        </View>
        {isOpen ? (
          <Text className={cn('text-[11px]', asked && !q.to.anyone ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')} testID="question-recipients">
            {recipientsLabel(q, names, me)}
          </Text>
        ) : null}
        {isOpen && (q.askCount ?? 1) > 1 ? <Text className="text-[11px] text-muted-foreground">{`· asked ${q.askCount} times`}</Text> : null}
      </View>
      <ChatMarkdown isStreaming={false}>{renderMentionsMarkdown(q.prompt, names)}</ChatMarkdown>
    </>
  )

  return (
    <>
      {onOpen ? (
        <Pressable onPress={onOpen} accessibilityRole="link" accessibilityLabel="Open in conversation" className="gap-2 rounded-md active:opacity-70">
          {heading}
        </Pressable>
      ) : (
        heading
      )}

      {!isOpen ? (
        <View className="flex-row items-start gap-1.5" testID={`question-${q.status}`}>
          {q.status === 'answered' ? <Check size={13} className="mt-0.5 text-emerald-600" /> : <X size={13} className="mt-0.5 text-muted-foreground" />}
          <Text className={cn('min-w-0 flex-1 text-xs', q.status === 'answered' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>{closedLine(q, me, waiting, agentName)}</Text>
        </View>
      ) : asked && canAnswer ? (
        <>
          <AnswerInput q={q} busy={busy} workspaceId={workspaceId} agentName={agentName} onSend={send} />
          <Pressable onPress={() => void dismiss()} disabled={busy} accessibilityRole="button" accessibilityLabel="Dismiss question" className="self-start">
            <Text className="text-[11px] text-muted-foreground">Dismiss</Text>
          </Pressable>
        </>
      ) : (
        <Text className="text-xs text-muted-foreground">Waiting for an answer</Text>
      )}
      {error ? <Text className="text-xs text-destructive" testID="question-error">{error}</Text> : null}
    </>
  )
}

function AnswerInput({
  q,
  busy,
  workspaceId,
  agentName,
  onSend,
}: {
  q: Question
  busy: boolean
  workspaceId?: string
  agentName?: string
  onSend: (input: { answer?: string; secret?: string }) => Promise<void>
}) {
  const options = questionOptions(q)
  const [picked, setPicked] = useState<string[]>([])
  const [other, setOther] = useState<boolean>(q.interaction === 'text' || q.interaction === 'secret')
  const [text, setText] = useState('')

  if (q.interaction === 'person') return <PersonPicker workspaceId={workspaceId} busy={busy} onPick={(answer) => void onSend({ answer })} />

  const submitText = () => {
    const value = text.trim()
    if (!value) return
    if (q.interaction === 'secret') void onSend({ secret: value })
    else void onSend({ answer: value })
  }

  return (
    <View className="gap-2">
      {options.length ? (
        <View className="flex-row flex-wrap gap-2">
          {options.map((o, i) => {
            const on = picked.includes(o.label)
            const primary = q.interaction === 'confirm' && i === 0
            return (
              <Pressable
                key={o.label}
                disabled={busy}
                onPress={() => {
                  if (q.multiSelect) setPicked((p) => (on ? p.filter((x) => x !== o.label) : [...p, o.label]))
                  else void onSend({ answer: o.label })
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={o.label}
                accessibilityHint={o.description}
                className={cn(
                  'max-w-full rounded-lg border px-3 py-1.5',
                  primary || on ? 'border-primary bg-primary' : 'border-border active:bg-muted',
                  busy && 'opacity-60',
                )}
              >
                <Text className={cn('text-sm font-medium', primary || on ? 'text-primary-foreground' : 'text-foreground')}>{o.label}</Text>
                {o.description ? <Text className={cn('text-[11px]', primary || on ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{o.description}</Text> : null}
              </Pressable>
            )
          })}
          {q.interaction === 'choice' && !other ? (
            <Pressable onPress={() => setOther(true)} accessibilityRole="button" className="rounded-lg border border-dashed border-border px-3 py-1.5 active:bg-muted">
              <Text className="text-sm text-muted-foreground">Other…</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {q.multiSelect && picked.length ? (
        <Pressable
          onPress={() => void onSend({ answer: picked.join(', ') })}
          disabled={busy}
          accessibilityRole="button"
          className={cn('self-start rounded-lg bg-primary px-3.5 py-2', busy && 'opacity-60')}
        >
          <Text className="text-sm font-medium text-primary-foreground">{busy ? 'Sending…' : `Send ${picked.length} selected`}</Text>
        </Pressable>
      ) : null}
      {other ? (
        <View className="gap-1">
          <View className="flex-row items-center gap-2">
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={q.interaction === 'secret' ? `Paste ${q.secretName ?? 'the value'}` : q.hint === 'url' ? 'https://…' : q.hint === 'number' ? 'A number' : 'Your answer'}
              secureTextEntry={q.interaction === 'secret'}
              autoCapitalize="none"
              autoCorrect={q.interaction === 'text' && !q.hint}
              keyboardType={q.hint === 'number' ? 'numeric' : q.hint === 'url' ? 'url' : 'default'}
              onSubmitEditing={submitText}
              accessibilityLabel={q.interaction === 'secret' ? `Secret ${q.secretName ?? ''}` : 'Answer'}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
              {...(Platform.OS === 'web' ? ({ autoComplete: q.interaction === 'secret' ? 'off' : undefined } as object) : {})}
            />
            <Pressable
              onPress={submitText}
              disabled={busy || !text.trim()}
              accessibilityRole="button"
              accessibilityLabel="Send answer"
              className={cn('rounded-lg bg-primary px-3.5 py-2', (busy || !text.trim()) && 'opacity-60')}
            >
              <Text className="text-sm font-medium text-primary-foreground">{busy ? 'Sending…' : 'Send'}</Text>
            </Pressable>
          </View>
          {q.interaction === 'secret' ? (
            <Text className="text-[11px] text-muted-foreground">{`Stored encrypted. Only ${agentName ?? 'the agent that asked'} can read it, and it never appears in the channel.`}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function PersonPicker({ workspaceId, busy, onPick }: { workspaceId?: string; busy: boolean; onPick: (answer: string) => void }) {
  const [people, setPeople] = useState<Array<{ id: string; name: string; email: string }>>([])
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!workspaceId) {
      setPeople([])
      return
    }
    void teamChatApi().mentionables(workspaceId).then((result) => setPeople(result.people)).catch(() => setPeople([]))
  }, [workspaceId])
  const visiblePeople = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (q ? people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) : people).slice(0, 6)
  }, [people, query])
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
        <Search size={13} className="text-muted-foreground" />
        <TextInput value={query} onChangeText={setQuery} placeholder="Pick a teammate" autoCapitalize="none" className="min-w-0 flex-1 text-sm text-foreground" accessibilityLabel="Search teammates" />
      </View>
      <View className="flex-row flex-wrap gap-2">
        {visiblePeople.map((p) => (
          <Pressable
            key={p.id}
            disabled={busy}
            onPress={() => onPick(`${p.name} (${p.email})`)}
            accessibilityRole="button"
            accessibilityLabel={p.name}
            className={cn('rounded-lg border border-border px-3 py-1.5 active:bg-muted', busy && 'opacity-60')}
          >
            <Text className="text-sm text-foreground">{p.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
