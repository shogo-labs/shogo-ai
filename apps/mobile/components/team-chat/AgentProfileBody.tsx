// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an agent profile says about the agent: what it is for, who owns it and
 * the channels it works in (with per-channel mute). Shared by the quick
 * profile card and the full profile screen.
 */
import { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Hash, Lock } from 'lucide-react-native'
import { teamChatApi, type AgentCard } from '../../lib/team-chat-api'

const api = teamChatApi()

const TRIGGER_LABEL: Record<string, string> = {
  mention: 'Replies when mentioned',
  keyword: 'Replies to keywords',
  all: 'Replies to every message',
  auto: 'Replies when relevant',
}

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger
}

/** Loads an agent's card and keeps it current as the person mutes channels. */
export function useAgentCard(workspaceId: string, projectId: string | null) {
  const [card, setCard] = useState<AgentCard | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setCard(null)
    setFailed(false)
    api.agentCard(workspaceId, projectId)
      .then((c) => { if (live) setCard(c) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [workspaceId, projectId])

  const toggleMute = useCallback((ch: AgentCard['channels'][number]) => {
    const muted = !ch.muted
    const set = (value: boolean) =>
      setCard((c) => c && { ...c, channels: c.channels.map((x) => (x.conversationId === ch.conversationId ? { ...x, muted: value } : x)) })
    set(muted)
    api.setAgentMuted(ch.conversationId, projectId, muted).catch(() => set(!muted))
  }, [projectId])

  return { card, setCard, failed, toggleMute }
}

export function AgentProfileBody({
  card,
  onToggleMute,
  onOpenChannel,
}: {
  card: AgentCard
  onToggleMute: (channel: AgentCard['channels'][number]) => void
  onOpenChannel?: (conversationId: string) => void
}) {
  return (
    <View className="gap-3">
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
                onPress={onOpenChannel ? () => onOpenChannel(ch.conversationId) : undefined}
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
                  onPress={() => onToggleMute(ch)}
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
  )
}
