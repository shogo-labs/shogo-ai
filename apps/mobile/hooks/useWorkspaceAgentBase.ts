// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where the workspace agent of the workspace currently in view lives.
 *
 * `null` means "the app's own API" — the cloud companion, or the desktop app's
 * local API. A paired desktop's own workspace (`source: 'machine'`) returns the
 * machine's relay instead: that desktop owns its workspace's agent, sessions and
 * team chat, and its workspace id is a different id from the cloud one on
 * screen, so both the base URL and the id have to come from the machine.
 */
import { useMemo } from "react"
import { API_URL } from "../lib/api"
import { agentProxyBase } from "../lib/agent-proxy-base"
import { useActiveInstance } from "../contexts/active-instance"
import { useActiveWorkspace } from "./useActiveWorkspace"

export interface WorkspaceAgentRoute {
  instanceId: string
  /** The desktop's own id for the workspace in view. */
  localWorkspaceId: string
  /** `${apiUrl}/api/machines/<id>/w/<localId>` — every workspace call hangs off this. */
  relayBase: string
  /** `${relayBase}/api/workspaces/<localId>/agent-proxy` — the agent runtime. */
  agentBase: string
  /** `${relayBase}/api/workspaces/<localId>` — the workspace's own API surface. */
  workspaceBase: string
}

export function useWorkspaceAgentBase(): WorkspaceAgentRoute | null {
  const { instance } = useActiveInstance()
  const workspace = useActiveWorkspace()

  return useMemo(() => {
    if (instance?.source !== "machine" || !instance.localWorkspaceId || !API_URL) return null
    const relayBase = `${API_URL}/api/machines/${instance.instanceId}/w/${instance.localWorkspaceId}`
    const agentBase = agentProxyBase({
      machine: { instanceId: instance.instanceId, localWorkspaceId: instance.localWorkspaceId },
      workspaceId: workspace?.id,
      apiUrl: API_URL,
    })
    if (!agentBase) return null
    return {
      instanceId: instance.instanceId,
      localWorkspaceId: instance.localWorkspaceId,
      relayBase,
      agentBase,
      workspaceBase: `${relayBase}/api/workspaces/${instance.localWorkspaceId}`,
    }
  }, [instance, workspace?.id])
}
