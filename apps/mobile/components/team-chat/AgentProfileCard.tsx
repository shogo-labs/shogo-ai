// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Profile card for an agent in team chat: avatar, what it is for, who owns
 * it, and the channels it works in. Opened by tapping an agent's avatar or
 * name on one of its messages.
 */
import { useEffect, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from 'react-native'
import { Bot, Hash, Lock, X } from 'lucide-react-native'
import { absoluteApiUrl, teamChatApi, type AgentCard } from '../../lib/team-chat-api'

const api = teamChatApi()

export function AgentAvatar({ name, iconUrl, size = 32 }: { name: string; iconUrl?: string | null; size?: number }) {
  if (iconUrl) {
    return (
      <Image
        source={{ uri: absoluteApiUrl(iconUrl) }}
        style={{ width: size, height: size, borderRadius: 8 }}
        accessibilityLabel={`${name} avatar`}
        accessibilityIgnoresInvertColors
      />
    )
  }
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center rounded-lg bg-primary/15">
      <Bot size={Math.round(size / 2)} className="text-primary" />
    </View>
  )
}

const TRIGGER_LABEL: Record<string, string> = {
  mention: 'Replies when mentioned',
  keyword: 'Replies to keywords',
  all: 'Replies to every message',
  auto: 'Replies when relevant',
}

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger
}

export interface AgentProfileCardProps {
  workspaceId: string
  projectId: string | null
  /** Shown while the card loads, and if it fails to. */
  name: string
  iconUrl?: string | null
  onClose: () => void
  onOpenChannel?: (conversationId: string) => void
}

export function AgentProfileCard({ workspaceId, projectId, name, iconUrl, onClose, onOpenChannel }: AgentProfileCardProps) {
  const [card, setCard] = useState<AgentCard | null>(null)
  const [failed, setFailed] = useState(false)

  const toggleMute = (ch: AgentCard['channels'][number]) => {
    const muted = !ch.muted
    const set = (value: boolean) =>
      setCard((c) => c && { ...c, channels: c.channels.map((x) => (x.conversationId === ch.conversationId ? { ...x, muted: value } : x)) })
    set(muted)
    api.setAgentMuted(ch.conversationId, projectId, muted).catch(() => set(!muted))
  }

  useEffect(() => {
    let live = true
    api.agentCard(workspaceId, projectId)
      .then((c) => { if (live) setCard(c) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [workspaceId, projectId])

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center p-6">
        <Pressable className="absolute inset-0 bg-black/30" onPress={onClose} accessibilityLabel="Close agent profile" />
        <View className="w-full max-w-[360px] rounded-xl border border-border bg-card p-4" testID="agent-profile-card">
          <View className="flex-row items-start gap-3">
            <AgentAvatar name={card?.name ?? name} iconUrl={card?.iconUrl ?? iconUrl} size={48} />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground" numberOfLines={2}>{card?.name ?? name}</Text>
              <View className="mt-0.5 self-start rounded bg-primary/10 px-1.5 py-px">
                <Text className="text-[10px] font-medium text-primary">AGENT</Text>
              </View>
            </View>
            <Pressable onPress={onClose} accessibilityLabel="Close" className="rounded p-1 active:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          {!card && !failed ? <ActivityIndicator className="mt-4" /> : null}
          {failed ? <Text className="mt-3 text-xs text-muted-foreground">Couldn’t load this agent’s details.</Text> : null}

          {card ? (
            <View className="mt-3 gap-3">
              {card.role ? <Text className="text-sm text-foreground">{card.role}</Text> : null}
              {card.owner ? (
                <View>
                  <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Owner</Text>
                  <Text className="text-sm text-foreground">{card.owner.name}</Text>
                </View>
              ) : null}
              <View>
                <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Channels</Text>
                {card.channels.length === 0 ? (
                  <Text className="text-sm text-muted-foreground">Not in any channel you can see.</Text>
                ) : (
                  card.channels.map((ch) => (
                    <View key={ch.conversationId} className="flex-row items-center gap-1.5 py-1">
                      <Pressable
                        onPress={onOpenChannel ? () => { onClose(); onOpenChannel(ch.conversationId) } : undefined}
                        className="min-w-0 flex-1 flex-row items-center gap-1.5"
                      >
                        {ch.kind === 'private' ? <Lock size={12} className="text-muted-foreground" /> : <Hash size={12} className="text-muted-foreground" />}
                        <Text className="text-sm text-foreground">{ch.name ?? ch.slug ?? 'channel'}</Text>
                        <Text className="min-w-0 flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
                          {ch.muted ? 'Muted' : triggerLabel(ch.agentTrigger)}
                        </Text>
                      </Pressable>
                      {ch.agentTrigger !== 'mention' ? (
                        <Pressable
                          onPress={() => toggleMute(ch)}
                          accessibilityRole="button"
                          accessibilityLabel={`${ch.muted ? 'Unmute' : 'Mute'} in ${ch.name ?? ch.slug ?? 'channel'}`}
                          className="rounded-md border border-border px-2 py-0.5 active:bg-muted"
                        >
                          <Text className="text-[11px] font-medium text-foreground">{ch.muted ? 'Unmute' : 'Mute'}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}
