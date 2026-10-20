// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The inline card a shared link to one of *our* messages or channels renders,
 * as Slack does: who wrote it, which channel it is in, the opening lines, and
 * "Show more" to read the rest without leaving the conversation.
 *
 * The card holds no content of its own. Every mount fetches the preview for
 * the person looking at it, through an endpoint that runs the same access check
 * as the conversation itself. A reader who cannot open the conversation gets
 * nothing at all — not a partial card, and not a fallback to the generic
 * website unfurl, which would at least reveal that something is there.
 */
import { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'
import { Hash, Lock, MessageSquare } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { openChatLinkInApp } from '../../lib/chat-link-navigation'
import {
  teamChatApi,
  type ChatMessage,
  type LinkPreviewConversation,
  type MessageLinkPreview,
} from '../../lib/team-chat-api'
import { previewTargetsFor, type ChatLinkTarget } from '../../lib/team-chat-links'
import { formatTime } from '../../lib/team-chat-time'

const api = teamChatApi()

type PreviewState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'ready'; conversation: LinkPreviewConversation; message: MessageLinkPreview['message'] | null }

/**
 * One entry per link, for the life of the session.
 *
 * The timeline is virtualized: rows unmount and remount as you scroll, so
 * re-asking the server for the same card each time would turn scrolling into a
 * request storm. Only two outcomes are remembered — a resolved preview, and a
 * refusal (which is final, and re-asking it could only ever reveal something a
 * later retry should not). A transient failure is deliberately *not* cached, so
 * a flaky moment does not cost you the card for the rest of the session.
 */
const resolvedPreviews = new Map<string, PreviewState>()
const refusedPreviews = new Set<string>()

export const __resetLinkPreviewCacheForTest = () => {
  resolvedPreviews.clear()
  refusedPreviews.clear()
}

function cacheKey(target: ChatLinkTarget): string {
  return `${target.kind}:${target.conversationId}:${target.messageId ?? ''}`
}

/**
 * Resolves one link as this reader.
 *
 * "Not allowed" and "does not exist" are deliberately the same answer here, and
 * both render nothing — so a link can never tell you whether a private channel
 * it points into is real.
 */
function useLinkPreview(target: ChatLinkTarget): PreviewState {
  const key = cacheKey(target)
  const [state, setState] = useState<PreviewState>(() =>
    refusedPreviews.has(key) ? { status: 'hidden' } : resolvedPreviews.get(key) ?? { status: 'loading' },
  )
  const { kind, conversationId, messageId } = target

  useEffect(() => {
    if (refusedPreviews.has(key) || resolvedPreviews.has(key)) return
    let live = true
    setState({ status: 'loading' })
    const load = async () => {
      try {
        const next: PreviewState =
          kind === 'message' && messageId
            ? await api.messagePreview(messageId).then((preview) => ({
                status: 'ready' as const,
                conversation: preview.conversation,
                message: preview.message,
              }))
            : await api.conversationPreview(conversationId).then((preview) => ({
                status: 'ready' as const,
                conversation: preview.conversation,
                message: null,
              }))
        resolvedPreviews.set(key, next)
        if (live) setState(next)
      } catch (error) {
        // A refusal is the server's answer, not a symptom — remember it.
        if ((error as { status?: number } | null)?.status === 404) refusedPreviews.add(key)
        if (live) setState({ status: 'hidden' })
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [key, kind, conversationId, messageId])

  return state
}

function ChannelLabel({ conversation }: { conversation: LinkPreviewConversation }) {
  const isChannel = conversation.kind === 'public' || conversation.kind === 'private' || conversation.kind === 'activity'
  const name = conversation.name ?? (conversation.kind === 'dm' ? 'Direct message' : 'this conversation')
  return (
    <View className="min-w-0 flex-row items-center gap-1">
      {conversation.private ? (
        <Lock size={11} className="text-muted-foreground" accessibilityLabel="Private" />
      ) : isChannel ? (
        <Hash size={11} className="text-muted-foreground" />
      ) : (
        <MessageSquare size={11} className="text-muted-foreground" />
      )}
      <Text className="text-[11px] font-medium text-muted-foreground" numberOfLines={1}>
        {isChannel ? `#${name}` : name}
      </Text>
    </View>
  )
}

function AuthorAvatar({ name, image }: { name: string; image: string | null }) {
  const uri = resolveAvatarUrl(image)
  if (uri) {
    return <Image source={{ uri }} className="h-4 w-4 rounded" accessibilityIgnoresInvertColors accessibilityLabel={name} />
  }
  return (
    <View className="h-4 w-4 items-center justify-center rounded bg-muted">
      <Text className="text-[9px] font-semibold text-muted-foreground">{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  )
}

/**
 * One card. Pressing the card opens the message (or channel) in place.
 *
 * "Show more" deliberately sits *outside* the pressable area rather than nested
 * inside it: a nested press is handled inconsistently across platforms (web
 * bubbles the click to the card as well), and expanding a preview must never
 * navigate you away from the message you are reading.
 */
export function ChatLinkPreviewCard({ target }: { target: ChatLinkTarget }) {
  const preview = useLinkPreview(target)
  const [expanded, setExpanded] = useState(false)

  if (preview.status !== 'ready') return null
  const { conversation, message } = preview

  const open = () => {
    openChatLinkInApp(target)
  }

  const expandable = !!message && (message.truncated || message.text.includes('\n'))
  const hasFooter = expandable || (!!message && !!message.threadRootId)

  return (
    <View className="max-w-[520px] rounded-lg border border-border bg-card/60">
      <Pressable
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={
          message
            ? `Message from ${message.authorName} in ${conversation.name ?? 'a conversation'}`
            : `Conversation ${conversation.name ?? ''}`.trim()
        }
        testID="chat-link-preview"
        className={cn('px-3 pt-3 active:bg-muted/60', hasFooter ? 'pb-1.5' : 'pb-3', 'rounded-lg')}
      >
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          {message ? (
            <>
              <AuthorAvatar name={message.authorName} image={message.authorImage} />
              <Text className="text-xs font-semibold text-foreground" numberOfLines={1}>
                {message.authorName}
              </Text>
              <ChannelLabel conversation={conversation} />
              <Text className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</Text>
            </>
          ) : (
            <>
              <ChannelLabel conversation={conversation} />
              <Text className="text-[11px] text-muted-foreground">
                {conversation.private ? 'Private channel' : 'Channel'}
              </Text>
            </>
          )}
        </View>

        {message ? (
          message.deleted ? (
            <Text className="mt-1.5 text-sm italic text-muted-foreground">This message was deleted.</Text>
          ) : (
            <Text className={cn('mt-1.5 text-sm text-foreground')} numberOfLines={expanded ? undefined : 3}>
              {message.text}
            </Text>
          )
        ) : conversation.topic ? (
          <Text className="mt-1.5 text-sm text-muted-foreground" numberOfLines={expanded ? undefined : 2}>
            {conversation.topic}
          </Text>
        ) : null}
      </Pressable>

      {hasFooter ? (
        <View className="flex-row items-center gap-3 px-3 pb-2.5">
          {message && message.threadRootId ? (
            <Text className="text-[11px] text-muted-foreground">Replied in a thread</Text>
          ) : null}
          {expandable ? (
            <Pressable
              onPress={() => setExpanded((value) => !value)}
              accessibilityRole="button"
              testID="chat-link-preview-toggle"
            >
              <Text className="text-[11px] font-semibold text-primary">{expanded ? 'Show less' : 'Show more'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/**
 * Every preview a message earns. Rendered under the body, in the same slot the
 * website unfurls used to occupy.
 */
export function ChatLinkPreviews({ message }: { message: Pick<ChatMessage, 'id' | 'text' | 'blocks'> }) {
  const targets = useMemo(
    () => previewTargetsFor(message.text, message.blocks, { selfId: message.id }),
    [message.text, message.blocks, message.id],
  )
  if (!targets.length) return null
  return (
    <View className="mt-1.5 gap-1.5">
      {targets.map((target) => (
        <ChatLinkPreviewCard key={`${target.kind}:${target.conversationId}:${target.messageId ?? ''}`} target={target} />
      ))}
    </View>
  )
}
