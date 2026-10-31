// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One request per workspace per poll window, however many hooks ask (SHO-277).
 *
 * `useAgentActivity` and `useWorkspaceChats` are mounted many times over —
 * `WideSidebar`, `TeamDock`, `AgentGlancePublisher`, `AgentWorkingBanner`,
 * `AgentsPanel`, `ActivityFeed`, `useHomeSignals`, `activity.tsx`, the phone
 * shell, `WorkspaceChatsPanel`, `SideChatsScreen` — and each instance used to
 * run its own 5 s poll of the same two workspace-wide endpoints. Eight mounted
 * consumers meant eight identical `active-chats` requests every five seconds,
 * each returning every live turn in the workspace, all served by the same
 * synchronous SQLite connection the chat stream writes to.
 *
 * This module is the single place that answers "what is running in workspace
 * W right now". Callers ask for a value; a request is made at most once per
 * window per workspace, and concurrent callers join the one in flight. The
 * value is served from cache while the window is hidden, so a backgrounded app
 * makes no requests at all.
 */

import type { HttpClient } from '@shogo-ai/sdk'
import { api, type ActiveChatTurn, type AgentTask } from './api'

/** How long one answer is reused. Matches the activity hooks' 5 s cadence. */
export const ACTIVITY_TTL_MS = 5_000

interface Entry {
  value?: unknown
  at: number
  inFlight?: Promise<unknown>
  requests: number
}

/** True when nothing on screen can consume a fresh answer. */
function windowHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden'
}

export class WorkspaceActivityCache {
  private entries = new Map<string, Entry>()

  /**
   * The cached promise for `key`, fetching at most once per {@link ttlMs}.
   * A rejected fetch clears the in-flight slot so the next ask retries.
   *
   * `fresh` is for a caller that has explicitly asked for a refresh (pull to
   * refresh, the refresh button): it joins a request already in flight but
   * never answers from a value that is merely young.
   */
  read<T>(
    key: string,
    load: () => Promise<T>,
    opts: { ttlMs?: number; fresh?: boolean } = {},
  ): Promise<T> {
    const ttlMs = opts.ttlMs ?? ACTIVITY_TTL_MS
    const now = Date.now()
    const entry = this.entries.get(key)

    if (entry?.inFlight) return entry.inFlight as Promise<T>

    // Hidden window: never fetch. Answer from the last known value, or with
    // nothing — no screen is showing it, and the app is about to be throttled
    // by the OS anyway. A backgrounded window makes zero requests.
    if (windowHidden()) {
      return Promise.resolve((entry?.value ?? []) as T)
    }

    if (!opts.fresh && entry && entry.value !== undefined && now - entry.at < ttlMs) {
      return Promise.resolve(entry.value as T)
    }

    const next: Entry = entry ?? { at: 0, requests: 0 }
    next.requests += 1
    const request = load()
      .then((value) => {
        next.value = value
        next.at = Date.now()
        return value
      })
      .finally(() => {
        if (next.inFlight === request) next.inFlight = undefined
      })
    next.inFlight = request
    this.entries.set(key, next)
    return request
  }

  /** Queued + running tasks for a workspace (`GET /api/agent-tasks`). */
  agentTasks(
    http: HttpClient,
    workspaceId: string | undefined,
    opts: { fresh?: boolean } = {},
  ): Promise<AgentTask[]> {
    return this.read(
      `agent-tasks:${workspaceId ?? 'all'}`,
      () => api.listAgentTasks(http, workspaceId ? { workspaceId } : {}),
      opts,
    )
  }

  /** Every live turn in the workspace (`GET /api/workspaces/:id/active-chats`). */
  activeChats(
    http: HttpClient,
    workspaceId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<ActiveChatTurn[]> {
    return this.read(
      `active-chats:${workspaceId}`,
      () => api.listWorkspaceActiveChats(http, workspaceId),
      opts,
    )
  }

  /** How many requests this key has actually made — for tests and diagnostics. */
  requestsFor(key: string): number {
    return this.entries.get(key)?.requests ?? 0
  }

  /** Forget everything. Tests only: a window is one real cache. */
  reset(): void {
    this.entries.clear()
  }
}

export const workspaceActivity = new WorkspaceActivityCache()
