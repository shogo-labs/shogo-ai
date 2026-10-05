// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A live timeline plus composer for one scope: a conversation's main view,
 * or a single thread when `threadRootId` is set.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, Upload, X } from 'lucide-react-native'
import { conversationTitle, teamChatApi, type ChatMessage, type ConversationDetail, type Mentionables } from '../../lib/team-chat-api'
import { mentionNames } from '../../lib/team-chat-state'
import { TIMELINE_SOFT_LIMIT, useConversationTimeline, useMarkReadWhileVisible, useTypingUsers } from '../../hooks/useTeamChat'
import { requestEditMessage } from '../../hooks/useChatShortcuts'
import { threadCrumbs } from '../../lib/team-chat-nav'
import { Breadcrumb } from './SessionBreadcrumb'
import { MessageList } from './MessageList'
import { Composer, type ComposerHandle } from './Composer'
import { CHROME_SIZE, GlassButton, GlassChip } from './FloatingChrome'
import { usePhoneChromeOverlay } from '../layout/PhoneChromeOverlay'
import { GlassBlurTarget } from '../ui/LiquidGlassBackdrop'
import { CHANNEL_CHAT_COLUMN_GUTTER, CHANNEL_GUTTER_STYLE } from '../../lib/chat-column'

const api = teamChatApi()
/** Pages of 200 to load back when jumping to an older message before opening it on its own. */
const SEEK_PAGES = 6
const SEEK_PAGE_SIZE = 200
const HIGHLIGHT_MS = 4000

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
  onClose?: () => void
  onJoin?: () => void
  /** Scroll to and emphasize this message (from a message link or search). */
  highlightMessageId?: string | null
  /** Phone presentation: messages run full-bleed under floating chrome. */
  floating?: boolean
  /** Height of the floating header drawn over this pane. */
  topInset?: number
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

function typingLabel(names: string[]): string | null {
  if (!names.length) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}

export function TimelinePane(props: TimelinePaneProps) {
  const { workspaceId, conversation, threadRootId = null, me, mentionables, visible, floating = false, topInset = 0 } = props
  const chrome = usePhoneChromeOverlay()
  const insets = useSafeAreaInsets()
  const [threadHeaderHeight, setThreadHeaderHeight] = useState(0)
  const [footerHeight, setFooterHeight] = useState(0)
  const timeline = useConversationTimeline(workspaceId, conversation.id, threadRootId)
  const typing = useTypingUsers(workspaceId, conversation.id, threadRootId)
  const names = useMemo(() => mentionNames(mentionables), [mentionables])
  const newestSeq = useMemo(() => {
    for (let i = timeline.state.messages.length - 1; i >= 0; i--) {
      const m = timeline.state.messages[i]!
      if (!m.pending && !m.threadRootId) return m.seq
    }
    return 0
  }, [timeline.state.messages])
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

  const onReact = useCallback((m: ChatMessage, emoji: string) => void timeline.react(m.id, emoji).catch(() => {}), [timeline.react])
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
  const typingText = typingLabel(typing)
  const listInsets = floating
    ? { top: topInset + threadHeaderHeight, bottom: footerHeight }
    : undefined
  const list = (
    <MessageList
      state={timeline.state}
      loading={timeline.loading}
      me={me}
      names={names}
      canManage={conversation.canManage}
      canPin={conversation.canReply}
      workspaceId={workspaceId}
      inThread={!!threadRootId}
      header={props.header}
      emptyText={threadRootId ? 'No replies yet.' : isChannel ? `This is the very beginning of #${conversation.name}.` : 'Say hello.'}
      onLoadOlder={threadRootId ? undefined : onLoadOlder}
      onTrim={timeline.trimOld}
      trimThreshold={TIMELINE_SOFT_LIMIT}
      onReply={props.onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onStopAgent={onStop}
      onRetry={timeline.retry}
      onDiscard={timeline.discard}
      onOpenSession={props.onOpenSession}
      onOpenProjectPane={props.onOpenProjectPane}
      onMarkUnread={threadRootId || !conversation.joined ? undefined : onMarkUnread}
      unreadAfterSeq={unread?.afterSeq ?? null}
      unreadUpToSeq={unread?.upToSeq}
      unreadNotLoaded={unreadNotLoaded}
      onRevealUnread={onRevealUnread}
      highlightId={highlight}
      insets={listInsets}
    />
  )
  const composer = (
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
      onSend={timeline.send}
      onEditLast={onEditLast}
    />
  )

  if (floating) {
    return (
      <View className="flex-1" ref={rootRef}>
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
          {typingText ? (
            <GlassChip className="mb-2 self-start px-3 py-1" style={{ marginLeft: CHANNEL_CHAT_COLUMN_GUTTER }}>
              <Text className="text-xs text-muted-foreground">{typingText}</Text>
            </GlassChip>
          ) : null}
          {!showComposer ? (
            <GlassChip className="mb-3 flex-row items-center justify-between gap-2 py-1.5 pl-4 pr-1.5" style={{ marginHorizontal: CHANNEL_CHAT_COLUMN_GUTTER }}>
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
        <View className="flex-row items-center border-b border-border py-2.5" style={CHANNEL_GUTTER_STYLE}>
          <Breadcrumb
            className="flex-1 flex-row flex-wrap items-center gap-x-1"
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
      <View className="h-5 justify-center" style={CHANNEL_GUTTER_STYLE}>
        {typingText && <Text className="text-xs text-muted-foreground">{typingText}</Text>}
      </View>
      {!showComposer ? (
        <View className="items-center gap-2 border-t border-border py-3" style={CHANNEL_GUTTER_STYLE}>
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
