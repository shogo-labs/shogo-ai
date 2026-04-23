// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared entrypoint for cancelling a single subagent by instance id.
 *
 * `ChatPanel` configures this module with the current API base, project id,
 * local agent URL, and cookie accessor. Any component (SubagentCard in the
 * chat, AgentEntry in the Agents panel) can then call `stopSubagent(id)`
 * without having to thread a handler through the tree.
 */

import { buildSubagentStopRequest } from "./chat-stop"
import { subagentStreamStore } from "./subagent-stream-store"

export interface SubagentStopConfig {
  localAgentUrl?: string | null
  projectId?: string | null
  apiBaseUrl: string
  platform: string
  getCookie?: () => string | null
  fetchFn?: typeof fetch
}

let current: SubagentStopConfig | null = null

export function configureSubagentStop(config: SubagentStopConfig | null) {
  current = config
}

/**
 * Cancel a running subagent by AgentManager instance id.
 *
 * Optionally pass the local tool-call id so we can optimistically mark the
 * matching `subagentStreamStore` entry as completed — this hides the stop
 * button immediately instead of waiting for the runtime to flush the final
 * tool output.
 */
export function stopSubagent(instanceId: string, toolId?: string): Promise<void> | void {
  if (!instanceId) return
  const cfg = current
  if (!cfg) {
    console.warn("[subagent-stop] No config set; ignoring stop request")
    return
  }

  if (toolId) {
    try { subagentStreamStore.updateStatus(toolId, "completed") } catch { /* non-fatal */ }
  }

  const req = buildSubagentStopRequest({
    localAgentUrl: cfg.localAgentUrl,
    projectId: cfg.projectId,
    apiBaseUrl: cfg.apiBaseUrl,
    platform: cfg.platform,
    getCookie: cfg.getCookie,
    instanceId,
  })
  if (!req) return

  const fetchFn = cfg.fetchFn || fetch
  return fetchFn(req.url, req.init)
    .then(() => undefined)
    .catch((err) => {
      console.warn("[subagent-stop] Failed to cancel subagent:", err)
    })
}
