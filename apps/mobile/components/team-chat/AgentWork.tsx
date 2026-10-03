// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an agent is doing, and did, behind its channel message.
 *
 * A channel reply shows only the agent's closing words. While it works the row shows the same
 * live status project chat does (`WorkGroup` labels that tick, `PlanningStatusLine` between
 * steps). Once it has finished, "Worked for X" folds the turn away and expands to the work log,
 * rendered by project chat's own `AssistantContent`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { PlanningStatusLine } from '../chat/turns/PlanningStatusLine'
import { WorkGroup } from '../chat/turns/WorkGroup'
import { WorkedForGroup } from '../chat/turns/WorkedForGroup'
import { AssistantContent } from '../chat/turns/AssistantContent'
import { groupWorkParts, shouldShowPlanningStatus } from '../chat/turns/turnShaping'
import { buildFallbackWorkedLabel } from '../chat/turns/workSummary'
import type { MessagePart } from '../chat/turns/types'
import { getToolCategory } from '../chat/tools/types'
import { teamChatApi, type AgentWorkLog } from '../../lib/team-chat-api'
import type { AgentWork } from '../../lib/team-chat-kinds'

const api = teamChatApi()

/** The tools a run has started, in the part shape project chat groups and labels. */
export function livePartsOf(tools: Array<{ name: string; done: boolean }>): MessagePart[] {
  return tools.map((t, i) => ({
    type: 'tool' as const,
    id: `live-${i}`,
    tool: {
      id: `live-${i}`,
      toolName: t.name,
      category: getToolCategory(t.name),
      state: t.done ? ('success' as const) : ('streaming' as const),
      args: {},
      timestamp: 0,
    },
  }))
}

/** The live status of a running reply. */
export function AgentWorkingStatus({ tools }: { tools: Array<{ name: string; done: boolean }> }) {
  const parts = useMemo(() => livePartsOf(tools), [tools])
  const groups = useMemo(() => groupWorkParts(parts), [parts])
  const lastGroup = groups[groups.length - 1]
  return (
    <View className="gap-y-1">
      {groups.map((group) =>
        group.type === 'work-group' ? (
          <WorkGroup
            key={group.id}
            items={group.items}
            isStreaming={group.id === lastGroup?.id}
            isExpanded={false}
            onToggle={() => {}}
          />
        ) : null,
      )}
      {shouldShowPlanningStatus(parts, true) ? <PlanningStatusLine /> : null}
    </View>
  )
}

/** The trimmed turn, fetched when "Worked for X" is first opened. */
function WorkLogBody({ messageId }: { messageId: string }) {
  const [log, setLog] = useState<AgentWorkLog | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.workLog(messageId)
      .then((l) => { if (!cancelled) setLog(l) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [messageId])

  const message = useMemo(
    () =>
      log
        ? ({
            id: `work-${messageId}`,
            role: 'assistant',
            // The empty closing text keeps every part in the work log; the final message is shown by the row.
            parts: [...(log.parts as any[]), { type: 'text', text: '' }],
          } as any)
        : null,
    [log, messageId],
  )

  if (failed) return <Text className="text-xs text-muted-foreground">The work log is not available.</Text>
  if (!message) return <Text className="text-xs text-muted-foreground">Loading…</Text>
  return <AssistantContent message={message} isStreaming={false} bare />
}

/** "Worked for 2m 05s", collapsed, opening to what the agent did. */
export function AgentWorkedFor({ messageId, work }: { messageId: string; work: AgentWork }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((v) => !v), [])
  return (
    <WorkedForGroup
      startedAt={work.startedAt}
      completedAt={work.completedAt}
      fallbackLabel={buildFallbackWorkedLabel([])}
      isExpanded={expanded}
      onToggle={toggle}
      hasBody
    >
      {expanded ? <WorkLogBody messageId={messageId} /> : null}
    </WorkedForGroup>
  )
}
