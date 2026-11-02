// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team chat conversation (channel, DM, or agent DM). Threads open from
 * `?thread=<rootId>`: beside the timeline on wide screens, in its place on
 * narrow ones. `?msg=<id>` scrolls to and highlights one message (in the
 * thread when `thread` is set too). `?project=<id>` shows an agent's project
 * (canvas, files, plans, chat) beside the timeline on wide screens, where it
 * replaces the thread pane. `?doc=1` shows the channel doc: beside the
 * timeline on wide screens (replacing the other panes), in its place on narrow.
 * `?files=1` lists the conversation's files in the same pane.
 * `?file=<url>` opens a file from chat (a `share_file` link or a stored chat
 * attachment) in that pane, in the app's own viewer — never a browser tab.
 * `?board=<id>` shows one of the channel's boards in place of the timeline;
 * `?card=<id>` opens a card beside it on wide screens (taking over from the
 * other panes) and in its place on narrow ones. `?profile=<userId>` shows a
 * person's profile in that same pane; narrow screens push `/(app)/people/[userId]`
 * instead, and closing it brings back a thread it was shown over.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { conversationTitle, teamChatApi, type ChatMessage, type ConversationDetail, type ConversationFile } from '../../../lib/team-chat-api'
import { sessionRoute } from '../../../lib/team-chat-nav'
import { resolvePanes } from '../../../lib/team-chat-panes'
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
import { AgentWorkingBanner } from '../../../components/team-chat/AgentWorkingBanner'
import { ConversationHeader } from '../../../components/team-chat/ConversationHeader'
import { ChatPermissionNudge } from '../../../components/notifications/ChatPermissionNudge'
import { HuddleBanner } from '../../../components/team-chat/Huddle'
import { TimelinePane } from '../../../components/team-chat/TimelinePane'
import { ProjectSidePane } from '../../../components/team-chat/ProjectSidePane'
import { FilesPane } from '../../../components/team-chat/FilesPane'
import { SidePaneResizeHandle, useSidePaneWidth } from '../../../components/team-chat/SidePaneResizer'
import { DocPane } from '../../../components/team-chat/DocPane'
import { UserProfilePane } from '../../../components/team-chat/UserProfilePane'
import { ChannelTabs, channelSupportsDoc, channelTabItems } from '../../../components/team-chat/ChannelTabs'
import { ShareFileView } from '../../../components/chat/ShareFileViewer'
import { ShareFileProvider, type ShareFileTarget } from '../../../components/chat/share-file-context'
import { parseInAppFileHref } from '../../../lib/share-file-links'
import { BoardKanban } from '../../../components/boards/BoardKanban'
import { CardPane } from '../../../components/boards/CardPane'
import { NewBoardSheet } from '../../../components/boards/NewBoardSheet'
import { useChannelBoards } from '../../../hooks/useWorkBoards'
import { usePlatformConfig } from '../../../lib/platform-config'
import type { WorkItem } from '../../../lib/work-boards-api'
import { usePhoneChromeOverlay } from '../../../components/layout/PhoneChromeOverlay'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const api = teamChatApi()
const THREAD_SIDE_PANE_MIN_WIDTH = 1024
const THREAD_PANE_DEFAULT = 420
const THREAD_PANE_MIN = 320
const PROJECT_PANE_MIN = 420
const DOC_PANE_MIN = 380
const CARD_PANE_DEFAULT = 460
const FILE_PANE_DEFAULT = 560
/** Slack-style fixed profile card; it has no resizer. */
const PROFILE_PANE_WIDTH = 380
/** Room left for the main timeline so a pane can never cover the conversation. */
const MAIN_TIMELINE_MIN = 480

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function ConversationScreen() {
  const params = useLocalSearchParams<{
    conversationId: string
    thread?: string
    msg?: string
    project?: string
    files?: string
    doc?: string
    board?: string
    card?: string
    profile?: string
    file?: string
  }>()
  const conversationId = first(params.conversationId) ?? null
  const threadRootId = first(params.thread) ?? null
  const linkedMessageId = first(params.msg) ?? null
  const projectPaneId = first(params.project) ?? null
  const filesOpen = first(params.files) === '1'
  const docParam = first(params.doc) === '1'
  const boardParam = first(params.board) ?? null
  const cardId = first(params.card) ?? null
  const profilePaneId = first(params.profile) ?? null
  const fileHref = first(params.file) ?? null
  const openFile = fileHref ? parseInAppFileHref(fileHref) : null
  const router = useRouter()
  const navigation = useNavigation()
  const activeToken = useRef({}).current
  const workspace = useActiveWorkspace()
  const me = useMyUserId()
  const { width: windowWidth } = useWindowDimensions()
  // Measured width of the conversation area, which is the window minus the app's sidebar. Falls back to the window until the first layout.
  const [containerWidth, setContainerWidth] = useState(0)
  const width = containerWidth || windowWidth
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(true)
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [headerHeight, setHeaderHeight] = useState(0)
  const [addingBoard, setAddingBoard] = useState(false)
  const chrome = usePhoneChromeOverlay()
  const insets = useSafeAreaInsets()

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
  const cardPane = useSidePaneWidth({
    storageKey: 'shogo.teamChat.cardPaneWidth',
    defaultWidth: CARD_PANE_DEFAULT,
    minWidth: THREAD_PANE_MIN,
    maxWidth: maxPaneWidth,
  })
  const filePane = useSidePaneWidth({
    storageKey: 'shogo.teamChat.filePaneWidth',
    defaultWidth: FILE_PANE_DEFAULT,
    minWidth: THREAD_PANE_MIN,
    maxWidth: maxPaneWidth,
  })
  const { features } = usePlatformConfig()
  const boardsOn = !!features.workBoards
  const channelBoards = useChannelBoards(workspaceId, conversationId, boardsOn && !!conversation && channelSupportsDoc(conversation))
  const docPane = useSidePaneWidth({
    storageKey: 'shogo.teamChat.docPaneWidth',
    defaultWidth: Math.max(DOC_PANE_MIN, Math.round(width * 0.45)),
    minWidth: DOC_PANE_MIN,
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
      setActiveConversation(conversationId, activeToken)
      return () => {
        setFocused(false)
        setActiveConversation(null, activeToken)
      }
    }, [conversationId, activeToken]),
  )

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'))
    return () => sub.remove()
  }, [])

  useTeamChatEvents(workspaceId, (event) => {
    if (!conversationId) return
    if (event.type === 'conversation.deleted' && event.conversationId === conversationId) {
      return setError('This channel was deleted.')
    }
    if (event.type === 'ready') return void load()
    if (
      (event.type === 'conversation.updated' || event.type === 'member.joined' || event.type === 'member.left') &&
      event.conversationId === conversationId
    ) {
      void load()
    }
    if (event.type === 'doc.updated' && event.conversationId === conversationId) {
      setConversation((c) => (c && !c.hasDoc ? { ...c, hasDoc: true } : c))
    }
  })

  const openThread = useCallback(
    (message: ChatMessage) => {
      if (!conversationId) return
      const thread = message.threadRootId ?? message.id
      if (threadRootId) {
        // Already in a thread: swap it in place so Back returns to the channel, not to the previous thread.
        router.setParams({ thread, project: undefined, files: undefined, doc: undefined } as any)
        return
      }
      // Push an entry so the browser or OS back button closes the thread rather than leaving the channel.
      router.push({
        pathname: '/(app)/c/[conversationId]',
        params: {
          conversationId,
          thread,
          ...(boardParam ? { board: boardParam } : {}),
          ...(cardId ? { card: cardId } : {}),
        },
      } as any)
    },
    [router, conversationId, threadRootId, boardParam, cardId],
  )
  const closeThread = useCallback(() => {
    // A thread opened from this channel pushed an entry on top of the channel: pop it, so the
    // channel comes back as it was and the browser history stays in step. A thread opened from
    // elsewhere (a deep link) has nothing to pop, so it closes in place.
    const state: any = navigation.getState()
    const current = state?.routes?.[state.index]
    const previous = state && state.index > 0 ? state.routes[state.index - 1] : undefined
    const previousParams = previous?.params as Record<string, string | undefined> | undefined
    // Only pop onto the plain channel. Popping onto a link that carries a `msg` would reopen
    // this thread on the next frame: the seek fallback opens the thread a thread reply belongs to.
    const popsToPlainChannel =
      current &&
      previous &&
      previous.name === current.name &&
      previousParams?.conversationId === conversationId &&
      !previousParams?.thread &&
      !previousParams?.msg
    if (popsToPlainChannel) {
      router.back()
      return
    }
    // `msg` belongs to the thread it came with (`?thread=<root>&msg=<reply>` — the link to a
    // running agent's answer). Left behind, it points the channel at a reply it cannot show,
    // and the seek fallback re-opened the pane on the next frame.
    router.setParams({ thread: undefined, msg: undefined } as any)
  }, [navigation, router, conversationId])
  const openProjectPane = useCallback(
    (projectId: string) => router.setParams({ project: projectId, thread: undefined, files: undefined, doc: undefined } as any),
    [router],
  )
  const closeProjectPane = useCallback(() => router.setParams({ project: undefined } as any), [router])
  const openFiles = useCallback(
    () => router.setParams({ files: '1', doc: undefined, thread: undefined, project: undefined } as any),
    [router],
  )
  const closeFiles = useCallback(() => router.setParams({ files: undefined } as any), [router])
  const showFileInChat = useCallback(
    (file: ConversationFile) =>
      router.setParams({ files: undefined, doc: undefined, project: undefined, thread: file.threadRootId ?? undefined, msg: file.messageId } as any),
    [router],
  )
  const openDoc = useCallback(
    () => router.setParams({ doc: '1', board: undefined, files: undefined, thread: undefined, project: undefined, card: undefined } as any),
    [router],
  )
  const closeDoc = useCallback(() => router.setParams({ doc: undefined, board: undefined } as any), [router])
  const openBoard = useCallback(
    (boardId: string) => router.setParams({ board: boardId, doc: undefined, files: undefined } as any),
    [router],
  )
  const openCard = useCallback(
    (item: Pick<WorkItem, 'id'>) => router.setParams({ card: item.id, thread: undefined, project: undefined, files: undefined, doc: undefined } as any),
    [router],
  )
  const closeCard = useCallback(() => router.setParams({ card: undefined } as any), [router])
  /**
   * Open a file from chat in the pane. A thread left in the URL is kept (as a
   * profile is) so closing the file brings it back, and the other panes step
   * aside — a file link should never open a tab or a second window.
   */
  const openShareFile = useCallback(
    (target: ShareFileTarget) =>
      router.setParams({ file: target.href, project: undefined, files: undefined, doc: undefined, card: undefined } as any),
    [router],
  )
  const closeShareFile = useCallback(() => router.setParams({ file: undefined } as any), [router])
  /**
   * Open a person's profile. Wide screens get the side pane and narrow ones
   * push the full page, the same split every other pane uses.
   *
   * Unlike the other panes this deliberately leaves `thread` in the URL: tapping
   * a name while reading a thread shows the profile over it, and closing the
   * profile brings the thread back instead of dropping you into the timeline.
   */
  const openProfile = useCallback(
    (userId: string) => {
      if (width >= THREAD_SIDE_PANE_MIN_WIDTH) {
        router.setParams({ profile: userId, project: undefined, files: undefined, doc: undefined, card: undefined } as any)
      } else {
        router.push({ pathname: '/(app)/people/[userId]', params: { userId } } as any)
      }
    },
    [router, width],
  )
  const closeProfile = useCallback(() => router.setParams({ profile: undefined } as any), [router])
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
  const supportsDoc = channelSupportsDoc(conversation)
  const boardId = supportsDoc && boardsOn ? boardParam : null
  const docOpen = supportsDoc && docParam && !boardId
  const {
    showDocPane,
    showDocFull,
    showFilesPane,
    showFilesFull,
    showCardPane,
    showProfilePane,
    showProjectPane,
    showThreadPane,
    showFilePane,
    showFileFull,
    showMain,
  } = resolvePanes({
    sidePane,
    threadRootId,
    projectPaneId,
    filesOpen,
    docOpen,
    cardId,
    profilePaneId,
    fileOpen: !!openFile,
  })
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
  const boards = channelBoards.boards
  const onAddBoard = boardsOn && conversation.canPost && !conversation.archivedAt ? () => setAddingBoard(true) : undefined
  const tabProps = {
    conversation,
    docOpen,
    onOpenDoc: openDoc,
    onShowMessages: closeDoc,
    boards,
    activeBoardId: boardId,
    onOpenBoard: openBoard,
    onAddBoard,
  }
  // On a phone the tabs live in the header's glass panel (like Slack), not in a strip under it.
  const tabsMenu = supportsDoc && floating ? { items: channelTabItems(tabProps), onAddBoard } : undefined
  const header = (
    <ConversationHeader
      conversation={conversation}
      mentionables={mentionables}
      me={me}
      onChanged={onChanged}
      onLeft={() => router.replace('/(app)/c' as any)}
      onDeleted={() => router.replace('/(app)/c' as any)}
      floating={floating}
      onBack={goBack}
      onOpenProjectPane={openProjectPaneCb}
      onOpenFiles={openFiles}
      onOpenDoc={supportsDoc ? openDoc : undefined}
      onLayout={floating ? (e) => setHeaderHeight(Math.round(e.nativeEvent.layout.height)) : undefined}
      tabsMenu={tabsMenu}
    />
  )
  const tabs = supportsDoc && !floating ? <ChannelTabs {...tabProps} /> : null
  // The phone header floats over the content; the content clears it with this inset.
  const topInset = headerHeight

  const huddleLabel =
    conversation.kind === 'dm' || conversation.kind === 'group_dm'
      ? conversation.members.filter((m) => m.type === 'user' && m.userId !== me).map((m) => m.name).join(', ') || 'Direct message'
      : `#${conversation.name ?? 'channel'}`
  const agentMember = conversation.kind === 'dm' ? conversation.members.find((m) => m.type === 'agent' && m.projectId) : undefined
  const banners = (
    <>
      <HuddleBanner conversation={conversation} me={me} label={huddleLabel} />
      {agentMember?.type === 'agent' && agentMember.projectId ? (
        <AgentWorkingBanner
          projectId={agentMember.projectId}
          agentName={agentMember.name || 'Agent'}
          conversationId={conversation.id}
          polling={visible}
        />
      ) : null}
    </>
  )
  const huddleBanner = floating ? (
    <View pointerEvents="box-none" className="absolute left-0 right-0 z-20" style={{ top: topInset }}>
      {banners}
    </View>
  ) : (
    banners
  )

  return (
    <ShareFileProvider open={openShareFile}>
      <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === 'web' ? undefined : 'padding'}>
        <View className="flex-1 flex-row" onLayout={(e) => setContainerWidth(Math.round(e.nativeEvent.layout.width))}>
          {showMain && (
            <View className="min-w-0 flex-1 overflow-hidden">
              {header}
              {tabs}
              {huddleBanner}
              <ChatPermissionNudge />
              {boardId ? (
                <View className="flex-1" style={floating ? { paddingTop: topInset, paddingBottom: chrome.bottom } : undefined}>
                  <BoardKanban
                    key={boardId}
                    boardId={boardId}
                    workspaceId={workspaceId}
                    mentionables={mentionables}
                    selectedItemId={cardId}
                    onOpenCard={openCard}
                  />
                </View>
              ) : (
                <TimelinePane
                  key={conversation.id}
                  workspaceId={workspaceId}
                  conversation={conversation}
                  me={me}
                  mentionables={mentionables}
                  visible={visible && !((threadRootId || cardId || filesOpen || docOpen || !!openFile) && !sidePane)}
                  highlightMessageId={threadRootId ? null : linkedMessageId}
                  onOpenThread={openThread}
                  onOpenSession={openSession}
                  onOpenProjectPane={openProjectPaneCb}
                  onOpenProfile={openProfile}
                  onJoin={onJoin}
                  onOpenCard={boardsOn ? openCard : undefined}
                  floating={floating}
                  topInset={topInset}
                />
              )}
            </View>
          )}
          {showThreadPane && (
            <View
              className={sidePane ? 'relative shrink-0 border-l border-border bg-background' : 'flex-1 bg-background'}
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
                onOpenProfile={openProfile}
                onOpenCard={boardsOn ? openCard : undefined}
                onClose={closeThread}
                floating={floating}
              />
            </View>
          )}
          {showCardPane && cardId && (
            <View
              className={sidePane ? 'relative shrink-0 border-l border-border bg-background' : 'flex-1 bg-background'}
              style={sidePane ? { width: cardPane.width } : floating ? { paddingTop: insets.top, paddingBottom: chrome.bottom } : undefined}
            >
              {sidePane && (
                <SidePaneResizeHandle
                  width={cardPane.width}
                  minWidth={THREAD_PANE_MIN}
                  maxWidth={maxPaneWidth}
                  onResize={cardPane.setWidth}
                  onResizeEnd={cardPane.commit}
                  onReset={cardPane.reset}
                />
              )}
              <CardPane
                key={cardId}
                itemId={cardId}
                workspaceId={workspaceId}
                me={me}
                mentionables={mentionables}
                conversation={conversation}
                visible={visible}
                onClose={closeCard}
              />
            </View>
          )}
          {(showFilePane || showFileFull) && openFile && (
            <View
              className={showFilePane ? 'relative shrink-0 border-l border-border bg-background' : 'flex-1 bg-background'}
              style={showFilePane ? { width: filePane.width } : floating ? { paddingTop: insets.top } : undefined}
              testID="chat-file-pane"
            >
              {showFilePane && (
                <SidePaneResizeHandle
                  width={filePane.width}
                  minWidth={THREAD_PANE_MIN}
                  maxWidth={maxPaneWidth}
                  onResize={filePane.setWidth}
                  onResizeEnd={filePane.commit}
                  onReset={filePane.reset}
                />
              )}
              <ShareFileView key={openFile.href} target={openFile} onClose={closeShareFile} embedded />
            </View>
          )}
          {showProjectPane && projectPaneId && (
            <View className="relative shrink-0 border-l border-border bg-background" style={{ width: projectPane.width }}>
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
          {(showFilesPane || showFilesFull) && (
            <View
              className={showFilesPane ? 'relative shrink-0 border-l border-border bg-background' : 'flex-1 bg-background'}
              style={showFilesPane ? { width: threadPane.width } : { paddingTop: floating ? insets.top : 0 }}
            >
              {showFilesPane && (
                <SidePaneResizeHandle
                  width={threadPane.width}
                  minWidth={THREAD_PANE_MIN}
                  maxWidth={maxPaneWidth}
                  onResize={threadPane.setWidth}
                  onResizeEnd={threadPane.commit}
                  onReset={threadPane.reset}
                />
              )}
              <FilesPane
                key={conversation.id}
                workspaceId={workspaceId}
                conversationId={conversation.id}
                title={huddleLabel}
                onClose={closeFiles}
                onShowInChat={showFileInChat}
              />
            </View>
          )}
          {showDocPane && (
            <View className="relative shrink-0 border-l border-border bg-background" style={{ width: docPane.width }}>
              <SidePaneResizeHandle
                width={docPane.width}
                minWidth={DOC_PANE_MIN}
                maxWidth={maxPaneWidth}
                onResize={docPane.setWidth}
                onResizeEnd={docPane.commit}
                onReset={docPane.reset}
              />
              <DocPane key={conversation.id} conversation={conversation} workspaceId={workspaceId} mentionables={mentionables} onClose={closeDoc} onOpenProfile={openProfile} />
            </View>
          )}
          {showDocFull && (
            <View className="flex-1">
              {floating ? <View style={{ height: insets.top }} /> : (
                <>
                  {header}
                  {tabs}
                </>
              )}
              <DocPane key={conversation.id} conversation={conversation} workspaceId={workspaceId} mentionables={mentionables} onClose={closeDoc} onOpenProfile={openProfile} />
            </View>
          )}
          {showProfilePane && profilePaneId && (
            <View
              className="relative shrink-0 border-l border-border bg-background"
              style={{ width: PROFILE_PANE_WIDTH }}
              testID="user-profile-pane"
            >
              <UserProfilePane
                key={profilePaneId}
                workspaceId={workspaceId}
                userId={profilePaneId}
                onClose={closeProfile}
              />
            </View>
          )}
        </View>
        {addingBoard ? (
          <NewBoardSheet
            workspaceId={workspaceId}
            conversationId={conversation.id}
            onClose={() => setAddingBoard(false)}
            onCreated={(board) => {
              setAddingBoard(false)
              channelBoards.setBoards((list) => (list.some((b) => b.id === board.id) ? list : [...list, board]))
              openBoard(board.id)
            }}
          />
        ) : null}
      </KeyboardAvoidingView>
    </ShareFileProvider>
  )
}
