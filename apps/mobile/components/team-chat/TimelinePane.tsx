// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A live timeline plus composer for one scope: a conversation's main view,
 * or a single thread when `threadRootId` is set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Filter, Upload, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { conversationTitle, teamChatApi, type ChatMessage, type ConversationDetail, type Mentionables } from '../../lib/team-chat-api'
import type { MentionTarget } from '../chat/file-links'
import { mentionNames, newestReadableSeq } from '../../lib/team-chat-state'
import { runningAgentReplies, typingLabel, typingLabelText } from '../../lib/team-chat-typing'
import { useComposerColumnStyle } from '../chat/composer/useComposerColumnStyle'
import { ACTIVITY_CHANNEL_FILTERS, EMPTY_ACTIVITY_FILTER, isActivityFilterActive, matchesActivityFilters, type ActivityFilterState } from '../../lib/activity-channel-filters'
import { TIMELINE_SOFT_LIMIT, useChannelDirectory, useConversationList, useConversationTimeline, useMarkReadWhileVisible, useTypingUsers, type SendInput } from '../../hooks/useTeamChat'
import { requestEditMessage } from '../../hooks/useChatShortcuts'
import { openConversationTarget, threadCrumbs } from '../../lib/team-chat-nav'
import { composerAutofocusesOnOpen } from '../../lib/composer-autofocus'
import { nonMemberMentionIds } from '../../lib/team-chat-mention-nudge'
import { dismissMentionNudgeForever, getMentionNudgeDismissed } from '../../lib/mention-nudge-preference'
import { Breadcrumb } from './SessionBreadcrumb'
import { ActivityFilterPicker } from './ActivityFilterPicker'
import { MessageList } from './MessageList'
import { RunningAgentsDock } from './RunningAgentsDock'
import { TypingIndicator } from './TypingIndicator'
import { Composer, type ComposerHandle } from './Composer'
import { MentionNudgeCard } from './MentionNudgeCard'
import { EphemeralNotice } from './EphemeralNotice'
import { AddToChannelConfirmHost, confirmsAddToChannel } from './AddToChannelConfirm'
import { LinkPreviewConsentHost } from './LinkPreviewConsent'
import { GlassChip } from './FloatingChrome'
import { PhoneScreenHeader } from '../layout/PhoneScreenHeader'
import { usePhoneChromeOverlay } from '../layout/PhoneChromeOverlay'
import { GlassBlurTarget } from '../ui/LiquidGlassBackdrop'
import { MakeCardSheet } from '../boards/MakeCardSheet'
import { useMemberMessages } from '../../hooks/useMemberMessages'
import { memberForKey, memberFromKey } from '../../lib/member-messages'
import { AgentAvatar } from './AgentAvatar'
import { UserAvatar } from './UserAvatar'
import type { ConversationMember } from '../../lib/team-chat-api'
import type { WorkItem } from '../../lib/work-boards-api'
import { emailBlockOf, mailApi, type MailView } from '../../lib/mail-api'
import { useMailboxForConversation } from '../../hooks/useMail'
import { MailReplyModeBar, MailThreadActions, type MailComposeMode } from './MailThreadBar'
import { ComposeEmailSheet, MailboxHeader, MailThreadList, ScreenerList, type MailboxTab } from './MailboxView'

const api = teamChatApi()
const mail = mailApi()
/** Pages of 200 to load back when jumping to an older message before opening it on its own. */
const SEEK_PAGES = 6
const SEEK_PAGE_SIZE = 200
const HIGHLIGHT_MS = 4000
/** Keep loading older #activity pages until a filter has about this many rows. */
const ACTIVITY_FILTER_MIN = 20

export interface TimelinePaneProps {
  workspaceId: string
  conversation: ConversationDetail
  threadRootId?: string | null
  me: string | null
  mentionables: Mentionables | null
  visible: boolean
  header?: React.ReactElement | null
  onOpenThread?: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
  onOpenProjectPane?: (projectId: string, name: string) => void
  /** Open a person's profile — from their name, their photo, or a mention of them. */
  onOpenProfile?: (userId: string) => void
  onClose?: () => void
  onJoin?: () => void
  /** Scroll to and emphasize this message (from a message link or search). */
  highlightMessageId?: string | null
  /** Phone presentation: messages run full-bleed under floating chrome. */
  floating?: boolean
  /** Height of the floating header drawn over this pane. */
  topInset?: number
  /** Open a card made from a message here. "Make a card" only shows when this is set. */
  onOpenCard?: (item: WorkItem) => void
  /** Filter the timeline to one member's messages (\ / \). Only
   * valid on the main scope (no \), not on #activity. */
  memberFilter?: string | null
  onChangeMemberFilter?: (from: string) => void
  onClearMemberFilter?: () => void
}

/** Files dropped anywhere on a web pane go to the composer. */
function useFileDrop(ref: React.RefObject<View | null>, enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null
    if (Platform.OS !== 'web' || !enabled || !node?.addEventListener) return
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) onFilesRef.current(files)
    }
    node.addEventListener('dragenter', onEnter as EventListener)
    node.addEventListener('dragover', onOver as EventListener)
    node.addEventListener('dragleave', onLeave as EventListener)
    node.addEventListener('drop', onDrop as EventListener)
    return () => {
      node.removeEventListener('dragenter', onEnter as EventListener)
      node.removeEventListener('dragover', onOver as EventListener)
      node.removeEventListener('dragleave', onLeave as EventListener)
      node.removeEventListener('drop', onDrop as EventListener)
    }
  }, [ref, enabled])
  return dragging
}

function confirmDelete(): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window === 'undefined' || window.confirm('Delete this message?'))
  return new Promise((resolve) =>
    Alert.alert('Delete message?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
    ]),
  )
}

/**
 * The footer sits over the transcript rather than under it: the pane measures
 * it on layout and pulls it back up by its own height, so the list keeps full
 * height and messages scroll behind the composer instead of stopping above an
 * opaque band. `box-none` lets the wheel and clicks through the empty space
 * around the composer reach the list underneath (SHO-439).
 */
function OverlayFooter({
  height,
  onHeight,
  style,
  testID,
  children,
}: {
  height: number
  onHeight: (height: number) => void
  style?: React.ComponentProps<typeof View>['style']
  testID?: string
  children: React.ReactNode
}) {
  return (
    <View
      pointerEvents="box-none"
      onLayout={(e) => onHeight(Math.round(e.nativeEvent.layout.height))}
      style={[{ marginTop: -height }, style]}
      testID={testID}
    >
      {children}
    </View>
  )
}

export function TimelinePane(props: TimelinePaneProps) {
  const { workspaceId, conversation, threadRootId = null, me, mentionables, visible, floating = false, topInset = 0 } = props
  const router = useRouter()
  const chrome = usePhoneChromeOverlay()
  const insets = useSafeAreaInsets()
  /**
   * What tapping a mention does. A person opens their profile through the
   * host (`onOpenProfile`), an agent opens its own profile page, a `#channel`
   * opens that channel in place, and the broadcast/group targets stay plain
   * highlights — so a host that offers no profile gets exactly today's
   * behaviour, except a channel reference still navigates.
   */
  const mentionPress = useMemo(() => {
    const openProfile = props.onOpenProfile
    return (target: MentionTarget) => {
      if (target.kind === 'c') {
        openConversationTarget(router, { conversationId: target.id })
        return
      }
      if (!openProfile) return
      if (target.kind === 'u') return openProfile(target.id)
      if (target.kind === 'a') {
        router.push({ pathname: '/(app)/agents/[key]', params: { key: target.id } } as any)
      }
    }
  }, [props.onOpenProfile, router])
  const [threadHeaderHeight, setThreadHeaderHeight] = useState(0)
  const [footerHeight, setFooterHeight] = useState(0)
  // A layout pass reports the footer every time it moves; only a different
  // height should re-inset the list.
  const measureFooter = useCallback((height: number) => {
    setFooterHeight((prev) => (prev === height ? prev : height))
  }, [])
  const [cardFrom, setCardFrom] = useState<ChatMessage | null>(null)
  const [cardNotice, setCardNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!cardNotice) return
    const t = setTimeout(() => setCardNotice(null), 4000)
    return () => clearTimeout(t)
  }, [cardNotice])
  const canMakeCards = !!props.onOpenCard && (conversation.kind === 'public' || conversation.kind === 'private') && conversation.canReply
  const showActivityFilters = conversation.kind === 'activity' && !threadRootId
  // Member filter: active only on the main scope (not threads, not #activity).
  const memberFilterKey = !threadRootId && !showActivityFilters ? (props.memberFilter ?? null) : null
  const memberData = useMemberMessages(workspaceId, memberFilterKey ? conversation.id : null, memberFilterKey)
  const channelList = useConversationList(showActivityFilters ? workspaceId : null)
  const channelDirectory = useChannelDirectory(workspaceId)
  const [activityFilter, setActivityFilter] = useState<ActivityFilterState>(EMPTY_ACTIVITY_FILTER)
  const timeline = useConversationTimeline(workspaceId, conversation.id, threadRootId)
  const typing = useTypingUsers(workspaceId, conversation.id, threadRootId)
  const mailbox = useMailboxForConversation(workspaceId, conversation.id)
  const rootEmail = useMemo(() => {
    if (!threadRootId) return null
    return emailBlockOf(timeline.state.messages.find((m) => m.id === threadRootId))
  }, [threadRootId, timeline.state.messages])
  const mailThreadId = rootEmail?.threadId ?? null
  // A mailbox thread replies by email unless the reader switches to a team comment.
  const [mailMode, setMailMode] = useState<MailComposeMode>('reply')
  const [replyAll, setReplyAll] = useState(false)
  const mailReply = !!mailThreadId && mailMode === 'reply'
  const [mailboxTab, setMailboxTab] = useState<MailboxTab>('inbox')
  const [composingEmail, setComposingEmail] = useState(false)
  const [mailListKey, setMailListKey] = useState(0)
  const showMailboxHeader = !!mailbox && !threadRootId
  const mailboxListView = showMailboxHeader && mailboxTab !== 'chat'
  // The typing row shares the composer's edges, so it lines up with the input box.
  const typingColumnStyle = useComposerColumnStyle({ presentation: 'agent' })
  // `#channel` references resolve against the channels this reader can see, so a
  // private channel they are not in renders as `#privatechannel`, not a name.
  const channelNames = useMemo(
    () =>
      new Map(
        channelDirectory
          .filter((c) => c.kind === 'public' || c.kind === 'private')
          .map((c) => [c.id, c.slug ?? c.name ?? 'channel']),
      ),
    [channelDirectory],
  )
  const names = useMemo(() => mentionNames(mentionables, channelNames), [mentionables, channelNames])
  const newestSeq = useMemo(() => newestReadableSeq(timeline.state.messages), [timeline.state.messages])
  // What was unread when the reader opened this conversation; messages arriving later aren't "new".
  const [unread, setUnread] = useState<{ afterSeq: number; upToSeq: number } | null>(() =>
    !threadRootId && conversation.joined && conversation.lastSeq > conversation.lastReadSeq
      ? { afterSeq: conversation.lastReadSeq, upToSeq: conversation.lastSeq }
      : null,
  )
  const [readPaused, setReadPaused] = useState(false)
  // The conversation's real unread count when it opened, from the list's own
  // summary: the loaded page caps at 50, so counting loaded messages is wrong.
  const summaryUnread = channelDirectory.find((c) => c.id === conversation.id)?.unreadCount
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null)
  useEffect(() => {
    if (unreadTotal !== null || !unread || summaryUnread === undefined) return
    setUnreadTotal(summaryUnread)
  }, [unreadTotal, unread, summaryUnread])
  // An anchored notification view is intentionally a non-contiguous slice.
  // A realtime insert or reconnect can add a much newer row to that slice,
  // but the reader has not seen the gap between it and the target yet.
  // Pause mark-read while filtered too: the user hasn't seen everyone else's messages.
  useMarkReadWhileVisible(
    threadRootId || !conversation.joined || !!memberFilterKey ? null : conversation.id,
    newestSeq,
    visible,
    readPaused || timeline.hasMoreNewer,
  )

  const onMarkUnread = useCallback((m: ChatMessage) => {
    const afterSeq = Math.max(0, m.seq - 1)
    setReadPaused(true)
    setUnread({ afterSeq, upToSeq: Number.MAX_SAFE_INTEGER })
    void api.markRead(conversation.id, afterSeq).catch(() => {})
  }, [conversation.id])

  const [highlight, setHighlight] = useState<string | null>(props.highlightMessageId ?? null)
  useEffect(() => {
    if (props.highlightMessageId) setHighlight(props.highlightMessageId)
  }, [props.highlightMessageId])
  const highlightLoaded = !!highlight && timeline.state.messages.some((m) => m.id === highlight)
  const isDirectMessage = conversation.kind === 'dm' || conversation.kind === 'group_dm'
  const [locatedHighlight, setLocatedHighlight] = useState<string | null>(null)
  const waitingForTarget = isDirectMessage && !!highlight && !highlightLoaded && locatedHighlight !== highlight
  useEffect(() => {
    if (!highlightLoaded) return
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [highlightLoaded, highlight])

  /** Load older pages until `found` holds, up to SEEK_PAGES. */
  const seekOlder = useCallback(async (found: (messages: ChatMessage[]) => boolean) => {
    for (let i = 0; i < SEEK_PAGES; i++) {
      const s = timeline.getState()
      if (found(s.messages) || !s.hasMoreOlder) break
      await timeline.loadOlder(SEEK_PAGE_SIZE)
    }
    return found(timeline.getState().messages)
  }, [timeline.getState, timeline.loadOlder])

  const filtering = showActivityFilters && isActivityFilterActive(activityFilter)
  const visibleMessages = useMemo(
    () => (filtering ? timeline.state.messages.filter((m) => matchesActivityFilters(m, activityFilter)) : timeline.state.messages),
    [filtering, activityFilter, timeline.state.messages],
  )
  const agentOptions = useMemo(
    () => (mentionables?.agents ?? []).map((agent) => ({ id: agent.key, label: agent.name })),
    [mentionables],
  )
  const channelOptions = useMemo(
    () => channelList.list
      .filter((channel) => channel.kind === 'public')
      .map((channel) => ({ id: channel.id, label: channel.name ?? channel.slug ?? 'channel' }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [channelList.list],
  )
  const filterLoads = useRef(0)
  useEffect(() => {
    filterLoads.current = 0
  }, [activityFilter, conversation.id])
  useEffect(() => {
    if (!filtering) return
    if (visibleMessages.length >= ACTIVITY_FILTER_MIN) return
    if (!timeline.state.hasMoreOlder || timeline.loading) return
    if (filterLoads.current >= SEEK_PAGES) return
    let cancelled = false
    void (async () => {
      while (!cancelled && filterLoads.current < SEEK_PAGES) {
        const current = timeline.getState()
        const count = current.messages.filter((m) => matchesActivityFilters(m, activityFilter)).length
        if (count >= ACTIVITY_FILTER_MIN || !current.hasMoreOlder) return
        filterLoads.current += 1
        await timeline.loadOlder(SEEK_PAGE_SIZE)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filtering, activityFilter, visibleMessages.length, timeline.state.hasMoreOlder, timeline.loading, timeline.getState, timeline.loadOlder])

  const sought = useRef<string | null>(null)
  useEffect(() => {
    if (!highlight || threadRootId) return
    if (highlightLoaded) {
      if (isDirectMessage) setLocatedHighlight(highlight)
      return
    }
    if (timeline.loading || sought.current === highlight) return
    sought.current = highlight
    const id = highlight
    void (async () => {
      let targetLoaded = false
      try {
        if (isDirectMessage) {
          // In DMs the target endpoint gives us its sequence directly. Fetching
          // it first avoids paging through up to 1,200 unrelated messages.
          const message = await api.message(id).catch(() => null)
          if (!message || message.conversationId !== conversation.id) return
          if (!message.threadRootId) {
            targetLoaded = await timeline.loadBeforeSeq(message.seq + 1).catch(() => false)
          } else {
            props.onOpenThread?.(message)
            // The reply lives in its own thread, not this DM timeline. Stop
            // hiding the DM so it is ready when the reader closes that thread.
            setHighlight((current) => current === id ? null : current)
            targetLoaded = true
          }
          return
        }

        if (await seekOlder((messages) => messages.some((m) => m.id === id))) return
        const message = await api.message(id).catch(() => null)
        if (!message || message.conversationId !== conversation.id) return
        // In channels, keep the existing fallback for messages beyond the
        // seek window; replies still open their actual thread.
        if (props.onOpenThread) props.onOpenThread(message)
      } finally {
        if (isDirectMessage && !targetLoaded) setLocatedHighlight(id)
      }
    })()
  }, [highlight, highlightLoaded, timeline.loading, threadRootId, seekOlder, props.onOpenThread, timeline.loadBeforeSeq, conversation.id, isDirectMessage])

  const oldestLoaded = timeline.state.messages.find((m) => !m.pending)
  const unreadNotLoaded = !!unread && timeline.state.hasMoreOlder && !!oldestLoaded &&
    oldestLoaded.seq > unread.afterSeq + 1 && oldestLoaded.seq <= unread.upToSeq && oldestLoaded.authorUserId !== me
  const onRevealUnread = useCallback(() => {
    if (!unread) return
    void seekOlder((messages) => messages.some((m) => !m.pending && m.seq <= unread.afterSeq + 1)).then(() => {
      const first = timeline.getState().messages.find((m) => m.seq > unread.afterSeq && !m.pending && m.authorUserId !== me)
      if (first) setHighlight(first.id)
    })
  }, [unread, seekOlder, timeline.getState, me])

  const composerRef = useRef<ComposerHandle>(null)
  const rootRef = useRef<View>(null)

  const onReact = useCallback((m: ChatMessage, emoji: string, on?: boolean) => void timeline.react(m.id, emoji, on).catch(() => {}), [timeline.react])
  const onEdit = useCallback((m: ChatMessage, text: string) => timeline.edit(m.id, text), [timeline.edit])
  const onDelete = useCallback(async (m: ChatMessage) => {
    if (await confirmDelete()) await timeline.remove(m.id).catch(() => {})
  }, [timeline.remove])
  const onStop = useCallback((m: ChatMessage) => void timeline.stopAgent(m.id).catch(() => {}), [timeline.stopAgent])
  const onLoadOlder = useCallback(() => void timeline.loadOlder().catch(() => {}), [timeline.loadOlder])
  const onLoadNewer = useCallback(() => void timeline.loadNewer().catch(() => {}), [timeline.loadNewer])
  const onJumpToLatest = useCallback(() => {
    setHighlight(null)
    void timeline.reload().catch(() => {})
  }, [timeline.reload])
  const onEditLast = useCallback(() => {
    const messages = timeline.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.pending || m.deletedAt || m.authorType !== 'user' || m.authorUserId !== me) continue
      requestEditMessage(m.id)
      return true
    }
    return false
  }, [timeline.state.messages, me])

  const isChannel = conversation.kind === 'public' || conversation.kind === 'private'

  // Flags @-mentions of non-members in the composer, and offers to add
  // anyone the sender just mentioned who isn't in the channel (never for
  // DMs: there's no "member" concept to flag against).
  const channelMemberIds = useMemo(
    () => (isChannel ? new Set(conversation.members.flatMap((m) => (m.type === 'user' ? [m.userId] : []))) : null),
    [isChannel, conversation.members],
  )
  const [mentionNudge, setMentionNudge] = useState<{ ids: string[]; busy: boolean; error: string | null; createdAt: string } | null>(null)
  const [channelsAdded, setChannelsAdded] = useState<{ ids: string[]; createdAt: string } | null>(null)
  useEffect(() => {
    setMentionNudge(null)
    setChannelsAdded(null)
  }, [conversation.id, threadRootId])
  const handleSend = useCallback(async (input: SendInput) => {
    setMentionNudge(null)
    setChannelsAdded(null)
    if (mailReply && mailThreadId) {
      await mail.reply(workspaceId, mailThreadId, { text: input.text, replyAll, attachmentIds: input.attachmentIds })
      return
    }
    const sent = await timeline.send(input)
    if (!sent || !channelMemberIds || getMentionNudgeDismissed()) return
    const ids = nonMemberMentionIds(input.text, channelMemberIds, me)
    if (ids.length) setMentionNudge({ ids, busy: false, error: null, createdAt: new Date().toISOString() })
  }, [timeline.send, channelMemberIds, me, mailReply, mailThreadId, workspaceId, replyAll])
  const handleMailSendLater = useCallback(
    async (input: SendInput, at: Date) => {
      if (!mailThreadId) return
      await mail.reply(workspaceId, mailThreadId, { text: input.text, replyAll, sendAt: at.toISOString() })
    },
    [workspaceId, mailThreadId, replyAll],
  )
  const addMentioned = useCallback(async () => {
    if (!mentionNudge) return
    const { ids } = mentionNudge
    // Adding to a private channel hands over the whole history, files
    // included — the warning Slack puts in front of it.
    if (!(await confirmsAddToChannel(conversation.kind))) return
    setMentionNudge((n) => (n ? { ...n, busy: true, error: null } : n))
    try {
      await api.addMembers(conversation.id, ids)
      setMentionNudge(null)
      setChannelsAdded({ ids, createdAt: new Date().toISOString() })
    } catch (err) {
      setMentionNudge((n) => (n ? { ...n, busy: false, error: err instanceof Error ? err.message : 'Could not add them' } : n))
    }
  }, [mentionNudge, conversation.id, conversation.kind])

  const placeholder = mailReply
    ? `Reply by email${replyAll ? ' to everyone' : ''}…`
    : mailThreadId
      ? 'Comment for the team (not emailed)…'
      : threadRootId
    ? 'Reply in thread…'
    : isChannel
      ? `Message #${conversation.name ?? 'channel'}`
      : 'Write a message…'
  const disabledReason = conversation.archivedAt
    ? 'This channel is archived.'
    : conversation.kind === 'activity'
      ? 'Activity is posted by Shogo. Reply in a thread to discuss.'
      : 'You do not have permission to post here.'
  const canPostHere = threadRootId ? conversation.canReply : conversation.canPost
  const showComposer = !(!conversation.joined && isChannel && !threadRootId) && !mailboxListView
  const dragging = useFileDrop(rootRef, showComposer && canPostHere, (files) => composerRef.current?.addFiles(files))

  // Opening a conversation leaves you ready to type, the way Slack does on the
  // desktop. Recorded per conversation id so a re-render — or a permission
  // flipping to allowed a beat later — never re-steals focus from wherever the
  // reader has since moved it.
  const autofocusedFor = useRef<string | null>(null)
  useEffect(() => {
    if (autofocusedFor.current === conversation.id) return
    autofocusedFor.current = conversation.id
    if (!composerAutofocusesOnOpen({ platform: Platform.OS, canPost: canPostHere })) return
    composerRef.current?.focus()
  }, [conversation.id, canPostHere])

  const crumbs = threadCrumbs({ kind: conversation.kind, label: conversationTitle(conversation) })
  // Running agents are the dock's business; this line is only ever people.
  const typingBody = typingLabelText(typing)
  // The slot is shared with transient notices ("Made SHO-123", an error), so a
  // notice wins the space and only a real typist gets the animated dots.
  const typingRow = cardNotice ? (
    <Text className="text-[13px] text-muted-foreground">{cardNotice}</Text>
  ) : typingBody ? (
    <TypingIndicator label={typingBody} spoken={typingLabel(typing) ?? undefined} />
  ) : null
  const runningReplies = useMemo(() => runningAgentReplies(timeline.state.messages), [timeline.state.messages])
  const runningDock = (
    <RunningAgentsDock
      replies={runningReplies}
      streaming={timeline.state.streaming}
      onJump={setHighlight}
      onStop={onStop}
      onOpenSession={props.onOpenSession}
      workspaceId={workspaceId}
      floating={floating}
    />
  )
  // The list runs full height and is told how much of its bottom the footer
  // covers, so the newest message clears the composer at rest while everything
  // older scrolls behind the transparent band above it.
  const listInsets = {
    top: floating ? (showActivityFilters || memberFilterKey || showMailboxHeader ? 0 : topInset) + threadHeaderHeight : 0,
    bottom: footerHeight,
  }
  // When filtered by member, sort the returned messages ascending (oldest first)
  // so MessageList renders them newest-at-bottom, same as the live timeline.
  const memberMessages = useMemo(
    () => memberFilterKey ? [...memberData.messages].sort((a, b) => a.seq - b.seq) : null,
    [memberFilterKey, memberData.messages],
  )
  const memberFilteredState = memberMessages
    ? { messages: memberMessages, hasMoreOlder: memberData.hasMore, streaming: timeline.state.streaming }
    : null
  const memberFilterName = useMemo(() => {
    if (!memberFilterKey) return null
    const member = memberForKey(conversation.members, memberFilterKey)
    return member?.name?.trim() || (member?.type === 'agent' ? 'Agent' : 'Former member')
  }, [memberFilterKey, conversation.members])
  const list = memberFilteredState ? (
    <MessageList
      state={memberFilteredState}
      loading={memberData.loading}
      me={me}
      names={names}
      mentionables={mentionables}
      channelMemberIds={channelMemberIds}
      canManage={conversation.canManage}
      canPin={conversation.canReply}
      workspaceId={workspaceId}
      inThread={false}
      header={props.header}
      emptyText={isChannel ? `${memberFilterName ?? 'This member'} hasn't posted in #${conversation.name} yet.` : `${memberFilterName ?? 'This member'} hasn't posted in this conversation yet.`}
      onLoadOlder={memberData.hasMore ? () => void memberData.loadMore() : undefined}
      onReply={props.onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onRetry={timeline.retry}
      onDiscard={timeline.discard}
      onOpenSession={props.onOpenSession}
      onOpenProjectPane={props.onOpenProjectPane}
      onOpenProfile={props.onOpenProfile}
      onMentionPress={mentionPress}
      onMakeCard={canMakeCards ? setCardFrom : undefined}
      showThreadContext
      unreadAfterSeq={null}
      unreadNotLoaded={false}
      unreadCount={null}
      highlightId={highlight}
      insets={listInsets}
    />
  ) : (
    <MessageList
      state={{ ...timeline.state, messages: waitingForTarget ? [] : visibleMessages }}
      loading={timeline.loading || waitingForTarget}
      me={me}
      names={names}
      mentionables={mentionables}
      channelMemberIds={channelMemberIds}
      canManage={conversation.canManage}
      canPin={conversation.canReply}
      workspaceId={workspaceId}
      inThread={!!threadRootId}
      header={props.header}
      emptyText={filtering ? 'No matching activity yet.' : threadRootId ? 'No replies yet.' : isChannel ? `This is the very beginning of #${conversation.name}.` : 'Say hello.'}
      onLoadOlder={threadRootId ? undefined : onLoadOlder}
      hasMoreNewer={timeline.hasMoreNewer}
      onLoadNewer={timeline.hasMoreNewer ? onLoadNewer : undefined}
      onJumpToLatest={timeline.hasMoreNewer ? onJumpToLatest : undefined}
      onTrim={timeline.trimOld}
      trimThreshold={TIMELINE_SOFT_LIMIT}
      onReply={props.onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onRetry={timeline.retry}
      onDiscard={timeline.discard}
      onOpenSession={props.onOpenSession}
      onOpenProjectPane={props.onOpenProjectPane}
      onOpenProfile={props.onOpenProfile}
      onMentionPress={mentionPress}
      onMarkUnread={threadRootId || !conversation.joined ? undefined : onMarkUnread}
      onMakeCard={canMakeCards ? setCardFrom : undefined}
      unreadAfterSeq={filtering ? null : unread?.afterSeq ?? null}
      unreadUpToSeq={unread?.upToSeq}
      unreadNotLoaded={filtering ? false : unreadNotLoaded}
      unreadCount={filtering ? null : unreadTotal}
      onRevealUnread={onRevealUnread}
      highlightId={highlight}
      deferHighlightReveal={isDirectMessage && !!props.highlightMessageId}
      insets={listInsets}
    />
  )
  const memberFilterBar = memberFilterKey ? (
    <View
      className="shrink-0 grow-0 border-b border-border/60"
      style={floating && topInset ? { marginTop: topInset } : undefined}
      testID="member-filter-bar"
    >
      {/* Active-filter chip: avatar + "From {Name}" + × */}
      <View className="flex-row items-center gap-2 px-3 py-2">
        <Filter size={14} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
          From {memberFilterName ?? 'member'}
        </Text>
        <Pressable
          onPress={props.onClearMemberFilter}
          accessibilityRole="button"
          accessibilityLabel="Clear member filter"
          testID="member-filter-clear"
          className="rounded-md p-1 active:bg-muted"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      {/* Member switcher */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5 px-3 pb-2"
        testID="member-filter-switcher"
      >
        {conversation.members.map((m: ConversationMember) => {
          const key = memberFromKey(m)
          const active = key === memberFilterKey
          const mname = m.name?.trim() || (m.type === 'agent' ? 'Agent' : 'Member')
          return (
            <Pressable
              key={m.id}
              onPress={() => props.onChangeMemberFilter?.(key)}
              accessibilityRole="button"
              accessibilityLabel={`Filter by ${mname}`}
              aria-selected={active}
              testID={`member-filter-switch-${key}`}
              className={cn(
                'flex-row items-center gap-1.5 rounded-full border px-2 py-1 active:bg-muted',
                active ? 'border-primary bg-primary/10' : 'border-border',
              )}
            >
              {m.type === 'agent' ? (
                <AgentAvatar name={mname} projectId={m.projectId} workspaceId={workspaceId} size={18} />
              ) : (
                <UserAvatar name={mname} image={m.image} size={18} />
              )}
              <Text
                className={cn('max-w-32 text-xs', active ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                numberOfLines={1}
              >
                {mname}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  ) : null
  const filterBar = memberFilterKey ? memberFilterBar : showActivityFilters ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="max-h-12 shrink-0 grow-0 border-b border-border/60"
      contentContainerClassName="items-center gap-2 px-3 py-2"
      style={floating && topInset ? { marginTop: topInset } : undefined}
      testID="activity-filters"
    >
      <ActivityFilterPicker
        label="Agent"
        value={activityFilter.agentKeys}
        options={agentOptions}
        onChange={(agentKeys) => setActivityFilter((filter) => ({ ...filter, agentKeys }))}
      />
      <ActivityFilterPicker
        label="Channel"
        value={activityFilter.conversationIds}
        options={channelOptions}
        onChange={(conversationIds) => setActivityFilter((filter) => ({ ...filter, conversationIds }))}
      />
      {ACTIVITY_CHANNEL_FILTERS.map(({ id, label }) => (
        <Pressable
          key={id}
          accessibilityRole="button"
          aria-selected={activityFilter.kind === id}
          onPress={() => setActivityFilter((filter) => ({ ...filter, kind: id }))}
          className={cn('rounded-full border px-3 py-1', activityFilter.kind === id ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50')}
        >
          <Text className={cn('text-xs', activityFilter.kind === id ? 'font-medium text-primary' : 'text-muted-foreground')}>{label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  ) : null
  const makeCardSheet = cardFrom ? (
    <MakeCardSheet
      workspaceId={workspaceId}
      conversationId={conversation.id}
      message={cardFrom}
      onClose={() => setCardFrom(null)}
      onError={setCardNotice}
      onCreated={(item) => {
        setCardNotice(`Made ${item.key}`)
        props.onOpenCard?.(item)
      }}
    />
  ) : null
  const mailThreadActions = mailThreadId ? (
    <MailThreadActions
      workspaceId={workspaceId}
      threadId={mailThreadId}
      mentionables={mentionables}
      me={me}
      onReply={() => {
        setMailMode('reply')
        composerRef.current?.focus()
      }}
    />
  ) : null
  const mailboxHeader = showMailboxHeader && mailbox ? (
    <MailboxHeader
      mailbox={mailbox}
      tab={mailboxTab}
      onTabChange={setMailboxTab}
      onCompose={() => setComposingEmail(true)}
      style={floating && topInset ? { marginTop: topInset } : undefined}
    />
  ) : null
  const openMailThread = (rootMessageId: string) =>
    props.onOpenThread?.({ id: rootMessageId, threadRootId: null } as unknown as ChatMessage)
  const mailboxBody = mailboxListView && mailbox ? (
    mailboxTab === 'screener' ? (
      <ScreenerList key={mailListKey} workspaceId={workspaceId} mailbox={mailbox} />
    ) : (
      <MailThreadList
        workspaceId={workspaceId}
        mailbox={mailbox}
        view={mailboxTab as MailView}
        mentionables={mentionables}
        onOpenThread={openMailThread}
        refreshKey={mailListKey}
      />
    )
  ) : null
  const composeEmailSheet = composingEmail && mailbox ? (
    <ComposeEmailSheet
      workspaceId={workspaceId}
      mailbox={mailbox}
      onClose={() => setComposingEmail(false)}
      onSent={(root) => {
        setMailListKey((k) => k + 1)
        if (root) openMailThread(root)
      }}
    />
  ) : null
  const composer = (
    <>
      {mentionNudge && (
        <MentionNudgeCard
          ids={mentionNudge.ids}
          names={names}
          isPrivate={conversation.kind === 'private'}
          workspaceId={workspaceId}
          createdAt={mentionNudge.createdAt}
          busy={mentionNudge.busy}
          error={mentionNudge.error}
          onMentionPress={mentionPress}
          onAdd={() => void addMentioned()}
          onDismiss={() => setMentionNudge(null)}
          onDontShowAgain={() => {
            void dismissMentionNudgeForever()
            setMentionNudge(null)
          }}
        />
      )}
      {channelsAdded && (
        <EphemeralNotice
          testID="added-to-channel-notice"
          text={`OK! ${channelsAdded.ids.map((id) => `<@u:${id}>`).join(', ')} ${channelsAdded.ids.length === 1 ? 'has' : 'have'} been added to this channel.`}
          names={names}
          createdAt={channelsAdded.createdAt}
          workspaceId={workspaceId}
          onMentionPress={mentionPress}
        />
      )}
      <AddToChannelConfirmHost />
      <LinkPreviewConsentHost />
      {mailThreadId ? (
        <MailReplyModeBar mode={mailMode} onModeChange={setMailMode} replyAll={replyAll} onReplyAllChange={setReplyAll} />
      ) : null}
      <Composer
        ref={composerRef}
        workspaceId={workspaceId}
        conversationId={conversation.id}
        threadRootId={threadRootId}
        placeholder={placeholder}
        mentionables={mentionables}
        me={me}
        disabled={!canPostHere}
        disabledReason={disabledReason}
        onSend={handleSend}
        onEditLast={onEditLast}
        channelMemberIds={channelMemberIds}
        channels={channelDirectory}
        onSendLater={mailReply ? handleMailSendLater : undefined}
      />
    </>
  )

  if (floating) {
    return (
      <View className="flex-1" ref={rootRef}>
        {filterBar}
        {mailboxHeader}
        {makeCardSheet}
        {composeEmailSheet}
        <GlassBlurTarget>
          {timeline.error && !timeline.state.messages.length ? (
            <View className="flex-1 items-center justify-center gap-2 px-8">
              <Text className="text-center text-sm text-muted-foreground">{timeline.error}</Text>
              <Pressable onPress={() => void timeline.reload()} className="rounded-md bg-muted px-3 py-1.5">
                <Text className="text-sm text-foreground">Try again</Text>
              </Pressable>
            </View>
          ) : (
            mailboxBody ?? list
          )}
        </GlassBlurTarget>
        {threadRootId ? (
          <PhoneScreenHeader
            testID="floating-thread-header"
            top={topInset}
            paddingTop={topInset ? 0 : undefined}
            rowClassName="pb-2"
            onLayout={(e) => setThreadHeaderHeight(Math.round(e.nativeEvent.layout.height))}
            onBack={props.onClose}
            backLabel="Back to conversation"
            title={crumbs[crumbs.length - 1]?.label ?? 'Thread'}
            subtitle={crumbs[0]?.label}
          >
            {mailThreadActions}
          </PhoneScreenHeader>
        ) : null}
        <OverlayFooter
          height={footerHeight}
          onHeight={measureFooter}
          style={{ paddingBottom: chrome.bottom }}
          testID="floating-composer"
        >
          {runningReplies.length ? (
            <View pointerEvents="box-none" className="mb-2" style={typingColumnStyle}>
              {runningDock}
            </View>
          ) : null}
          {typingRow ? (
            <View pointerEvents="box-none" className="mb-2.5" style={typingColumnStyle}>
              <GlassChip className="self-start px-3 py-1.5">
                {typingRow}
              </GlassChip>
            </View>
          ) : null}
          {!showComposer ? (
            <GlassChip className="mx-4 mb-3 flex-row items-center justify-between gap-2 py-1.5 pl-4 pr-1.5">
              <Text className="flex-shrink text-sm text-foreground" numberOfLines={1}>
                You are viewing #{conversation.name}.
              </Text>
              <Pressable onPress={props.onJoin} className="rounded-full bg-primary px-4 py-2">
                <Text className="text-sm font-medium text-primary-foreground">Join channel</Text>
              </Pressable>
            </GlassChip>
          ) : (
            composer
          )}
        </OverlayFooter>
      </View>
    )
  }

  return (
    <View className="flex-1" ref={rootRef}>
      {threadRootId && (
        <View className="flex-row items-center border-b border-border bg-background px-4 py-2.5">
          <Breadcrumb
            className="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-1"
            items={crumbs.map((c) => ({
              key: c.key,
              label: c.label,
              onPress: c.up ? props.onClose : undefined,
            }))}
          />
          {props.onClose && (
            <Pressable onPress={props.onClose} accessibilityLabel="Close thread" className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      )}
      {mailThreadActions}
      {filterBar}
      {mailboxHeader}
      {makeCardSheet}
      {composeEmailSheet}
      {timeline.error && !timeline.state.messages.length ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Text className="text-center text-sm text-muted-foreground">{timeline.error}</Text>
          <Pressable onPress={() => void timeline.reload()} className="rounded-md bg-muted px-3 py-1.5">
            <Text className="text-sm text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : (
        mailboxBody ?? list
      )}
      <OverlayFooter height={footerHeight} onHeight={measureFooter} testID="composer-footer">
        <View pointerEvents="box-none" style={typingColumnStyle}>
          {runningDock}
        </View>
        {/* The slot keeps its height so the composer never jumps, but it draws
            nothing until someone types — and then only a pill behind the text.
            The pill's own vertical padding is taken back out of the layout
            (`-my-1`): the slot reserves 20px of content and a padded one-line
            pill is 24px, which would grow the footer by 4px and move both the
            composer and the transcript the moment someone starts typing. */}
        <View pointerEvents="box-none" className="min-h-[30px] justify-end pb-2.5" style={typingColumnStyle} testID="typing-slot">
          {typingRow ? (
            <View className="-my-1 self-start rounded-full bg-background/90 px-2.5 py-1">{typingRow}</View>
          ) : null}
        </View>
        {!showComposer ? (
          <View className="items-center gap-2 border-t border-border bg-background px-4 py-3">
            <Text className="text-sm text-muted-foreground">You are viewing #{conversation.name}.</Text>
            <Pressable onPress={props.onJoin} className="rounded-md bg-primary px-4 py-1.5">
              <Text className="text-sm font-medium text-primary-foreground">Join channel</Text>
            </Pressable>
          </View>
        ) : (
          composer
        )}
      </OverlayFooter>
      {dragging && (
        <View
          pointerEvents="none"
          className="absolute inset-2 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/90"
          testID="file-drop-overlay"
        >
          <Upload size={22} className="text-primary" />
          <Text className="text-sm font-medium text-foreground">Drop files to upload</Text>
        </View>
      )}
    </View>
  )
}
