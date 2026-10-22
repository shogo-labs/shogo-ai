// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * When the workspace has more tagged messages than agent slots, the extra runs
 * wait in line rather than disappearing — but nobody can see a line they were
 * never told about, so this strip says how many are waiting and where to change
 * the limit. Admins get a link straight to the stepper; everyone else reads the
 * count and knows why their reply is slow.
 *
 * It shows only while replies are actually queued, and a dismissal lasts until
 * the queue empties (a fresh backlog is news again).
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { X } from 'lucide-react-native'
import { Text } from './settings/account-sheet-chrome'
import { useActiveWorkspace } from '../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../hooks/useWorkspaceExperience'
import { useAgentCapacity } from '../hooks/useAgentCapacity'

/** How often the banner re-reads the queue. Matches the capacity route's cache window. */
const POLL_MS = 20_000

export function AgentLimitBanner() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId = experience.kind === 'team' ? workspace?.id ?? null : null
  const { capacity } = useAgentCapacity(workspaceId, { pollMs: POLL_MS })
  const [dismissed, setDismissed] = useState(false)

  const queued = capacity?.queued ?? 0
  useEffect(() => {
    if (queued === 0) setDismissed(false)
  }, [queued])

  if (!capacity || queued === 0 || dismissed) return null

  const change = () => {
    router.push('/(app)/settings?tab=chat&section=agent-concurrency' as never)
  }

  return (
    <View
      testID="agent-limit-banner"
      className="relative flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-amber-600 px-8 py-1.5"
    >
      <Text className="text-xs font-medium text-white">
        {queued === 1 ? 'An agent is waiting' : `${queued} agents are waiting`} — {capacity.limit}{' '}
        {capacity.limit === 1 ? 'works' : 'work'} at once.
      </Text>
      {capacity.canManage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change how many agents work at once"
          onPress={change}
          className="ml-2 rounded bg-white/20 px-2 py-0.5 active:bg-white/30"
        >
          <Text className="text-xs font-semibold text-white">Change</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={() => setDismissed(true)}
        className="absolute right-2 p-1"
      >
        <X size={12} className="text-white" />
      </Pressable>
    </View>
  )
}
