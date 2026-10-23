// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle link landing page: `/huddle/join/<token>`.
 *
 * Anyone with the link can ask to join the call. A teammate who can already
 * join goes straight in; a teammate without access to the conversation, or an
 * outside guest who gives a name, waits here while everyone in the call sees
 * "X wants to join". When someone admits them the call opens: members join
 * the huddle (not the conversation), guests get a call and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { HuddleNotesNotice } from '../../../components/team-chat/HuddleNotesPill'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AlertTriangle, Headphones } from 'lucide-react-native'
import { useAuth } from '../../../contexts/auth'
import { HuddlePanel } from '../../../components/team-chat/HuddleWindow'
import { joinHuddleAsGuest, joinHuddleCall, leaveHuddleCall, setHuddleView, useHuddleCall } from '../../../lib/huddle-call'
import { teamChatApi, type HuddleLinkInfo, type HuddleRequestResult } from '../../../lib/team-chat-api'

/** How often the waiting screen asks whether someone answered. The API rate-limits this. */
export const KNOCK_POLL_MS = 2_500

type Phase =
  | { kind: 'loading' }
  | { kind: 'ended' }
  | { kind: 'ready'; info: HuddleLinkInfo }
  | { kind: 'waiting'; info: HuddleLinkInfo; requestId: string; name: string }
  | { kind: 'denied' }
  | { kind: 'expired'; info: HuddleLinkInfo }
  | { kind: 'error'; message: string }

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
      <View className="w-full max-w-sm items-center gap-5 rounded-xl border border-border bg-card p-8">{children}</View>
    </SafeAreaView>
  )
}

function Button({ label, onPress, disabled, tone = 'primary' }: { label: string; onPress: () => void; disabled?: boolean; tone?: 'primary' | 'ghost' }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      className={tone === 'primary' ? `w-full items-center rounded-lg bg-primary px-4 py-2.5 active:opacity-80 ${disabled ? 'opacity-50' : ''}` : 'w-full items-center rounded-lg px-4 py-2.5 active:bg-muted'}
    >
      <Text className={tone === 'primary' ? 'text-sm font-medium text-primary-foreground' : 'text-sm text-muted-foreground'}>{label}</Text>
    </Pressable>
  )
}

function who(info: HuddleLinkInfo): string {
  const count = info.participantCount ?? 0
  const people = `${count} ${count === 1 ? 'person' : 'people'} in the call`
  return info.startedBy ? `Started by ${info.startedBy} · ${people}` : people
}

export default function HuddleJoinScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ token?: string }>()
  const token = typeof params.token === 'string' ? params.token : Array.isArray(params.token) ? params.token[0] : undefined
  const { isLoading: authLoading } = useAuth()
  const call = useHuddleCall()

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const joined = useRef(false)

  const load = useCallback(async () => {
    if (!token) return setPhase({ kind: 'error', message: 'This huddle link is not valid' })
    try {
      const info = await teamChatApi().huddleLinkInfo(token)
      setPhase(info.enabled === false ? { kind: 'error', message: 'Huddles are not set up on this server' } : info.live ? { kind: 'ready', info } : { kind: 'ended' })
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error && err.message ? err.message : 'Could not open this huddle link' })
    }
  }, [token])

  useEffect(() => {
    if (!authLoading) void load()
  }, [authLoading, load])

  /**
   * Once in the call: people who can read the conversation land in it; someone
   * let in through the link has no access to it, so they land on the home
   * screen with the call open in front.
   */
  const landInCall = useCallback(
    (conversationId: string, info: HuddleLinkInfo) => {
      if (info.access === 'member') {
        router.replace({ pathname: '/(app)/c/[conversationId]', params: { conversationId } } as never)
        return
      }
      setHuddleView('expanded')
      router.replace('/' as never)
    },
    [router],
  )

  /** Teammates enter the huddle through the normal join (token minted for them); guests use the one the admission handed over. */
  const enter = useCallback(
    async (result: HuddleRequestResult, info: HuddleLinkInfo, requestId: string | null, guestName: string) => {
      if (joined.current) return
      joined.current = true
      if (result.token && result.url && requestId) {
        await joinHuddleAsGuest({ token: result.token, url: result.url, requestId, name: guestName })
        return
      }
      if (result.conversationId && result.workspaceId) {
        await joinHuddleCall({ conversationId: result.conversationId, workspaceId: result.workspaceId, label: info.label ?? 'Huddle' })
        landInCall(result.conversationId, info)
      }
    },
    [landInCall],
  )

  // Waiting at the door: ask until someone answers.
  const requestId = phase.kind === 'waiting' ? phase.requestId : null
  useEffect(() => {
    if (phase.kind !== 'waiting' || !requestId) return
    let stopped = false
    const info = phase.info
    const guestName = phase.name
    const tick = async () => {
      try {
        const result = await teamChatApi().huddleJoinRequest(requestId)
        if (stopped) return
        if (result.status === 'admitted') {
          await enter(result, info, requestId, guestName)
        } else if (result.status === 'denied') setPhase({ kind: 'denied' })
        else if (result.status === 'expired') setPhase({ kind: 'expired', info })
        else if (result.status === 'ended') setPhase({ kind: 'ended' })
      } catch {
        // A hiccup shouldn't drop the request; the next tick retries.
      }
    }
    const timer = setInterval(() => void tick(), KNOCK_POLL_MS)
    void tick()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [phase.kind, requestId]) // eslint-disable-line react-hooks/exhaustive-deps

  const goIn = async (info: HuddleLinkInfo) => {
    if (!info.conversationId || !info.workspaceId) return
    setBusy(true)
    joined.current = true
    await joinHuddleCall({ conversationId: info.conversationId, workspaceId: info.workspaceId, label: info.label ?? 'Huddle' })
    landInCall(info.conversationId, info)
  }

  const knock = async (info: HuddleLinkInfo) => {
    if (!token || busy) return
    const guestName = name.trim()
    if (!info.signedIn && !guestName) return setError('Enter your name so people know who is asking')
    setBusy(true)
    setError(null)
    try {
      const result = await teamChatApi().knockOnHuddle(token, info.signedIn ? undefined : guestName)
      if (result.status === 'admitted' || !result.requestId) {
        await enter({ status: 'admitted', conversationId: result.conversationId, workspaceId: result.workspaceId }, info, null, guestName)
      } else {
        joined.current = false
        setPhase({ kind: 'waiting', info, requestId: result.requestId, name: guestName })
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not ask to join')
    } finally {
      setBusy(false)
    }
  }

  const signIn = () => router.replace({ pathname: '/(auth)/sign-in', params: { next: `/huddle/join/${token}` } } as never)

  // After a guest hangs up (or the call drops) the link starts over from the landing screen.
  const inGuestCall = !!call.guest && call.status !== 'idle'
  const wasInGuestCall = useRef(false)
  useEffect(() => {
    if (inGuestCall) wasInGuestCall.current = true
    else if (wasInGuestCall.current) {
      wasInGuestCall.current = false
      joined.current = false
      void load()
    }
  }, [inGuestCall, load])

  // In the call as a guest: the call is the whole page.
  if (call.guest && call.status !== 'idle') {
    return (
      <SafeAreaView className="flex-1 bg-background p-2" testID="huddle-guest-call">
        <HuddlePanel />
      </SafeAreaView>
    )
  }

  if (authLoading || phase.kind === 'loading') {
    return (
      <Frame>
        <ActivityIndicator size="large" />
      </Frame>
    )
  }

  if (phase.kind === 'error') {
    return (
      <Frame>
        <AlertTriangle size={40} className="text-destructive" />
        <Text className="text-center text-lg font-semibold text-foreground">Link unavailable</Text>
        <Text className="text-center text-sm text-muted-foreground">{phase.message}</Text>
        <Button label="Try again" onPress={() => void load()} />
      </Frame>
    )
  }

  if (phase.kind === 'ended') {
    return (
      <Frame>
        <Headphones size={40} className="text-muted-foreground" />
        <Text className="text-center text-lg font-semibold text-foreground">This huddle has ended</Text>
        <Text className="text-center text-sm text-muted-foreground">The link only works while the call is live.</Text>
        <Button label="Go to Shogo" tone="ghost" onPress={() => router.replace('/')} />
      </Frame>
    )
  }

  if (phase.kind === 'denied') {
    return (
      <Frame>
        <Text className="text-center text-lg font-semibold text-foreground">You weren't let in</Text>
        <Text className="text-center text-sm text-muted-foreground">Someone in the call declined your request.</Text>
        <Button label="Go to Shogo" tone="ghost" onPress={() => router.replace('/')} />
      </Frame>
    )
  }

  if (phase.kind === 'expired') {
    const info = phase.info
    return (
      <Frame>
        <Text className="text-center text-lg font-semibold text-foreground">No one answered</Text>
        <Text className="text-center text-sm text-muted-foreground">Your request timed out. You can ask again.</Text>
        <Button label="Ask again" onPress={() => void knock(info)} disabled={busy} />
      </Frame>
    )
  }

  if (phase.kind === 'waiting') {
    return (
      <Frame>
        <ActivityIndicator />
        <Text className="text-center text-lg font-semibold text-foreground">Asking to join…</Text>
        <Text className="text-center text-sm text-muted-foreground">Everyone in the call can see your request. You'll go in as soon as someone lets you.</Text>
        <Button label="Cancel" tone="ghost" onPress={() => { void leaveHuddleCall(); setPhase({ kind: 'ready', info: phase.info }) }} />
      </Frame>
    )
  }

  const info = phase.info
  const member = info.access === 'member'
  return (
    <Frame>
      <View className="h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
        <Headphones size={32} className="text-emerald-600" />
      </View>
      <View className="items-center gap-1">
        <Text className="text-center text-xl font-semibold text-foreground">{info.label ? `Huddle in #${info.label}` : 'Join the huddle'}</Text>
        <Text className="text-center text-sm text-muted-foreground">{who(info)}</Text>
      </View>
      {error || call.error ? <Text className="text-center text-sm text-destructive">{error ?? call.error}</Text> : null}
      {/* Nobody joins this call without knowing it is written down. A guest gets
          the same notice minus the wake, which AC7 never gives them. */}
      <View className="w-full">
        <HuddleNotesNotice guest={!member} />
      </View>
      {member ? (
        <Button label="Join huddle" onPress={() => void goIn(info)} disabled={busy} />
      ) : (
        <View className="w-full gap-3">
          {info.signedIn ? null : (
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor="#9ca3af"
              maxLength={60}
              autoFocus
              onSubmitEditing={() => void knock(info)}
              accessibilityLabel="Your name"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground"
            />
          )}
          <Button label="Ask to join" onPress={() => void knock(info)} disabled={busy} />
          {info.signedIn ? null : <Button label="Sign in instead" tone="ghost" onPress={signIn} />}
        </View>
      )}
    </Frame>
  )
}
