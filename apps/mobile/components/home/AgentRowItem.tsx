// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One agent on Home: its buddy, what it is doing, and what it needs. When it
 * waits on an approval, swipe right to approve and left to deny (a rail of
 * buttons on web and desktop). Press and hold for a peek at its last turn.
 */
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import Swipeable from 'react-native-gesture-handler/Swipeable'
import { Check, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { stateLabel, type AgentRow } from '../../lib/agent-urgency'
import type { ApprovalAnswer, ApprovalOutcome } from '../../lib/approval-decision'
import { haptics } from '../../lib/haptics'
import { useAgentLook } from '../../hooks/useTeamChat'
import { AgentAvatar } from '../team-chat/AgentAvatar'
import { buddyAvatarColor } from '../team-chat/BuddyAvatar'
import { DrawnCheckmark } from '../ui/DrawnCheckmark'
import { GlassCard } from '../ui/GlassCard'

const AMBER = '#f59e0b'
const SETTLED_MS = 1800

const STATE_TEXT: Record<AgentRow['state'], string> = {
  needs_you: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  running: 'text-primary',
  queued: 'text-muted-foreground',
  done: 'text-emerald-700 dark:text-emerald-400',
}

export interface AgentRowItemProps {
  row: AgentRow
  workspaceId: string
  onOpen: (row: AgentRow) => void
  onPeek: (row: AgentRow) => void
  onDecide: (row: AgentRow, decision: ApprovalAnswer) => Promise<ApprovalOutcome>
}

function SwipeRail({ side }: { side: 'approve' | 'deny' }) {
  const approve = side === 'approve'
  return (
    <View
      className={cn('mb-2 mt-0 w-24 flex-row items-center rounded-2xl px-6', approve ? 'justify-start bg-emerald-600' : 'justify-end bg-red-600')}
      style={{ marginLeft: approve ? 0 : 8, marginRight: approve ? 8 : 0 }}
    >
      {approve ? <Check size={22} color="#fff" /> : <X size={22} color="#fff" />}
    </View>
  )
}

export function AgentRowItem({ row, workspaceId, onOpen, onPeek, onDecide }: AgentRowItemProps) {
  const look = useAgentLook(workspaceId, row.projectId)
  const color = buddyAvatarColor(look)
  const swipeRef = useRef<Swipeable>(null)
  const [settled, setSettled] = useState<ApprovalAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const waiting = row.state === 'needs_you' && !!row.approval
  const swipeable = waiting && Platform.OS !== 'web'

  const decide = async (decision: ApprovalAnswer) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const outcome = await onDecide(row, decision)
    setBusy(false)
    swipeRef.current?.close()
    if (outcome.ok) {
      setSettled(decision)
      timer.current = setTimeout(() => setSettled(null), SETTLED_MS)
    } else if (outcome.reason === 'failed') {
      setError(outcome.message)
    }
  }

  const detail = settled ? (settled === 'approve' ? 'Approved, sent to the agent' : 'Denied, sent to the agent') : error ?? row.detail

  const body = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${stateLabel(row.state)}. ${row.detail}`}
      accessibilityActions={waiting ? [{ name: 'activate' }, { name: 'approve', label: 'Approve' }, { name: 'deny', label: 'Deny' }] : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'approve') void decide('approve')
        else if (event.nativeEvent.actionName === 'deny') void decide('deny')
        else onOpen(row)
      }}
      onPress={() => onOpen(row)}
      onLongPress={() => {
        haptics.selection()
        onPeek(row)
      }}
      delayLongPress={350}
      className="flex-row items-center gap-3 px-3.5 py-3 active:opacity-80"
      testID={`agent-row-${row.key}`}
    >
      <View style={{ borderRadius: 12, padding: 2, backgroundColor: `${color}22` }}>
        <AgentAvatar name={row.name} projectId={row.projectId} workspaceId={workspaceId} size={44} />
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-base font-semibold text-foreground" numberOfLines={1}>
            {row.name}
          </Text>
          <Text className={cn('text-xs font-medium', STATE_TEXT[row.state])}>{stateLabel(row.state)}</Text>
        </View>
        <Text
          className={cn(waiting && !settled ? 'font-mono text-[13px]' : 'text-sm', error ? 'text-destructive' : 'text-muted-foreground')}
          numberOfLines={2}
        >
          {detail}
        </Text>
        {waiting && Platform.OS === 'web' && !settled ? (
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Approve ${row.name}`}
              disabled={busy}
              onPress={() => void decide('approve')}
              className={cn('rounded-md bg-primary px-3 py-1.5', busy && 'opacity-60')}
            >
              <Text className="text-xs font-medium text-primary-foreground">Approve</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Deny ${row.name}`}
              disabled={busy}
              onPress={() => void decide('deny')}
              className={cn('rounded-md border border-border px-3 py-1.5 active:bg-muted', busy && 'opacity-60')}
            >
              <Text className="text-xs font-medium text-foreground">Deny</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {settled ? <DrawnCheckmark size={30} tone={settled === 'approve' ? 'success' : 'danger'} /> : null}
    </Pressable>
  )

  const card = waiting ? (
    <GlassCard accent={`${AMBER}80`} tint={`${AMBER}1f`} radius={18}>
      {body}
    </GlassCard>
  ) : (
    <View className="overflow-hidden rounded-[18px] border border-border bg-card">{body}</View>
  )

  if (!swipeable) return <View className="px-4 pb-2">{card}</View>

  return (
    <View className="px-4 pb-2">
      <Swipeable
        ref={swipeRef}
        overshootLeft={false}
        overshootRight={false}
        friction={1.6}
        leftThreshold={70}
        rightThreshold={70}
        renderLeftActions={() => <SwipeRail side="approve" />}
        renderRightActions={() => <SwipeRail side="deny" />}
        onSwipeableOpen={(direction) => {
          // Dragging right opens the left rail: approve. Dragging left: deny.
          void decide(direction === 'left' ? 'approve' : 'deny')
        }}
      >
        {card}
      </Swipeable>
    </View>
  )
}
