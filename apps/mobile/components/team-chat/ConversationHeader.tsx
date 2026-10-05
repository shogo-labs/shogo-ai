// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useRef, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, type LayoutChangeEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Archive, Bell, BellOff, Bot, Check, ChevronLeft, FolderOpen, Hash, Lock, LogOut, MoreHorizontal, Pencil, PanelRight, Pin, Radio, Sparkles, Star, UserCircle, UserPlus, Users, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'
import { CHROME_SIZE, GlassButton, GlassChip } from './FloatingChrome'
import { MarkdownText } from '../chat/MarkdownText'
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
import { mentionNames, renderMentions } from '../../lib/team-chat-state'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { usePresence } from '../../hooks/usePresence'
import { PresenceDot, presenceLabel } from './PresenceDot'
import { AgentAvatar } from './AgentAvatar'
import { HuddleButton } from './Huddle'

const api = teamChatApi()

export interface ConversationHeaderProps {
  conversation: ConversationDetail
  mentionables: Mentionables | null
  me: string | null
  onChanged: () => void
  onLeft: () => void
  /** Phone presentation: glass back button, title pill and actions sheet over the messages. */
  floating?: boolean
  onBack?: () => void
  /** Show the agent's project beside the conversation. Only passed on wide screens. */
  onOpenProjectPane?: (projectId: string, name: string) => void
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

export function ConversationHeader({ conversation, mentionables, me, onChanged, onLeft, floating, onBack, onOpenProjectPane, onLayout }: ConversationHeaderProps) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const [detailsOpen, setDetailsOpen] = useState(false)
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
  const [error, setError] = useState<string | null>(null)
  const isChannel = conversation.kind === 'public' || conversation.kind === 'private' || conversation.kind === 'activity'
  const canRename = conversation.canManage && (conversation.kind === 'public' || conversation.kind === 'private') && !conversation.archivedAt
  const canEditTopic = conversation.kind !== 'activity' && !conversation.archivedAt && (conversation.canPost || conversation.canManage)
  const participants: Participant[] = conversation.members
    .filter((m) => m.type === 'agent' || m.userId !== me)
    .map((m) => (m.type === 'agent' ? { type: 'agent', projectId: m.projectId, name: m.name } : { type: 'user', id: m.userId, name: m.name, image: m.image }))
  const title = isChannel ? conversation.name ?? 'channel' : conversationTitle({ kind: conversation.kind, name: conversation.name, participants })
  const dmPeer = conversation.kind === 'dm' ? participants.find((p) => p.type === 'user') : undefined
  const peerId = dmPeer?.type === 'user' ? dmPeer.id : null
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

  const leading = peerId ? (
    <View className="w-4 items-center">
      <PresenceDot userId={peerId} workspaceId={conversation.workspaceId} size={9} />
    </View>
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
                <MarkdownText>{renderMentions(catchUp.summary, mentionNames(mentionables))}</MarkdownText>
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
                  <MarkdownText>{renderMentions(m.text, mentionNames(mentionables))}</MarkdownText>
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
    const subtitle = peerId
      ? statusLine ?? (peerPresence ? presenceLabel(peerPresence) : null)
      : isChannel && conversation.kind !== 'activity'
        ? `${conversation.members.length} ${conversation.members.length === 1 ? 'member' : 'members'}`
        : null
    const catchUpAction = actions.find((a) => a.key === 'catchup')!
    return (
      <View
        pointerEvents="box-none"
        onLayout={onLayout}
        className="absolute left-0 right-0 top-0 z-30 px-3"
        style={{ paddingTop: insets.top + 6 }}
        testID="floating-conversation-header"
      >
        <View pointerEvents="box-none" className="flex-row items-center gap-2">
          <GlassButton label="Back" onPress={onBack}>
            <ChevronLeft size={22} className="text-foreground" />
          </GlassButton>
          <Pressable
            onPress={() => setDetailsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${title} details`}
            className="min-w-0 flex-shrink justify-center overflow-hidden rounded-full bg-transparent px-4 shadow-sm"
            style={{ height: CHROME_SIZE }}
          >
            <LiquidGlassBackdrop style={{ borderRadius: CHROME_SIZE / 2 }} />
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
          </Pressable>
          <View className="flex-1" pointerEvents="none" />
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
        </View>
        {error ? (
          <GlassChip className="mt-2 self-center px-3 py-1.5">
            <Text className="text-xs text-destructive">{error}</Text>
          </GlassChip>
        ) : null}

        <Modal
          visible={detailsOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setDetailsOpen(false)}
          onDismiss={() => {
            const fn = afterDetails.current
            afterDetails.current = null
            if (fn) void fn()
          }}
        >
          <Pressable className="flex-1 justify-end bg-black/30" onPress={() => setDetailsOpen(false)}>
            <Pressable
              className="rounded-t-3xl bg-card px-2 pt-3"
              style={{ paddingBottom: insets.bottom + 12 }}
              onPress={() => {}}
              testID="conversation-actions-sheet"
            >
              <View className="mb-2 h-1 w-10 self-center rounded-full bg-muted-foreground/30" />
              <View className="flex-row items-center gap-2 px-3 py-2">
                {leading}
                <Text className="flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
                  {title}
                </Text>
                {conversation.archivedAt ? (
                  <View className="rounded bg-muted px-1.5 py-0.5">
                    <Text className="text-[10px] font-medium uppercase text-muted-foreground">Archived</Text>
                  </View>
                ) : null}
              </View>
              {conversation.topic || (canEditTopic && isChannel) ? (
                <Pressable
                  disabled={!canEditTopic}
                  onPress={() => fromDetails(() => setEditOpen(true))}
                  accessibilityLabel={conversation.topic ? `Topic: ${conversation.topic}` : 'Add a topic'}
                  className="px-3 pb-2"
                >
                  <Text className={cn('text-sm', conversation.topic ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
                    {conversation.topic || 'Add a topic'}
                  </Text>
                </Pressable>
              ) : null}
              {actions
                .filter((a) => a.key !== 'catchup')
                .map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={() => fromDetails(a.onPress)}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    className="min-h-12 flex-row items-center gap-3 rounded-xl px-3 py-3 active:bg-muted"
                  >
                    {a.icon(18)}
                    <Text className={cn('flex-1 text-base', a.danger ? 'text-destructive' : 'text-foreground')}>{a.label}</Text>
                  </Pressable>
                ))}
            </Pressable>
          </Pressable>
        </Modal>
        {modals}
      </View>
    )
  }

  return (
    <View className="border-b border-border px-4 py-2.5">
      <View className="flex-row items-center gap-2">
        {leading}
        <Text className="flex-shrink text-base font-semibold text-foreground" numberOfLines={1}>
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
        {actions.map((a) => (
          <HeaderButton key={a.key} label={a.label} onPress={() => void a.onPress()}>
            {a.icon(16)}
          </HeaderButton>
        ))}
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
      {children}
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
              accessibilityState={{ checked: current === c.value }}
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
            accessibilityState={{ checked: !!conversation.muted }}
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
                    onPress={() => act(() => api.addMembers(conversation.id, [p.id]))}
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
