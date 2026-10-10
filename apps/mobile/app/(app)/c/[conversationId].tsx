// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team chat conversation (channel, DM, or agent DM). Threads open from
 * `?thread=<rootId>`: beside the timeline on wide screens, in its place on
 * narrow ones. `?msg=<id>` scrolls to and highlights one message (in the
 * thread when `thread` is set too). `?project=<id>` shows an agent's project
 * (canvas, files, plans, chat) beside the timeline on wide screens, where it
 * replaces the thread pane.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { conversationTitle, teamChatApi, type ChatMessage, type ConversationDetail } from '../../../lib/team-chat-api'
import { sessionRoute } from '../../../lib/team-chat-nav'
import { useTeamChatEvents } from '../../../lib/team-chat-connection'
import {
  invalidateConversationList,
  setActiveConversation,
  useMentionables,
  useMyUserId,
} from '../../../hooks/useTeamChat'
import { useStatusFeed } from '../../../hooks/useChatPrefs'
import { usePresenceFeed } from '../../../hooks/usePresence'
import { useDraftsFeed, useSavedFeed } from '../../../hooks/useChatItems'
import { useCustomEmojiFeed } from '../../../hooks/useCustomEmoji'
import { ConversationHeader } from '../../../components/team-chat/ConversationHeader'
import { HuddleBanner } from '../../../components/team-chat/Huddle'
import { TimelinePane } from '../../../components/team-chat/TimelinePane'
import { ProjectSidePane } from '../../../components/team-chat/ProjectSidePane'
import { SidePaneResizeHandle, useSidePaneWidth } from '../../../components/team-chat/SidePaneResizer'
import { usePhoneChromeOverlay } from '../../../components/layout/PhoneChromeOverlay'

const api = teamChatApi()
const THREAD_SIDE_PANE_MIN_WIDTH = 1024
const THREAD_PANE_DEFAULT = 420
const THREAD_PANE_MIN = 320
const PROJECT_PANE_MIN = 420
/** Room left for the main timeline so a pane can never cover the conversation. */
const MAIN_TIMELINE_MIN = 480

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ conversationId: string; thread?: string; msg?: string; project?: string }>()
  const conversationId = first(params.conversationId) ?? null
  const threadRootId = first(params.thread) ?? null
  const linkedMessageId = first(params.msg) ?? null
  const projectPaneId = first(params.project) ?? null
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const me = useMyUserId()
  const { width } = useWindowDimensions()
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [headerHeight, setHeaderHeight] = useState(0)
  const chrome = usePhoneChromeOverlay()

  const workspaceId = conversation?.workspaceId ?? workspace?.id ?? null
  const mentionables = useMentionables(workspaceId)
  const sidePane = width >= THREAD_SIDE_PANE_MIN_WIDTH
  const maxPaneWidth = width - MAIN_TIMELINE_MIN
  const threadPane = useSidePaneWidth({
    storageKey: 'shogo.teamChat.threadPaneWidth',
    defaultWidth: THREAD_PANE_DEFAULT,
    minWidth: THREAD_PANE_MIN,
    maxWidth: maxPaneWidth,
  })
  const projectPane = useSidePaneWidth({
    storageKey: 'shogo.teamChat.projectPaneWidth',
    defaultWidth: Math.max(PROJECT_PANE_MIN, Math.round(width * 0.45)),
    minWidth: PROJECT_PANE_MIN,
    maxWidth: maxPaneWidth,
  })
  useStatusFeed(workspaceId)
  usePresenceFeed(workspaceId)
  useSavedFeed(workspaceId)
  useDraftsFeed(workspaceId)
  useCustomEmojiFeed(workspaceId)

  useEffect(() => {
    if (workspaceId && threadRootId) void api.markInboxRead(workspaceId, { threadRootId }).catch(() => {})
  }, [workspaceId, threadRootId])

  const load = useCallback(async () => {
    if (!conversationId) return
    try {
      setConversation(await api.get(conversationId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this conversation')
    }
  }, [conversationId])

  useEffect(() => {
    setConversation(null)
    void load()
  }, [load])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      setActiveConversation(conversationId)
      return () => {
        setFocused(false)
        setActiveConversation(null)
      }
    }, [conversationId]),
  )

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'))
    return () => sub.remove()
  }, [])

  useTeamChatEvents(workspaceId, (event) => {
    if (!conversationId) return
    if (event.type === 'ready') return void load()
    if (
      (event.type === 'conversation.updated' || event.type === 'member.joined' || event.type === 'member.left') &&
      event.conversationId === conversationId
    ) {
      void load()
    }
  })

  const openThread = useCallback(
    (message: ChatMessage) => {
      router.setParams({ thread: message.threadRootId ?? message.id, project: undefined } as any)
    },
    [router],
  )
  const closeThread = useCallback(() => router.setParams({ thread: undefined } as any), [router])
  const openProjectPane = useCallback(
    (projectId: string) => router.setParams({ project: projectId, thread: undefined } as any),
    [router],
  )
  const closeProjectPane = useCallback(() => router.setParams({ project: undefined } as any), [router])
  const openSession = useCallback(
    (message: ChatMessage) => {
      // The workspace agent has no project; its session opens in the workspace agent chat.
      const projectId = message.authorAgent?.projectId ?? null
      if (!message.agentSessionId) return
      if (!conversation) return
      router.push(
        sessionRoute({
          projectId,
          sessionId: message.agentSessionId,
          wide: sidePane,
          origin: {
            conversationId: conversation.id,
            conversationLabel: conversationTitle(conversation),
            conversationKind: conversation.kind,
            threadRootId: message.threadRootId ?? threadRootId,
            agentName: message.authorAgent?.name ?? 'Agent',
          },
        }) as any,
      )
    },
    [router, conversation, threadRootId],
  )
  const onChanged = useCallback(() => {
    void load()
    if (workspaceId) invalidateConversationList(workspaceId)
  }, [load, workspaceId])
  const onJoin = useCallback(async () => {
    if (!conversationId) return
    await api.join(conversationId).catch(() => {})
    onChanged()
  }, [conversationId, onChanged])

  if (error) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">{error}</Text>
        <Pressable onPress={() => router.replace('/(app)/c' as any)} className="rounded-md bg-muted px-3 py-1.5">
          <Text className="text-sm text-foreground">Browse channels</Text>
        </Pressable>
      </View>
    )
  }
  if (!conversation || !workspaceId) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    )
  }

  const visible = focused && foreground
  const showProjectPane = sidePane && !!projectPaneId
  const showThreadPane = !!threadRootId && !showProjectPane
  const showMain = sidePane || !threadRootId
  const projectPaneName =
    (projectPaneId &&
      (conversation.members.find((m) => m.type === 'agent' && m.projectId === projectPaneId)?.name ??
        mentionables?.agents.find((a) => a.projectId === projectPaneId)?.name)) ||
    'Project'
  const openProjectPaneCb = sidePane ? openProjectPane : undefined
  const floating = chrome.overlay && !sidePane
  const goBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace((conversation.kind === 'dm' || conversation.kind === 'group_dm' ? '/(app)/c/dms' : '/(app)') as any)
  }
  const header = (
    <ConversationHeader
      conversation={conversation}
      mentionables={mentionables}
      me={me}
      onChanged={onChanged}
      onLeft={() => router.replace('/(app)/c' as any)}
      floating={floating}
      onBack={goBack}
      onOpenProjectPane={openProjectPaneCb}
      onLayout={floating ? (e) => setHeaderHeight(Math.round(e.nativeEvent.layout.height)) : undefined}
    />
  )

  const huddleLabel =
    conversation.kind === 'dm' || conversation.kind === 'group_dm'
      ? conversation.members.filter((m) => m.type === 'user' && m.userId !== me).map((m) => m.name).join(', ') || 'Direct message'
      : `#${conversation.name ?? 'channel'}`
  const huddleBanner = floating ? (
    <View pointerEvents="box-none" className="absolute left-0 right-0 z-20" style={{ top: headerHeight }}>
      <HuddleBanner conversation={conversation} me={me} label={huddleLabel} />
    </View>
  ) : (
    <HuddleBanner conversation={conversation} me={me} label={huddleLabel} />
  )

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View className="flex-1 flex-row">
        {showMain && (
          <View className="min-w-0 flex-1">
            {header}
            {huddleBanner}
            <TimelinePane
              key={conversation.id}
              workspaceId={workspaceId}
              conversation={conversation}
              me={me}
              mentionables={mentionables}
              visible={visible && !(threadRootId && !sidePane)}
              highlightMessageId={threadRootId ? null : linkedMessageId}
              onOpenThread={openThread}
              onOpenSession={openSession}
              onOpenProjectPane={openProjectPaneCb}
              onJoin={onJoin}
              floating={floating}
              topInset={headerHeight}
            />
          </View>
        )}
        {showThreadPane && (
          <View
            className={sidePane ? 'relative shrink-0 border-l border-border' : 'flex-1'}
            style={sidePane ? { width: threadPane.width } : undefined}
          >
            {sidePane && (
              <SidePaneResizeHandle
                width={threadPane.width}
                minWidth={THREAD_PANE_MIN}
                maxWidth={maxPaneWidth}
                onResize={threadPane.setWidth}
                onResizeEnd={threadPane.commit}
                onReset={threadPane.reset}
              />
            )}
            <TimelinePane
              key={`${conversation.id}:${threadRootId}`}
              workspaceId={workspaceId}
              conversation={conversation}
              threadRootId={threadRootId}
              me={me}
              mentionables={mentionables}
              visible={visible}
              highlightMessageId={linkedMessageId}
              onOpenSession={openSession}
              onClose={closeThread}
              floating={floating}
            />
          </View>
        )}
        {showProjectPane && projectPaneId && (
          <View className="relative shrink-0 border-l border-border" style={{ width: projectPane.width }}>
            <SidePaneResizeHandle
              width={projectPane.width}
              minWidth={PROJECT_PANE_MIN}
              maxWidth={maxPaneWidth}
              onResize={projectPane.setWidth}
              onResizeEnd={projectPane.commit}
              onReset={projectPane.reset}
            />
            <ProjectSidePane key={projectPaneId} projectId={projectPaneId} workspaceId={workspaceId} name={projectPaneName} onClose={closeProjectPane} />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}
