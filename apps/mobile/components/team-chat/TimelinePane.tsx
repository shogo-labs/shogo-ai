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
import { ChevronLeft, Upload, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { conversationTitle, teamChatApi, type ChatMessage, type ConversationDetail, type Mentionables } from '../../lib/team-chat-api'
import type { MentionTarget } from '../chat/file-links'
import { mentionNames, newestReadableSeq } from '../../lib/team-chat-state'
import { runningAgentReplies, typingLabel, typingLabelText } from '../../lib/team-chat-typing'
import { useComposerColumnStyle } from '../chat/composer/useComposerColumnStyle'
import { ACTIVITY_CHANNEL_FILTERS, EMPTY_ACTIVITY_FILTER, isActivityFilterActive, matchesActivityFilters, type ActivityFilterState } from '../../lib/activity-channel-filters'
import { TIMELINE_SOFT_LIMIT, useChannelDirectory, useConversationList, useConversationTimeline, useMarkReadWhileVisible, useTypingUsers, type SendInput } from '../../hooks/useTeamChat'
import { requestEditMessage } from '../../hooks/useChatShortcuts'
import { threadCrumbs } from '../../lib/team-chat-nav'
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
import { CHROME_SIZE, GlassButton, GlassChip } from './FloatingChrome'
import { usePhoneChromeOverlay } from '../layout/PhoneChromeOverlay'
import { GlassBlurTarget } from '../ui/LiquidGlassBackdrop'
import { MakeCardSheet } from '../boards/MakeCardSheet'
import type { WorkItem } from '../../lib/work-boards-api'

const api = teamChatApi()
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
        router.push({
          pathname: '/(app)/c/[conversationId]',
          params: { conversationId: target.id },
        } as any)
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
  const [cardFrom, setCardFrom] = useState<ChatMessage | null>(null)
  const [cardNotice, setCardNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!cardNotice) return
    const t = setTimeout(() => setCardNotice(null), 4000)
    return () => clearTimeout(t)
  }, [cardNotice])
  const canMakeCards = !!props.onOpenCard && (conversation.kind === 'public' || conversation.kind === 'private') && conversation.canReply
  const showActivityFilters = conversation.kind === 'activity' && !threadRootId
  const channelList = useConversationList(showActivityFilters ? workspaceId : null)
  const channelDirectory = useChannelDirectory(workspaceId)
  const [activityFilter, setActivityFilter] = useState<ActivityFilterState>(EMPTY_ACTIVITY_FILTER)
  const timeline = useConversationTimeline(workspaceId, conversation.id, threadRootId)
  const typing = useTypingUsers(workspaceId, conversation.id, threadRootId)
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
  useMarkReadWhileVisible(threadRootId || !conversation.joined ? null : conversation.id, newestSeq, visible, readPaused)

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
    if (!highlight || highlightLoaded || timeline.loading || threadRootId || sought.current === highlight) return
    sought.current = highlight
    const id = highlight
    void (async () => {
      if (await seekOlder((messages) => messages.some((m) => m.id === id))) return
      // Too far back to load into the timeline: show it on its own in the thread view.
      const message = await api.message(id).catch(() => null)
      if (message && props.onOpenThread) props.onOpenThread(message)
    })()
  }, [highlight, highlightLoaded, timeline.loading, threadRootId, seekOlder, props.onOpenThread])

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
    const sent = await timeline.send(input)
    if (!sent || !channelMemberIds || getMentionNudgeDismissed()) return
    const ids = nonMemberMentionIds(input.text, channelMemberIds, me)
    if (ids.length) setMentionNudge({ ids, busy: false, error: null, createdAt: new Date().toISOString() })
  }, [timeline.send, channelMemberIds, me])
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

  const placeholder = threadRootId
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
  const showComposer = !(!conversation.joined && isChannel && !threadRootId)
  const dragging = useFileDrop(rootRef, showComposer && canPostHere, (files) => composerRef.current?.addFiles(files))

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
  const listInsets = floating
    ? { top: (showActivityFilters ? 0 : topInset) + threadHeaderHeight, bottom: footerHeight }
    : undefined
  const list = (
    <MessageList
      state={{ ...timeline.state, messages: visibleMessages }}
      loading={timeline.loading}
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
      onRevealUnread={onRevealUnread}
      highlightId={highlight}
      insets={listInsets}
    />
  )
  const filterBar = showActivityFilters ? (
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
      />
    </>
  )

  if (floating) {
    return (
      <View className="flex-1" ref={rootRef}>
        {filterBar}
        {makeCardSheet}
        <GlassBlurTarget>
          {timeline.error && !timeline.state.messages.length ? (
            <View className="flex-1 items-center justify-center gap-2 px-8">
              <Text className="text-center text-sm text-muted-foreground">{timeline.error}</Text>
              <Pressable onPress={() => void timeline.reload()} className="rounded-md bg-muted px-3 py-1.5">
                <Text className="text-sm text-foreground">Try again</Text>
              </Pressable>
            </View>
          ) : (
            list
          )}
        </GlassBlurTarget>
        {threadRootId ? (
          <View
            pointerEvents="box-none"
            onLayout={(e) => setThreadHeaderHeight(Math.round(e.nativeEvent.layout.height))}
            className="absolute left-0 right-0 z-30 flex-row items-center gap-2 px-3 pb-2"
            style={{ top: topInset, paddingTop: topInset ? 0 : insets.top + 6 }}
            testID="floating-thread-header"
          >
            <GlassButton label="Back to conversation" onPress={props.onClose}>
              <ChevronLeft size={22} className="text-foreground" />
            </GlassButton>
            <GlassChip className="min-w-0 flex-shrink justify-center px-4" style={{ height: CHROME_SIZE }}>
              <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                {crumbs[crumbs.length - 1]?.label ?? 'Thread'}
              </Text>
              <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                {crumbs[0]?.label}
              </Text>
            </GlassChip>
          </View>
        ) : null}
        <View
          pointerEvents="box-none"
          onLayout={(e) => {
            const next = Math.round(e.nativeEvent.layout.height)
            setFooterHeight((prev) => (prev === next ? prev : next))
          }}
          style={{ marginTop: -footerHeight, paddingBottom: chrome.bottom }}
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
        </View>
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
      {filterBar}
      {makeCardSheet}
      {timeline.error && !timeline.state.messages.length ? (
        <View className="flex-1 items-center justify-center gap-2 px-8">
          <Text className="text-center text-sm text-muted-foreground">{timeline.error}</Text>
          <Pressable onPress={() => void timeline.reload()} className="rounded-md bg-muted px-3 py-1.5">
            <Text className="text-sm text-foreground">Try again</Text>
          </Pressable>
        </View>
      ) : (
        list
      )}
      <View style={typingColumnStyle}>
        {runningDock}
      </View>
      <View className="min-h-[30px] justify-end pb-2.5" style={typingColumnStyle}>
        {typingRow}
      </View>
      {!showComposer ? (
        <View className="items-center gap-2 border-t border-border px-4 py-3">
          <Text className="text-sm text-muted-foreground">You are viewing #{conversation.name}.</Text>
          <Pressable onPress={props.onJoin} className="rounded-md bg-primary px-4 py-1.5">
            <Text className="text-sm font-medium text-primary-foreground">Join channel</Text>
          </Pressable>
        </View>
      ) : (
        composer
      )}
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
