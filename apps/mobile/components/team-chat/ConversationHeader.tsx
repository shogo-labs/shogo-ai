// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Archive, Bell, BellOff, Bot, Check, ChevronLeft, ChevronRight, FileText, FolderOpen, Hash, Lock, LogOut, MoreHorizontal, Paperclip, Pencil, PanelRight, Pin, Radio, Sparkles, Star, Trash2, UserCircle, UserPlus, Users, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'
import { CHROME_SIZE, GlassButton, GlassChip } from './FloatingChrome'
import { MarkdownText } from '../chat/MarkdownText'
import { WebTooltip } from '../chat/WebTooltip'
import {
  conversationTitle,
  isAgentDm,
  teamChatApi,
  type CatchUpResult,
  type ChatMessage,
  type ConversationDetail,
  type Mentionables,
  type MembershipNotifyLevel,
  type Participant,
} from '../../lib/team-chat-api'
import { mentionNames, renderMentionsMarkdown } from '../../lib/team-chat-state'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { usePresence } from '../../hooks/usePresence'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { PresenceDot, presenceLabel } from './PresenceDot'
import { AgentAvatar } from './AgentAvatar'
import { confirmsAddToChannel } from './AddToChannelConfirm'
import { UserAvatar } from './UserAvatar'
import { HuddleButton } from './Huddle'
import { ChannelTabList, type ChannelTabItem } from './ChannelTabs'

const api = teamChatApi()

/** One inline header icon: a 16px icon with `p-1.5` padding, plus the row gap. */
const HEADER_SLOT = 36
/** Room kept for the leading avatar, the title's minimum width, the huddle button and their gaps. */
const HEADER_FIXED = 24 + 8 + 120 + 8 + 28 + 8
/** Narrower than this, the desktop header shows only the title, the huddle button and "More". */
const HEADER_COMPACT = 260
/** Actions that stay inline first, in this order. Anything else goes under "More" when space runs out. */
const INLINE_PRIORITY = ['catchup', 'notify', 'star', 'pins', 'files', 'members']

/**
 * Splits the desktop header actions into the ones that fit inline and the rest,
 * which move under "More". A `rowWidth` of 0 means the row is not measured yet,
 * so everything stays inline.
 */
export function splitHeaderActions<T extends { key: string }>(actions: T[], rowWidth: number): { inline: T[]; overflow: T[] } {
  if (rowWidth <= 0) return { inline: actions, overflow: [] }
  if (rowWidth < HEADER_COMPACT) return { inline: [], overflow: actions }
  const slotsIn = (width: number) => Math.max(0, Math.floor((width - HEADER_FIXED) / HEADER_SLOT))
  if (actions.length <= slotsIn(rowWidth)) return { inline: actions, overflow: [] }
  // The More button takes one slot itself.
  const slots = slotsIn(rowWidth - HEADER_SLOT)
  const rank = (key: string) => {
    const i = INLINE_PRIORITY.indexOf(key)
    return i === -1 ? INLINE_PRIORITY.length : i
  }
  const kept = new Set([...actions].sort((a, b) => rank(a.key) - rank(b.key)).slice(0, slots).map((a) => a.key))
  return { inline: actions.filter((a) => kept.has(a.key)), overflow: actions.filter((a) => !kept.has(a.key)) }
}

export interface ConversationHeaderProps {
  conversation: ConversationDetail
  mentionables: Mentionables | null
  me: string | null
  onChanged: () => void
  onLeft: () => void
  /** The channel was deleted from here; defaults to `onLeft`. */
  onDeleted?: () => void
  /** Phone presentation: glass back button, title pill and actions sheet over the messages. */
  floating?: boolean
  /** Phone: the channel's tabs, listed in the details panel instead of a strip under the header. */
  tabsMenu?: { items: ChannelTabItem[]; onAddBoard?: () => void }
  onBack?: () => void
  /** Show the agent's project beside the conversation. Only passed on wide screens. */
  onOpenProjectPane?: (projectId: string, name: string) => void
  onOpenFiles?: () => void
  /** Open the channel doc. Passed for channels that support one. */
  onOpenDoc?: () => void
  onLayout?: (event: LayoutChangeEvent) => void
}

function confirm(title: string, message: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window === 'undefined' || window.confirm(`${title}\n\n${message}`))
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
    ]),
  )
}

export function ConversationHeader({ conversation, mentionables, me, onChanged, onLeft, onDeleted, floating, onBack, onOpenProjectPane, onOpenFiles, onOpenDoc, onLayout, tabsMenu }: ConversationHeaderProps) {
  const insets = useSafeAreaInsets()
  const { width: windowWidth, height: windowHeight } = useWindowDimensions()
  const router = useRouter()
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The details panel grows out of the title pill: `panel` runs 0 (the pill) to 1 (open).
  // The modal stays mounted until the close animation has finished.
  const [panelMounted, setPanelMounted] = useState(false)
  const panel = useRef(new Animated.Value(0)).current
  const [pillBox, setPillBox] = useState({ x: 0, width: 0 })
  const [panelContentHeight, setPanelContentHeight] = useState(0)
  useEffect(() => {
    if (detailsOpen) {
      setPanelMounted(true)
      Animated.timing(panel, { toValue: 1, duration: 240, easing: Easing.bezier(0.2, 0.9, 0.25, 1), useNativeDriver: false }).start()
    } else {
      Animated.timing(panel, { toValue: 0, duration: 190, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: false }).start((result) => {
        // An interrupted close (reopened mid-way) must keep the panel mounted.
        if (!result || result.finished) setPanelMounted(false)
      })
    }
  }, [detailsOpen, panel])
  // iOS can't present a modal while the sheet's modal is dismissing.
  const afterDetails = useRef<(() => unknown) | null>(null)
  const fromDetails = (fn: () => unknown) => {
    setDetailsOpen(false)
    if (Platform.OS === 'ios') afterDetails.current = fn
    else void fn()
  }
  const [catchUp, setCatchUp] = useState<CatchUpResult | null>(null)
  const [catchingUp, setCatchingUp] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [pins, setPins] = useState<ChatMessage[] | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Desktop only: the width of the action row and the header's height, which places the More menu.
  const [actionRowWidth, setActionRowWidth] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  // iOS can't present a modal while the More menu's modal is dismissing.
  const afterMore = useRef<(() => unknown) | null>(null)
  const fromMore = (fn: () => unknown) => {
    setMoreOpen(false)
    if (Platform.OS === 'ios') afterMore.current = fn
    else void fn()
  }
  const isChannel = conversation.kind === 'public' || conversation.kind === 'private' || conversation.kind === 'activity'
  const canRename = conversation.canManage && (conversation.kind === 'public' || conversation.kind === 'private') && !conversation.archivedAt
  const canEditTopic = conversation.kind !== 'activity' && !conversation.archivedAt && (conversation.canPost || conversation.canManage)
  // You are not one of the people in your own direct message — except in a
  // note-to-self, where you are the only one and the header still needs a
  // name and a face. Keep your row only when nothing else would name it.
  const others = conversation.members.filter((m) => m.type === 'agent' || m.userId !== me)
  const named = others.length ? others : conversation.members
  const participants: Participant[] = named.map((m) => (m.type === 'agent'
    ? { type: 'agent', projectId: m.projectId, name: m.name }
    : { type: 'user', id: m.userId, name: m.name, image: resolveAvatarUrl(m.image), ...(m.userId === me ? { self: true } : {}) }))
  const title = isChannel ? conversation.name ?? 'channel' : conversationTitle({ kind: conversation.kind, name: conversation.name, participants })
  const dmPeer = conversation.kind === 'dm' ? participants.find((p) => p.type === 'user') : undefined
  // Your own note is the one direct message whose leading slot is you: nobody
  // is across from you, so the header shows your face instead of an icon.
  const selfPeer = dmPeer?.type === 'user' && dmPeer.self === true ? dmPeer : null
  // Presence next to your own note would be your own status, so drop it.
  const peerId = dmPeer?.type === 'user' && dmPeer.self !== true ? dmPeer.id : null
  const peerStatus = useUserStatus(conversation.workspaceId, peerId)
  const peerPresence = usePresence(conversation.workspaceId, peerId)
  const Icon = conversation.kind === 'activity' ? Radio : conversation.kind === 'private' ? Lock : isChannel ? Hash : isAgentDm({ kind: conversation.kind, participants }) ? Bot : Users

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  const doCatchUp = async () => {
    setCatchingUp(true)
    setError(null)
    try {
      setCatchUp(await api.catchUp(conversation.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not summarize')
    } finally {
      setCatchingUp(false)
    }
  }

  const agentDm = isAgentDm({ kind: conversation.kind, participants })
  const agentPeer = agentDm ? participants.find((p) => p.type === 'agent') : undefined
  const agentProjectId = agentPeer?.type === 'agent' ? agentPeer.projectId : null
  const agentName = agentPeer?.type === 'agent' ? agentPeer.name ?? 'Agent' : 'Agent'
  const openProject = () => router.push({ pathname: '/(app)/projects/[id]', params: { id: agentProjectId! } } as any)

  const actions: HeaderAction[] = []
  if (agentPeer) {
    actions.push({
      key: 'agent-profile',
      label: 'View profile',
      icon: (s) => <UserCircle size={s} className="text-muted-foreground" />,
      onPress: () => router.push({ pathname: '/(app)/agents/[key]', params: { key: agentProjectId ?? 'ws' } } as any),
    })
  }
  if (agentProjectId) {
    actions.push({ key: 'open-project', label: 'Open project', icon: (s) => <FolderOpen size={s} className="text-muted-foreground" />, onPress: openProject })
    if (onOpenProjectPane) {
      actions.push({
        key: 'project-pane',
        label: 'Show in side panel',
        icon: (s) => <PanelRight size={s} className="text-muted-foreground" />,
        onPress: () => onOpenProjectPane(agentProjectId, agentName),
      })
    }
  }
  if (onOpenDoc && floating && !tabsMenu) {
    actions.push({
      key: 'doc',
      label: conversation.hasDoc ? 'Channel doc' : 'Create channel doc',
      icon: (s) => <FileText size={s} className="text-muted-foreground" />,
      onPress: onOpenDoc,
    })
  }
  if (canRename) actions.push({ key: 'edit', label: 'Edit channel', icon: (s) => <Pencil size={s} className="text-muted-foreground" />, onPress: () => setEditOpen(true) })
  if (conversation.joined && conversation.kind !== 'activity') {
    actions.push({
      key: 'notify',
      label: 'Notification settings',
      icon: (s) =>
        conversation.muted || conversation.notifyLevel === 'none'
          ? <BellOff size={s} className="text-muted-foreground" />
          : <Bell size={s} className={conversation.notifyLevel === 'all' ? 'text-primary' : 'text-muted-foreground'} />,
      onPress: () => setNotifyOpen(true),
    })
  }
  if (conversation.joined) {
    actions.push({
      key: 'star',
      label: conversation.starred ? 'Unstar' : 'Star',
      icon: (s) => <Star size={s} className={conversation.starred ? 'text-amber-500' : 'text-muted-foreground'} fill={conversation.starred ? '#f59e0b' : 'none'} />,
      onPress: () => run(() => api.updateMembership(conversation.id, { starred: !conversation.starred })),
    })
  }
  if (conversation.kind !== 'activity') {
    actions.push({
      key: 'pins',
      label: 'Pinned messages',
      icon: (s) => <Pin size={s} className="text-muted-foreground" />,
      onPress: () => void api.pins(conversation.id).then(setPins).catch((err) => setError(err?.message ?? 'Could not load pins')),
    })
  }
  if (onOpenFiles && conversation.kind !== 'activity') {
    actions.push({ key: 'files', label: 'Files', icon: (s) => <Paperclip size={s} className="text-muted-foreground" />, onPress: onOpenFiles })
  }
  actions.push({
    key: 'catchup',
    label: 'Catch me up',
    icon: (s) => (catchingUp ? <ActivityIndicator size="small" /> : <Sparkles size={s} className="text-muted-foreground" />),
    onPress: doCatchUp,
  })
  if (conversation.kind !== 'dm' && conversation.kind !== 'activity') {
    actions.push({ key: 'members', label: 'Members', icon: (s) => <UserPlus size={s} className="text-muted-foreground" />, onPress: () => setMembersOpen(true) })
  }
  if (isChannel && conversation.kind !== 'activity' && conversation.joined && conversation.slug !== 'general') {
    actions.push({
      key: 'leave',
      label: 'Leave channel',
      danger: true,
      icon: (s) => <LogOut size={s} className="text-muted-foreground" />,
      onPress: async () => {
        if (!(await confirm(`Leave #${conversation.name}?`, 'You can rejoin public channels any time.'))) return
        await run(() => api.leave(conversation.id))
        onLeft()
      },
    })
  }
  if (conversation.canManage && isChannel && conversation.kind !== 'activity' && conversation.slug !== 'general') {
    actions.push({
      key: 'archive',
      label: conversation.archivedAt ? 'Unarchive' : 'Archive',
      danger: !conversation.archivedAt,
      icon: (s) => <Archive size={s} className="text-muted-foreground" />,
      onPress: async () => {
        const archiving = !conversation.archivedAt
        if (archiving && !(await confirm(`Archive #${conversation.name}?`, 'Nobody will be able to post until it is unarchived.'))) return
        await run(() => api.update(conversation.id, { archived: archiving }))
      },
    })
  }
  // Shown to whoever could delete it but for an agent system declaring it, so
  // the dialog can explain why instead of the option just being missing.
  if (conversation.canDelete || (conversation.systemManaged && conversation.canManage)) {
    actions.push({
      key: 'delete',
      label: 'Delete channel',
      danger: true,
      icon: (s) => <Trash2 size={s} className="text-destructive" />,
      onPress: () => setDeleteOpen(true),
    })
  }

  const leading = peerId ? (
    <View className="w-4 items-center">
      <PresenceDot userId={peerId} workspaceId={conversation.workspaceId} size={9} />
    </View>
  ) : selfPeer ? (
    <UserAvatar name={selfPeer.name} image={selfPeer.image} size={20} />
  ) : agentPeer?.type === 'agent' ? (
    <AgentAvatar name={agentName} projectId={agentProjectId} workspaceId={conversation.workspaceId} size={20} />
  ) : (
    <Icon size={16} className="text-muted-foreground" />
  )
  const statusLine = peerStatus
    ? [peerStatus.emoji, peerStatus.text, peerStatus.dnd ? '· Do not disturb' : null].filter(Boolean).join(' ')
    : null

  const modals = (
    <>

      <Modal visible={!!catchUp} transparent animationType="fade" onRequestClose={() => setCatchUp(null)}>
        <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={() => setCatchUp(null)}>
          <Pressable className="max-h-[80%] w-full max-w-lg rounded-xl bg-card p-5" onPress={() => {}}>
            <View className="mb-3 flex-row items-center gap-2">
              <Sparkles size={16} className="text-primary" />
              <Text className="flex-1 text-base font-semibold text-foreground">Catch up on {title}</Text>
              <Pressable onPress={() => setCatchUp(null)} accessibilityLabel="Close">
                <X size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <ScrollView>
              {catchUp?.summary ? (
                <MarkdownText>{renderMentionsMarkdown(catchUp.summary, mentionNames(mentionables))}</MarkdownText>
              ) : (
                <Text className="text-sm text-muted-foreground">You're all caught up. Nothing new since you last read.</Text>
              )}
            </ScrollView>
            {catchUp && catchUp.messageCount > 0 && (
              <Text className="mt-3 text-xs text-muted-foreground">Summarized {catchUp.messageCount} messages.</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!pins} transparent animationType="fade" onRequestClose={() => setPins(null)}>
        <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={() => setPins(null)}>
          <Pressable className="max-h-[80%] w-full max-w-lg rounded-xl bg-card p-5" onPress={() => {}}>
            <View className="mb-3 flex-row items-center gap-2">
              <Pin size={16} className="text-amber-600" />
              <Text className="flex-1 text-base font-semibold text-foreground">Pinned in {title}</Text>
              <Pressable onPress={() => setPins(null)} accessibilityLabel="Close">
                <X size={16} className="text-muted-foreground" />
              </Pressable>
            </View>
            <ScrollView>
              {pins?.length ? pins.map((m) => (
                <View key={m.id} className="mb-2 rounded-md border border-border px-3 py-2">
                  <View className="flex-row items-center gap-2">
                    <Text className="flex-1 text-xs font-semibold text-foreground">
                      {m.authorType === 'agent' ? m.authorAgent?.name ?? 'Agent' : m.author?.name ?? 'Someone'}
                    </Text>
                    <Text className="text-[11px] text-muted-foreground">{new Date(m.createdAt).toLocaleDateString()}</Text>
                    {conversation.canReply ? (
                      <Pressable
                        accessibilityLabel="Unpin"
                        onPress={() => void api.pin(m.id, false).then(() => setPins((list) => (list ?? []).filter((x) => x.id !== m.id)))}
                      >
                        <Text className="text-[11px] text-muted-foreground">Unpin</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <MarkdownText>{renderMentionsMarkdown(m.text, mentionNames(mentionables))}</MarkdownText>
                </View>
              )) : (
                <Text className="text-sm text-muted-foreground">Nothing pinned yet. Hover a message and use the pin button to keep it here.</Text>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {notifyOpen && (
        <NotifyModal
          conversation={conversation}
          onClose={() => setNotifyOpen(false)}
          onPick={(patch) => run(() => api.updateMembership(conversation.id, patch))}
        />
      )}

      {editOpen && (
        <EditChannelModal
          conversation={conversation}
          canRename={canRename}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false)
            onChanged()
          }}
        />
      )}

      {deleteOpen && (
        <DeleteChannelModal
          conversation={conversation}
          onClose={() => setDeleteOpen(false)}
          onArchived={() => {
            setDeleteOpen(false)
            onChanged()
          }}
          onDeleted={() => {
            setDeleteOpen(false)
            const leave = onDeleted ?? onLeft
            leave()
          }}
        />
      )}

      {membersOpen && (
        <MembersModal
          conversation={conversation}
          mentionables={mentionables}
          onClose={() => setMembersOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  )

  if (floating) {
    // Like Slack: the pill names the open tab when it isn't Messages, otherwise the member and tab counts.
    const tabCount = tabsMenu ? tabsMenu.items.filter((t) => !t.placeholder).length : 0
    const openTab = tabsMenu?.items.find((t) => t.active && t.kind !== 'messages')
    const memberCount = `${conversation.members.length} ${conversation.members.length === 1 ? 'member' : 'members'}`
    const subtitle = peerId
      ? statusLine ?? (peerPresence ? presenceLabel(peerPresence) : null)
      : openTab
        ? openTab.label
        : isChannel && conversation.kind !== 'activity'
          ? tabCount > 1 ? `${memberCount} • ${tabCount} tabs` : memberCount
          : null
    const chipKeys = ['star', 'notify', 'members']
    const chips = actions.filter((a) => chipKeys.includes(a.key))
    const listed = actions.filter((a) => a.key !== 'catchup' && !chipKeys.includes(a.key))
    const chipLabel: Record<string, string> = { star: conversation.starred ? 'Starred' : 'Star', notify: 'Notify', members: 'Add' }
    const closeDetails = () => setDetailsOpen(false)
    // Open to the content's height, until the keyboard-safe edge of the screen.
    const panelMax = windowHeight - insets.top - insets.bottom - 24
    const panelHeight = panelContentHeight ? Math.min(CHROME_SIZE + panelContentHeight, panelMax) : panelMax
    // Tab rows only switch views, so they need not wait out the modal's dismissal like the actions do.
    const selectTab = (run: () => void) => {
      closeDetails()
      run()
    }
    const catchUpAction = actions.find((a) => a.key === 'catchup')!
    // The rest of the header fades out as the panel takes its place.
    const chromeOpacity = panel.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: 'clamp' })
    return (
      <View
        pointerEvents="box-none"
        onLayout={onLayout}
        className="absolute left-0 right-0 top-0 z-30 px-3"
        style={{ paddingTop: insets.top + 6 }}
        testID="floating-conversation-header"
      >
        <View pointerEvents="box-none" className="flex-row items-center gap-2">
          <Animated.View style={{ opacity: chromeOpacity }} pointerEvents={panelMounted ? 'none' : 'auto'}>
            <GlassButton label="Back" onPress={onBack}>
              <ChevronLeft size={22} className="text-foreground" />
            </GlassButton>
          </Animated.View>
          <Pressable
            onPress={() => setDetailsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${title} details`}
            className="min-w-0 flex-shrink justify-center overflow-hidden rounded-full bg-transparent px-4 shadow-sm"
            style={{ height: CHROME_SIZE }}
            onLayout={(e) => setPillBox({ x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width })}
          >
            <LiquidGlassBackdrop style={{ borderRadius: CHROME_SIZE / 2 }} />
            {/* The open panel draws its own copy of the title, so this one steps aside. */}
            <View style={{ opacity: panelMounted ? 0 : 1 }}>
              <View className="flex-row items-center gap-1.5">
                {leading}
                <Text className="flex-shrink text-[15px] font-semibold text-foreground" numberOfLines={1}>
                  {title}
                </Text>
              </View>
              {subtitle ? (
                <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </Pressable>
          <View className="flex-1" pointerEvents="none" />
          <Animated.View
            className="flex-row items-center gap-2"
            style={{ opacity: chromeOpacity }}
            pointerEvents={panelMounted ? 'none' : 'box-none'}
          >
            {agentProjectId ? (
              <GlassButton label="Open project" onPress={openProject}>
                <FolderOpen size={18} className="text-foreground" />
              </GlassButton>
            ) : null}
            <HuddleButton conversation={conversation} me={me} label={title} floating />
            <GlassButton label={catchUpAction.label} onPress={catchUpAction.onPress}>
              {catchUpAction.icon(18)}
            </GlassButton>
            <GlassButton label="More actions" onPress={() => setDetailsOpen(true)}>
              <MoreHorizontal size={20} className="text-foreground" />
            </GlassButton>
          </Animated.View>
        </View>
        {error ? (
          <GlassChip className="mt-2 self-center px-3 py-1.5">
            <Text className="text-xs text-destructive">{error}</Text>
          </GlassChip>
        ) : null}

        <Modal
          visible={panelMounted}
          transparent
          animationType="none"
          onRequestClose={() => setDetailsOpen(false)}
          onDismiss={() => {
            const fn = afterDetails.current
            afterDetails.current = null
            if (fn) void fn()
          }}
        >
          {/* No scrim: like Slack, the panel opens out of the pill over the live messages. */}
          <Pressable className="flex-1" onPress={closeDetails}>
            <Animated.View
              className="overflow-hidden bg-transparent shadow-lg"
              style={{
                marginTop: insets.top + 6,
                marginLeft: panel.interpolate({ inputRange: [0, 1], outputRange: [12 + pillBox.x, 12] }),
                marginRight: panel.interpolate({ inputRange: [0, 1], outputRange: [Math.max(12, windowWidth - 12 - pillBox.x - pillBox.width), 12] }),
                height: panel.interpolate({ inputRange: [0, 1], outputRange: [CHROME_SIZE, panelHeight] }),
                borderRadius: panel.interpolate({ inputRange: [0, 1], outputRange: [CHROME_SIZE / 2, 26] }),
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: 'rgba(128,128,128,0.35)',
              }}
              testID="conversation-actions-sheet"
            >
              <Pressable className="flex-1" onPress={() => {}}>
                <LiquidGlassBackdrop style={{ borderRadius: 26 }} />
                <View pointerEvents="none" style={StyleSheet.absoluteFill} className="bg-card/70" />
                {/* The title row is the pill's own height, so the title starts exactly where the pill's did and slides over beside the X. */}
                <View className="justify-center" style={{ height: CHROME_SIZE }}>
                  <Animated.View
                    className="min-w-0 pr-12"
                    style={{ paddingLeft: panel.interpolate({ inputRange: [0, 1], outputRange: [16, 56] }) }}
                  >
                    <View className="flex-row items-center gap-1.5">
                      {leading}
                      <Text className="flex-shrink text-[15px] font-semibold text-foreground" numberOfLines={1}>{title}</Text>
                      {conversation.archivedAt ? (
                        <View className="rounded bg-muted px-1.5 py-0.5">
                          <Text className="text-[10px] font-medium uppercase text-muted-foreground">Archived</Text>
                        </View>
                      ) : null}
                    </View>
                    {subtitle ? <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{subtitle}</Text> : null}
                  </Animated.View>
                  <Animated.View className="absolute left-1.5 top-0.5" style={{ opacity: panel }}>
                    <Pressable onPress={closeDetails} accessibilityRole="button" accessibilityLabel="Close" className="h-10 w-10 items-center justify-center rounded-full active:bg-muted/60">
                      <X size={20} className="text-foreground" />
                    </Pressable>
                  </Animated.View>
                </View>
                {/* Clipped, not faded in late: the rows are there from the first frame of the growth. */}
                <Animated.View style={{ flex: 1, opacity: panel.interpolate({ inputRange: [0, 0.3], outputRange: [0, 1], extrapolate: 'clamp' }) }}>
                  <ScrollView
                    bounces={false}
                    showsVerticalScrollIndicator={false}
                    contentContainerClassName="px-2 pb-2"
                    onContentSizeChange={(_, h) => setPanelContentHeight(h)}
                  >
                    {conversation.topic || (canEditTopic && isChannel) ? (
                      <Pressable
                        disabled={!canEditTopic}
                        onPress={() => fromDetails(() => setEditOpen(true))}
                        accessibilityLabel={conversation.topic ? `Topic: ${conversation.topic}` : 'Add a topic'}
                        className="px-3 pb-2"
                      >
                        <Text className={cn('text-[13px]', conversation.topic ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
                          {conversation.topic || 'Add a topic'}
                        </Text>
                      </Pressable>
                    ) : null}
                    {chips.length ? (
                      <View className="flex-row gap-2 px-1 pb-2">
                        {chips.map((a) => (
                          <Pressable
                            key={a.key}
                            onPress={() => fromDetails(a.onPress)}
                            accessibilityRole="button"
                            accessibilityLabel={a.label}
                            className="h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border border-foreground/10 bg-foreground/5 active:bg-foreground/10"
                          >
                            {a.icon(16)}
                            <Text className="text-[14px] font-medium text-foreground" numberOfLines={1}>{chipLabel[a.key] ?? a.label}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                    {tabsMenu ? (
                      <>
                        <ChannelTabList items={tabsMenu.items} onAddBoard={tabsMenu.onAddBoard} onSelect={selectTab} />
                        {listed.length ? <View className="mx-3 my-1.5 h-px bg-foreground/10" /> : null}
                      </>
                    ) : null}
                    {listed.map((a) => (
                      <Pressable
                        key={a.key}
                        onPress={() => fromDetails(a.onPress)}
                        accessibilityRole="button"
                        accessibilityLabel={a.label}
                        className="min-h-11 flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-foreground/10"
                      >
                        {a.icon(18)}
                        <Text className={cn('flex-1 text-[15px]', a.danger ? 'text-destructive' : 'text-foreground')}>{a.label}</Text>
                        {a.danger ? null : <ChevronRight size={16} className="text-muted-foreground" />}
                      </Pressable>
                    ))}
                  </ScrollView>
                </Animated.View>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Modal>
        {modals}
      </View>
    )
  }

  const { inline, overflow } = splitHeaderActions(actions, actionRowWidth)

  return (
    <View className="border-b border-border px-4 py-2.5" onLayout={(e) => setHeaderHeight(Math.round(e.nativeEvent.layout.height))}>
      <View className="flex-row items-center gap-2 overflow-hidden" onLayout={(e) => setActionRowWidth(Math.round(e.nativeEvent.layout.width))}>
        {leading}
        <Text className="min-w-0 flex-shrink text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {peerId && peerPresence ? <Text className="text-xs text-muted-foreground">{presenceLabel(peerPresence)}</Text> : null}
        {conversation.archivedAt && (
          <View className="rounded bg-muted px-1.5 py-0.5">
            <Text className="text-[10px] font-medium uppercase text-muted-foreground">Archived</Text>
          </View>
        )}
        {statusLine ? (
          <Text className="flex-shrink text-xs text-muted-foreground" numberOfLines={1}>
            {statusLine}
          </Text>
        ) : null}
        <View className="flex-1" />
        <HuddleButton conversation={conversation} me={me} label={title} />
        {inline.map((a) => (
          <HeaderButton key={a.key} label={a.label} onPress={() => void a.onPress()}>
            {a.icon(16)}
          </HeaderButton>
        ))}
        {overflow.length > 0 ? (
          <HeaderButton label="More actions" onPress={() => setMoreOpen(true)}>
            <MoreHorizontal size={16} className="text-muted-foreground" />
          </HeaderButton>
        ) : null}
      </View>
      {conversation.topic ? (
        <Pressable
          disabled={!canEditTopic}
          onPress={() => setEditOpen(true)}
          accessibilityLabel={canEditTopic ? `Topic: ${conversation.topic}. Edit topic` : `Topic: ${conversation.topic}`}
          className="mt-0.5 self-start"
        >
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {conversation.topic}
          </Text>
        </Pressable>
      ) : canEditTopic && isChannel ? (
        <Pressable onPress={() => setEditOpen(true)} accessibilityLabel="Add a topic" className="mt-0.5 self-start">
          <Text className="text-xs text-muted-foreground/70">Add a topic</Text>
        </Pressable>
      ) : null}
      {error && <Text className="mt-1 text-xs text-destructive">{error}</Text>}
      <Modal
        visible={moreOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMoreOpen(false)}
        onDismiss={() => {
          const fn = afterMore.current
          afterMore.current = null
          if (fn) void fn()
        }}
      >
        <Pressable className="flex-1" onPress={() => setMoreOpen(false)}>
          <Pressable
            className="absolute right-4 min-w-52 rounded-xl border border-border bg-card p-1 shadow-lg"
            style={{ top: headerHeight }}
            onPress={() => {}}
            testID="header-more-menu"
          >
            {overflow.map((a) => (
              <Pressable
                key={a.key}
                onPress={() => fromMore(a.onPress)}
                accessibilityRole="menuitem"
                accessibilityLabel={a.label}
                className="flex-row items-center gap-3 rounded-md px-3 py-2 active:bg-muted hover:bg-muted"
              >
                {a.icon(16)}
                <Text className={cn('flex-1 text-sm', a.danger ? 'text-destructive' : 'text-foreground')}>{a.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      {modals}
    </View>
  )
}

interface HeaderAction {
  key: string
  label: string
  icon: (size: number) => React.ReactNode
  onPress: () => unknown
  danger?: boolean
}

function HeaderButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
      <WebTooltip label={label}>{children}</WebTooltip>
    </Pressable>
  )
}

const NOTIFY_CHOICES: Array<{ value: MembershipNotifyLevel; label: string; hint: string }> = [
  { value: 'default', label: 'Use my default', hint: 'Follow your chat preferences' },
  { value: 'all', label: 'All new messages', hint: 'Every message in this conversation' },
  { value: 'mentions', label: 'Mentions and keywords', hint: '@mentions, @channel, keywords, and threads you follow' },
  { value: 'none', label: 'Nothing', hint: 'Only direct @mentions' },
]

function NotifyModal({
  conversation,
  onClose,
  onPick,
}: {
  conversation: ConversationDetail
  onClose: () => void
  onPick: (patch: { notifyLevel?: MembershipNotifyLevel; muted?: boolean }) => Promise<void>
}) {
  const current = (conversation.notifyLevel || 'default') as MembershipNotifyLevel
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="w-full max-w-sm rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">Notifications</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          {NOTIFY_CHOICES.map((c) => (
            <Pressable
              key={c.value}
              accessibilityRole="radio"
              aria-checked={current === c.value}
              onPress={async () => {
                await onPick({ notifyLevel: c.value })
                onClose()
              }}
              className="flex-row items-center gap-3 rounded-md px-1 py-2 active:bg-muted hover:bg-muted"
            >
              <View className="w-4">{current === c.value ? <Check size={14} className="text-primary" /> : null}</View>
              <View className="flex-1">
                <Text className="text-sm text-foreground">{c.label}</Text>
                <Text className="text-xs text-muted-foreground">{c.hint}</Text>
              </View>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="switch"
            aria-checked={!!conversation.muted}
            onPress={async () => {
              await onPick({ muted: !conversation.muted })
              onClose()
            }}
            className="mt-2 flex-row items-center gap-3 rounded-md border-t border-border px-1 pt-3"
          >
            <BellOff size={14} className="text-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground">{conversation.muted ? 'Unmute' : 'Mute'} conversation</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/** Channel names are lowercase with dashes, like the server stores them. */
export function previewChannelName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function EditChannelModal({
  conversation,
  canRename,
  onClose,
  onSaved,
}: {
  conversation: ConversationDetail
  canRename: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(conversation.name ?? '')
  const [topic, setTopic] = useState(conversation.topic ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = previewChannelName(name)
  const isGeneral = conversation.slug === 'general'
  const nameChanged = canRename && !isGeneral && preview !== (conversation.slug ?? conversation.name ?? '')
  const topicChanged = topic.trim() !== (conversation.topic ?? '')

  const save = async () => {
    if (canRename && !isGeneral && !preview) return setError('Channel name is required')
    if (!nameChanged && !topicChanged) return onClose()
    setSaving(true)
    setError(null)
    try {
      await api.update(conversation.id, {
        ...(nameChanged ? { name: preview } : {}),
        ...(topicChanged ? { topic: topic.trim() || null } : {}),
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">{canRename ? 'Edit channel' : 'Edit topic'}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          {canRename && (
            <>
              <Text className="mb-1 text-xs font-medium text-muted-foreground">Name</Text>
              <View className="mb-1 flex-row items-center rounded-md border border-border px-3">
                <Hash size={14} className="text-muted-foreground" />
                <TextInput
                  value={name}
                  onChangeText={setName}
                  editable={!isGeneral}
                  accessibilityLabel="Channel name"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={80}
                  className="flex-1 py-2 pl-2 text-sm text-foreground"
                />
              </View>
              <Text className="mb-3 text-[11px] text-muted-foreground">
                {isGeneral
                  ? '#general can’t be renamed.'
                  : preview && preview !== name.trim()
                    ? `Will be saved as #${preview}`
                    : 'Lowercase, without spaces or periods.'}
              </Text>
            </>
          )}
          <Text className="mb-1 text-xs font-medium text-muted-foreground">Topic</Text>
          <TextInput
            value={topic}
            onChangeText={setTopic}
            placeholder="What’s this channel about?"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Channel topic"
            maxLength={500}
            multiline
            className="min-h-[60px] rounded-md border border-border px-3 py-2 text-sm text-foreground"
          />
          {error && <Text className="mt-2 text-xs text-destructive">{error}</Text>}
          <View className="mt-4 flex-row justify-end gap-2">
            <Pressable onPress={onClose} className="rounded-md px-3 py-1.5 active:bg-muted hover:bg-muted">
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={save}
              disabled={saving}
              accessibilityLabel="Save channel"
              className={cn('rounded-md bg-primary px-3 py-1.5', saving && 'opacity-60')}
            >
              <Text className="text-sm font-medium text-primary-foreground">{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/**
 * Permanent delete, confirmed by typing the channel name (as Slack asks for an
 * explicit "yes, permanently delete"). Offers archiving instead, which keeps
 * the history. A channel an agent system declares can't be deleted here, so
 * the dialog explains where to remove it instead.
 */
function DeleteChannelModal({
  conversation,
  onClose,
  onArchived,
  onDeleted,
}: {
  conversation: ConversationDetail
  onClose: () => void
  onArchived: () => void
  onDeleted: () => void
}) {
  const name = conversation.name ?? ''
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<'delete' | 'archive' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const confirmed = typed.trim().replace(/^#/, '').toLowerCase() === name.toLowerCase()
  const blocked = !!conversation.systemManaged

  const act = async (kind: 'delete' | 'archive') => {
    if (busy || (kind === 'delete' && (!confirmed || blocked))) return
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'delete') {
        await api.delete(conversation.id)
        onDeleted()
      } else {
        await api.update(conversation.id, { archived: true })
        onArchived()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(null)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">Delete #{name}?</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          {blocked ? (
            <Text className="text-sm text-foreground">
              An agent system declares this channel in its shogo-system.yaml, so deleting it here would only bring it back
              on the next apply. Remove it from teamChannels there and run system_apply, then delete it.
            </Text>
          ) : (
            <>
              <Text className="text-sm text-foreground">
                This permanently deletes #{name} for everyone, with all of its messages, threads and files. It can’t be undone.
              </Text>
              {!conversation.archivedAt && (
                <Text className="mt-2 text-sm text-muted-foreground">
                  To keep the history, archive it instead: nobody can post, but everything stays readable.
                </Text>
              )}
              <Text className="mb-1 mt-4 text-xs font-medium text-muted-foreground">Type the channel name to confirm</Text>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder={name}
                placeholderTextColor="#8a8a8a"
                accessibilityLabel="Channel name to confirm"
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-md border border-border px-3 py-2 text-sm text-foreground"
              />
            </>
          )}
          {error && <Text className="mt-2 text-xs text-destructive">{error}</Text>}
          <View className="mt-4 flex-row flex-wrap justify-end gap-2">
            <Pressable onPress={onClose} className="rounded-md px-3 py-1.5 active:bg-muted hover:bg-muted">
              <Text className="text-sm text-muted-foreground">{blocked ? 'Close' : 'Cancel'}</Text>
            </Pressable>
            {!blocked && !conversation.archivedAt && (
              <Pressable
                onPress={() => void act('archive')}
                disabled={!!busy}
                accessibilityLabel="Archive instead"
                className={cn('rounded-md border border-border px-3 py-1.5 active:bg-muted', busy && 'opacity-60')}
              >
                <Text className="text-sm text-foreground">{busy === 'archive' ? 'Archiving…' : 'Archive instead'}</Text>
              </Pressable>
            )}
            {!blocked && (
              <Pressable
                onPress={() => void act('delete')}
                disabled={!confirmed || !!busy}
                accessibilityLabel="Delete permanently"
                aria-disabled={!confirmed || !!busy}
                className={cn('rounded-md bg-destructive px-3 py-1.5', (!confirmed || busy) && 'opacity-50')}
              >
                <Text className="text-sm font-medium text-destructive-foreground">{busy === 'delete' ? 'Deleting…' : 'Delete permanently'}</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function MembersModal({
  conversation,
  mentionables,
  onClose,
  onChanged,
}: {
  conversation: ConversationDetail
  mentionables: Mentionables | null
  onClose: () => void
  onChanged: () => void
}) {
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const memberUserIds = new Set(conversation.members.flatMap((m) => (m.type === 'user' ? [m.userId] : [])))
  const memberAgents = new Set(conversation.members.flatMap((m) => (m.type === 'agent' ? [m.projectId ?? 'ws'] : [])))
  const q = filter.trim().toLowerCase()
  const people = (mentionables?.people ?? []).filter((p) => !memberUserIds.has(p.id) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)))
  const agents = (mentionables?.agents ?? []).filter((a) => !memberAgents.has(a.projectId ?? 'ws') && (!q || a.name.toLowerCase().includes(q)))

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[80%] w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">Members</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView>
            {conversation.members.map((m) => (
              <View key={m.id} className="flex-row items-center gap-2 py-1.5">
                {m.type === 'agent' ? (
                  <AgentAvatar name={m.name ?? 'Agent'} projectId={m.projectId} workspaceId={conversation.workspaceId} size={20} />
                ) : (
                  <View className="w-3.5 items-center">
                    <PresenceDot userId={m.userId} workspaceId={conversation.workspaceId} />
                  </View>
                )}
                <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                  {m.name ?? 'Agent'}
                  {m.type === 'agent' ? <Text className="text-xs text-muted-foreground">{`  replies on ${m.agentTrigger}`}</Text> : null}
                </Text>
                {conversation.canManage && (
                  <Pressable onPress={() => act(() => api.removeMember(conversation.id, m.id))} accessibilityLabel={`Remove ${m.name ?? 'agent'}`}>
                    <Text className="text-xs text-destructive">Remove</Text>
                  </Pressable>
                )}
              </View>
            ))}
            {conversation.canPost && !conversation.archivedAt && (
              <>
                <Text className="mb-1 mt-4 text-xs font-semibold uppercase text-muted-foreground">Add</Text>
                <TextInput
                  value={filter}
                  onChangeText={setFilter}
                  placeholder="Search people and agents"
                  placeholderTextColor="#8a8a8a"
                  className="mb-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
                />
                {agents.map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={() => act(() => api.addAgent(conversation.id, { projectId: a.projectId }))}
                    className="flex-row items-center gap-2 rounded-md px-1 py-1.5 active:bg-muted hover:bg-muted"
                  >
                    <AgentAvatar name={a.name} projectId={a.projectId} workspaceId={conversation.workspaceId} size={20} />
                    <Text className="flex-1 text-sm text-foreground">{a.name}</Text>
                    <Text className="text-xs text-primary">Add agent</Text>
                  </Pressable>
                ))}
                {people.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      void (async () => {
                        // A private channel's history (and its files) is handed
                        // over on add — the same warning the mention nudge gives.
                        if (!(await confirmsAddToChannel(conversation.kind))) return
                        void act(() => api.addMembers(conversation.id, [p.id]))
                      })()
                    }}
                    className="flex-row items-center gap-2 rounded-md px-1 py-1.5 active:bg-muted hover:bg-muted"
                  >
                    <Users size={14} className="text-muted-foreground" />
                    <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{p.name}</Text>
                    <Text className="text-xs text-primary">Add</Text>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
          {error && <Text className="mt-2 text-xs text-destructive">{error}</Text>}
        </Pressable>
      </Pressable>
    </Modal>
  )
}
