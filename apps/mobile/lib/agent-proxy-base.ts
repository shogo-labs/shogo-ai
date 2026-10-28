// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The base URL every runtime call from a chat panel hangs off.
 *
 * Three chat shapes reach the same agent runtime and each needs a different
 * proxy route: an explicit local runtime (`localAgentUrl`), a project chat
 * (`/api/projects/:id/agent-proxy`), and the project-less workspace chat — the
 * landing / personal-companion chat — which has only a `workspaceId`
 * (`/api/workspaces/:id/agent-proxy`).
 *
 * Resolving this inline at each call site is how the dock lost its seed fetch
 * for workspace chats: the base came out `null` there, so tasks were only ever
 * fed live frames and vanished on the next mount.
 */
export function agentProxyBase(opts: {
  /** Explicit runtime URL (remote instance / desktop local agent). */
  localAgentUrl?: string | null
  /** Project chat. */
  projectId?: string | null
  /** Workspace-scoped chat (`chatScope === "workspace"`). */
  workspaceId?: string | null
  /**
   * A paired desktop's own workspace. The desktop owns that workspace's agent,
   * so the base goes through the machine relay with the *machine's* workspace
   * id — the cloud id in `workspaceId` means nothing there.
   */
  machine?: { instanceId: string; localWorkspaceId: string } | null
  /** API origin, e.g. `https://shogo.example` or `http://localhost:8002`. */
  apiUrl: string
}): string | null {
  if (opts.localAgentUrl) return opts.localAgentUrl.replace(/\/+$/, "")
  const apiUrl = opts.apiUrl.replace(/\/+$/, "")
  if (opts.projectId) return `${apiUrl}/api/projects/${opts.projectId}/agent-proxy`
  if (opts.machine?.localWorkspaceId) {
    const { instanceId, localWorkspaceId } = opts.machine
    return `${apiUrl}/api/machines/${instanceId}/w/${localWorkspaceId}/api/workspaces/${localWorkspaceId}/agent-proxy`
  }
  if (opts.workspaceId) return `${apiUrl}/api/workspaces/${opts.workspaceId}/agent-proxy`
  return null
}

/**
 * Another project's runtime, reached from a chat that belongs to the workspace
 * rather than to that project — a file the workspace agent wrote there with
 * `project: "<name>"`, for one (SHO-247).
 *
 * `relayBase` is a paired desktop's relay prefix when the workspace lives on
 * that machine, so the call lands on the runtime that owns the files.
 */
export function projectAgentProxyBase(opts: {
  projectId: string | null | undefined
  /** `${apiUrl}/api/machines/<id>/w/<localId>` when a machine owns the workspace. */
  relayBase?: string | null
  apiUrl: string
}): string | null {
  const projectId = opts.projectId?.trim()
  if (!projectId) return null
  const origin = (opts.relayBase ?? opts.apiUrl).replace(/\/+$/, "")
  if (!origin) return null
  return `${origin}/api/projects/${projectId}/agent-proxy`
}
