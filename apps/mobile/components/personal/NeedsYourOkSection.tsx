// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Needs your OK" — the approval-first surface described in the plan doc:
 * pending `GoalEvent.kind === 'approval'` items, shown at the top of Goals
 * and Activity so an irreversible action the companion wants to take never
 * gets buried in a chat scrollback. Approve/Decline resolve immediately via
 * `resolveGoalApproval`; tapping the card body instead prefills the primary
 * chat with a reply, since a "why" often benefits from a sentence of context
 * the two buttons can't capture — see `useChatPrefill`.
 */
import { useCallback, useState } from 'react'
import { useRouter } from 'expo-router'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { CircleCheck, CircleX, ShieldQuestion } from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { setChatPrefill } from '../../hooks/useChatPrefill'
import { api, type PersonalWorkspaceActivity } from '../../lib/api'

export interface NeedsYourOkSectionProps {
  workspaceId: string
  /** Pending approval items — callers filter with `isApprovalPending` before passing these in. */
  items: PersonalWorkspaceActivity[]
  /** Called after a decision is recorded so the caller can drop the item from its own list. */
  onResolved: (eventId: string) => void
}

export function NeedsYourOkSection({ workspaceId, items, onResolved }: NeedsYourOkSectionProps) {
  if (items.length === 0) return null
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-1.5">
        <ShieldQuestion size={15} className="text-amber-500" />
        <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-amber-600">
          Needs your OK
        </Text>
      </View>
      <View className="gap-2.5">
        {items.map((item) => (
          <NeedsYourOkCard key={item.id} workspaceId={workspaceId} item={item} onResolved={onResolved} />
        ))}
      </View>
    </View>
  )
}

function NeedsYourOkCard({
  workspaceId,
  item,
  onResolved,
}: {
  workspaceId: string
  item: PersonalWorkspaceActivity
  onResolved: (eventId: string) => void
}) {
  const http = useDomainHttp()
  const router = useRouter()
  const [pending, setPending] = useState<'approved' | 'declined' | null>(null)
  const goalId = item.goalId

  const decide = useCallback(
    async (decision: 'approved' | 'declined') => {
      if (!goalId || pending) return
      setPending(decision)
      try {
        await api.resolveGoalApproval(http, workspaceId, goalId, item.id, decision)
        onResolved(item.id)
      } catch {
        setPending(null)
      }
    },
    [goalId, http, item.id, onResolved, pending, workspaceId],
  )

  const reply = useCallback(() => {
    const context = item.message ? `"${item.message}"` : 'this'
    setChatPrefill(`About ${context} — `)
    router.push('/(app)' as any)
  }, [item.message, router])

  return (
    <View className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <Pressable onPress={reply} accessibilityRole="button" accessibilityLabel="Reply about this approval">
        {item.goalTitle ? (
          <Text className="text-xs font-medium text-amber-700">{item.goalTitle}</Text>
        ) : null}
        <Text className="mt-1 text-sm leading-5 text-foreground">{item.message || 'Wants your approval'}</Text>
      </Pressable>
      <View className="mt-3 flex-row items-center gap-2">
        <Pressable
          onPress={() => void decide('approved')}
          disabled={!!pending || !goalId}
          accessibilityRole="button"
          accessibilityLabel="Approve"
          className="flex-1 flex-row items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 active:opacity-80 disabled:opacity-50"
        >
          {pending === 'approved' ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <CircleCheck size={15} className="text-white" />
          )}
          <Text className="text-sm font-semibold text-white">Approve</Text>
        </Pressable>
        <Pressable
          onPress={() => void decide('declined')}
          disabled={!!pending || !goalId}
          accessibilityRole="button"
          accessibilityLabel="Decline"
          className="flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 active:opacity-80 disabled:opacity-50"
        >
          {pending === 'declined' ? (
            <ActivityIndicator size="small" />
          ) : (
            <CircleX size={15} className="text-muted-foreground" />
          )}
          <Text className="text-sm font-semibold text-foreground">Decline</Text>
        </Pressable>
      </View>
    </View>
  )
}
