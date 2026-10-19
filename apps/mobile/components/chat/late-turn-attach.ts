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
