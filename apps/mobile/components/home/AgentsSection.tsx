// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home's agents, most urgent first. Tap to open, swipe to answer an approval,
 * press and hold for a peek at the last turn.
 */
import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { openActiveChat } from '../../lib/open-active-chat'
import type { AgentRow } from '../../lib/agent-urgency'
import { answerApproval, type ApprovalAnswer } from '../../lib/approval-decision'
import { AgentRowItem } from './AgentRowItem'
import { LastTurnPeekSheet } from './LastTurnPeekSheet'

export function AgentsSection({ rows, workspaceId }: { rows: AgentRow[]; workspaceId: string }) {
  const router = useRouter()
  const [peek, setPeek] = useState<AgentRow | null>(null)

  const open = useCallback(
    (row: AgentRow) => {
      if (row.approval) {
        router.push(`/(app)/c/${encodeURIComponent(row.approval.conversationId)}?project=${encodeURIComponent(row.approval.projectId)}` as any)
      } else if (row.projectId && row.chatSessionId) {
        openActiveChat(router, { projectId: row.projectId, chatSessionId: row.chatSessionId, isPrimary: false })
      } else if (row.projectId) {
        router.push({ pathname: '/(app)/projects/[id]', params: { id: row.projectId } } as any)
      } else {
        router.push('/(app)/agent' as any)
      }
    },
    [router],
  )

  const decide = useCallback(async (row: AgentRow, decision: ApprovalAnswer) => {
    if (!row.approval) return { ok: false as const, reason: 'failed' as const, message: 'Nothing is waiting on you here' }
    return answerApproval(row.approval.messageId, decision, { biometricReason: `Approve: ${row.approval.summary}` })
  }, [])

  if (!rows.length) return null

  const waiting = rows.filter((r) => r.state === 'needs_you').length
  return (
    <View testID="agents-section">
      <View className="flex-row items-center gap-2 px-4 pb-2 pt-2">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{`Agents · ${rows.length}`}</Text>
        {waiting > 0 ? (
          <View className="rounded-full bg-amber-500/20 px-2 py-0.5">
            <Text className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">{`${waiting} waiting for you`}</Text>
          </View>
        ) : null}
      </View>
      {rows.map((row) => (
        <AgentRowItem key={row.key} row={row} workspaceId={workspaceId} onOpen={open} onPeek={setPeek} onDecide={decide} />
      ))}
      <LastTurnPeekSheet row={peek} onClose={() => setPeek(null)} onOpen={open} />
    </View>
  )
}
