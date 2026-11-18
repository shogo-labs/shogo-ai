// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stopping a run from the "Running now" strip.
 *
 * A channel reply stops through its own message; a chat turn stops through its
 * session's chat endpoint. Both are the calls the chat panel and the team-chat
 * reply menu already make, so a stop from either place ends the same run — and
 * the row leaves the strip on the next poll, because the server clears the turn.
 */
import { Platform } from 'react-native'
import { canStopRunningChat } from './activity-feed'
import type { ActiveChatTurn } from './api'
import { API_URL } from './api-url'
import { authClient } from './auth-client'
import { buildStopRequest } from './chat-stop'
import { teamChatApi } from './team-chat-api'

/** The cookie the runtime's auth client holds; older typed builds omit it from the surface. */
function authCookie(): string | null {
  return (authClient as unknown as { getCookie?: () => string | null }).getCookie?.() ?? null
}

/** Stop the run behind one row. False when the row names nothing to stop. */
export async function stopRunningChat(chat: ActiveChatTurn, workspaceId: string | null): Promise<boolean> {
  if (!canStopRunningChat(chat)) return false
  if (chat.messageId) {
    await teamChatApi().stopAgent(chat.messageId)
    return true
  }
  const req = buildStopRequest({
    projectId: chat.projectId,
    // A session with no project belongs to the workspace agent.
    workspaceId: chat.projectId ? null : workspaceId,
    apiBaseUrl: API_URL,
    platform: Platform.OS,
    getCookie: authCookie,
    chatSessionId: chat.chatSessionId,
  })
  if (!req) return false
  await fetch(req.url, req.init)
  return true
}
