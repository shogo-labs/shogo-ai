// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Teammate Permission Bridge
 *
 * When a teammate needs permission to use a tool (e.g. bash, file write),
 * the request is sent to the leader's mailbox. The leader's inbox poller
 * pushes it to the UI via SSE/WebSocket. The user approves/rejects,
 * and the response is written back to the teammate's mailbox.
 */

import type { TeamManager } from './team-manager'

const PERMISSION_POLL_MS = 500
const PERMISSION_TIMEOUT_MS = 120_000

export interface PermissionRequest {
  requestId: string
  agentId: string
  teamId: string
  toolName: string
  toolInput: unknown
}

export interface PermissionResponse {
  requestId: string
  approved: boolean
  reason?: string
}

let requestCounter = 0

export function createPermissionRequestId(): string {
  return `perm-${Date.now()}-${++requestCounter}`
}

/**
 * Sends a permission request to the leader's mailbox and polls for a response.
 * Returns true if approved, false if rejected or timed out.
 */
export async function requestPermissionFromLeader(
  teamManager: TeamManager,
  teamId: string,
  leaderAgentId: string,
  agentId: string,
  toolName: string,
  toolInput: unknown,
): Promise<{ approved: boolean; reason?: string }> {
  const requestId = createPermissionRequestId()

  teamManager.writeMessage(teamId, leaderAgentId, agentId, {
    type: 'permission_request',
    message: JSON.stringify({
      requestId,
      toolName,
      toolInput: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput).slice(0, 2000),
    }),
    summary: `Permission needed: ${toolName}`,
  })

  const deadline = Date.now() + PERMISSION_TIMEOUT_MS

  while (Date.now() < deadline) {
    const messages = teamManager.readUnread(agentId)

    for (const msg of messages) {
      if (msg.messageType === 'permission_response') {
        try {
          const response = JSON.parse(msg.message) as PermissionResponse
          if (response.requestId === requestId) {
            return { approved: response.approved, reason: response.reason }
          }
        } catch { /* malformed response, keep polling */ }
      }
    }

    await new Promise(resolve => setTimeout(resolve, PERMISSION_POLL_MS))
  }

  return { approved: false, reason: 'Permission request timed out' }
}
