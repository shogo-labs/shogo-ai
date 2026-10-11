// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether a loaded session should keep probing /turn. A delegated task and a
 * channel dispatch both start their turn outside this panel, so the first
 * probe can legitimately see no turn yet.
 */

import { channelDispatchOf, extractTextContent } from '@shogo/shared-app/chat'
import type { ChatTurnStatus } from './probe-turn-status'

export const LATE_TURN_POLL_INTERVAL_MS = 1_000
export const LATE_TURN_MAX_WAIT_MS = 5 * 60 * 1_000

const DELEGATED_TASK_PROMPT_PREFIX = "This is a delegated task from the user's task list:"

function isDelegatedTaskPrompt(message: any): boolean {
  return message?.role === 'user' && extractTextContent(message).trim().startsWith(DELEGATED_TASK_PROMPT_PREFIX)
}

/**
 * Latest user message whose reply is produced somewhere else (a delegated
 * task, or a channel agent run). -1 when the history has neither.
 */
export function pendingExternalPromptIndex(messages: readonly any[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (isDelegatedTaskPrompt(message) || channelDispatchOf(message)) return index
  }
  return -1
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
