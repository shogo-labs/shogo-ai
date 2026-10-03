// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The workspace agent chat. Home links here; on phones it renders inside the mobile workspace shell. */
import { WorkspaceAgentChatScreen } from '../../components/workspace/WorkspaceAgentChatScreen'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'

export default function AgentChatRoute() {
  const workspace = useActiveWorkspace()
  return <WorkspaceAgentChatScreen key={workspace?.id ?? 'workspace-loading'} />
}
