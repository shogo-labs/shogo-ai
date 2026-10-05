// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle chrome: the header button that starts or joins one and the banner
 * over a conversation with a live huddle. `HuddleDock` keeps your call in
 * reach everywhere else.
 */
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native'
import { Headphones, Mic, MicOff, MonitorOff, MonitorUp, PhoneOff, Video, VideoOff, Volume2, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useConversationHuddle } from '../../hooks/useHuddles'
import {
  clearHuddleError,
  huddleMediaSupported,
  huddleVideoSupported,
  joinHuddleCall,
  leaveHuddleCall,
  resumeHuddlePlayback,
  screenShareSupported,
  setHuddleCamera,
  setHuddleMuted,
  setHuddleScreenShare,
  useHuddleCall,
  type HuddleVideoTile,
} from '../../lib/huddle-call'
import { isAgentDm, type ConversationDetail, type HuddleParticipant, type Participant } from '../../lib/team-chat-api'
import { GlassButton } from './FloatingChrome'
import { HuddleVideo } from './HuddleVideo'

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
        <Image source={{ uri: person.image }} style={{ width: size, height: size, borderRadius: size / 2 }} accessibilityIgnoresInvertColors />
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
    else void joinHuddleCall({ conversationId: conversation.id, workspaceId: conversation.workspaceId, label, kind: conversation.kind })
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
      <Headphones size={16} className={iconClass} />
      {huddle && !inThis ? <Text className="text-xs font-medium text-emerald-600">{huddle.participants.length}</Text> : null}
    </Pressable>
  )
}

function VideoTile({ tile, speaking, fit, className }: { tile: HuddleVideoTile; speaking: boolean; fit: 'cover' | 'contain'; className?: string }) {
  return (
    <View
      className={cn('overflow-hidden rounded-xl border-2 bg-black', speaking ? 'border-emerald-500' : 'border-transparent', className)}
      accessibilityLabel={`${tile.isLocal ? 'You' : tile.name}${tile.source === 'screen' ? ', sharing screen' : ', camera'}`}
      testID={`huddle-tile-${tile.userId}-${tile.source}`}
    >
      <HuddleVideo tile={tile} fit={fit} />
      <View className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5">
        <Text className="text-[11px] font-medium text-white" numberOfLines={1}>
          {tile.isLocal ? 'You' : tile.name}
          {tile.source === 'screen' ? ' · screen' : ''}
        </Text>
      </View>
    </View>
  )
}

/** Cameras and shared screens in the call: a shared screen takes the stage, cameras line up beneath. */
function HuddleStage({ tiles, speaking }: { tiles: HuddleVideoTile[]; speaking: Set<string> }) {
  const screen = tiles.find((t) => t.source === 'screen' && !t.isLocal) ?? tiles.find((t) => t.source === 'screen')
  const rest = tiles.filter((t) => t !== screen)
  return (
    <View className="mt-2 gap-2" testID="huddle-stage">
      {screen ? <VideoTile tile={screen} speaking={false} fit="contain" className="aspect-video max-h-[60vh] w-full" /> : null}
      {rest.length ? (
        <View className="flex-row flex-wrap gap-2">
          {rest.map((tile) => (
            <VideoTile
              key={tile.key}
              tile={tile}
              speaking={tile.source === 'camera' && speaking.has(tile.userId)}
              fit={tile.source === 'screen' ? 'contain' : 'cover'}
              className={cn('aspect-video', screen ? 'w-40' : 'w-64')}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** Who's in this conversation's huddle, with join / mute / camera / screen / leave. */
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
          ? `In a huddle with ${others.slice(0, 2).map((p) => p.name).join(', ')}${others.length > 2 ? ` and ${others.length - 2} more` : ''}`
          : conversation.kind === 'dm' || conversation.kind === 'group_dm'
            ? `Calling ${label}…`
            : 'In a huddle · waiting for others'
    : people.length
      ? `${people.length} ${people.length === 1 ? 'person' : 'people'} in a huddle`
      : null

  return (
    <View className="z-20 px-3" style={{ paddingTop: topInset }} testID="huddle-banner">
      {summary ? (
        <View className="mt-2 flex-row items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
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
          {inThis && call.playbackBlocked ? (
            <CircleButton label="Turn on huddle audio" onPress={resumeHuddlePlayback}>
              <Volume2 size={16} className="text-foreground" />
            </CircleButton>
          ) : null}
          {inThis && call.status !== 'joining' ? (
            <>
              <CircleButton label={call.muted ? 'Unmute' : 'Mute'} onPress={() => void setHuddleMuted(!call.muted)}>
                {call.muted ? <MicOff size={16} className="text-destructive" /> : <Mic size={16} className="text-foreground" />}
              </CircleButton>
              {huddleVideoSupported ? (
                <CircleButton label={call.camera ? 'Turn off camera' : 'Turn on camera'} onPress={() => void setHuddleCamera(!call.camera)}>
                  {call.camera ? <Video size={16} className="text-emerald-600" /> : <VideoOff size={16} className="text-foreground" />}
                </CircleButton>
              ) : null}
              {screenShareSupported ? (
                <CircleButton label={call.screen ? 'Stop sharing' : 'Share screen'} onPress={() => void setHuddleScreenShare(!call.screen)}>
                  {call.screen ? <MonitorOff size={16} className="text-emerald-600" /> : <MonitorUp size={16} className="text-foreground" />}
                </CircleButton>
              ) : null}
              <CircleButton label="Leave huddle" tone="danger" onPress={() => void leaveHuddleCall()}>
                <PhoneOff size={16} color="white" />
              </CircleButton>
            </>
          ) : null}
          {!inThis && huddleMediaSupported && canHuddle(conversation, me) ? (
            <Pressable
              onPress={() => void joinHuddleCall({ conversationId: conversation.id, workspaceId: conversation.workspaceId, label, kind: conversation.kind })}
              accessibilityRole="button"
              accessibilityLabel="Join huddle"
              className="rounded-full bg-emerald-600 px-3 py-1.5 active:opacity-80"
            >
              <Text className="text-xs font-semibold text-white">Join</Text>
            </Pressable>
          ) : null}
          {!inThis && !huddleMediaSupported ? <Text className="text-xs text-muted-foreground">Join from web or desktop</Text> : null}
        </View>
      ) : null}
      {inThis && call.video.length ? <HuddleStage tiles={call.video} speaking={speaking} /> : null}
      {error ? (
        <Pressable onPress={clearHuddleError} accessibilityRole="button" accessibilityLabel={`${error}. Dismiss`} className="mt-2 flex-row items-center gap-2 rounded-xl bg-destructive/10 px-3 py-2">
          <Text className="flex-1 text-xs text-destructive">{error}</Text>
          <X size={14} className="text-destructive" />
        </Pressable>
      ) : null}
    </View>
  )
}
