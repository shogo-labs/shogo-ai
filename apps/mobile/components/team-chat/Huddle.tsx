// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle chrome: the header button that starts or joins one and the one-line
 * banner over a conversation with a live huddle. The call itself is the
 * floating `HuddleWindow`.
 */
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'
import { Headphones, PhoneOff, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { WebTooltip } from '../chat/WebTooltip'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'
import { useConversationHuddle } from '../../hooks/useHuddles'
import {
  clearHuddleError,
  huddleMediaSupported,
  leaveHuddleCall,
  requestHuddleJoin,
  setHuddleView,
  useHuddleCall,
} from '../../lib/huddle-call'
import { summarizeNames } from '../../lib/huddle-roster'
import { isAgentDm, type ConversationDetail, type HuddleParticipant, type Participant } from '../../lib/team-chat-api'
import { GlassButton } from './FloatingChrome'

const MAX_FACES = 5

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

function canHuddle(conversation: ConversationDetail, me: string | null): boolean {
  if (conversation.kind === 'activity' || conversation.archivedAt || !conversation.canPost) return false
  const participants: Participant[] = conversation.members
    .filter((m) => m.type === 'agent' || m.userId !== me)
    .map((m) => (m.type === 'agent' ? { type: 'agent', projectId: m.projectId, name: m.name } : { type: 'user', id: m.userId, name: m.name, image: m.image }))
  return !isAgentDm({ kind: conversation.kind, participants })
}

export function Face({ person, speaking, size = 28 }: { person: HuddleParticipant; speaking: boolean; size?: number }) {
  return (
    <View
      className={cn('rounded-full border-2', speaking ? 'border-emerald-500' : 'border-background')}
      accessibilityLabel={speaking ? `${person.name}, speaking` : person.name}
    >
      {person.image ? (
        <Image source={{ uri: resolveAvatarUrl(person.image) ?? undefined }} style={{ width: size, height: size, borderRadius: size / 2 }} accessibilityIgnoresInvertColors />
      ) : (
        <View className="items-center justify-center rounded-full bg-secondary" style={{ width: size, height: size }}>
          <Text className="text-[10px] font-semibold text-secondary-foreground">{initials(person.name)}</Text>
        </View>
      )}
    </View>
  )
}

export function CircleButton({ label, onPress, tone = 'muted', children }: { label: string; onPress: () => void; tone?: 'muted' | 'danger'; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn(
        'h-8 w-8 items-center justify-center rounded-full active:opacity-80',
        tone === 'danger' ? 'bg-destructive' : 'bg-muted hover:bg-muted/80',
      )}
    >
      {children}
    </Pressable>
  )
}

/** Start, join, or leave this conversation's huddle from the header. */
export function HuddleButton({ conversation, me, label, floating }: { conversation: ConversationDetail; me: string | null; label: string; floating?: boolean }) {
  const { enabled, huddle } = useConversationHuddle(conversation.workspaceId, conversation.id)
  const call = useHuddleCall()
  if (!enabled || !canHuddle(conversation, me)) return null
  const inThis = call.conversationId === conversation.id && call.status !== 'idle'
  const action = inThis ? 'Leave huddle' : huddle ? 'Join huddle' : 'Start a huddle'
  const onPress = () => {
    if (inThis) void leaveHuddleCall()
    else void requestHuddleJoin({ conversationId: conversation.id, workspaceId: conversation.workspaceId, label, kind: conversation.kind })
  }
  const iconClass = inThis || huddle ? 'text-emerald-500' : floating ? 'text-foreground' : 'text-muted-foreground'
  if (!huddleMediaSupported && !huddle) return null

  if (floating) {
    return (
      <GlassButton label={action} onPress={huddleMediaSupported ? onPress : undefined}>
        <Headphones size={18} className={iconClass} />
      </GlassButton>
    )
  }
  return (
    <Pressable
      onPress={huddleMediaSupported ? onPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={action}
      className={cn('flex-row items-center gap-1 rounded-md p-1.5 active:bg-muted hover:bg-muted', huddle && !inThis && 'bg-emerald-500/10')}
    >
      <WebTooltip label={action}>
        <Headphones size={16} className={iconClass} />
        {huddle && !inThis ? <Text className="text-xs font-medium text-emerald-600">{huddle.participants.length}</Text> : null}
      </WebTooltip>
    </Pressable>
  )
}

/**
 * One line over a conversation with a live huddle: who is in it, and Join /
 * Open call. The call itself lives in `HuddleWindow`, so the chat is never
 * pushed down by video.
 */
export function HuddleBanner({ conversation, me, label, topInset = 0 }: { conversation: ConversationDetail; me: string | null; label: string; topInset?: number }) {
  const { huddle } = useConversationHuddle(conversation.workspaceId, conversation.id)
  const call = useHuddleCall()
  const inThis = call.conversationId === conversation.id && call.status !== 'idle'
  const error = call.error && !inThis && call.status === 'idle' ? call.error : null
  if (!huddle && !inThis && !error) return null

  const people = huddle?.participants ?? []
  const speaking = new Set(inThis ? call.speaking : [])
  const others = people.filter((p) => p.userId !== me)
  const summary = inThis
    ? call.status === 'joining'
      ? 'Joining huddle…'
      : call.status === 'reconnecting'
        ? 'Reconnecting…'
        : others.length
          ? `In a huddle with ${summarizeNames(others.map((p) => p.name))}`
          : conversation.kind === 'dm' || conversation.kind === 'group_dm'
            ? `Calling ${label}…`
            : 'In a huddle · waiting for others'
    : people.length
      ? `Huddle live · ${people.length} ${people.length === 1 ? 'person' : 'people'}`
      : null

  const join = () => void requestHuddleJoin({ conversationId: conversation.id, workspaceId: conversation.workspaceId, label, kind: conversation.kind })

  return (
    <View className="z-20 px-3" style={{ paddingTop: topInset }} testID="huddle-banner">
      {summary ? (
        <View className="mt-2 flex-row items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5">
          <Headphones size={16} className="text-emerald-600" />
          <View className="flex-row">
            {people.slice(0, MAX_FACES).map((p, i) => (
              <View key={p.userId} style={i ? { marginLeft: -8 } : undefined}>
                <Face person={p} speaking={speaking.has(p.userId)} />
              </View>
            ))}
          </View>
          <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
            {summary}
          </Text>
          {call.status === 'joining' && inThis ? <ActivityIndicator size="small" /> : null}
          {inThis && call.status !== 'joining' ? (
            <>
              {call.view !== 'expanded' ? (
                <Pressable onPress={() => setHuddleView('expanded')} accessibilityRole="button" accessibilityLabel="Open call" className="rounded-full bg-emerald-600 px-3 py-1.5 active:opacity-80">
                  <Text className="text-xs font-semibold text-white">Open call</Text>
                </Pressable>
              ) : null}
              <CircleButton label="Leave huddle" tone="danger" onPress={() => void leaveHuddleCall()}>
                <PhoneOff size={16} color="white" />
              </CircleButton>
            </>
          ) : null}
          {!inThis && huddleMediaSupported && canHuddle(conversation, me) ? (
            <Pressable onPress={join} accessibilityRole="button" accessibilityLabel="Join huddle" className="rounded-full bg-emerald-600 px-3 py-1.5 active:opacity-80">
              <Text className="text-xs font-semibold text-white">Join</Text>
            </Pressable>
          ) : null}
          {!inThis && !huddleMediaSupported ? <Text className="text-xs text-muted-foreground">Join from web or desktop</Text> : null}
        </View>
      ) : null}
      {error ? (
        <Pressable onPress={clearHuddleError} accessibilityRole="button" accessibilityLabel={`${error}. Dismiss`} className="mt-2 flex-row items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2">
          <Text className="flex-1 text-xs text-destructive">{error}</Text>
          <X size={14} className="text-destructive" />
        </Pressable>
      ) : null}
    </View>
  )
}
