// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link to another message, rendered as what it points at: who wrote it, when,
 * and the opening of the message — the way Slack and Discord show a quoted
 * message, instead of a URL you have to decode.
 *
 * The quote is built per viewer at render time from
 * `GET /api/conversation-messages/:id`, which already enforces membership and
 * per-message visibility, so a message someone can't read never reaches this
 * component. The server answers 404 for both "deleted" and "not yours" there,
 * and the card says the same neutral thing for either: naming which of the two
 * it was would tell a stranger what exists in a channel they're not in.
 */
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { CornerDownRight, MessageSquare } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ChatMessage } from '../../lib/team-chat-api'
import { formatShortTime } from '../../lib/team-chat-time'
import { markdownToPlainText, renderMentions, type MentionNames } from '../../lib/team-chat-state'
import type { MessageQuote } from '../../lib/message-quotes'

const api = teamChatApi()

type QuoteState =
  | { status: 'loading' }
  | { status: 'ready'; message: ChatMessage }
  | { status: 'unavailable' }

/**
 * One fetch per message, session-wide: a channel where three people quote the
 * same message asks for it once, and a message this viewer cannot read is not
 * re-asked on every re-render. In memory only — nothing here is persisted.
 */
const resolved = new Map<string, QuoteState>()
const inflight = new Map<string, Promise<QuoteState>>()

function loadQuote(messageId: string): Promise<QuoteState> {
  const settled = resolved.get(messageId)
  if (settled) return Promise.resolve(settled)
  const pending = inflight.get(messageId)
  if (pending) return pending

  const request = api
    .message(messageId)
    .then((message): QuoteState => {
      const state: QuoteState = { status: 'ready', message }
      resolved.set(messageId, state)
      return state
    })
    .catch((err: { status?: number }): QuoteState => {
      const state: QuoteState = { status: 'unavailable' }
      // 404 is the server's only answer for a message this viewer may not
      // read, deleted or elsewhere, so that one is worth remembering; anything
      // else is worth retrying on the next mount.
      if (err?.status === 404) resolved.set(messageId, state)
      else console.warn('[message-quote] could not load quoted message:', err)
      return state
    })
    .finally(() => {
      inflight.delete(messageId)
    })

  inflight.set(messageId, request)
  return request
}

/** Drop the session cache. Tests only. */
export function resetMessageQuoteCache(): void {
  resolved.clear()
  inflight.clear()
}

function useQuotedMessage(messageId: string): QuoteState {
  const [state, setState] = useState<QuoteState>(() => resolved.get(messageId) ?? { status: 'loading' })

  useEffect(() => {
    const settled = resolved.get(messageId)
    if (settled) {
      setState(settled)
      return
    }
    let live = true
    setState({ status: 'loading' })
    void loadQuote(messageId).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [messageId])

  return state
}

function authorName(message: ChatMessage): string {
  return message.author?.name ?? message.authorAgent?.name ?? 'Someone'
}

/** Where the quoted message lives, as its own links label it. */
function channelLabel(conversation: NonNullable<ChatMessage['conversation']>): string {
  if (conversation.kind === 'dm') return 'DM'
  if (conversation.kind === 'group_dm') return 'Group DM'
  if (conversation.kind === 'activity') return 'Activity'
  return conversation.name ? `#${conversation.name}` : 'Channel'
}

/**
 * The opening of the quoted message as a reader should see it: mention tokens
 * turned into the names they stand for, and markdown reduced to the text it
 * marks up.
 *
 * The body this reads is the message's stored source, so a mention arrives as
 * `<@u:200cca11-…>` — a wire token, not a name. Showing that verbatim is what
 * made a quote read as a wall of ids. `names` is the same workspace-wide map
 * the message body resolves its own mentions from, so the quote names people
 * exactly as the channel does, and an unknown id degrades to `@someone` rather
 * than to an id.
 *
 * Cut to one line and left untruncated: the card clamps it with `numberOfLines`,
 * which adds its own ellipsis on both platforms.
 */
function excerpt(message: ChatMessage, names: MentionNames): string {
  const text = markdownToPlainText(renderMentions(message.text ?? '', names))
  if (text) return text
  const count = message.attachments.length
  if (count) return count === 1 ? 'Shared a file' : `Shared ${count} files`
  return 'No preview for this message'
}

export interface MessageQuoteCardProps {
  quote: MessageQuote
  names: MentionNames
  className?: string
}

export function MessageQuoteCard({ quote, names, className }: MessageQuoteCardProps) {
  const router = useRouter()
  const state = useQuotedMessage(quote.target.messageId)
  const { conversationId, messageId, threadRootId } = quote.target

  const open = () => {
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId, msg: messageId, ...(threadRootId ? { thread: threadRootId } : {}) },
    } as never)
  }

  if (state.status === 'unavailable') {
    return (
      <View
        className={cn(
          'mt-1.5 max-w-[520px] flex-row items-start gap-2 rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2',
          className,
        )}
        testID="message-quote-unavailable"
      >
        <MessageSquare size={13} className="mt-0.5 text-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-muted-foreground">Message unavailable</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            It may have been deleted, or it's in a conversation you can't see.
          </Text>
        </View>
      </View>
    )
  }

  if (state.status === 'loading') {
    return (
      <View
        className={cn(
          'mt-1.5 max-w-[520px] rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2',
          className,
        )}
        testID="message-quote-loading"
      >
        <Text className="text-xs text-muted-foreground">Loading quoted message…</Text>
      </View>
    )
  }

  const { message } = state
  const deleted = !!message.deletedAt
  const { conversation } = message

  return (
    <Pressable
      onPress={deleted ? undefined : open}
      disabled={deleted}
      accessibilityRole={deleted ? undefined : 'link'}
      accessibilityLabel={`Quoted message from ${authorName(message)}${conversation ? ` in ${channelLabel(conversation)}` : ''}`}
      className={cn(
        'mt-1.5 max-w-[520px] flex-row items-start gap-2 rounded-md border-l-4 border-primary/50 bg-muted/40 py-2 pl-3 pr-2',
        !deleted && 'active:bg-muted',
        className,
      )}
      testID="message-quote"
    >
      <CornerDownRight size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline gap-1.5">
          {conversation ? (
            <Text
              className="shrink-0 text-[11px] font-medium text-muted-foreground"
              numberOfLines={1}
              testID="message-quote-channel"
            >
              {channelLabel(conversation)}
            </Text>
          ) : null}
          <Text className="min-w-0 shrink text-sm font-semibold text-foreground" numberOfLines={1}>
            {authorName(message)}
          </Text>
          <Text className="text-[11px] text-muted-foreground">{formatShortTime(message.createdAt)}</Text>
        </View>
        <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={3}>
          {deleted ? 'This message was deleted.' : excerpt(message, names)}
        </Text>
        {deleted ? null : (
          <Text className="mt-1 text-[11px] font-medium text-primary">Jump to message</Text>
        )}
      </View>
    </Pressable>
  )
}

/** Every quoted message in one body, in the order they appeared. */
export function MessageQuoteCards({ quotes, names, className }: { quotes: MessageQuote[]; names: MentionNames; className?: string }) {
  if (!quotes.length) return null
  return (
    <View className={cn('gap-1.5', className)} testID="message-quotes">
      {quotes.map((quote) => (
        <MessageQuoteCard key={`${quote.target.messageId}:${quote.href}`} quote={quote} names={names} />
      ))}
    </View>
  )
}
