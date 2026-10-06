// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The agents on Home, most urgent first: tasks, running chats and pending approvals joined per agent. */
import { useMemo } from 'react'
import { buildAgentRows, type AgentRow } from '../lib/agent-urgency'
import type { ActiveChatTurn, AgentTask } from '../lib/api'
import type { Mentionables } from '../lib/team-chat-api'
import { usePendingApprovals } from './usePendingApprovals'

export function useAgentRows(input: {
  workspaceId: string | null | undefined
  agents: Mentionables['agents'] | undefined
  tasks: AgentTask[]
  activeChats: ActiveChatTurn[]
  polling: boolean
}): { rows: AgentRow[]; refreshApprovals: () => Promise<void> } {
  const { approvals, refresh } = usePendingApprovals(input.workspaceId, { polling: input.polling })
  const rows = useMemo(
    () =>
      buildAgentRows({
        agents: (input.agents ?? []).map((a) => ({ key: a.key, projectId: a.projectId, name: a.name })),
        tasks: input.tasks,
        activeChats: input.activeChats,
        approvals,
      }),
    [input.agents, input.tasks, input.activeChats, approvals],
  )
  return { rows, refreshApprovals: refresh }
}
