// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent chat. Home links here; on phones it renders inside the mobile workspace shell.
 * `?chatSessionId=<id>` opens that workspace session instead of the primary one (a team chat DM
 * reply opens the session it ran in), with the trail back to the conversation it came from.
 */
import { useLocalSearchParams } from 'expo-router'
import { WorkspaceAgentChatScreen } from '../../components/workspace/WorkspaceAgentChatScreen'
import { SessionBreadcrumb } from '../../components/team-chat/SessionBreadcrumb'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function AgentChatRoute() {
  const workspace = useActiveWorkspace()
  const params = useLocalSearchParams<{
    chatSessionId?: string | string[]
    fromConversation?: string | string[]
    fromLabel?: string | string[]
    fromKind?: string | string[]
    fromThread?: string | string[]
    fromAgent?: string | string[]
  }>()
  const chatSessionId = firstParam(params.chatSessionId)
  const header = firstParam(params.fromConversation) ? <SessionBreadcrumb params={params} /> : undefined
  return (
    <WorkspaceAgentChatScreen
      key={`${workspace?.id ?? 'workspace-loading'}:${chatSessionId ?? ''}`}
      initialSessionId={chatSessionId}
      header={header}
    />
  )
}
