// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The picture of a huddle: one tile per person (video when their camera is on,
 * an avatar with a speaking ring when it isn't), in a grid, a speaker layout,
 * or with a shared screen on stage. Each tile shows mute, raised hand, weak
 * connection, and a menu to pin or moderate.
 */
import { useState } from 'react'
import { Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native'
import { Hand, MicOff, MoreHorizontal, Pin, PinOff, UserMinus, VolumeX, WifiOff } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { gridColumns, pickStage, qualityIsWeak, type RosterEntry } from '../../lib/huddle-roster'
import type { HuddleLayout } from '../../lib/huddle-prefs'
import type { HuddleReactionEvent, HuddleVideoTile } from '../../lib/huddle-call'
import { UserAvatar } from './UserAvatar'
import { HuddleVideo } from './HuddleVideo'
import { ReactionOverlay } from './HuddleReactions'

export interface TileActions {
  pinned: string | null
  onPin: (userId: string) => void
  canModerate: boolean
  onMute: (userId: string) => void
  onRemove: (userId: string) => void
}

function statusLabel(e: RosterEntry): string | null {
  if (e.status === 'ringing') return 'Ringing…'
  if (e.status === 'declined') return 'Declined'
  if (e.status === 'missed') return 'No answer'
  return null
}

/** One person: video or avatar, with their live state on top. */
export function PersonTile({
  entry,
  actions,
  className,
  style,
  avatarSize = 56,
  showMenu = true,
}: {
  entry: RosterEntry
  actions?: TileActions
  className?: string
  style?: ViewStyle
  avatarSize?: number
  showMenu?: boolean
}) {
  const [menu, setMenu] = useState(false)
  const inCall = entry.status === 'in-call'
  const label = entry.isLocal ? 'You' : entry.name
  const pinned = actions?.pinned === entry.userId
  const video = inCall && entry.cameraOn ? entry.camera : null
  const status = statusLabel(entry)
  return (
    <View
      className={cn(
        'overflow-hidden rounded-xl border-2 bg-zinc-900',
        entry.speaking && inCall ? 'border-emerald-500' : 'border-transparent',
        !inCall && 'opacity-70',
        className,
      )}
      style={style}
      accessibilityLabel={[label, entry.speaking ? 'speaking' : null, entry.muted && inCall ? 'muted' : null, entry.handRaisedAt ? 'hand raised' : null, status].filter(Boolean).join(', ')}
      testID={`huddle-tile-${entry.userId}`}
    >
      {video ? (
        <HuddleVideo tile={video} fit="cover" />
      ) : (
        <View className="absolute inset-0 items-center justify-center gap-1">
          <UserAvatar name={entry.name} image={entry.image} size={avatarSize} />
          {status ? <Text className="text-[11px] text-zinc-300">{status}</Text> : null}
        </View>
      )}

      <View className="absolute bottom-1.5 left-1.5 right-1.5 flex-row items-center gap-1">
        <View className="max-w-full flex-row items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5">
          {entry.muted && inCall ? <MicOff size={11} color="#f87171" /> : null}
          <Text className="flex-shrink text-[11px] font-medium text-white" numberOfLines={1}>
            {label}
            {entry.guest ? ' · Guest' : ''}
          </Text>
        </View>
      </View>

      <View className="absolute left-1.5 top-1.5 flex-row items-center gap-1">
        {entry.handRaisedAt ? (
          <View className="rounded-full bg-amber-400 p-1" testID={`huddle-hand-${entry.userId}`}>
            <Hand size={12} color="#1f1300" />
          </View>
        ) : null}
        {inCall && qualityIsWeak(entry.quality) ? (
          <View className="rounded-full bg-black/60 p-1" accessibilityLabel={`${label} has a weak connection`} testID={`huddle-quality-${entry.userId}`}>
            <WifiOff size={12} color={entry.quality === 'lost' ? '#f87171' : '#fbbf24'} />
          </View>
        ) : null}
      </View>

      {actions && showMenu && inCall ? (
        <View className="absolute right-1.5 top-1.5 items-end gap-1">
          <Pressable
            onPress={() => setMenu((m) => !m)}
            accessibilityRole="button"
            accessibilityLabel={`More for ${label}`}
            className="rounded-full bg-black/60 p-1 active:opacity-70"
          >
            <MoreHorizontal size={14} color="white" />
          </Pressable>
          {menu ? (
            <View className="z-10 min-w-36 rounded-lg border border-border bg-card py-1 shadow-lg">
              <MenuItem
                label={pinned ? 'Unpin' : 'Pin to stage'}
                icon={pinned ? <PinOff size={14} className="text-foreground" /> : <Pin size={14} className="text-foreground" />}
                onPress={() => {
                  setMenu(false)
                  actions.onPin(entry.userId)
                }}
              />
              {actions.canModerate && !entry.isLocal ? (
                <>
                  <MenuItem
                    label="Mute"
                    icon={<VolumeX size={14} className="text-foreground" />}
                    onPress={() => {
                      setMenu(false)
                      actions.onMute(entry.userId)
                    }}
                  />
                  <MenuItem
                    label="Remove from huddle"
                    destructive
                    icon={<UserMinus size={14} className="text-destructive" />}
                    onPress={() => {
                      setMenu(false)
                      actions.onRemove(entry.userId)
                    }}
                  />
                </>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function MenuItem({ label, icon, onPress, destructive }: { label: string; icon: React.ReactNode; onPress: () => void; destructive?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="menuitem" accessibilityLabel={label} className="flex-row items-center gap-2 px-3 py-2 active:bg-muted hover:bg-muted">
      {icon}
      <Text className={cn('text-xs', destructive ? 'text-destructive' : 'text-foreground')}>{label}</Text>
    </Pressable>
  )
}

function ScreenTile({ tile }: { tile: HuddleVideoTile }) {
  return (
    <View
      className="flex-1 overflow-hidden rounded-xl bg-black"
      accessibilityLabel={`${tile.isLocal ? 'You are' : `${tile.name} is`} sharing a screen`}
      testID={`huddle-tile-${tile.userId}-screen`}
    >
      <HuddleVideo tile={tile} fit="contain" />
      <View className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5">
        <Text className="text-[11px] font-medium text-white" numberOfLines={1}>
          {tile.isLocal ? 'Your screen' : `${tile.name}'s screen`}
        </Text>
      </View>
    </View>
  )
}

export function HuddleStageView({
  roster,
  layout,
  pinned,
  speaking,
  reactions,
  actions,
}: {
  roster: RosterEntry[]
  layout: HuddleLayout
  pinned: string | null
  speaking: string[]
  reactions: HuddleReactionEvent[]
  actions: TileActions
}) {
  const stage = pickStage(roster, layout, pinned, speaking)

  if (stage.screen || stage.spotlight) {
    return (
      <View className="min-h-0 flex-1 gap-2" testID="huddle-stage">
        <View className="min-h-0 flex-1">
          {stage.screen ? <ScreenTile tile={stage.screen} /> : <PersonTile entry={stage.spotlight!} actions={actions} className="flex-1" avatarSize={96} />}
          <ReactionOverlay reactions={reactions} />
        </View>
        {stage.rail.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-28 flex-grow-0" contentContainerStyle={{ gap: 8 }} testID="huddle-rail">
            {stage.rail.map((e) => (
              <PersonTile key={e.userId} entry={e} actions={actions} className="aspect-video h-24" avatarSize={36} />
            ))}
          </ScrollView>
        ) : null}
      </View>
    )
  }

  const cols = gridColumns(roster.length)
  return (
    <View className="min-h-0 flex-1" testID="huddle-stage">
      <View className="flex-1 flex-row flex-wrap content-center items-center justify-center gap-2" testID="huddle-grid">
        {roster.map((e) => (
          <PersonTile
            key={e.userId}
            entry={e}
            actions={actions}
            className="aspect-video"
            style={{ width: `${Math.floor(100 / cols) - 2}%` }}
            avatarSize={roster.length > 4 ? 44 : 72}
          />
        ))}
      </View>
      <ReactionOverlay reactions={reactions} />
    </View>
  )
}
