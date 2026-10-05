// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Incoming huddle calls, anywhere in the app: who's calling, with Join and
 * Decline.
 */
import { useEffect, useRef } from 'react'
import { AppState, Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Headphones, PhoneOff } from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { useMyUserId } from '../../hooks/useTeamChat'
import { useTeamChatEvents } from '../../lib/team-chat-connection'
import { nativeChatVisible, teamChatApi } from '../../lib/team-chat-api'
import { huddleMediaSupported } from '../../lib/huddle-call'
import { answerRing, applyRingEvent, declineRing, restoreRings, useIncomingRings, type IncomingRing } from '../../lib/huddle-ring'
import { startRingtone } from '../../lib/huddle-ringtone'
import { isUserInactive, notifyChannelMessage } from '../../lib/notifications/chat-notifier'
import { Face } from './Huddle'

/** Ring for calls that started while this app was offline or still connecting. */
function catchUp(workspaceId: string, me: string | null) {
  void Promise.resolve()
    .then(() => teamChatApi().huddles(workspaceId))
    .then(({ huddles }) => restoreRings(workspaceId, huddles, me))
    .catch(() => {})
}

function ringTitle(ring: IncomingRing): string {
  return ring.kind === 'dm' ? `${ring.from.name} is calling you` : `${ring.from.name} started a huddle with you`
}

export function HuddleRinger() {
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const teamWorkspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const { config } = useWorkspaceChatMode(teamWorkspaceId)
  const workspaceId = nativeChatVisible(config?.mode) ? teamWorkspaceId : null
  const me = useMyUserId()
  const meRef = useRef(me)
  meRef.current = me
  const insets = useSafeAreaInsets()
  const rings = useIncomingRings()
  const ring = rings[0] ?? null

  useEffect(() => {
    if (workspaceId && me) catchUp(workspaceId, me)
  }, [workspaceId, me])

  useTeamChatEvents(workspaceId, (event) => {
    if (!workspaceId) return
    if (event.type === 'ready') {
      catchUp(workspaceId, meRef.current)
      return
    }
    applyRingEvent(workspaceId, event, meRef.current)
    if (event.type !== 'huddle.ring' || event.from.userId === meRef.current) return
    void (async () => {
      if (AppState.currentState === 'active' && !(await isUserInactive())) return
      await notifyChannelMessage({
        conversationId: event.conversationId,
        messageId: `huddle-${event.huddleId}`,
        threadRootId: null,
        title: event.from.name,
        body: event.conversationKind === 'dm' ? 'is calling you' : 'started a huddle with you',
      })
    })()
  })

  const ringing = !!ring
  useEffect(() => {
    if (!ringing) return
    return startRingtone()
  }, [ringing])

  if (!ring) return null
  const label = ring.kind === 'dm' ? ring.from.name : `${ring.from.name}'s huddle`

  return (
    <View
      className="absolute left-3 right-3 z-50 items-center"
      style={Platform.OS === 'web' ? { position: 'fixed' as any, top: 16, left: 'auto' as any, right: 16 } : { top: insets.top + 8 }}
      testID="huddle-ringer"
      accessibilityRole="alert"
      accessibilityLabel={ringTitle(ring)}
    >
      <View className="w-full max-w-[360px] flex-row items-center gap-3 rounded-2xl border border-emerald-500/40 bg-card px-3 py-3 shadow-lg">
        <Face person={{ ...ring.from, joinedAt: '' }} speaking size={40} />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {ring.from.name}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {ring.kind === 'dm' ? 'Incoming huddle' : 'Started a huddle with you'}
            {huddleMediaSupported ? '' : ' · join from web or desktop'}
          </Text>
        </View>
        <Pressable
          onPress={() => void declineRing(ring)}
          accessibilityRole="button"
          accessibilityLabel="Decline huddle"
          className="h-10 w-10 items-center justify-center rounded-full bg-destructive active:opacity-80"
        >
          <PhoneOff size={18} color="white" />
        </Pressable>
        {huddleMediaSupported ? (
          <Pressable
            onPress={() => void answerRing(ring, label)}
            accessibilityRole="button"
            accessibilityLabel="Answer huddle"
            className="h-10 w-10 items-center justify-center rounded-full bg-emerald-600 active:opacity-80"
          >
            <Headphones size={18} color="white" />
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}
