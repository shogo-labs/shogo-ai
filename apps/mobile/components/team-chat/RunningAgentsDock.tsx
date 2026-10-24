// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The agents working in this timeline, docked directly above the composer.
 *
 * A reply row is created when its run starts, so anything posted while it runs
 * lands below it and the row — with its live status and Stop — disappears up
 * the thread. This dock keeps that run where the reader is: one row per running
 * reply, whichever channel or thread the pane is showing, and it renders
 * nothing at all when no agent is running.
 *
 * The row is the handle for the run it belongs to: pressing it jumps to the
 * reply (`onJump`, which the pane turns into the same scroll-and-highlight a
 * message link uses), and its Open session / Stop buttons are the ones that
 * used to sit in the reply's header.
 *
 * Chrome: the phone pane floats everything over the messages, so there this is
 * a glass card like `GlassChip`; in a docked pane it is the same rounded card
 * `ChatDock` uses, so it reads as part of the composer column.
 */
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { ExternalLink, Square } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ChatMessage } from '../../lib/team-chat-api'
import type { TimelineState } from '../../lib/team-chat-state'
import { AgentAvatar } from './AgentAvatar'
import { AgentQueueStatus, AgentWorkingStatus } from './AgentWork'
import { CappedContentScroll } from '../chat/dock/CappedContentScroll'
import { LiquidGlassBackdrop } from '../ui/LiquidGlassBackdrop'

/** Rows shown before the dock scrolls instead of growing. */
export const MAX_DOCK_ROWS = 3
/** A row: avatar, name, one line of status, the two buttons. */
const DOCK_ROW_HEIGHT = 36
const DOCK_MAX_HEIGHT = MAX_DOCK_ROWS * DOCK_ROW_HEIGHT

export interface RunningAgentsDockProps {
  /** Running agent replies, oldest first — see `runningAgentReplies`. */
  replies: ChatMessage[]
  /** Live state by message id, straight from the timeline. */
  streaming: TimelineState['streaming']
  /** Scroll to and emphasize this reply. */
  onJump: (messageId: string) => void
  onStop: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
  workspaceId?: string | null
  /** Phone pane: glass chrome, floating over the messages. */
  floating?: boolean
  /** Horizontal placement, so the rows line up with the composer's edges. */
  style?: StyleProp<ViewStyle>
}

function RunningAgentRow({
  reply,
  live,
  last,
  workspaceId,
  onJump,
  onStop,
  onOpenSession,
}: {
  reply: ChatMessage
  live: TimelineState['streaming'][string] | undefined
  last: boolean
  workspaceId?: string | null
  onJump: (messageId: string) => void
  onStop: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
}) {
  const name = reply.authorAgent?.name ?? 'Agent'
  // A reply created with no free slot carries `blocks.queued` until it starts,
  // so its place in line survives a reload.
  const queuedSince = !!(reply.blocks as { queued?: { since?: string } } | null | undefined)?.queued
  const openSession = !!reply.agentSessionId && !!onOpenSession
  return (
    <Pressable
      onPress={() => onJump(reply.id)}
      accessibilityRole="button"
      accessibilityLabel={`Jump to ${name}'s reply`}
      testID={`running-agent-row-${reply.id}`}
      className={cn('flex-row items-center gap-1.5 px-2.5 py-1.5 active:bg-accent/40', !last && 'border-b border-border/50')}
      style={{ minHeight: DOCK_ROW_HEIGHT }}
    >
      <AgentAvatar
        name={name}
        projectId={reply.authorAgent?.projectId ?? null}
        workspaceId={workspaceId}
        iconUrl={reply.authorAgent?.iconUrl}
        size={18}
      />
      <Text className="shrink text-xs font-medium text-foreground" numberOfLines={1}>
        {name}
      </Text>
      <View className="min-w-0 flex-1">
        {live?.waiting ? (
          <AgentQueueStatus compact waiting={live.waiting} />
        ) : live?.queue || queuedSince ? (
          <AgentQueueStatus compact position={live?.queue?.position ?? null} />
        ) : (
          <AgentWorkingStatus compact tools={live?.tools ?? (live?.tool ? [{ name: live.tool, done: false }] : [])} />
        )}
      </View>
      {openSession ? (
        <Pressable
          onPress={(event) => {
            event?.stopPropagation?.()
            onOpenSession?.(reply)
          }}
          accessibilityLabel="Open the session this agent is working in"
          className="flex-row items-center gap-1 rounded-md border border-border px-2 py-0.5 active:bg-muted"
        >
          <ExternalLink size={10} className="text-muted-foreground" />
          <Text className="text-[11px] text-muted-foreground">Open session</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={(event) => {
          event?.stopPropagation?.()
          onStop(reply)
        }}
        accessibilityLabel="Stop agent"
        className="flex-row items-center gap-1 rounded-md border border-border px-2 py-0.5 active:bg-muted"
      >
        <Square size={10} className="text-muted-foreground" />
        <Text className="text-[11px] text-muted-foreground">Stop</Text>
      </Pressable>
    </Pressable>
  )
}

export function RunningAgentsDock({
  replies,
  streaming,
  onJump,
  onStop,
  onOpenSession,
  workspaceId,
  floating = false,
  style,
}: RunningAgentsDockProps) {
  if (!replies.length) return null
  const rows = (
    <CappedContentScroll maxHeight={DOCK_MAX_HEIGHT} testID="running-agents-dock-scroll">
      {replies.map((reply, index) => (
        <RunningAgentRow
          key={reply.id}
          reply={reply}
          live={streaming[reply.id]}
          last={index === replies.length - 1}
          workspaceId={workspaceId}
          onJump={onJump}
          onStop={onStop}
          onOpenSession={onOpenSession}
        />
      ))}
    </CappedContentScroll>
  )
  return (
    <View style={style} pointerEvents="box-none">
      {floating ? (
        <View testID="running-agents-dock" className="overflow-hidden rounded-2xl bg-transparent shadow-sm">
          <LiquidGlassBackdrop style={{ borderRadius: 16 }} />
          {rows}
        </View>
      ) : (
        <View
          testID="running-agents-dock"
          className="overflow-hidden rounded-xl border border-border/60 bg-popover shadow-md"
        >
          {rows}
        </View>
      )}
    </View>
  )
}
