// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Manual context summarization from the context-usage dock (SHO-96).
 *
 * Goes through the API rather than the runtime directly: on an idle session
 * there is no live turn to carry the SSE frame, so the API writes the
 * transcript row itself. A live turn returns `queued: true` (202) and the row
 * lands with the assistant message at the next step.
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
}

export async function requestContextCompaction(
  projectId: string,
  chatSessionId: string,
): Promise<CompactContextResult> {
  const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}/chat/compact`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "X-Chat-Session-Id": chatSessionId,
    },
    body: JSON.stringify({ chatSessionId }),
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
}
