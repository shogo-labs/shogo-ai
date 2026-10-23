// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One message in a team chat timeline: author header (grouped), Markdown
 * body with mentions, attachments, reactions, thread summary, and live agent
 * replies (streaming text, the tool in use, Stop).
 */
import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Image, Linking, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { createPortal } from 'react-dom'
import { useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { AlarmClock, AlertCircle, Bookmark, Check, CircleDot, ClipboardCopy, CornerDownRight, FileText, Headphones, KanbanSquare, Link2, Loader2, MessageSquare, MoreHorizontal, NotebookPen, Pencil, Pin, SmilePlus, Trash2, UserPlus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { ChatMarkdown } from '../chat/ChatMarkdown'
import type { MentionTarget } from '../chat/file-links'
import { SidebarContextMenu, type SidebarMenuEntry, type SidebarMenuItem } from '../layout/SidebarContextMenu'
import { MessageActionSheet } from './MessageActionSheet'
import { absoluteApiUrl, teamChatApi, type ChatMessage, type LinkUnfurl, type ReactionSummary } from '../../lib/team-chat-api'
import { messageLink, openMessageLinkInApp } from '../../lib/team-chat-links'
import { extractMessageQuotes } from '../../lib/message-quotes'
import { previewOptOutMatcher } from '../../lib/link-preview-consent'
import { MessageQuoteCards } from './MessageQuoteCard'
import { activityTarget } from '../../lib/activity-target'
import { formatFullTime, formatShortTime, formatTime } from '../../lib/team-chat-time'
import { EmojiPicker } from './EmojiPicker'
import { AgentAvatar } from './AgentAvatar'
import { ShogoAvatar } from './ShogoAvatar'
import { AgentProfileCard } from './AgentProfileCard'
import { ApprovalCardView, StatusCardView } from './AgentStatus'
import { WorkItemCard } from './WorkItemCard'
import { QuestionCardView } from './QuestionCard'
import { AudienceQuestionCardView, PollCardView } from './PollCard'
import { QueuedWakeRow, wakeQueuedOf } from './QueuedWakeRow'
import { approvalOf, audienceQuestionOf, connectRequestsOf, pollOf, isAskedOf, messageKind, questionRefsOf, questionsOf, statusCardOf, workItemOf, workOf, type WorkItemBlock } from '../../lib/team-chat-kinds'
import { continueAfterConnect } from '../../lib/question-answer'
import { IntegrationConnectCard } from '../chat/IntegrationConnectCard'
import { ImagePreviewModal } from '../chat/ImagePreviewModal'
import { AgentWorkedFor } from './AgentWork'
import { markdownToPlainText, renderMentions, renderMentionsMarkdown, type MentionNames } from '../../lib/team-chat-state'
import { isVoiceNote } from '../../lib/voice-note'
import { VoiceNotePlayer } from './VoiceNotePlayer'
import { DownloadBadge, FileAttachmentCard } from './FileAttachmentCard'
import { ChatImageAttachment } from './ChatImageAttachment'
import { PastedMarkdownCard } from './MarkdownAttachmentBody'
import { isPastedMarkdownAttachment } from '../chat/long-text-utils'
import { VideoAttachment } from './VideoAttachment'
import { useMeasuredWidth } from '../chat/turns/use-measured-width'
import { hasReacted, reactionDetail, reactionTooltip } from '../../lib/team-chat-reactions'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { PresenceDot } from './PresenceDot'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { toggleSaved, useIsSaved } from '../../hooks/useChatItems'
import { customEmojiFor, jumboEmojiCodes, useCustomEmoji } from '../../hooks/useCustomEmoji'
import { useEditRequest } from '../../hooks/useChatShortcuts'
import { useMobileWorkspaceChrome } from '../layout/MobileWorkspaceChromeContext'
import { HuddleWakeNote, huddleWakeBlockOf } from './HuddleWakeNote'

export const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '😂']

/** Above this, an update carrying a question for the viewer folds behind "Show full update". */
const LONG_UPDATE_CHARS = 600

const api = teamChatApi()

export const REMIND_OPTIONS: Array<{ label: string; at: () => Date }> = [
  { label: 'In 20 minutes', at: () => new Date(Date.now() + 20 * 60_000) },
  { label: 'In 1 hour', at: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'In 3 hours', at: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: 'Tomorrow',
    at: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d
    },
  },
]

export interface MessageRowProps {
  message: ChatMessage
  grouped: boolean
  me: string | null
  names: MentionNames
  streaming?: {
    text: string
    tool: string | null
    tools?: Array<{ name: string; done: boolean }>
    queue?: { position: number; ahead: number; running: number; limit: number } | null
    waiting?: { tool: string | null } | null
  }
  canManage: boolean
  /** Can pin (anyone who can post or reply here). */
  canPin?: boolean
  workspaceId?: string
  inThread?: boolean
  onReply?: (message: ChatMessage) => void
  /** Add (`on: true`) or remove (`on: false`) a reaction; omit to let the handler toggle. */
  onReact: (message: ChatMessage, emoji: string, on?: boolean) => void
  onEdit: (message: ChatMessage, text: string) => Promise<void>
  onDelete: (message: ChatMessage) => void
  onRetry: (message: ChatMessage) => void
  onDiscard: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
  /** Show an agent's project beside the conversation (wide screens only). */
  onOpenProjectPane?: (projectId: string, name: string) => void
  /** Open a person's profile — from their name, their photo, or a mention of them. */
  onOpenProfile?: (userId: string) => void
  /** What an @-mention in the message points at (an agent is opened by the host). */
  onMentionPress?: (target: MentionTarget) => void
  /** Move the read line back to just before this message. */
  onMarkUnread?: (message: ChatMessage) => void
  /** Turn this message into a card on one of the channel's boards. */
  onMakeCard?: (message: ChatMessage) => void
  /** Briefly emphasized after opening a link to it. */
  highlighted?: boolean
}

/**
 * Links this app can open in place — see `team-chat-links`; re-exported here
 * because the row is where a message's links are handled.
 */
export { openMessageLinkInApp } from '../../lib/team-chat-links'

/**
 * Wraps a message time so hovering it underlines the time and shows the full
 * date and time in a dark bubble above it (web only; passthrough on native).
 * `children` receives whether the time is hovered.
 */
function TimeTooltip({ iso, align = 'center', children }: { iso: string; align?: 'center' | 'start'; children: (hovered: boolean) => ReactNode }) {
  const [hovered, setHovered] = useState(false)
  if (Platform.OS !== 'web') return <>{children(false)}</>
  return createElement(
    'div',
    {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      style: { position: 'relative', display: 'inline-flex', whiteSpace: 'nowrap' },
    },
    children(hovered),
    hovered
      ? createElement(
          'div',
          {
            role: 'tooltip',
            'data-testid': 'time-tooltip',
            style: { position: 'absolute', bottom: '100%', ...(align === 'start' ? { left: 0 } : { left: '50%', transform: 'translateX(-50%)' }), marginBottom: 6, zIndex: 100, pointerEvents: 'none', whiteSpace: 'nowrap', width: 'max-content' },
          },
          <View className={align === 'start' ? 'items-start' : 'items-center'}>
            <View className="rounded-md border border-transparent bg-zinc-900 px-3 py-2 shadow-lg dark:border-white/20 dark:bg-zinc-600">
              <Text className="text-sm font-semibold text-white">{formatFullTime(iso)}</Text>
            </View>
            <View className={cn('-mt-1 h-2 w-2 rotate-45 bg-zinc-900 dark:bg-zinc-600', align === 'start' && 'ml-3')} />
          </View>,
        )
      : null,
  )
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
}

/** Open a channel from an agent's profile card. */
function openConversationInApp(conversationId: string): void {
  void import('expo-router').then(({ router }) =>
    router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId } } as any),
  )
}

function Avatar({ message, onPress }: { message: ChatMessage; onPress?: () => void }) {
  if (message.authorType === 'agent') {
    const name = message.authorAgent?.name ?? 'Agent'
    const avatar = <AgentAvatar name={name} projectId={message.authorAgent?.projectId ?? null} workspaceId={message.workspaceId} iconUrl={message.authorAgent?.iconUrl} />
    if (!onPress) return avatar
    return (
      <Pressable onPress={onPress} accessibilityLabel={`${name} profile`} accessibilityRole="button">
        {avatar}
      </Pressable>
    )
  }
  if (message.authorType === 'system') {
    return <ShogoAvatar workspaceId={message.workspaceId} />
  }
  const name = message.author?.name ?? 'Someone'
  const photo = (
    <View className="relative">
      {message.author?.image ? (
        <Image source={{ uri: resolveAvatarUrl(message.author.image) ?? undefined }} className="h-8 w-8 rounded-lg" accessibilityIgnoresInvertColors />
      ) : (
        <View className="h-8 w-8 items-center justify-center rounded-lg bg-secondary">
          <Text className="text-xs font-semibold text-secondary-foreground">{initials(name)}</Text>
        </View>
      )}
      <PresenceDot userId={message.authorUserId} size={10} badge />
    </View>
  )
  if (!onPress) return photo
  return (
    <Pressable onPress={onPress} accessibilityLabel={`${name} avatar`} accessibilityRole="button">
      {photo}
    </Pressable>
  )
}

function authorName(message: ChatMessage): string {
  if (message.authorType === 'agent') return message.authorAgent?.name ?? 'Agent'
  if (message.authorType === 'system') return 'Shogo'
  if (message.authorType === 'bot') return 'Bot'
  return message.author?.name ?? 'Someone'
}

function onBehalfOfName(message: ChatMessage): string | null {
  const value = message.blocks?.onBehalfOf
  if (!value || typeof value !== 'object') return null
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' && name.trim() ? name : null
}

function AuthorStatus({ userId }: { userId: string | null | undefined }) {
  const status = useUserStatus(undefined, userId)
  if (!status?.emoji && !status?.dnd) return null
  const label = [status.text, status.dnd ? 'Do not disturb' : null].filter(Boolean).join(' · ')
  return (
    <Text className="text-xs" accessibilityLabel={label || 'Status'} {...({ title: label } as object)}>
      {status.emoji ?? ''}
      {status.dnd ? <Text className="text-[10px] text-muted-foreground"> 🔕</Text> : null}
    </Text>
  )
}

function UnfurlCards({ message }: { message: ChatMessage }) {
  const unfurls = (message.blocks as { unfurls?: LinkUnfurl[] } | null)?.unfurls
  if (!Array.isArray(unfurls)) return null
  const live = unfurls.filter((u) => message.text.includes(u.url))
  if (!live.length) return null
  return (
    <View className="mt-1.5 gap-1.5">
      {live.map((u) => (
        <Pressable
          key={u.url}
          onPress={() => Linking.openURL(u.url)}
          accessibilityRole="link"
          accessibilityLabel={`Link preview: ${u.title}`}
          className="max-w-[520px] flex-row gap-3 rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2 active:bg-muted"
        >
          <View className="min-w-0 flex-1">
            {u.siteName ? <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{u.siteName}</Text> : null}
            <Text className="text-sm font-semibold text-primary" numberOfLines={2}>{u.title}</Text>
            {u.description ? <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={3}>{u.description}</Text> : null}
          </View>
          {u.image ? (
            <Image source={{ uri: resolveAvatarUrl(u.image) ?? undefined }} className="h-16 w-16 rounded" resizeMode="cover" accessibilityIgnoresInvertColors />
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}

function ReactionGlyph({ emoji, size = 12 }: { emoji: string; size?: number }) {
  const custom = customEmojiFor(emoji, useCustomEmoji())
  if (custom) {
    return <Image source={{ uri: custom.url }} style={{ width: size + 4, height: size + 4 }} accessibilityLabel={emoji} />
  }
  return <Text style={{ fontSize: size }}>{emoji}</Text>
}

/** The text of a "who reacted" card: a large emoji, then bold names and what they did. */
function ReactionDetailCard({ emoji, userIds, me, names }: { emoji: string; userIds: string[]; me: string | null; names: MentionNames }) {
  const { who, verb, viewerReacted } = reactionDetail(emoji, userIds, me, names)
  return (
    <View className="items-center" style={{ alignItems: 'center' }}>
      <View
        className="rounded-lg border border-transparent bg-zinc-900 px-3 py-3 shadow-lg dark:border-white/20 dark:bg-zinc-600"
        style={{ width: 240, flexDirection: 'column', alignItems: 'center', gap: 8 }}
      >
        <View className="rounded-md bg-white" style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
          <ReactionGlyph emoji={emoji} size={40} />
        </View>
        <Text className="text-sm text-white" style={{ textAlign: 'center' }} testID="reaction-tooltip-text">
          <Text className="font-bold text-white">{who}</Text>
          {/* Only when the click would remove: the chip toggles, so say which way. */}
          {viewerReacted ? <Text className="text-zinc-400"> ({Platform.OS === 'web' ? 'click' : 'tap'} to remove)</Text> : null}
          <Text className="text-zinc-300"> {verb}</Text>
        </Text>
      </View>
      <View className="-mt-1 h-2 w-2 rotate-45 bg-zinc-900 dark:bg-zinc-600" />
    </View>
  )
}

/** Hover delay before the card appears, so a pointer passing over a chip doesn't flash it. */
const REACTION_TOOLTIP_DELAY_MS = 150

/**
 * Shows who reacted in a card above the chip on hover (web). Positioned like
 * `TimeTooltip`; `align="start"` anchors it to the chip's left edge when the
 * chip sits near the window edge.
 */
function ReactionTooltip({ emoji, userIds, me, names, children }: { emoji: string; userIds: string[]; me: string | null; names: MentionNames; children: ReactNode }) {
  // The anchor is the chip's viewport rect; the card is portaled to <body> (like
  // SidebarContextMenu) so the message row's own stacking contexts can't paint over it.
  const [anchor, setAnchor] = useState<{ left: number; right: number; top: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  if (Platform.OS !== 'web') return <>{children}</>
  const align = anchor && anchor.left < 140 ? 'start' : 'center'
  return createElement(
    'div',
    {
      onMouseEnter: (e: { currentTarget: HTMLElement }) => {
        clear()
        const rect = e.currentTarget?.getBoundingClientRect?.()
        timer.current = setTimeout(() => {
          setAnchor(rect ? { left: rect.left, right: rect.right, top: rect.top } : { left: 0, right: 0, top: 0 })
        }, REACTION_TOOLTIP_DELAY_MS)
      },
      onMouseLeave: () => {
        clear()
        setAnchor(null)
      },
      style: { display: 'inline-flex' },
    },
    children,
    anchor && typeof document !== 'undefined'
      ? createPortal(
          createElement(
            'div',
            {
              role: 'tooltip',
              'data-testid': 'reaction-tooltip',
              style: {
                position: 'fixed',
                top: anchor.top - 6,
                ...(align === 'start'
                  ? { left: anchor.left, transform: 'translateY(-100%)' }
                  : { left: (anchor.left + anchor.right) / 2, transform: 'translate(-50%, -100%)' }),
                zIndex: 9999,
                pointerEvents: 'none',
              },
            },
            <View className={align === 'start' ? 'items-start' : 'items-center'} style={{ alignItems: align === 'start' ? 'flex-start' : 'center' }}>
              <ReactionDetailCard emoji={emoji} userIds={userIds} me={me} names={names} />
            </View>,
          ),
          document.body,
        )
      : null,
  )
}

const PICKER_W = 312
const PICKER_H = 360

/**
 * The reaction picker as a Slack-style popover: portaled to <body> and pinned
 * under the button that opened it. The previous centred modal dimmed and hid the
 * very message being reacted to, and on a wide window put the picker a screen
 * away from the pointer.
 *
 * `trigger` is excluded from the outside-click close so the button keeps its own
 * toggle — otherwise mousedown closes the popover and the click reopens it.
 */
function ReactionPickerPopover({
  left,
  top,
  trigger,
  onClose,
  children,
}: {
  left: number
  top: number
  trigger: HTMLElement | null
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (trigger?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // A fixed-position popover would otherwise hang in place while the timeline
    // scrolls out from under it. `capture` because scroll does not bubble.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose, trigger])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={ref}
      data-testid="reaction-picker-popover"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left, top, zIndex: 9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** One reaction chip: tap toggles; hover (web) or long press (native) shows who reacted. */
function ReactionChip({ reaction, reacted, label, me, names, onToggle }: { reaction: ReactionSummary; reacted: boolean; label: string; me: string | null; names: MentionNames; onToggle: () => void }) {
  const [sheet, setSheet] = useState(false)
  return (
    <>
      <ReactionTooltip emoji={reaction.emoji} userIds={reaction.userIds} me={me} names={names}>
        <Pressable
          onPress={onToggle}
          onLongPress={Platform.OS === 'web' ? undefined : () => setSheet(true)}
          accessibilityLabel={label}
          className={cn(
            'flex-row items-center gap-1 rounded-full border px-2 py-0.5',
            reacted ? 'border-primary/50 bg-primary/10' : 'border-border bg-card',
          )}
        >
          <ReactionGlyph emoji={reaction.emoji} />
          <Text className={cn('text-[11px]', reacted ? 'text-primary' : 'text-muted-foreground')}>{reaction.count}</Text>
        </Pressable>
      </ReactionTooltip>
      {sheet && Platform.OS !== 'web' && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setSheet(false)}>
          <Pressable className="flex-1 items-center justify-center bg-black/40" onPress={() => setSheet(false)}>
            <ReactionDetailCard emoji={reaction.emoji} userIds={reaction.userIds} me={me} names={names} />
          </Pressable>
        </Modal>
      )}
    </>
  )
}

/**
 * A message that is nothing but emoji renders large, as in Slack and Discord.
 * The body is 16px everywhere except desktop web's 12px (`text-xs` on the
 * markdown), so the size is derived from it rather than hardcoded — otherwise
 * the same message is 2.5x on a phone and 3.3x in a browser.
 */
const JUMBO_EMOJI_SCALE = 2.5

function bodyTextSize(usesMobileWorkspaceChrome: boolean): number {
  return Platform.OS !== 'web' || usesMobileWorkspaceChrome ? 16 : 12
}

/** One large emoji: a custom image and a unicode glyph occupy the same box. */
function JumboEmoji({ code, size }: { code: string; size: number }) {
  const custom = customEmojiFor(code, useCustomEmoji())
  if (custom) {
    return <Image source={{ uri: custom.url }} style={{ width: size, height: size }} accessibilityLabel={code} />
  }
  // An explicit line height keeps tall glyphs from clipping on Android, where a
  // Text's default line box is sized by the font rather than the font size.
  return (
    <Text style={{ fontSize: size, lineHeight: Math.round(size * 1.15) }} accessibilityLabel={code}>
      {code}
    </Text>
  )
}

/**
 * Hover state for a row whose action bar floats half outside it. Wire `hoverIn`/`hoverOut` to the
 * DOM `onPointerEnter`/`onPointerLeave` of the row, not to `Pressable`'s `onHoverIn`/`onHoverOut`:
 * react-native-web's Pressable hover is `contain`ed, so entering any nested Pressable (every
 * emoji button, reaction chip, ...) ends the hover of all its ancestor Pressables. Pointer
 * enter/leave ignore moves between a row and its descendants. Leaving the row still hides the bar
 * after a short grace period, which entering the row again cancels.
 */
function useRowHover() {
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverIn = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setHovered(true)
  }, [])
  const hoverOut = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setHovered(false)
    }, 180)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { hovered, hoverIn, hoverOut }
}

function MessageRowImpl(props: MessageRowProps) {
  const router = useRouter()
  const { message, grouped, me, names, streaming, canManage, inThread } = props
  const { hovered, hoverIn, hoverOut } = useRowHover()
  const [pickerOpen, setPickerOpen] = useState(false)
  // Web anchor for the picker; null means "no button rect" (e.g. opened from the
  // long-press action sheet), which falls back to the centred sheet.
  const [pickerPos, setPickerPos] = useState<{ left: number; top: number } | null>(null)
  const pickerTrigger = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // The menu and the picker are portaled out of the row, so keep the row lit
  // while either is open.
  const active = hovered || !!menu || pickerOpen
  const [editing, setEditing] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const saved = useIsSaved(message.id)
  const customEmoji = useCustomEmoji()
  const jumboSize = Math.round(bodyTextSize(useMobileWorkspaceChrome()) * JUMBO_EMOJI_SCALE)
  const [draft, setDraft] = useState(message.text)
  const mine = !!me && message.authorUserId === me
  const deleted = !!message.deletedAt
  /**
   * An author's name and photo open their profile. An agent gets the quick
   * card; a person gets whatever the host presents (the side pane on wide
   * screens, the full page on a phone).
   */
  const opensProfile =
    !deleted && (message.authorType === 'agent' || (message.authorType === 'user' && !!props.onOpenProfile && !!message.authorUserId))
  const openAuthorProfile = useCallback(() => {
    if (message.authorType === 'user') {
      if (message.authorUserId) props.onOpenProfile?.(message.authorUserId)
      return
    }
    setProfileOpen(true)
  }, [message.authorType, message.authorUserId, props.onOpenProfile])
  const running = message.authorType === 'agent' && message.agentStatus === 'running'
  const rawBody = running ? streaming?.text ?? '' : message.text
  // A link to another message renders as a quote of it and is taken out of the
  // text; the quote itself is fetched per viewer and never stored on the row.
  // A link whose author declined a preview is the one exception: it stays in the
  // text, so the link is still there for anyone who can open it.
  const optOut = useMemo(() => previewOptOutMatcher(message.blocks), [message.blocks])
  const { body, quotes } = useMemo(
    () => extractMessageQuotes(rawBody ?? '', undefined, { skip: optOut }),
    [rawBody, optOut],
  )
  const card = !running && message.authorType === 'agent' ? statusCardOf(message) : null
  // Board cards are posted by the system, so this is deliberately author-agnostic.
  const workItem = running || deleted ? null : workItemOf(message)
  // Polls and audience questions (from a huddle's thread) replace the text, which only summarises them.
  const pollBlock = running || deleted ? null : pollOf(message)
  const audienceQuestion = running || deleted || pollBlock ? null : audienceQuestionOf(message)
  const approval = !running && message.authorType === 'agent' ? approvalOf(message) : null
  const kind = message.authorType === 'agent' ? messageKind(message) : null
  const onBehalfOf = message.authorType === 'agent' ? onBehalfOfName(message) : null
  const canOpenSession = message.authorType === 'agent' && !!message.agentSessionId && !!props.onOpenSession
  const work = !running && message.authorType === 'agent' ? workOf(message) : null
  const connectRequests = !running && message.authorType === 'agent' ? connectRequestsOf(message) : []
  const [continuedConnects, setContinuedConnects] = useState<string[]>([])
  const questions = !running && message.authorType === 'agent' ? questionsOf(message) : []
  const questionRefs = !running && message.authorType === 'agent' ? questionRefsOf(message) : []
  const openQuestion = questions.some((q) => q.status === 'open')
  const askedOfMe = questions.some((q) => q.status === 'open' && isAskedOf(q, me))
  const [showFullUpdate, setShowFullUpdate] = useState(false)
  const foldBody = askedOfMe && !showFullUpdate && (body?.length ?? 0) > LONG_UPDATE_CHARS
  const isWeb = Platform.OS === 'web'
  // Clicking an image opens the same viewer the agent chat uses instead of
  // handing the URL to the browser. The gallery is the message's own images,
  // so a post with several can be stepped through.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const imageAttachments = deleted ? [] : message.attachments.filter((a) => a.mimeType.startsWith('image/'))
  const imageIndexById = new Map(imageAttachments.map((a, index) => [a.id, index]))
  const activeLightboxImage = lightboxIndex === null ? null : imageAttachments[lightboxIndex] ?? null
  // The row's own width, not the window's: a thread sidebar or side pane is
  // narrower, and an image must fit the space the message actually got.
  const attachmentRow = useMeasuredWidth()
  useEditRequest(message.id, () => {
    if (!mine || deleted || message.authorType !== 'user') return
    setDraft(message.text)
    setEditing(true)
  })

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copyLink = () => {
    const url = messageLink({ conversationId: message.conversationId, messageId: message.id, threadRootId: message.threadRootId })
    void Clipboard.setStringAsync(url).then(() => setCopied(true)).catch(() => {})
  }
  const [copiedMessage, setCopiedMessage] = useState(false)
  useEffect(() => {
    if (!copiedMessage) return
    const t = setTimeout(() => setCopiedMessage(false), 1500)
    return () => clearTimeout(t)
  }, [copiedMessage])
  /**
   * Copies what the message *reads as*, not what is stored. The stored form
   * carries `<@u:id>` tokens, which would paste as UUIDs anywhere outside Shogo.
   */
  const copyMessage = () => {
    const text = markdownToPlainText(renderMentions(message.text ?? '', names)).trim()
    if (!text) return
    void Clipboard.setStringAsync(text).then(() => setCopiedMessage(true)).catch(() => {})
  }
  const markUnread = props.onMarkUnread && !inThread && !message.threadRootId ? () => props.onMarkUnread!(message) : null
  const pin = () => void api.pin(message.id, !message.pinned).catch(() => {})
  const save = () => void toggleSaved(message.id, !saved).catch(() => {})
  const remind = (at: Date) => {
    if (!props.workspaceId) return
    void api.createReminder(props.workspaceId, { messageId: message.id, remindAt: at.toISOString() }).catch(() => {})
  }
  const canAct = !deleted && !message.pending && message.authorType !== 'system'

  /** Clicking a reaction you already have removes it; otherwise it adds it. */
  const toggleReact = (emoji: string) => {
    props.onReact(message, emoji, !hasReacted(message.reactions, emoji, props.me))
  }

  /** Open the card pane: its thread when the post is in a channel, the inbox otherwise. */
  const openWorkItem = (item: WorkItemBlock) => {
    if (message.conversationId) {
      const params: Record<string, string> = { conversationId: message.conversationId, card: item.id }
      if (item.boardId) params.board = item.boardId
      router.push({ pathname: '/(app)/c/[conversationId]', params } as any)
      return
    }
    router.push({ pathname: '/(app)/work', params: { card: item.id } } as any)
  }

  const [actionsOpen, setActionsOpen] = useState(false)
  const openActions = () => {
    if (deleted || message.pending) return
    setActionsOpen(true)
  }

  const startEditing = () => { setDraft(message.text); setEditing(true) }
  /**
   * The message menu, grouped the way Slack groups it. One model feeds both the
   * web context menu and the native sheet, so the two can't drift apart.
   *
   * Reminders are a nested flyout rather than four flat rows: they are a family
   * of the same action, not four separate ones.
   */
  const menuGroups = (): SidebarMenuItem[][] => {
    const icon = (Icon: typeof Link2, tone = 'text-muted-foreground') => <Icon size={14} className={tone} />
    const groups: SidebarMenuItem[][] = []
    if (canAct) {
      const primary: SidebarMenuItem[] = []
      if (props.onReply && !inThread) primary.push({ label: 'Reply in thread', icon: icon(MessageSquare), onSelect: () => props.onReply!(message) })
      if (markUnread) primary.push({ label: 'Mark unread', icon: icon(CircleDot), onSelect: markUnread })
      primary.push({ label: saved ? 'Remove from saved' : 'Save for later', icon: icon(Bookmark, saved ? 'text-primary' : undefined), onSelect: save })
      if (props.workspaceId) {
        primary.push({
          label: 'Add a reminder',
          icon: icon(AlarmClock),
          children: REMIND_OPTIONS.map((o) => ({ label: o.label, icon: icon(AlarmClock), onSelect: () => remind(o.at()) })),
        })
      }
      groups.push(primary)

      groups.push([
        { label: copied ? 'Link copied' : 'Copy link', icon: icon(copied ? Check : Link2, copied ? 'text-primary' : undefined), onSelect: copyLink },
        { label: copiedMessage ? 'Message copied' : 'Copy message', icon: icon(copiedMessage ? Check : ClipboardCopy, copiedMessage ? 'text-primary' : undefined), onSelect: copyMessage },
      ])

      const organize: SidebarMenuItem[] = []
      if (props.canPin) organize.push({ label: message.pinned ? 'Unpin' : 'Pin to conversation', icon: icon(Pin, message.pinned ? 'text-amber-600' : undefined), onSelect: pin })
      if (props.onMakeCard) organize.push({ label: 'Make a card', icon: icon(KanbanSquare), onSelect: () => props.onMakeCard!(message) })
      if (organize.length) groups.push(organize)
    }
    if (mine && message.authorType === 'user') {
      groups.push([{ label: 'Edit message', icon: icon(Pencil), onSelect: startEditing }])
    }
    if (mine || canManage) {
      groups.push([{ label: 'Delete message', icon: icon(Trash2, 'text-destructive'), danger: true, onSelect: () => props.onDelete(message) }])
    }
    return groups.filter((group) => group.length > 0)
  }
  const menuItems = (): SidebarMenuEntry[] => {
    const items: SidebarMenuEntry[] = []
    for (const group of menuGroups()) {
      if (items.length) items.push({ separator: true })
      items.push(...group)
    }
    return items
  }
  const hasMenu = !deleted && !message.pending && menuGroups().length > 0
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenuFromButton = (e: any) => {
    const rect = e?.currentTarget?.getBoundingClientRect?.()
    const ne = e?.nativeEvent ?? e
    setMenu(rect && (rect.width || rect.height) ? { x: rect.left, y: rect.bottom + 4 } : { x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 })
  }
  // Slack-style: anchor the picker under the button that opened it rather than
  // centring it, so it lands next to the pointer and the message stays visible.
  const togglePickerFromButton = (e: any) => {
    const el = e?.currentTarget ?? null
    const rect = el?.getBoundingClientRect?.()
    pickerTrigger.current = el
    if (rect && (rect.width || rect.height) && typeof window !== 'undefined') {
      const left = Math.max(8, Math.min(rect.right - PICKER_W, window.innerWidth - PICKER_W - 8))
      const below = rect.bottom + 6
      const top =
        below + PICKER_H > window.innerHeight - 8
          ? Math.max(8, rect.top - PICKER_H - 6)
          : below
      setPickerPos({ left, top })
    } else {
      setPickerPos(null)
    }
    setPickerOpen((open) => !open)
  }
  const onContextMenu = (e: any) => {
    if (!hasMenu || editing) return
    // Leave the browser's own menu when text is selected, so it can still be copied.
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
    if (sel && !sel.isCollapsed && sel.toString().trim() && sel.anchorNode && e.currentTarget?.contains?.(sel.anchorNode)) return
    e.preventDefault?.()
    const ne = e.nativeEvent ?? e
    setMenu({ x: ne.clientX ?? 0, y: ne.clientY ?? 0 })
  }
  // Web only: pointer enter/leave drive the row hover, and a right-click opens the actions menu.
  const rowWebProps = isWeb ? ({ onPointerEnter: hoverIn, onPointerLeave: hoverOut, onContextMenu } as object) : {}

  const saveEdit = async () => {
    const text = draft.trim()
    if (!text || text === message.text) {
      setEditing(false)
      return
    }
    await props.onEdit(message, text)
    setEditing(false)
  }

  // "Hey Shogo" in a huddle: the request, with the transcript the agent was given behind a toggle.
  const wakeBlock = huddleWakeBlockOf(message.blocks)
  if (message.authorType === 'system' && wakeBlock) {
    return <HuddleWakeNote block={wakeBlock} createdAt={formatTime(message.createdAt)} />
  }

  // A huddle's notes: the summary the meeting pipeline wrote, with the transcript behind it.
  const notesBlock = message.blocks?.huddleNotes as
    | { huddleId: string; meetingId: string | null; title: string | null; status: 'ready' | 'failed' | 'deleted' }
    | undefined
  if (message.authorType === 'system' && notesBlock) {
    const deleted = notesBlock.status === 'deleted'
    // The text opens with the same title the card shows.
    const body = message.text.replace(/^Huddle notes:.*?\n\n/s, '')
    return (
      <View className="px-4 py-1.5" testID="huddle-notes-block">
        <View className="rounded-xl border border-border bg-card px-3 py-2.5">
          <View className="flex-row items-center gap-1.5">
            <NotebookPen size={13} className={deleted ? 'text-muted-foreground' : 'text-emerald-600'} />
            <Text className="min-w-0 flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>
              {deleted ? 'Huddle notes deleted' : notesBlock.title || 'Huddle notes'}
            </Text>
            <TimeTooltip iso={message.createdAt}>
              {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
            </TimeTooltip>
          </View>
          {deleted ? null : (
            <>
              <View className="mt-1.5">
                <ChatMarkdown isStreaming={false}>{renderMentionsMarkdown(body, names)}</ChatMarkdown>
              </View>
              <Pressable
                onPress={() => router.push({ pathname: '/(app)/huddles/[huddleId]/notes', params: { huddleId: notesBlock.huddleId } } as any)}
                accessibilityRole="link"
                accessibilityLabel="Open the full transcript"
                className="mt-2 flex-row items-center gap-1 self-start rounded-md bg-muted px-2 py-1 active:opacity-70"
              >
                <FileText size={12} className="text-foreground" />
                <Text className="text-[11px] font-medium text-foreground">Transcript</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    )
  }

  // The ended huddle card carries the link to what was said in it.
  const huddleBlock = message.blocks?.huddle as { id?: string; status?: string; notesMeetingId?: string | null } | undefined
  if (message.authorType === 'system' && huddleBlock?.notesMeetingId && huddleBlock.status !== 'live') {
    return (
      <View className="flex-row items-center gap-2 px-4 py-1.5" testID="huddle-notes-link">
        <Headphones size={13} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground">{renderMentions(message.text, names)}</Text>
        <Pressable
          onPress={() =>
            router.push({ pathname: '/(app)/huddles/[huddleId]/notes', params: { huddleId: huddleBlock.id } } as any)
          }
          accessibilityRole="link"
          accessibilityLabel="Open this huddle's notes"
          className="flex-row items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 active:opacity-70"
        >
          <FileText size={11} className="text-foreground" />
          <Text className="text-[11px] font-medium text-foreground">Notes</Text>
        </Pressable>
        <TimeTooltip iso={message.createdAt}>
          {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
        </TimeTooltip>
      </View>
    )
  }

  if (message.authorType === 'system' && message.blocks?.type === 'activity') {
    const canDiscuss = !!props.onReply && !inThread
    const target = activityTarget(message.blocks)
    const detail = typeof message.blocks.summary === 'string' && message.blocks.summary
      ? message.blocks.summary
      : typeof message.blocks.preview === 'string' ? message.blocks.preview : ''
    const open = () => {
      if (!target) return
      if (target.type === 'url') {
        void Linking.openURL(target.url)
        return
      }
      router.push({ pathname: target.pathname, params: target.params } as any)
    }
    return (
      <Pressable
        onPress={target ? open : undefined}
        accessibilityRole={target ? 'link' : undefined}
        accessibilityLabel={target ? 'Open activity' : undefined}
        {...(isWeb ? ({ onPointerEnter: hoverIn, onPointerLeave: hoverOut } as object) : {})}
        className={cn('flex-row items-start gap-2 px-4 py-1.5', hovered && 'bg-muted/40')}
      >
        <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/60" />
        <View className="min-w-0 flex-1">
          <ChatMarkdown isStreaming={false}>{renderMentionsMarkdown(message.text, names)}</ChatMarkdown>
          {detail ? (
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={2}>{renderMentions(detail, names)}</Text>
          ) : null}
          {message.replyCount > 0 && canDiscuss && (
            <Pressable onPress={() => props.onReply!(message)} className="mt-0.5 flex-row items-center gap-1 self-start">
              <MessageSquare size={11} className="text-primary" />
              <Text className="text-xs font-medium text-primary">
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </Text>
            </Pressable>
          )}
        </View>
        {isWeb && hovered && target ? (
          <Pressable onPress={open} accessibilityLabel="Open" className="rounded px-1.5 py-0.5 hover:bg-muted">
            <Text className="text-[11px] text-muted-foreground">Open</Text>
          </Pressable>
        ) : (
          <TimeTooltip iso={message.createdAt}>
            {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
          </TimeTooltip>
        )}
      </Pressable>
    )
  }

  if (message.authorType === 'system' && message.blocks?.type === 'membership') {
    return (
      <View
        accessibilityLabel={`Channel update: ${message.text}`}
        className="flex-row items-center gap-2 px-4 py-1.5"
      >
        <UserPlus size={13} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground">{message.text}</Text>
        <TimeTooltip iso={message.createdAt}>
          {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
        </TimeTooltip>
      </View>
    )
  }

  if (message.authorType === 'system' && message.blocks?.wakeQueued) {
    const wake = wakeQueuedOf(message)
    // A note from before the row knew its wake has no buttons to press: it
    // stays the plain line it has always been.
    if (wake?.wakeId && !deleted) return <QueuedWakeRow message={message} wake={wake} />
  }

  return (
    <Pressable
      onLongPress={isWeb ? undefined : openActions}
      {...rowWebProps}
      className={cn(
        'relative flex-row gap-3 px-4',
        grouped ? 'py-0.5' : 'pt-2.5 pb-0.5',
        message.pinned && !deleted ? 'bg-amber-500/5' : null,
        active && 'bg-muted/40',
        kind === 'decision' && !deleted ? 'border-l-2 border-amber-500 bg-amber-500/10' : null,
        kind === 'alert' && !deleted ? 'border-l-2 border-destructive bg-destructive/10' : null,
        props.highlighted && 'bg-amber-400/20',
      )}
      testID={props.highlighted ? 'message-highlighted' : undefined}
      accessibilityLabel={`${authorName(message)}: ${markdownToPlainText(renderMentions(message.text, names))}`}
    >
      <View className="w-8">
        {grouped ? (
          active ? (
            <TimeTooltip iso={message.createdAt} align="start">
              {(h) => (
                <Text numberOfLines={1} className={cn('pt-1 text-[10px] text-muted-foreground', h && 'underline')}>
                  {formatShortTime(message.createdAt)}
                </Text>
              )}
            </TimeTooltip>
          ) : null
        ) : (
          <Avatar message={message} onPress={opensProfile ? openAuthorProfile : undefined} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        {!grouped && (
          <View className="flex-row items-baseline gap-2">
            {opensProfile ? (
              <Pressable onPress={openAuthorProfile} accessibilityRole="button" accessibilityLabel={`${authorName(message)} profile`}>
                <Text className="text-sm font-semibold text-foreground">{authorName(message)}</Text>
              </Pressable>
            ) : (
              <Text className="text-sm font-semibold text-foreground">{authorName(message)}</Text>
            )}
            {message.authorType === 'user' ? <AuthorStatus userId={message.authorUserId} /> : null}
            {message.authorType === 'agent' && (
              <View className="rounded bg-primary/10 px-1.5 py-px">
                <Text className="text-[10px] font-medium text-primary">AGENT</Text>
              </View>
            )}
            {onBehalfOf && (
              <Text className="text-[11px] text-muted-foreground">on behalf of {onBehalfOf}</Text>
            )}
            {(kind === 'decision' && (approval ? approval.status === 'pending' : questions.length ? openQuestion : true)) || kind === 'alert' ? (
              <View className={cn('rounded px-1.5 py-px', kind === 'alert' ? 'bg-destructive/15' : 'bg-amber-500/20')}>
                <Text className={cn('text-[10px] font-semibold', kind === 'alert' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')} testID={`kind-${kind}`}>
                  {kind === 'alert' ? 'ALERT' : 'NEEDS A DECISION'}
                </Text>
              </View>
            ) : null}
            <TimeTooltip iso={message.createdAt}>
              {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
            </TimeTooltip>
          </View>
        )}

        {message.pinned && !deleted && (
          <View className="flex-row items-center gap-1">
            <Pin size={10} className="text-amber-600" />
            <Text className="text-[11px] text-amber-700 dark:text-amber-400">Pinned</Text>
          </View>
        )}
        {saved && !deleted && (
          <View className="flex-row items-center gap-1">
            <Bookmark size={10} className="text-primary" />
            <Text className="text-[11px] text-primary">Saved for later</Text>
          </View>
        )}

        {message.threadRootId && message.alsoSentToChannel && !inThread && (
          <View className="flex-row items-center gap-1">
            <CornerDownRight size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">replied to a thread</Text>
          </View>
        )}

        {deleted ? (
          <Text className="text-sm italic text-muted-foreground">This message was deleted.</Text>
        ) : editing ? (
          <View className="mt-1 rounded-lg border border-border bg-background p-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              className="min-h-[40px] text-sm text-foreground"
              onKeyPress={(e: any) => {
                if (!isWeb) return
                if (e.nativeEvent.key === 'Escape') setEditing(false)
                if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.()
                  void saveEdit()
                }
              }}
            />
            <View className="mt-2 flex-row justify-end gap-2">
              <Pressable onPress={() => setEditing(false)} className="rounded-md px-3 py-1.5 active:bg-muted">
                <Text className="text-xs text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable onPress={saveEdit} className="rounded-md bg-primary px-3 py-1.5">
                <Text className="text-xs font-medium text-primary-foreground">Save</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            {workItem ? (
              <WorkItemCard item={workItem} onPress={() => openWorkItem(workItem)} />
            ) : card ? (
              <StatusCardView card={card} onOpenLink={openMessageLinkInApp} />
            ) : null}
            {pollBlock ? <PollCardView message={message} me={me} canManage={canManage} /> : null}
            {audienceQuestion ? <AudienceQuestionCardView message={message} me={me} canManage={canManage} /> : null}
            {approval ? <ApprovalCardView approval={approval} messageId={message.id} canDecide={!message.pending} onDecide={(decision) => api.decideApproval(message.id, decision)} /> : null}
            {work ? <AgentWorkedFor messageId={message.id} work={work} /> : null}
            {connectRequests.filter((c) => !continuedConnects.includes(c.provider)).map((c) => (
              <View key={c.provider} className="mt-1.5 max-w-[520px] rounded-lg border border-border bg-card p-3" testID="connect-card">
                <IntegrationConnectCard
                  request={c}
                  onContinue={(label) => {
                    setContinuedConnects((prev) => [...prev, c.provider])
                    void continueAfterConnect({
                      conversationId: message.conversationId,
                      messageId: message.id,
                      threadRootId: message.threadRootId ?? null,
                      agentProjectId: message.authorAgent?.projectId ?? null,
                      label,
                    }).catch(() => setContinuedConnects((prev) => prev.filter((p) => p !== c.provider)))
                  }}
                />
              </View>
            ))}
            {questions.length ? (
              <QuestionCardView
                questions={questions}
                messageId={message.id}
                workspaceId={props.workspaceId ?? message.workspaceId}
                me={me}
                names={names}
                canAnswer={!message.pending}
                agentName={message.authorAgent?.name}
              />
            ) : null}
            {questionRefs.map((ref) => (
              <Pressable
                key={`${ref.messageId}:${ref.questionId}`}
                onPress={() => router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: message.conversationId, msg: ref.messageId } } as any)}
                accessibilityRole="link"
                className="mt-1 flex-row items-center gap-1.5 self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 active:bg-amber-500/20"
                testID="question-ref"
              >
                <Text className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Still waiting</Text>
                <Text className="text-[11px] text-foreground" numberOfLines={1}>{ref.header}</Text>
                <Text className="text-[11px] text-primary">View question</Text>
              </Pressable>
            ))}
            {/* While an agent works the row shows its status; its closing message appears when it is done. */}
            {!workItem && !card && !approval && !pollBlock && !audienceQuestion && !!body && !(running && message.authorType === 'agent') && foldBody ? (
              <Pressable onPress={() => setShowFullUpdate(true)} accessibilityRole="button" className="mt-1 self-start" testID="show-full-update">
                <Text className="text-xs font-medium text-primary">Show full update</Text>
              </Pressable>
            ) : null}
            {!workItem && !card && !approval && !pollBlock && !audienceQuestion && !!body && !foldBody && !(running && message.authorType === 'agent') && (() => {
              const jumbo = running ? null : jumboEmojiCodes(body, customEmoji)
              return (
                <View className={cn(message.pending && 'opacity-60')}>
                  {jumbo ? (
                    <View className="flex-row flex-wrap items-center gap-1.5 py-1" testID="jumbo-emoji">
                      {jumbo.map((code, i) => <JumboEmoji key={`${code}-${i}`} code={code} size={jumboSize} />)}
                    </View>
                  ) : (
                    <ChatMarkdown isStreaming={running} onLinkPress={openMessageLinkInApp} onMentionPress={props.onMentionPress}>{renderMentionsMarkdown(body, names)}</ChatMarkdown>
                  )}
                </View>
              )
            })()}
            {!deleted && <MessageQuoteCards quotes={quotes} names={names} />}
            {!running && <UnfurlCards message={message} />}
            {running && (
              // A run in progress is a marker, not a report: the live tool
              // status and Stop/Open live in the dock above the composer, so
              // this row only keeps its place until the reply lands in it.
              <Text className="mt-0.5 text-sm text-muted-foreground" testID="running-reply-marker">
                Replying…
              </Text>
            )}
            {message.authorType === 'agent' && message.agentStatus === 'error' && (
              <View className="mt-1 flex-row items-center gap-1">
                <AlertCircle size={12} className="text-destructive" />
                <Text className="text-xs text-destructive">The agent hit an error.</Text>
              </View>
            )}
            {canOpenSession && !running && (
              <Pressable onPress={() => props.onOpenSession!(message)} className="mt-1 self-start">
                <Text className="text-[11px] text-primary">Open full session</Text>
              </Pressable>
            )}
            {message.editedAt && <Text className="text-[10px] text-muted-foreground">(edited)</Text>}
          </>
        )}

        {!deleted && message.attachments.length > 0 && (
          <View className="mt-1.5 flex-row flex-wrap gap-2" testID="message-attachments" onLayout={attachmentRow.onLayout}>
            {message.attachments.map((a) =>
              isVoiceNote(a) ? (
                <VoiceNotePlayer
                  key={a.id}
                  attachmentId={a.id}
                  url={absoluteApiUrl(a.url)}
                  durationMs={a.durationMs}
                  peaks={a.peaks}
                  name={a.name}
                />
              ) : a.mimeType.startsWith('image/') ? (
                <View key={a.id} className="relative">
                  <Pressable
                    onPress={() => setLightboxIndex(imageIndexById.get(a.id) ?? 0)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${a.name}`}
                    className={isWeb ? 'cursor-pointer' : undefined}
                  >
                    <ChatImageAttachment
                      url={absoluteApiUrl(a.url)}
                      name={a.name}
                      naturalWidth={a.width}
                      naturalHeight={a.height}
                      containerWidth={attachmentRow.width}
                    />
                  </Pressable>
                  <DownloadBadge url={absoluteApiUrl(a.url)} name={a.name} />
                </View>
              ) : a.mimeType.startsWith('video/') ? (
                <View key={a.id} className="relative">
                  <VideoAttachment
                    url={absoluteApiUrl(a.url)}
                    name={a.name}
                    width={a.width}
                    height={a.height}
                    containerWidth={attachmentRow.width}
                  />
                  <DownloadBadge url={absoluteApiUrl(a.url)} name={a.name} />
                </View>
              ) : isPastedMarkdownAttachment(a.name, a.mimeType) ? (
                <PastedMarkdownCard
                  key={a.id}
                  attachmentId={a.id}
                  name={a.name}
                  mimeType={a.mimeType}
                  size={a.size}
                  url={absoluteApiUrl(a.url)}
                  preview={a.preview}
                  onOpen={() =>
                    router.push({
                      pathname: '/(app)/f/[attachmentId]',
                      params: { attachmentId: a.id, name: a.name },
                    } as never)
                  }
                />
              ) : (
                <FileAttachmentCard
                  key={a.id}
                  name={a.name}
                  mimeType={a.mimeType}
                  size={a.size}
                  url={absoluteApiUrl(a.url)}
                  preview={a.preview}
                  onOpen={() =>
                    router.push({
                      pathname: '/(app)/f/[attachmentId]',
                      params: { attachmentId: a.id, name: a.name },
                    } as never)
                  }
                />
              ),
            )}
          </View>
        )}

        {message.pending === 'failed' && (
          <View className="mt-1 flex-row items-center gap-3">
            <Text className="text-xs text-destructive">Not sent.</Text>
            <Pressable onPress={() => props.onRetry(message)}>
              <Text className="text-xs font-medium text-primary">Retry</Text>
            </Pressable>
            <Pressable onPress={() => props.onDiscard(message)}>
              <Text className="text-xs text-muted-foreground">Discard</Text>
            </Pressable>
          </View>
        )}

        {!deleted && message.reactions.length > 0 && (
          <View className="mt-1 flex-row flex-wrap gap-1">
            {message.reactions.map((r) => {
              const reacted = hasReacted(message.reactions, r.emoji, me)
              const who = reactionTooltip(r.emoji, r.userIds, me, names)
              return (
                <ReactionChip
                  key={r.emoji}
                  reaction={r}
                  reacted={reacted}
                  label={who}
                  me={me}
                  names={names}
                  onToggle={() => toggleReact(r.emoji)}
                />
              )
            })}
          </View>
        )}

        {!inThread && message.replyCount > 0 && props.onReply && (
          <Pressable onPress={() => props.onReply!(message)} className="mt-1 flex-row items-center gap-1.5 self-start rounded-md py-0.5">
            <MessageSquare size={12} className="text-primary" />
            <Text className="text-xs font-medium text-primary">
              {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            </Text>
            {message.lastReplyAt && (
              <Text className="text-[11px] text-muted-foreground">Last reply {formatTime(message.lastReplyAt)}</Text>
            )}
          </Pressable>
        )}
      </View>

      {isWeb && active && !deleted && !message.pending && !editing && (
        <View className="absolute right-3 -top-3 flex-row items-center rounded-lg border border-border bg-card px-1 py-0.5 shadow-sm">
          {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
            <Pressable key={emoji} onPress={() => toggleReact(emoji)} className="rounded px-1.5 py-1 hover:bg-muted">
              <Text className="text-sm">{emoji}</Text>
            </Pressable>
          ))}
          <Pressable onPress={togglePickerFromButton} accessibilityLabel="More reactions" className="rounded px-1.5 py-1 hover:bg-muted">
            <SmilePlus size={14} className="text-muted-foreground" />
          </Pressable>
          {props.onReply && !inThread && (
            <Pressable onPress={() => props.onReply!(message)} accessibilityLabel="Reply in thread" className="rounded px-1.5 py-1 hover:bg-muted">
              <MessageSquare size={14} className="text-muted-foreground" />
            </Pressable>
          )}
          {hasMenu && (
            <Pressable onPress={openMenuFromButton} accessibilityLabel="More actions" className="rounded px-1.5 py-1 hover:bg-muted">
              <MoreHorizontal size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      )}
      {menu && <SidebarContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}
      {actionsOpen && (
        <MessageActionSheet
          open={actionsOpen}
          onClose={() => setActionsOpen(false)}
          groups={menuGroups()}
          reactions={QUICK_REACTIONS.slice(0, 5).map((emoji) => ({
            emoji,
            active: hasReacted(message.reactions, emoji, props.me),
            onPress: () => toggleReact(emoji),
          }))}
          onAddReaction={() => {
            // No trigger rect from the action sheet, so use the centred sheet.
            setPickerPos(null)
            setPickerOpen(true)
          }}
        />
      )}
      {profileOpen && message.authorAgent && (
        <AgentProfileCard
          workspaceId={message.workspaceId}
          projectId={message.authorAgent.projectId}
          name={message.authorAgent.name}
          iconUrl={message.authorAgent.iconUrl}
          onClose={() => setProfileOpen(false)}
          onOpenChannel={openConversationInApp}
          onOpenProjectPane={props.onOpenProjectPane}
        />
      )}
      {pickerOpen && (
        Platform.OS === 'web' && pickerPos ? (
          <ReactionPickerPopover
            left={pickerPos.left}
            top={pickerPos.top}
            trigger={pickerTrigger.current}
            onClose={() => setPickerOpen(false)}
          >
            <EmojiPicker
              workspaceId={props.workspaceId}
              onPick={(code) => {
                setPickerOpen(false)
                toggleReact(code)
              }}
            />
          </ReactionPickerPopover>
        ) : (
          <Modal visible transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
            <Pressable className="flex-1 items-center justify-center bg-black/30 p-6" onPress={() => setPickerOpen(false)} accessibilityLabel="Close emoji picker">
              <Pressable onPress={() => {}}>
                <EmojiPicker
                  workspaceId={props.workspaceId}
                  onPick={(code) => {
                    setPickerOpen(false)
                    toggleReact(code)
                  }}
                />
              </Pressable>
            </Pressable>
          </Modal>
        )
      )}
      {lightboxIndex !== null && (
        <ImagePreviewModal
          visible
          onClose={() => setLightboxIndex(null)}
          url={absoluteApiUrl(activeLightboxImage?.url ?? '')}
          gallery={imageAttachments.map((a) => ({ url: absoluteApiUrl(a.url), title: a.name, alt: a.name }))}
          initialIndex={lightboxIndex}
          mediaType={activeLightboxImage?.mimeType}
          title={activeLightboxImage?.name ?? 'Image'}
          alt={activeLightboxImage?.name ?? 'Image attachment'}
        />
      )}
    </Pressable>
  )
}

export const MessageRow = memo(MessageRowImpl)
