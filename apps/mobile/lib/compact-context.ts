// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Manual context summarization from the context-usage dock (SHO-96, SHO-230).
 *
 * Goes through the API rather than the runtime directly: on an idle session
 * there is no live turn to carry the SSE frame, so the API writes the
 * transcript row itself. A live turn returns `queued: true` (202) and the row
 * lands with the assistant message at the next step.
 *
 * The chat's *scope* decides the route. A workspace-scoped chat's session only
 * exists on the workspace runtime, so it must go to
 * `/api/workspaces/:workspaceId/chat/compact` — the project route used to be
 * the only option here, and on a workspace chat it reached a runtime that had
 * never held the session (SHO-230). Same precedence as `buildStopRequest`.
 *
 * The API's `reason` is surfaced verbatim — "nothing to compact" is a real
 * answer, and swallowing it would leave the user staring at an unchanged ring.
 */
import { API_URL } from "./api-url"

export interface CompactContextResult {
  compacted: boolean
  queued: boolean
  reason?: string
  tokensBefore?: number
  tokensAfter?: number
  /** The request budget ran out — summarizing continues server-side. */
  timedOut?: boolean
}

export interface CompactContextTarget {
  /** Project-scoped chat: `/api/projects/:projectId/chat/compact`. */
  projectId?: string | null
  /** Workspace-scoped chat: `/api/workspaces/:workspaceId/chat/compact`. */
  workspaceId?: string | null
  chatSessionId?: string | null
}

/**
 * A fold of a long chat runs sequential summarizer calls server-side. Past this
 * budget the API answers `queued` and keeps going, so the client mostly has to
 * cover a cold runtime; either way the button must never spin indefinitely.
 */
export const COMPACT_REQUEST_TIMEOUT_MS = 45_000

const STILL_SUMMARIZING = "Still summarizing — check back in a minute"

/** The compact route for this chat's scope, or null when there is nothing to address. */
export function buildCompactUrl(target: CompactContextTarget): string | null {
  const { projectId, workspaceId, chatSessionId } = target
  if (!chatSessionId) return null
  if (workspaceId) return `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/chat/compact`
  if (projectId) return `${API_URL}/api/projects/${encodeURIComponent(projectId)}/chat/compact`
  return null
}

export async function requestContextCompaction(
  target: CompactContextTarget,
  options: { timeoutMs?: number } = {},
): Promise<CompactContextResult> {
  const url = buildCompactUrl(target)
  const chatSessionId = target.chatSessionId
  if (!url || !chatSessionId) return { compacted: false, queued: false, reason: "no chat to summarize" }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? COMPACT_REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "X-Chat-Session-Id": chatSessionId,
      },
      body: JSON.stringify({ chatSessionId }),
      signal: controller.signal,
    })

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: string | { message?: string }
    }
    if (!res.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : body.error?.message ?? (typeof body.reason === "string" ? body.reason : undefined)
      return { compacted: false, queued: false, reason: message ?? `Request failed (${res.status})` }
    }

    return {
      compacted: body.compacted === true,
      queued: body.queued === true,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      tokensBefore: typeof body.tokensBefore === "number" ? body.tokensBefore : undefined,
      tokensAfter: typeof body.tokensAfter === "number" ? body.tokensAfter : undefined,
    }
  } catch (err) {
    if (timedOut) {
      return { compacted: false, queued: true, timedOut: true, reason: STILL_SUMMARIZING }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
