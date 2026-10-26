// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat-session id a heartbeat turn bills under.
 *
 * A heartbeat turn runs through the normal chat path, so its provider charges
 * land in `usage_events.actionMetadata.chatSessionId` like any other turn. That
 * string is the only thing that marks the spend as a heartbeat, which means the
 * producer (`gateway.heartbeatTick`) and every reader (analytics) have to agree
 * on it exactly — hence this module instead of a literal in each place.
 *
 * Two shapes exist:
 *   - `heartbeat` — every tick in a runtime shares this one id, so a workspace
 *     runtime's ticks all bill against the runtime's own project.
 *   - `heartbeat:<projectId>:<tickId>` — SHO-178's shape, which names the
 *     project the tick was for so the spend can be attributed to it.
 *
 * The match is exact (`heartbeat`) or prefix (`heartbeat:`) on purpose: a chat
 * session a person named `heartbeat-notes` is not a heartbeat.
 */

/** Bare id used before SHO-178, and by single-project runtimes after it. */
export const HEARTBEAT_SESSION_ID = 'heartbeat'

/** Prefix of the per-tick id: `heartbeat:<projectId>:<tickId>`. */
export const HEARTBEAT_SESSION_PREFIX = 'heartbeat:'

/** Build the per-tick session id, so the producer and the reader agree. */
export function heartbeatSessionIdFor(projectId: string, tickId: string): string {
  return `${HEARTBEAT_SESSION_PREFIX}${projectId}:${tickId}`
}

/** True for `heartbeat` and `heartbeat:<anything>`. */
export function isHeartbeatChatSessionId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false
  return id === HEARTBEAT_SESSION_ID || id.startsWith(HEARTBEAT_SESSION_PREFIX)
}

/**
 * The project a per-tick session id names, or null for the bare `heartbeat` id
 * (and for anything that is not a heartbeat session at all).
 */
export function heartbeatSessionProjectId(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith(HEARTBEAT_SESSION_PREFIX)) return null
  const projectId = id.slice(HEARTBEAT_SESSION_PREFIX.length).split(':')[0]
  return projectId || null
}
