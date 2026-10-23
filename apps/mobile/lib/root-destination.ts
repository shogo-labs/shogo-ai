// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What the app shows at `/`.
 *
 * Landing is always the workspace agent on an empty chat — team and personal
 * workspaces, phone and web. The pre-landing team home (phone feed / wide
 * "What are we building" builder) moved to the explicit `/(app)/home` route,
 * and `/(app)/new-project` still pins the builder. With the workspace runtime
 * disabled the landing falls back to what it rendered before: the builder.
 */
export type AppHomeSurface = 'agent' | 'feed' | 'builder'

export interface AppHomeInput {
  /** `/(app)/new-project`: the builder entry point, whatever the width. */
  forceBuilder?: boolean
  /** `/(app)/home`: the explicit home, not the landing. */
  explicitHome?: boolean
  /** Active workspace kind (`'team'`, `'personal'`, …). */
  kind?: string | null
  /** Narrow surface: a phone, or web below `WEB_WIDE_MIN_WIDTH`. */
  narrow: boolean
  /** `isWorkspaceRuntimeEnabled()` — without it a chat cannot run a turn. */
  runtimeEnabled: boolean
}

export function appHomeSurface({
  forceBuilder = false,
  explicitHome = false,
  kind,
  narrow,
  runtimeEnabled,
}: AppHomeInput): AppHomeSurface {
  if (forceBuilder) return 'builder'
  // A chat that cannot run a turn must not be the landing.
  if (!runtimeEnabled) return 'builder'
  if (!explicitHome) return 'agent'
  if (kind === 'team' && narrow) return 'feed'
  return kind === 'personal' ? 'agent' : 'builder'
}

/**
 * Which session the workspace agent screen opens.
 *
 * - An explicit `?chatSessionId=` always wins.
 * - The **team** landing starts a new, empty chat every time; the previous
 *   conversation stays in history.
 * - **Personal** workspaces keep resuming their last chat (unchanged).
 * - A plain `/agent` route also keeps resuming the primary chat.
 */
export type AgentSessionSource = 'url' | 'new' | 'primary'

export function agentSessionSource({
  initialSessionId,
  startNewSession = false,
  kind,
}: {
  initialSessionId?: string
  /** The landing (`/`) asked for an empty chat. Only team honours it. */
  startNewSession?: boolean
  kind?: string | null
}): AgentSessionSource {
  if (initialSessionId) return 'url'
  return startNewSession && kind === 'team' ? 'new' : 'primary'
}
