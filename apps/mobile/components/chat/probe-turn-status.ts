// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Probe the runtime's read-only durable-turn snapshot to decide whether
 * to attach to the live `/stream` endpoint after loading message history.
 *
 * Why this exists:
 * The original code wired `useChat({ resume: isInitialLoadComplete })`,
 * which made the AI SDK fire `chat.resumeStream()` automatically on every
 * mount as soon as the history finished loading. That caused two problems:
 *
 *   1. Orphan reconnects. On a fresh refresh of a session whose last turn
 *      had already completed (the common case) the runtime has no buffered
 *      stream, so the GET 204s — but the server logs still showed
 *      `[AgentChat] Stream reconnect: session=... fromSeq=0 snapshot=none`
 *      for every chat tab on every refresh.
 *
 *   2. Two writers to `messages`. The history loader called
 *      `setMessages(loadedHistory)` and the resume's response (when there
 *      *was* a buffered turn) pushed an in-progress assistant message in
 *      parallel — racy, and the source of "I see the same message twice".
 *
 * Probing first decouples them: we only attach to /stream when the runtime
 * actually has an `active` turn. Completed / failed / aborted turns are
 * already represented in the history we just loaded — no need to replay.
 */

/**
 * Snapshot status as exposed by the runtime's `/agent/chat/:id/turn` route
 * (forwarded by the API's `/projects/:projectId/chat/:chatSessionId/turn`).
 *
 * `unknown` is returned when the runtime has no buffer for this session at
 * all — either it never started a turn, or the buffer was evicted past the
 * grace window. Network failures, JSON parse errors, and 5xx upstreams all
 * also collapse to `unknown` so the client never blocks on a probe failure.
 */
export type ChatTurnStatus = "active" | "completed" | "failed" | "aborted" | "unknown"

/**
 * What the turn snapshot says, with the id of the turn it describes. A send
 * straight after Stop needs the id: the turn Stop cancelled can still read
 * `active` for a moment (the runtime only sees `/agent/stop` a beat later), and
 * queuing the new message behind it is what attached the old reply to the new
 * message.
 */
export interface ChatTurnSnapshot {
  status: ChatTurnStatus
  turnId: string | null
}

export interface ProbeTurnStatusOptions {
  /** Resolved chat-turn URL — typically built via `buildChatTurnUrl`. */
  url: string
  /** Optional fetch override (e.g. `expo/fetch` for native streaming). */
  fetch?: typeof globalThis.fetch
  /** Per-call headers (e.g. native auth cookies). */
  headers?: Record<string, string>
  /** Fetch credentials mode (`'include'` for cross-origin cookie auth). */
  credentials?: RequestCredentials
  /**
   * Abort signal to cancel the probe (e.g. on tab close or session switch).
   * The probe is cheap (~50 bytes JSON) but should not outlive its caller.
   */
  signal?: AbortSignal
  /**
   * Delays before each retry when the probe itself fails (network error,
   * 5xx). A 404/204 (no buffer) is an answer and is not retried. Without
   * retries one dropped request on open strands the window idle over a
   * live turn.
   */
  retryDelaysMs?: readonly number[]
}

/**
 * Decide whether to attach to the live /stream after loading history.
 *
 * Pulled out as a pure function so the unit test suite can hit every
 * status arm without standing up React or the runtime — the dynamic
 * fetch is wrapped in a thin async shell (`probeChatTurn`) below.
 */
export function shouldAttachLiveStream(status: ChatTurnStatus): boolean {
  return status === "active"
}

/**
 * True when the snapshot is a live turn other than the one the user just
 * stopped. The cancelled turn can still read `active` for a moment, and a send
 * that queues behind it ends up showing the new reply under the old message
 * (see stopped-turn.ts); only a *different* live turn may hold a send back.
 *
 * Without a stopped turn id, or without an id on the snapshot (an older
 * runtime), this falls back to the plain status check.
 */
export function isLiveTurnOtherThan(
  snapshot: ChatTurnSnapshot,
  stoppedTurnId: string | null | undefined,
): boolean {
  if (snapshot.status !== "active") return false
  if (!stoppedTurnId || !snapshot.turnId) return true
  return snapshot.turnId !== stoppedTurnId
}

/**
 * Coerce an arbitrary value (parsed JSON, possibly malformed) into a
 * known `ChatTurnStatus`. Anything we don't recognise is `unknown` so
 * the caller falls through to the "history is enough" path.
 */
export function normalizeTurnStatus(raw: unknown): ChatTurnStatus {
  if (raw === "active" || raw === "completed" || raw === "failed" || raw === "aborted") {
    return raw
  }
  return "unknown"
}

/**
 * Fetch the durable-turn snapshot: its status and the id of the turn it
 * describes. Never throws — a probe failure is treated as "no live turn" so a
 * flaky network can't permanently strand the user on a half-rendered chat.
 */
export async function probeChatTurn(
  opts: ProbeTurnStatusOptions,
): Promise<ChatTurnSnapshot> {
  const delays = opts.retryDelaysMs ?? []
  for (let attempt = 0; ; attempt++) {
    const result = await probeOnce(opts)
    if (result !== "error") return result
    if (attempt >= delays.length || opts.signal?.aborted) return UNKNOWN_TURN
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    if (opts.signal?.aborted) return UNKNOWN_TURN
  }
}

/** Just the status, for the callers that only decide whether to attach. */
export async function probeChatTurnStatus(
  opts: ProbeTurnStatusOptions,
): Promise<ChatTurnStatus> {
  return (await probeChatTurn(opts)).status
}

const UNKNOWN_TURN: ChatTurnSnapshot = { status: "unknown", turnId: null }

async function probeOnce(
  opts: ProbeTurnStatusOptions,
): Promise<ChatTurnSnapshot | "error"> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  try {
    const res = await fetchFn(opts.url, {
      method: "GET",
      headers: opts.headers ?? {},
      credentials: opts.credentials,
      signal: opts.signal,
    } as any)

    // 404 ⇒ runtime has no buffer for this session — treat as unknown.
    if (res.status === 404 || res.status === 204) return UNKNOWN_TURN
    if (!res.ok) return "error"

    const body = (await res.json().catch(() => null)) as
      | { status?: unknown; turnId?: unknown }
      | null
    return {
      status: normalizeTurnStatus(body?.status),
      turnId: typeof body?.turnId === "string" ? body.turnId : null,
    }
  } catch {
    // Network error, abort, or otherwise — fall back to "no live turn".
    return "error"
  }
}
