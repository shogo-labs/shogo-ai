// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Your huddle, pinned to the corner while you're somewhere other than its conversation. */
import { Platform, Pressable, Text, View } from 'react-native'
import { useGlobalSearchParams, useRouter, useSegments } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Headphones, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react-native'
import { leaveHuddleCall, resumeHuddlePlayback, setHuddleMuted, useHuddleCall } from '../../lib/huddle-call'
import { CircleButton } from './Huddle'

export function HuddleDock() {
  const call = useHuddleCall()
  const router = useRouter()
  const segments = useSegments() as string[]
  const params = useGlobalSearchParams<{ conversationId?: string | string[] }>()
  const insets = useSafeAreaInsets()
  if (call.status === 'idle' || !call.conversationId) return null
  const routeConversationId = Array.isArray(params.conversationId) ? params.conversationId[0] : params.conversationId
  if (segments.includes('[conversationId]') && routeConversationId === call.conversationId) return null

  return (
    <View
      className="absolute bottom-20 right-3 z-50"
      style={Platform.OS === 'web' ? { position: 'fixed' as any, bottom: 16, right: 16 } : { bottom: insets.bottom + 72 }}
      testID="huddle-dock"
    >
      <View className="flex-row items-center gap-2 rounded-full border border-emerald-500/40 bg-card px-2 py-1.5 shadow-lg">
        <Pressable
          onPress={() => router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: call.conversationId! } } as any)}
          accessibilityRole="button"
          accessibilityLabel={`Open huddle in ${call.label ?? 'conversation'}`}
          className="max-w-[180px] flex-row items-center gap-2 pl-1"
        >
          <Headphones size={16} className="text-emerald-600" />
          <Text className="flex-shrink text-sm font-medium text-foreground" numberOfLines={1}>
            {call.status === 'joining' ? 'Joining…' : call.status === 'reconnecting' ? 'Reconnecting…' : call.label ?? 'Huddle'}
          </Text>
        </Pressable>
        {call.playbackBlocked ? (
          <CircleButton label="Turn on huddle audio" onPress={resumeHuddlePlayback}>
            <Volume2 size={16} className="text-foreground" />
          </CircleButton>
        ) : null}
        <CircleButton label={call.muted ? 'Unmute' : 'Mute'} onPress={() => void setHuddleMuted(!call.muted)}>
          {call.muted ? <MicOff size={16} className="text-destructive" /> : <Mic size={16} className="text-foreground" />}
        </CircleButton>
        <CircleButton label="Leave huddle" tone="danger" onPress={() => void leaveHuddleCall()}>
          <PhoneOff size={16} color="white" />
        </CircleButton>
      </View>
    </View>
  )
}
