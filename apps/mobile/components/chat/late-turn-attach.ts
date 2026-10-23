// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether a loaded session should keep probing /turn. A delegated task, a
 * channel dispatch, a project call and a `[Task update]` wake all start their
 * turn outside this panel, so the first probe can legitimately see no turn
 * yet.
 */

import {
  channelDispatchOf,
  extractTextContent,
  projectCallOf,
  taskNotificationOf,
} from '@shogo/shared-app/chat'
import type { ChatTurnStatus } from './probe-turn-status'

export const LATE_TURN_POLL_INTERVAL_MS = 1_000
export const LATE_TURN_MAX_WAIT_MS = 5 * 60 * 1_000

/**
 * How long a wake row with no reply is still worth waiting for. The queue
 * drains within ~15 s of the task finishing, so an unanswered wake older than
 * this is history that never got a turn — polling it forever would keep an
 * idle chat busy every time its session is opened.
 */
export const TASK_WAKE_PENDING_WINDOW_MS = 10 * 60 * 1_000

const DELEGATED_TASK_PROMPT_PREFIX = "This is a delegated task from the user's task list:"
const TASK_UPDATE_PREFIX = '[Task update]'

function isDelegatedTaskPrompt(message: any): boolean {
  return message?.role === 'user' && extractTextContent(message).trim().startsWith(DELEGATED_TASK_PROMPT_PREFIX)
}

/**
 * The `[Task update]` row the API posts before it wakes the agent. The row is
 * written when the task finishes; the reply follows once the queue's drain
 * tick picks it up, which can be seconds later and is not this window's turn
 * to run.
 */
function isTaskWakeRow(message: any): boolean {
  if (message?.role !== 'user') return false
  if (taskNotificationOf(message)) return true
  return extractTextContent(message).trim().startsWith(TASK_UPDATE_PREFIX)
}

function ageMs(message: any, now: number): number | null {
  const raw = message?.createdAt ?? message?.created_at
  const at =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Date.parse(raw)
        : raw instanceof Date
          ? raw.getTime()
          : Number.NaN
  return Number.isFinite(at) ? now - at : null
}

/**
 * A wake row that may still get its reply. Without a usable timestamp the row
 * is treated as recent — a wake is answered within seconds of being written.
 */
export function isTaskWakePrompt(message: any, now: number = Date.now()): boolean {
  if (!isTaskWakeRow(message)) return false
  const age = ageMs(message, now)
  return age === null || age <= TASK_WAKE_PENDING_WINDOW_MS
}

/**
 * Latest user message whose reply is produced somewhere else (a delegated
 * task, a channel agent run, a project call, or a background task's wake).
 * -1 when the history has none.
 */
export function pendingExternalPromptIndex(messages: readonly any[], now: number = Date.now()): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (
      isDelegatedTaskPrompt(message) ||
      channelDispatchOf(message) ||
      projectCallOf(message) ||
      isTaskWakePrompt(message, now)
    ) {
      return index
    }
  }
  return -1
}

/** Whether the newest `[Task update]` row already has a reply, i.e. the wake ran. */
export function taskWakeHasResponse(messages: readonly any[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isTaskWakeRow(messages[index])) continue
    return messages.some((message, offset) => offset > index && message?.role === 'assistant')
  }
  return false
}

export function externalPromptHasResponse(messages: readonly any[], promptIndex: number): boolean {
  if (promptIndex < 0) return false
  return messages.some((message, index) => index > promptIndex && message?.role === 'assistant')
}

/**
 * The query that reads a chat's newest saved row, one row wide (SHO-53).
 *
 * `orderBy` is not optional: the generated list route only orders when the
 * request says so, and an unordered `limit=1` returns an arbitrary row — in
 * local mode the *oldest* one, which made every refocus read "history moved"
 * and reload the whole transcript (SHO-99). Kept here so the request is
 * testable without a running API.
 */
export function persistedTailQuery(sessionId: string): Record<string, string> {
  return {
    sessionId,
    agent: 'technical',
    limit: '1',
    offset: '0',
    orderBy: 'createdAt:desc',
  }
}

/** The newest saved row of a chat, as the one-shot refocus check reads it. */
export interface PersistedTail {
  id?: string | null
  role?: string | null
  /** The row's text, to recognise the prompt this panel's own reply answers. */
  content?: string | null
  /**
   * Wall-clock start of the turn the row was written for, read off the
   * `data-turn-timing` part the API appends when it persists a reply.
   */
  turnStartedAt?: number | null
  /** Length of the saved text, to notice a reply that grew after a cut stream. */
  contentLength?: number | null
}

export interface PersistedTailCheck {
  /**
   * This panel streamed (or joined) the reply on screen and no history paint
   * has adopted it yet, so the reply is this window's own.
   */
  streamedHere?: boolean
}

/**
 * The turn a transcript message belongs to. The runtime stamps every turn with
 * `data-turn-start` (which the AI SDK appends to the message's parts) and the
 * API copies that stamp into the persisted row as `data-turn-timing`, so the
 * same number identifies the same turn on both sides of the wire.
 */
export function messageTurnStartedAt(message: any): number | null {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const part of parts) {
    if (part?.type !== 'data-turn-start' && part?.type !== 'data-turn-timing') continue
    const startedAt = part?.data?.startedAt
    if (typeof startedAt === 'number') return startedAt
  }
  return null
}

/** Characters of reply text a message carries, from its parts or its content. */
export function messageTextLength(message: any): number {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const fromParts = parts.reduce(
    (total: number, part: any) =>
      total + (part?.type === 'text' && typeof part?.text === 'string' ? part.text.length : 0),
    0,
  )
  return fromParts || (typeof message?.content === 'string' ? message.content.length : 0)
}

/**
 * Whether saved history holds a row this panel never rendered: the newest
 * persisted message is not the one on screen (SHO-53).
 *
 * A window that was not in front when a turn ran somewhere else watches
 * nothing (the wake watch only runs for an active panel), and its refocus
 * probe sees a turn that is already `completed` — the reply was saved while
 * nobody here was looking. This comparison is what tells that apart from a
 * chat that is simply up to date, so a refocus costs one cheap read of the
 * newest row instead of a transcript reload.
 *
 * Ids alone cannot answer it (SHO-99). A reply this panel streamed stays on
 * screen under the AI SDK's own id: the post-turn reconcile paints the saved
 * row over it only when the row has been written by then, and the row can land
 * after that window. Comparing ids then reads the panel's own reply as unseen
 * and pays the full reload on every refocus. Two things close that gap:
 *
 * - The saved row carries its turn's `startedAt`, the same stamp the live
 *   message got from `data-turn-start`, so the same turn is recognised
 *   whichever id the screen shows.
 * - While that reply is still unwritten the newest saved row is the panel's
 *   own prompt. The reply is on screen and only its row is missing, so that is
 *   history behind the screen, not ahead of it (`streamedHere`).
 */
export function persistedTailIsUnseen(
  tail: PersistedTail | null | undefined,
  messages: readonly any[],
  check: PersistedTailCheck = {},
): boolean {
  const persistedId = tail?.id
  if (!persistedId) return false
  const newest = messages[messages.length - 1]
  if (!newest) return true
  if (String(newest?.id ?? '') === String(persistedId)) return false

  const tailTurn = tail?.turnStartedAt ?? null
  if (tailTurn === null) {
    // An assistant tail with no stamp is an older row (the API only stamps
    // turns it saw start), so it cannot be this window's reply.
    if (tail?.role !== 'user') return true
    // A prompt row with no reply written yet. When it is the prompt this
    // panel's own reply answers, nothing is unseen.
    return !(check.streamedHere && tailAnswersScreenPrompt(tail, newest, messages))
  }
  if (messageTurnStartedAt(newest) !== tailTurn) return true
  // Same turn, same reply — unless the saved row carries more text than the
  // one on screen, which is how a stream that was cut and finished server-side
  // gets its remainder painted (SHO-121).
  const savedLength = typeof tail?.contentLength === 'number' ? tail.contentLength : null
  return savedLength !== null && savedLength > messageTextLength(newest)
}

/**
 * Whether a saved prompt row is the one the reply on screen answers: the same
 * text as the newest prompt this panel shows, with that reply still unwritten.
 */
function tailAnswersScreenPrompt(
  tail: PersistedTail,
  newest: any,
  messages: readonly any[],
): boolean {
  if (newest?.role !== 'assistant') return false
  const saved = String(tail?.content ?? '').trim()
  if (!saved) return false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    return String(message?.content ?? '').trim() === saved
  }
  return false
}

/**
 * The newest saved row is a user row, so its reply is still being written — or
 * is queued behind the API's drain tick. A repaint may paint it before the
 * reply exists: the panel's late-turn probe is what picks the reply up then.
 */
export function persistedTailAwaitsReply(tail: PersistedTail | null | undefined): boolean {
  return tail?.role === 'user'
}

export interface LateTurnPollOptions {
  probe: () => Promise<ChatTurnStatus>
  /** The turn is active. Attach to its stream. Called at most once. */
  attach: () => void
  /** The turn is not active yet. Reload saved history in case it already finished. */
  reload: () => Promise<void>
  isCancelled?: () => boolean
  intervalMs?: number
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onError?: (error: unknown) => void
}

/**
 * Probe until the turn is active, the caller cancels, or the wait is used up.
 * A probe that is not active reloads history first: the run may have finished
 * and been saved before any probe saw it.
 */
export async function pollForLateTurn(opts: LateTurnPollOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? LATE_TURN_POLL_INTERVAL_MS
  const maxWaitMs = opts.maxWaitMs ?? LATE_TURN_MAX_WAIT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const started = now()
  while (!opts.isCancelled?.()) {
    let status: ChatTurnStatus = 'unknown'
    try {
      status = await opts.probe()
    } catch (error) {
      opts.onError?.(error)
      status = 'unknown'
    }
    if (opts.isCancelled?.()) return
    if (status === 'active') {
      opts.attach()
      return
    }
    try {
      await opts.reload()
    } catch (error) {
      opts.onError?.(error)
    }
    if (opts.isCancelled?.()) return
    if (now() - started >= maxWaitMs) return
    await sleep(intervalMs)
    if (opts.isCancelled?.() || now() - started >= maxWaitMs) return
  }
}
