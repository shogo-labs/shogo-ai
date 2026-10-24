// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Polls and audience questions, posted in a huddle's thread. Both are ordinary
 * messages carrying a `poll` or `question` block, so they show up in the call
 * and stay in the thread afterwards. Votes sync to everyone as the message
 * updates over the conversation bus.
 */
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { BarChart3, Check, ChevronUp, HelpCircle, Lock } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ChatMessage } from '../../lib/team-chat-api'
import { audienceQuestionOf, pollOf, pollVoterCount } from '../../lib/team-chat-kinds'

/** The latest message the server returned for an action, until the live update catches up. */
function useLiveMessage(message: ChatMessage) {
  const [override, setOverride] = useState<ChatMessage | null>(null)
  useEffect(() => setOverride(null), [message.blocks])
  return [override ?? message, setOverride] as const
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function PollCardView({ message, me, canManage }: { message: ChatMessage; me: string | null; canManage?: boolean }) {
  const [live, setLive] = useLiveMessage(message)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const poll = pollOf(live)
  if (!poll) return null

  const total = pollVoterCount(poll)
  const mine = new Set(Object.entries(poll.voters).filter(([, ids]) => !!me && ids.includes(me)).map(([option]) => option))
  const canClose = !poll.closed && (!!canManage || (!!me && message.authorUserId === me))
  const disabled = busy || poll.closed || !!message.pending

  const run = async (action: () => Promise<ChatMessage>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      setLive(await action())
    } catch (err) {
      setError(errorText(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="mt-1.5 w-full max-w-[420px] gap-2 rounded-xl border border-border bg-card p-3" testID="poll-card">
      <View className="flex-row items-start gap-2">
        <BarChart3 size={15} className="mt-0.5 text-primary" />
        <Text className="flex-1 text-sm font-semibold text-foreground">{poll.question}</Text>
        {poll.closed ? <Lock size={13} className="mt-0.5 text-muted-foreground" accessibilityLabel="Poll closed" /> : null}
      </View>
      {poll.options.map((option) => {
        const votes = poll.tally[option.id] ?? 0
        const pct = total ? Math.round((votes / total) * 100) : 0
        const picked = mine.has(option.id)
        return (
          <Pressable
            key={option.id}
            disabled={disabled}
            onPress={() => void run(() => teamChatApi().voteOnMessage(message.id, option.id), 'Could not record your vote')}
            accessibilityRole={poll.multiple ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: picked, disabled }}
            accessibilityLabel={`${option.text}, ${votes} ${votes === 1 ? 'vote' : 'votes'}`}
            className={cn('overflow-hidden rounded-lg border px-3 py-2 active:opacity-80', picked ? 'border-primary' : 'border-border')}
            testID={`poll-option-${option.id}`}
          >
            <View className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${pct}%` }} />
            <View className="flex-row items-center gap-2">
              <View className={cn('h-4 w-4 items-center justify-center border', poll.multiple ? 'rounded' : 'rounded-full', picked ? 'border-primary bg-primary' : 'border-muted-foreground/50')}>
                {picked ? <Check size={10} color="white" /> : null}
              </View>
              <Text className="flex-1 text-sm text-foreground">{option.text}</Text>
              <Text className="text-xs text-muted-foreground">{votes}</Text>
            </View>
          </Pressable>
        )
      })}
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-[11px] text-muted-foreground">
          {total} {total === 1 ? 'person has' : 'people have'} voted{poll.multiple ? ' · pick any' : ''}
          {poll.closed ? ' · closed' : ''}
        </Text>
        {canClose ? (
          <Pressable onPress={() => void run(() => teamChatApi().closePoll(message.id), 'Could not close the poll')} accessibilityRole="button" className="rounded-md border border-border px-2 py-1 active:bg-muted">
            <Text className="text-[11px] font-medium text-foreground">Close poll</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text className="text-[11px] text-destructive">{error}</Text> : null}
    </View>
  )
}

export function AudienceQuestionCardView({ message, me, canManage }: { message: ChatMessage; me: string | null; canManage?: boolean }) {
  const [live, setLive] = useLiveMessage(message)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = audienceQuestionOf(live)
  if (!question) return null

  const upvoted = !!me && question.upvoters.includes(me)
  const canMark = !!canManage || (!!me && message.authorUserId === me)
  const asker = message.author?.name ?? 'Someone'

  const run = async (action: () => Promise<ChatMessage>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      setLive(await action())
    } catch (err) {
      setError(errorText(err, fallback))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className={cn('mt-1.5 w-full max-w-[420px] flex-row items-start gap-2 rounded-xl border bg-card p-3', question.answered ? 'border-emerald-500/40' : 'border-border')} testID="question-card">
      <Pressable
        disabled={busy || !!message.pending}
        onPress={() => void run(() => teamChatApi().voteOnMessage(message.id, 'up'), 'Could not upvote')}
        accessibilityRole="button"
        accessibilityState={{ selected: upvoted }}
        accessibilityLabel={`${upvoted ? 'Remove upvote' : 'Upvote'}, ${question.upvotes} ${question.upvotes === 1 ? 'upvote' : 'upvotes'}`}
        className={cn('items-center rounded-lg border px-2 py-1 active:opacity-80', upvoted ? 'border-primary bg-primary/10' : 'border-border')}
        testID="question-upvote"
      >
        <ChevronUp size={14} className={upvoted ? 'text-primary' : 'text-muted-foreground'} />
        <Text className={cn('text-xs font-semibold', upvoted ? 'text-primary' : 'text-foreground')}>{question.upvotes}</Text>
      </Pressable>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-1">
          <HelpCircle size={12} className="text-muted-foreground" />
          <Text className="text-[11px] text-muted-foreground">{asker} asked</Text>
          {question.answered ? <Text className="text-[11px] font-medium text-emerald-600">Answered</Text> : null}
        </View>
        <Text className="text-sm text-foreground">{message.text}</Text>
        {canMark ? (
          <Pressable
            disabled={busy}
            onPress={() => void run(() => teamChatApi().setQuestionAnswered(message.id, !question.answered), 'Could not update the question')}
            accessibilityRole="button"
            className="self-start rounded-md border border-border px-2 py-1 active:bg-muted"
          >
            <Text className="text-[11px] font-medium text-foreground">{question.answered ? 'Mark unanswered' : 'Mark answered'}</Text>
          </Pressable>
        ) : null}
        {error ? <Text className="text-[11px] text-destructive">{error}</Text> : null}
      </View>
    </View>
  )
}
