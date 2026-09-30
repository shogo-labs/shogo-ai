// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Archive, Bell, BellOff, Bot, Check, Hash, Lock, LogOut, Pin, Radio, Sparkles, Star, UserPlus, Users, X } from 'lucide-react-native'
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

const api = teamChatApi()

export interface ConversationHeaderProps {
  conversation: ConversationDetail
  mentionables: Mentionables | null
  me: string | null
  onChanged: () => void
  onLeft: () => void
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

export function ConversationHeader({ conversation, mentionables, me, onChanged, onLeft }: ConversationHeaderProps) {
  const [catchUp, setCatchUp] = useState<CatchUpResult | null>(null)
  const [catchingUp, setCatchingUp] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [pins, setPins] = useState<ChatMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isChannel = conversation.kind === 'public' || conversation.kind === 'private' || conversation.kind === 'activity'
  const participants: Participant[] = conversation.members
    .filter((m) => m.type === 'agent' || m.userId !== me)
    .map((m) => (m.type === 'agent' ? { type: 'agent', projectId: m.projectId, name: m.name } : { type: 'user', id: m.userId, name: m.name, image: m.image }))
  const title = isChannel ? conversation.name ?? 'channel' : conversationTitle({ kind: conversation.kind, name: conversation.name, participants })
  const dmPeer = conversation.kind === 'dm' ? participants.find((p) => p.type === 'user') : undefined
  const peerStatus = useUserStatus(conversation.workspaceId, dmPeer?.type === 'user' ? dmPeer.id : null)
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

  return (
    <View className="border-b border-border px-4 py-2.5">
      <View className="flex-row items-center gap-2">
        <Icon size={16} className="text-muted-foreground" />
        <Text className="flex-shrink text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        {conversation.archivedAt && (
          <View className="rounded bg-muted px-1.5 py-0.5">
            <Text className="text-[10px] font-medium uppercase text-muted-foreground">Archived</Text>
          </View>
        )}
        {peerStatus ? (
          <Text className="flex-shrink text-xs text-muted-foreground" numberOfLines={1}>
            {[peerStatus.emoji, peerStatus.text, peerStatus.dnd ? '· Do not disturb' : null].filter(Boolean).join(' ')}
          </Text>
        ) : null}
        <View className="flex-1" />
        {conversation.joined && conversation.kind !== 'activity' && (
          <HeaderButton label="Notification settings" onPress={() => setNotifyOpen(true)}>
            {conversation.muted || conversation.notifyLevel === 'none'
              ? <BellOff size={16} className="text-muted-foreground" />
              : <Bell size={16} className={conversation.notifyLevel === 'all' ? 'text-primary' : 'text-muted-foreground'} />}
          </HeaderButton>
        )}
        {conversation.joined && (
          <HeaderButton
            label={conversation.starred ? 'Unstar' : 'Star'}
            onPress={() => run(() => api.updateMembership(conversation.id, { starred: !conversation.starred }))}
          >
            <Star size={16} className={conversation.starred ? 'text-amber-500' : 'text-muted-foreground'} fill={conversation.starred ? '#f59e0b' : 'none'} />
          </HeaderButton>
        )}
        {conversation.kind !== 'activity' && (
          <HeaderButton
            label="Pinned messages"
            onPress={() => void api.pins(conversation.id).then(setPins).catch((err) => setError(err?.message ?? 'Could not load pins'))}
          >
            <Pin size={16} className="text-muted-foreground" />
          </HeaderButton>
        )}
        <HeaderButton label="Catch me up" onPress={doCatchUp}>
          {catchingUp ? <ActivityIndicator size="small" /> : <Sparkles size={16} className="text-muted-foreground" />}
        </HeaderButton>
        {conversation.kind !== 'dm' && conversation.kind !== 'activity' && (
          <HeaderButton label="Members" onPress={() => setMembersOpen(true)}>
            <UserPlus size={16} className="text-muted-foreground" />
          </HeaderButton>
        )}
        {isChannel && conversation.kind !== 'activity' && conversation.joined && conversation.slug !== 'general' && (
          <HeaderButton
            label="Leave channel"
            onPress={async () => {
              if (!(await confirm(`Leave #${conversation.name}?`, 'You can rejoin public channels any time.'))) return
              await run(() => api.leave(conversation.id))
              onLeft()
            }}
          >
            <LogOut size={16} className="text-muted-foreground" />
          </HeaderButton>
        )}
        {conversation.canManage && isChannel && conversation.kind !== 'activity' && conversation.slug !== 'general' && (
          <HeaderButton
            label={conversation.archivedAt ? 'Unarchive' : 'Archive'}
            onPress={async () => {
              const archiving = !conversation.archivedAt
              if (archiving && !(await confirm(`Archive #${conversation.name}?`, 'Nobody will be able to post until it is unarchived.'))) return
              await run(() => api.update(conversation.id, { archived: archiving }))
            }}
          >
            <Archive size={16} className="text-muted-foreground" />
          </HeaderButton>
        )}
      </View>
      {conversation.topic ? (
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {conversation.topic}
        </Text>
      ) : null}
      {error && <Text className="mt-1 text-xs text-destructive">{error}</Text>}

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

      {membersOpen && (
        <MembersModal
          conversation={conversation}
          mentionables={mentionables}
          onClose={() => setMembersOpen(false)}
          onChanged={onChanged}
        />
      )}
    </View>
  )
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
                {m.type === 'agent' ? <Bot size={14} className="text-primary" /> : <Users size={14} className="text-muted-foreground" />}
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
                    <Bot size={14} className="text-primary" />
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
