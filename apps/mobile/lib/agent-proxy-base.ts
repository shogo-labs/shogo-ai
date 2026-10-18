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
  /** API origin, e.g. `https://shogo.example` or `http://localhost:8002`. */
  apiUrl: string
}): string | null {
  if (opts.localAgentUrl) return opts.localAgentUrl.replace(/\/+$/, "")
  const apiUrl = opts.apiUrl.replace(/\/+$/, "")
  if (opts.projectId) return `${apiUrl}/api/projects/${opts.projectId}/agent-proxy`
  if (opts.workspaceId) return `${apiUrl}/api/workspaces/${opts.workspaceId}/agent-proxy`
  return null
}
