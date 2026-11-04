// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent chat. Home links here; on phones it renders inside the mobile workspace shell.
 * `?chatSessionId=<id>` opens that workspace session instead of the primary one (a team chat DM
 * reply opens the session it ran in), with the trail back to the conversation it came from.
 * `?initialMessage=<text>` sends that message once the session loads, if it has no messages yet.
 * `?workspace=<id>&file=<path>` is a shared file link: it opens that workspace's chat with
 * the file pane on that file, and both params are dropped once the pane opens.
 */
import { useLocalSearchParams } from 'expo-router'
import { WorkspaceAgentChatScreen } from '../../components/workspace/WorkspaceAgentChatScreen'
import { SessionBreadcrumb } from '../../components/team-chat/SessionBreadcrumb'
import { useWorkspaceInView } from '../../hooks/useWorkspaceInView'
import { useWorkspaceRemountKey } from '../../hooks/useWorkspaceRemountKey'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function AgentChatRoute() {
  // The workspace in view, so a paired computer's own workspace remounts this
  // chat under its own id rather than the cloud workspace that is selected.
  const workspace = useWorkspaceInView()
  const params = useLocalSearchParams<{
    chatSessionId?: string | string[]
    fromConversation?: string | string[]
    fromLabel?: string | string[]
    fromKind?: string | string[]
    fromThread?: string | string[]
    fromAgent?: string | string[]
    initialMessage?: string | string[]
    /** A shared file link (`/agent?workspace=&file=`, SHO-284). */
    workspace?: string | string[]
    file?: string | string[]
  }>()
  const chatSessionId = firstParam(params.chatSessionId)
  // The workspace id alone is not a stable key: on a cold open it is `null` for
  // the first frames and then the id, so the chat was torn down and rebuilt the
  // moment the collection answered — a second load, a second page read, and a
  // window in which the screen had no `chatSessionId` yet and fell back to the
  // primary chat (SHO-309). `useWorkspaceRemountKey` keeps the key across
  // loading → first workspace and only bumps it for a genuinely different one.
  const mountKey = useWorkspaceRemountKey(workspace?.id)
  const header = firstParam(params.fromConversation) ? <SessionBreadcrumb params={params} /> : undefined
  return (
    <WorkspaceAgentChatScreen
      key={`${mountKey}:${chatSessionId ?? ''}`}
      initialSessionId={chatSessionId}
      initialMessage={firstParam(params.initialMessage)}
      initialFilePath={firstParam(params.file) ?? null}
      linkWorkspaceId={firstParam(params.workspace) ?? null}
      header={header}
    />
  )
}
