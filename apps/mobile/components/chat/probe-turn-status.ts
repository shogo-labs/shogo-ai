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

import { STALL_PROBE_TIMEOUT_MS } from "../../lib/chat-stall-watchdog"

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
  /**
   * Whether the runtime answered the probe at all. `false` means every attempt
   * failed (network error, abort, 5xx) — the status is a placeholder, not an
   * answer. Recovery has to tell the two apart: a runtime that says "I have no
   * turn for this session" (answered, `unknown`) really has nothing to reattach
   * to, while a probe that could not reach the pod says nothing about the turn
   * and is worth retrying (Sentry REACT-5Z gave up on 4 blind probes).
   */
  answered: boolean
  /**
   * The API refused the credential (401/403) and re-establishing the session
   * did not help (SHO-564). The turn state is unknown because we are not
   * signed in — not because the runtime has no buffer — so the caller shows
   * the signed-out state instead of treating the chat as idle.
   */
  refused?: boolean
}

/** Static headers, or a getter so a retry after reauth sends the fresh cookie. */
export type ProbeTurnHeaders =
  | Record<string, string>
  | (() => Record<string, string> | undefined)

export interface ProbeTurnStatusOptions {
  /** Resolved chat-turn URL — typically built via `buildChatTurnUrl`. */
  url: string
  /** Optional fetch override (e.g. `expo/fetch` for native streaming). */
  fetch?: typeof globalThis.fetch
  /**
   * Per-call headers (e.g. native auth cookies). Pass a getter when the
   * caller can re-establish its session: the probe calls it again for the
   * retry, so the retried request carries the refreshed credential.
   */
  headers?: ProbeTurnHeaders
  /** Fetch credentials mode (`'include'` for cross-origin cookie auth). */
  credentials?: RequestCredentials
  /**
   * Called once when the API refuses the probe's credential (401/403).
   * Resolve `true` when the session was re-established — the probe then
   * retries immediately with freshly built headers. Resolve `false` and the
   * snapshot comes back `refused`, which the caller can show as signed out.
   */
  onRefused?: () => Promise<boolean>
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
  let attempt = 0
  let reestablished = false
  for (;;) {
    const result = await probeOnce(opts)
    // A refusal is about the credential, not the turn: re-establish the
    // session once and retry with the refreshed cookie (SHO-564). Reporting it
    // as `unknown` is what made the rejoin silently give up — the chat looked
    // idle while the reply was still streaming.
    if (result === "refused") {
      if (!reestablished && opts.onRefused) {
        reestablished = true
        if (await opts.onRefused()) {
          if (opts.signal?.aborted) return UNKNOWN_TURN
          continue
        }
      }
      return REFUSED_TURN
    }
    if (result !== "error") return result
    if (attempt >= delays.length || opts.signal?.aborted) return UNKNOWN_TURN
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    attempt += 1
    if (opts.signal?.aborted) return UNKNOWN_TURN
  }
}

/** Just the status, for the callers that only decide whether to attach. */
export async function probeChatTurnStatus(
  opts: ProbeTurnStatusOptions,
): Promise<ChatTurnStatus> {
  return (await probeChatTurn(opts)).status
}

/**
 * The probe every stall/recovery path must use: `probeChatTurn` with a hard
 * upper bound on how long the caller can wait.
 *
 * Without a bound a half-open socket never settles the fetch, and the caller
 * cannot distinguish "the runtime is slow" from "this request will never come
 * back": the watchdog's in-flight latch stays taken (every 15 s tick returns
 * early) and the recovery loop sits inside its "recovering" state forever —
 * the exact "nothing comes back" the probe exists to prevent. An abort reads
 * as `answered: false`, which every caller already handles as "the runtime
 * said nothing".
 *
 * `opts.signal` wins when the caller passes one (it owns the lifetime), and
 * the timer is always cleared so a fast probe leaves nothing behind.
 */
export async function probeChatTurnBounded(
  opts: ProbeTurnStatusOptions,
  timeoutMs: number = STALL_PROBE_TIMEOUT_MS,
): Promise<ChatTurnSnapshot> {
  if (opts.signal) return probeChatTurn(opts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await probeChatTurn({ ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const UNKNOWN_TURN: ChatTurnSnapshot = { status: "unknown", turnId: null, answered: false }
/** The runtime answered, and it has no turn for this session. */
const NO_LIVE_TURN: ChatTurnSnapshot = { status: "unknown", turnId: null, answered: true }
/** The API refused the credential and re-establishing the session did not help. */
const REFUSED_TURN: ChatTurnSnapshot = {
  status: "unknown",
  turnId: null,
  answered: false,
  refused: true,
}

/** Headers for this attempt — a getter is re-read so a reauth retry is fresh. */
function headersForAttempt(headers: ProbeTurnHeaders | undefined): Record<string, string> {
  if (!headers) return {}
  const resolved = typeof headers === "function" ? headers() : headers
  return resolved ?? {}
}

async function probeOnce(
  opts: ProbeTurnStatusOptions,
): Promise<ChatTurnSnapshot | "error" | "refused"> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  try {
    const res = await fetchFn(opts.url, {
      method: "GET",
      headers: headersForAttempt(opts.headers),
      credentials: opts.credentials,
      signal: opts.signal,
    } as any)

    // 404 ⇒ runtime has no buffer for this session — treat as unknown.
    if (res.status === 404 || res.status === 204) return NO_LIVE_TURN
    // 401/403 ⇒ the credential was refused. Not an answer about the turn.
    if (res.status === 401 || res.status === 403) return "refused"
    if (!res.ok) return "error"

    const body = (await res.json().catch(() => null)) as
      | { status?: unknown; turnId?: unknown }
      | null
    // A 200 whose body we could not parse is not an answer either.
    if (!body) return "error"
    return {
      status: normalizeTurnStatus(body.status),
      turnId: typeof body.turnId === "string" ? body.turnId : null,
      answered: true,
    }
  } catch {
    // Network error, abort, or otherwise — fall back to "no live turn".
    return "error"
  }
}
