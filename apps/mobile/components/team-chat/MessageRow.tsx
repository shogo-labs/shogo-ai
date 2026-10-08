// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One message in a team chat timeline: author header (grouped), Markdown
 * body with mentions, attachments, reactions, thread summary, and live agent
 * replies (streaming text, the tool in use, Stop).
 */
import { createElement, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActionSheetIOS, Alert, Image, Linking, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { AlarmClock, AlertCircle, Bookmark, Check, CircleDot, CornerDownRight, FileText, Link2, Loader2, MessageSquare, MoreHorizontal, Pencil, Pin, SmilePlus, Square, Trash2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { MarkdownText } from '../chat/MarkdownText'
import { SidebarContextMenu, type SidebarMenuEntry } from '../layout/SidebarContextMenu'
import { absoluteApiUrl, teamChatApi, type ChatMessage, type LinkUnfurl } from '../../lib/team-chat-api'
import { messageLink, parseMessageLink } from '../../lib/team-chat-links'
import { formatFullTime, formatShortTime, formatTime } from '../../lib/team-chat-time'
import { EmojiPicker } from './EmojiPicker'
import { AgentAvatar } from './AgentAvatar'
import { AgentProfileCard } from './AgentProfileCard'
import { ApprovalCardView, StatusCardView } from './AgentStatus'
import { approvalOf, messageKind, statusCardOf, workOf } from '../../lib/team-chat-kinds'
import { AgentWorkedFor, AgentWorkingStatus } from './AgentWork'
import { renderMentions, type MentionNames } from '../../lib/team-chat-state'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { PresenceDot } from './PresenceDot'
import { toggleSaved, useIsSaved } from '../../hooks/useChatItems'
import { customEmojiFor, jumboEmojiCodes, useCustomEmoji } from '../../hooks/useCustomEmoji'
import { useEditRequest } from '../../hooks/useChatShortcuts'

export const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '😂']

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
  streaming?: { text: string; tool: string | null }
  canManage: boolean
  /** Can pin (anyone who can post or reply here). */
  canPin?: boolean
  workspaceId?: string
  inThread?: boolean
  onReply?: (message: ChatMessage) => void
  onReact: (message: ChatMessage, emoji: string) => void
  onEdit: (message: ChatMessage, text: string) => Promise<void>
  onDelete: (message: ChatMessage) => void
  onStopAgent: (message: ChatMessage) => void
  onRetry: (message: ChatMessage) => void
  onDiscard: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
  /** Show an agent's project beside the conversation (wide screens only). */
  onOpenProjectPane?: (projectId: string, name: string) => void
  /** Move the read line back to just before this message. */
  onMarkUnread?: (message: ChatMessage) => void
  /** Briefly emphasized after opening a link to it. */
  highlighted?: boolean
}

/** Message links open in place; everything else goes to the browser. */
export function openMessageLinkInApp(href: string): boolean {
  const target = parseMessageLink(href)
  if (!target) return false
  void import('expo-router').then(({ router }) =>
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: target.conversationId, msg: target.messageId, ...(target.threadRootId ? { thread: target.threadRootId } : {}) },
    } as any),
  )
  return true
}

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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
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
    return <View className="h-8 w-8 items-center justify-center rounded-lg bg-muted" />
  }
  const name = message.author?.name ?? 'Someone'
  return (
    <View className="relative">
      {message.author?.image ? (
        <Image source={{ uri: message.author.image }} className="h-8 w-8 rounded-lg" accessibilityIgnoresInvertColors />
      ) : (
        <View className="h-8 w-8 items-center justify-center rounded-lg bg-secondary">
          <Text className="text-xs font-semibold text-secondary-foreground">{initials(name)}</Text>
        </View>
      )}
      <PresenceDot userId={message.authorUserId} size={10} badge />
    </View>
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
            <Image source={{ uri: u.image }} className="h-16 w-16 rounded" resizeMode="cover" accessibilityIgnoresInvertColors />
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
  const { message, grouped, me, names, streaming, canManage, inThread } = props
  const { hovered, hoverIn, hoverOut } = useRowHover()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // The menu is portaled out of the row, so keep the row lit while it is open.
  const active = hovered || !!menu
  const [editing, setEditing] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const saved = useIsSaved(message.id)
  const customEmoji = useCustomEmoji()
  const [draft, setDraft] = useState(message.text)
  const mine = !!me && message.authorUserId === me
  const deleted = !!message.deletedAt
  const running = message.authorType === 'agent' && message.agentStatus === 'running'
  const body = running ? streaming?.text ?? '' : message.text
  const card = !running && message.authorType === 'agent' ? statusCardOf(message) : null
  const approval = !running && message.authorType === 'agent' ? approvalOf(message) : null
  const kind = message.authorType === 'agent' ? messageKind(message) : null
  const onBehalfOf = message.authorType === 'agent' ? onBehalfOfName(message) : null
  const canOpenSession = message.authorType === 'agent' && !!message.agentSessionId && !!props.onOpenSession
  const work = !running && message.authorType === 'agent' ? workOf(message) : null
  const isWeb = Platform.OS === 'web'
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
  const markUnread = props.onMarkUnread && !inThread && !message.threadRootId ? () => props.onMarkUnread!(message) : null
  const pin = () => void api.pin(message.id, !message.pinned).catch(() => {})
  const save = () => void toggleSaved(message.id, !saved).catch(() => {})
  const remind = (at: Date) => {
    if (!props.workspaceId) return
    void api.createReminder(props.workspaceId, { messageId: message.id, remindAt: at.toISOString() }).catch(() => {})
  }
  const canAct = !deleted && !message.pending && message.authorType !== 'system'

  const openActions = () => {
    if (deleted || message.pending) return
    const options: Array<{ label: string; run: () => void; destructive?: boolean }> = [
      ...QUICK_REACTIONS.slice(0, 4).map((emoji) => ({ label: emoji, run: () => props.onReact(message, emoji) })),
      { label: 'Add reaction…', run: () => setPickerOpen(true) },
    ]
    if (props.onReply && !inThread) options.push({ label: 'Reply in thread', run: () => props.onReply!(message) })
    options.push({ label: 'Copy link', run: copyLink })
    if (markUnread) options.push({ label: 'Mark unread', run: markUnread })
    options.push({ label: saved ? 'Remove from saved' : 'Save for later', run: save })
    if (props.workspaceId) options.push({ label: 'Remind me in 1 hour', run: () => remind(REMIND_OPTIONS[1].at()) })
    if (props.canPin) options.push({ label: message.pinned ? 'Unpin' : 'Pin to conversation', run: pin })
    if (mine && message.authorType === 'user') options.push({ label: 'Edit', run: () => { setDraft(message.text); setEditing(true) } })
    if (mine || canManage) options.push({ label: 'Delete', run: () => props.onDelete(message), destructive: true })
    if (Platform.OS === 'ios') {
      const labels = [...options.map((o) => o.label), 'Cancel']
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1, destructiveButtonIndex: options.findIndex((o) => o.destructive) },
        (i) => options[i]?.run(),
      )
    } else {
      Alert.alert('Message', undefined, [
        ...options.map((o) => ({ text: o.label, onPress: o.run, style: o.destructive ? ('destructive' as const) : ('default' as const) })),
        { text: 'Cancel', style: 'cancel' as const },
      ])
    }
  }

  const startEditing = () => { setDraft(message.text); setEditing(true) }
  const menuItems = (): SidebarMenuEntry[] => {
    const icon = (Icon: typeof Link2, tone = 'text-muted-foreground') => <Icon size={14} className={tone} />
    const items: SidebarMenuEntry[] = []
    if (canAct) {
      items.push({ label: copied ? 'Link copied' : 'Copy link', icon: icon(copied ? Check : Link2, copied ? 'text-primary' : undefined), onSelect: copyLink })
      if (markUnread) items.push({ label: 'Mark unread', icon: icon(CircleDot), onSelect: markUnread })
      items.push({ label: saved ? 'Remove from saved' : 'Save for later', icon: icon(Bookmark, saved ? 'text-primary' : undefined), onSelect: save })
      if (props.workspaceId) {
        for (const o of REMIND_OPTIONS) {
          items.push({ label: `Remind me: ${o.label.toLowerCase()}`, icon: icon(AlarmClock), onSelect: () => remind(o.at()) })
        }
      }
      if (props.canPin) items.push({ label: message.pinned ? 'Unpin' : 'Pin to conversation', icon: icon(Pin, message.pinned ? 'text-amber-600' : undefined), onSelect: pin })
    }
    if (mine && message.authorType === 'user') items.push({ label: 'Edit message', icon: icon(Pencil), onSelect: startEditing })
    if (mine || canManage) {
      if (items.length) items.push({ separator: true })
      items.push({ label: 'Delete message', icon: icon(Trash2, 'text-destructive'), danger: true, onSelect: () => props.onDelete(message) })
    }
    return items
  }
  const hasMenu = !deleted && !message.pending && menuItems().length > 0
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenuFromButton = (e: any) => {
    const rect = e?.currentTarget?.getBoundingClientRect?.()
    const ne = e?.nativeEvent ?? e
    setMenu(rect && (rect.width || rect.height) ? { x: rect.left, y: rect.bottom + 4 } : { x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 })
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

  if (message.authorType === 'system' && message.blocks?.type === 'activity') {
    const canDiscuss = !!props.onReply && !inThread
    return (
      <Pressable
        onPress={canDiscuss && !isWeb ? () => props.onReply!(message) : undefined}
        {...(isWeb ? ({ onPointerEnter: hoverIn, onPointerLeave: hoverOut } as object) : {})}
        className={cn('flex-row items-start gap-2 px-4 py-1.5', hovered && 'bg-muted/40')}
      >
        <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/60" />
        <View className="min-w-0 flex-1">
          <MarkdownText>{renderMentions(message.text, names)}</MarkdownText>
          {message.replyCount > 0 && canDiscuss && (
            <Pressable onPress={() => props.onReply!(message)} className="mt-0.5 flex-row items-center gap-1 self-start">
              <MessageSquare size={11} className="text-primary" />
              <Text className="text-xs font-medium text-primary">
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </Text>
            </Pressable>
          )}
        </View>
        {isWeb && hovered && canDiscuss ? (
          <Pressable onPress={() => props.onReply!(message)} accessibilityLabel="Discuss in thread" className="rounded px-1.5 py-0.5 hover:bg-muted">
            <Text className="text-[11px] text-muted-foreground">Discuss</Text>
          </Pressable>
        ) : (
          <TimeTooltip iso={message.createdAt}>
            {(h) => <Text className={cn('text-[11px] text-muted-foreground', h && 'underline')}>{formatTime(message.createdAt)}</Text>}
          </TimeTooltip>
        )}
      </Pressable>
    )
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
      accessibilityLabel={`${authorName(message)}: ${message.text}`}
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
          <Avatar message={message} onPress={message.authorType === 'agent' && !deleted ? () => setProfileOpen(true) : undefined} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        {!grouped && (
          <View className="flex-row items-baseline gap-2">
            {message.authorType === 'agent' && !deleted ? (
              <Pressable onPress={() => setProfileOpen(true)} accessibilityLabel={`${authorName(message)} profile`}>
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
            {(kind === 'decision' && (!approval || approval.status === 'pending')) || kind === 'alert' ? (
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
            {card ? <StatusCardView card={card} onOpenLink={openMessageLinkInApp} /> : null}
            {approval ? <ApprovalCardView approval={approval} messageId={message.id} canDecide={!message.pending} onDecide={(decision) => api.decideApproval(message.id, decision)} /> : null}
            {work ? <AgentWorkedFor messageId={message.id} work={work} /> : null}
            {/* While an agent works the row shows its status; its closing message appears when it is done. */}
            {!card && !approval && !!body && !(running && message.authorType === 'agent') && (() => {
              const jumbo = running ? null : jumboEmojiCodes(body, customEmoji)
              return (
                <View className={cn(message.pending && 'opacity-60')}>
                  {jumbo ? (
                    <View className="flex-row flex-wrap gap-1 py-0.5">
                      {jumbo.map((code, i) => <ReactionGlyph key={`${code}-${i}`} emoji={code} size={32} />)}
                    </View>
                  ) : (
                    <MarkdownText isStreaming={running} onLinkPress={openMessageLinkInApp}>{renderMentions(body, names)}</MarkdownText>
                  )}
                </View>
              )
            })()}
            {!running && <UnfurlCards message={message} />}
            {running && (
              <View className="mt-1 flex-row items-center gap-2">
                {/* The live status opens the session the agent is writing in. */}
                <Pressable
                  disabled={!canOpenSession}
                  onPress={() => props.onOpenSession!(message)}
                  accessibilityLabel="Open the session this agent is working in"
                  className="rounded-md active:bg-muted"
                >
                  <AgentWorkingStatus tools={streaming?.tools ?? (streaming?.tool ? [{ name: streaming.tool, done: false }] : [])} />
                </Pressable>
                <Pressable
                  onPress={() => props.onStopAgent(message)}
                  accessibilityLabel="Stop agent"
                  className="flex-row items-center gap-1 rounded-md border border-border px-2 py-0.5 active:bg-muted"
                >
                  <Square size={10} className="text-muted-foreground" />
                  <Text className="text-[11px] text-muted-foreground">Stop</Text>
                </Pressable>
              </View>
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
          <View className="mt-1.5 flex-row flex-wrap gap-2">
            {message.attachments.map((a) =>
              a.mimeType.startsWith('image/') ? (
                <Pressable key={a.id} onPress={() => Linking.openURL(absoluteApiUrl(a.url))}>
                  <Image
                    source={{ uri: absoluteApiUrl(a.url) }}
                    className="rounded-lg border border-border"
                    style={{ width: 220, height: a.width && a.height ? Math.min(260, (220 * a.height) / a.width) : 160 }}
                    resizeMode="cover"
                    accessibilityLabel={a.name}
                  />
                </Pressable>
              ) : (
                <Pressable
                  key={a.id}
                  onPress={() => Linking.openURL(absoluteApiUrl(a.url))}
                  className="flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 active:bg-muted"
                >
                  <FileText size={16} className="text-muted-foreground" />
                  <View>
                    <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{a.name}</Text>
                    <Text className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</Text>
                  </View>
                </Pressable>
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
              const reacted = !!me && r.userIds.includes(me)
              return (
                <Pressable
                  key={r.emoji}
                  onPress={() => props.onReact(message, r.emoji)}
                  accessibilityLabel={`${r.emoji} ${r.count}`}
                  className={cn(
                    'flex-row items-center gap-1 rounded-full border px-2 py-0.5',
                    reacted ? 'border-primary/50 bg-primary/10' : 'border-border bg-card',
                  )}
                >
                  <ReactionGlyph emoji={r.emoji} />
                  <Text className={cn('text-[11px]', reacted ? 'text-primary' : 'text-muted-foreground')}>{r.count}</Text>
                </Pressable>
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
            <Pressable key={emoji} onPress={() => props.onReact(message, emoji)} className="rounded px-1.5 py-1 hover:bg-muted">
              <Text className="text-sm">{emoji}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setPickerOpen((open) => !open)} accessibilityLabel="More reactions" className="rounded px-1.5 py-1 hover:bg-muted">
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
        <Modal visible transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
          <Pressable className="flex-1 items-center justify-center bg-black/30 p-6" onPress={() => setPickerOpen(false)} accessibilityLabel="Close emoji picker">
            <Pressable onPress={() => {}}>
              <EmojiPicker
                workspaceId={props.workspaceId}
                onPick={(code) => {
                  setPickerOpen(false)
                  props.onReact(message, code)
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </Pressable>
  )
}

export const MessageRow = memo(MessageRowImpl)
