// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * When the workspace has more tagged messages than agent slots, the extra runs
 * wait in line rather than disappearing — but nobody can see a line they were
 * never told about, so this strip names the backlog and offers the one action
 * that actually helps:
 *
 *   - cloud, at the plan ceiling → "Upgrade your plan", because the "+" on the
 *     stepper is disabled there and Settings would be a dead end;
 *   - cloud, below the ceiling (an admin lowered it) → the stepper;
 *   - desktop, where the ceiling is 100 and there is no plan → the stepper.
 *
 * It shows only while replies are actually queued: the counts arrive live from
 * the queue's `agent.capacity` event. A dismissal is remembered per workspace
 * and lasts until the queue drains — a fresh backlog is news again.
 *
 * Mount it inside `(app)`, where the domain store context exists: it reads the
 * active workspace through `useActiveWorkspace`/`useWorkspaceExperience`, which
 * throw above `DomainProvider` (the root layout has no provider, so mounting
 * there blanks every screen).
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { X } from 'lucide-react-native'
import { Text } from './settings/account-sheet-chrome'
import { useActiveWorkspace } from '../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../hooks/useWorkspaceExperience'
import { useAgentCapacity } from '../hooks/useAgentCapacity'
import { getPlanDisplayName } from '../lib/billing-config'

const CHAT_LIMIT_HREF = '/(app)/settings?tab=chat&section=agent-concurrency'
const BILLING_HREF = '/(app)/settings?tab=billing'

/** Dismissals outlive the component: the banner unmounts on navigation. */
const dismissed = new Set<string>()

/** Test hook: forget the dismissals remembered this session. */
export function _resetAgentLimitBannerForTests(): void {
  dismissed.clear()
}

export function AgentLimitBanner() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId = experience.kind === 'team' ? workspace?.id ?? null : null
  const { capacity } = useAgentCapacity(workspaceId)
  const [dismissedNow, setDismissedNow] = useState(false)

  const queued = capacity?.queued ?? 0
  useEffect(() => {
    // A drained queue clears the dismissal: the next backlog is news again.
    if (queued > 0) return
    if (workspaceId) dismissed.delete(workspaceId)
    setDismissedNow(false)
  }, [queued, workspaceId])

  const remembered = !!workspaceId && dismissed.has(workspaceId)
  if (!capacity || queued === 0 || remembered || dismissedNow) return null

  const cloud = capacity.source === 'plan'
  const planLabel = getPlanDisplayName(capacity.planId)
  const atCeiling = capacity.limit >= capacity.max
  const action = !capacity.canManage
    ? null
    : cloud && atCeiling
      ? { label: 'Upgrade your plan', href: BILLING_HREF }
      : { label: 'Change settings', href: CHAT_LIMIT_HREF }

  const dismiss = () => {
    if (workspaceId) dismissed.add(workspaceId)
    setDismissedNow(true)
  }

  return (
    <View
      testID="agent-limit-banner"
      className="relative flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-amber-600 px-8 py-1.5"
    >
      <Text className="text-xs font-medium text-white">
        Agent limit reached: {capacity.running} running, {queued} queued.
      </Text>
      <Text className="text-xs text-white/80">
        {cloud
          ? `Your ${planLabel} plan runs up to ${capacity.max} at once.`
          : `This desktop runs up to ${capacity.max} at once.`}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => router.push(action.href as never)}
          className="ml-2 rounded bg-white/20 px-2 py-0.5 active:bg-white/30"
        >
          <Text className="text-xs font-semibold text-white">{action.label}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={dismiss}
        className="absolute right-2 p-1"
      >
        <X size={12} className="text-white" />
      </Pressable>
    </View>
  )
}
