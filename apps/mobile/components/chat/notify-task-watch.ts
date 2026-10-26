// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An open chat window has to notice the turn a finished background task wakes
 * into it (SHO-31).
 *
 * The wake is produced by the API's queue drain, not by this window: it posts
 * a `[Task update]` message and runs the turn server-side. Nothing pushes that
 * to a window that is already open, and the window's only other signals — the
 * one-shot `/turn` probes after a turn, a focus recheck — have long given up
 * by the time the 15 s queue tick starts the turn. The transcript then only
 * updates after a reload, which from the user's seat is the same as the agent
 * never waking up.
 *
 * So an idle window keeps asking while background work is in flight: the
 * task list tells it whether something is still running — polled for as long
 * as it is, however long the task takes — and once nothing is listed it probes
 * `/turn` and reloads history until the wake turn shows up in the transcript.
 * Only that last phase is capped, and the whole watch is armed only while a
 * task is listed or the last turn started one, so an idle chat makes no
 * requests.
 */

import type { ChatTurnStatus } from './probe-turn-status'

export const NOTIFY_WAKE_POLL_INTERVAL_MS = 5_000
/**
 * How long to keep asking for the wake after the task list came back empty.
 * It applies only to that wait: a task that is still listed is polled for as
 * long as it runs, however long that is.
 */
export const NOTIFY_WAKE_MAX_WAIT_MS = 5 * 60 * 1_000

export interface NotifyWakeWatchOptions {
  /**
   * The notify-capable tasks the runtime still lists for this chat. Empty
   * means nothing is running any more — or that the task finished before the
   * first poll ever saw it. `null` means the list could not be read, which is
   * not the same thing and holds the wait.
   */
  probeTasks: () => Promise<readonly string[] | null>
  /** Ask the runtime whether a turn is live for this chat right now. */
  probeTurn: () => Promise<ChatTurnStatus>
  /** A turn is live: attach to its stream (the caller reloads first). */
  attach: () => void
  /** Reload saved history — the wake may have finished before any probe saw it. */
  reload: () => Promise<void>
  /** Stop once the wake turn's reply is in the transcript. */
  isSettled?: () => boolean
  isCancelled?: () => boolean
  intervalMs?: number
  /** Bound on the wait for the wake once the task list is empty. */
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onError?: (error: unknown) => void
}

/**
 * Poll until the wake turn is attached, settled, cancelled, or the wait is
 * used up. Returns as soon as the caller has something to render — attaching
 * hands the rest to the stream, and a reload that settles ends the wait.
 */
export async function watchForNotifyWake(options: NotifyWakeWatchOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? NOTIFY_WAKE_POLL_INTERVAL_MS
  const maxWaitMs = options.maxWaitMs ?? NOTIFY_WAKE_MAX_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  let wakeWaitingSince: number | null = null

  while (!options.isCancelled?.()) {
    let tasks: readonly string[] | null = null
    try {
      tasks = await options.probeTasks()
    } catch (error) {
      options.onError?.(error)
    }
    if (options.isCancelled?.()) return

    // While a task is still listed there is nothing to attach to: its wake is
    // queued only once it finishes, and it may run for hours. Keep asking
    // about it for as long as it is listed — that is also what keeps the
    // panel's running-task list accurate — and start the wake wait only once
    // the list comes back empty. An unreadable list says nothing either way,
    // so hold on to whatever state the wait is in.
    if (tasks && tasks.length === 0) {
      wakeWaitingSince ??= now()
      let status: ChatTurnStatus = 'unknown'
      try {
        status = await options.probeTurn()
      } catch (error) {
        options.onError?.(error)
        status = 'unknown'
      }
      if (options.isCancelled?.()) return
      if (status === 'active') {
        options.attach()
        return
      }
      try {
        await options.reload()
      } catch (error) {
        options.onError?.(error)
      }
      if (options.isCancelled?.()) return
      if (options.isSettled?.()) return
      // Only the wait for the wake is bounded: a wake that has not been queued
      // within this window after the task list emptied is not coming.
      if (now() - wakeWaitingSince >= maxWaitMs) return
    } else if (tasks && tasks.length > 0) {
      // Still running (or a new task started): no wake to wait for yet.
      wakeWaitingSince = null
    }

    await sleep(intervalMs)
  }
}

/**
 * Whether the last assistant turn left work running in the background.
 *
 * This is the arming signal that does not depend on the task list ever showing
 * the task: a `background: true` exec (or an exec that outlived its soft
 * timeout and came back `status: "running"`) means the chat will be woken when
 * it finishes, so the window has to watch for that turn.
 */
export function lastTurnStartedBackgroundWork(messages: readonly any[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const parts = partsOf(message)
    if (!parts) return false
    return parts.some(startsBackgroundWork)
  }
  return false
}

function partsOf(message: any): any[] | null {
  const parts = message?.parts
  if (Array.isArray(parts)) return parts
  if (typeof parts !== 'string' || !parts.trim()) return null
  try {
    const parsed = JSON.parse(parts)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function startsBackgroundWork(part: any): boolean {
  const tool = toolPartOf(part)
  if (!tool || tool.name !== 'exec') return false
  if (tool.args?.background === true || tool.args?.mode === 'background') return true
  return tool.result?.status === 'running' && typeof tool.result?.task_id === 'string'
}

function toolPartOf(part: any): { name: string; args: any; result: any } | null {
  if (!part || typeof part !== 'object') return null
  if (part.type === 'tool-invocation') {
    const invocation = part.toolInvocation ?? {}
    return { name: invocation.toolName ?? '', args: invocation.args, result: invocation.result }
  }
  if (part.type === 'dynamic-tool') {
    return {
      name: part.toolName ?? '',
      args: part.input ?? part.args,
      result: part.output ?? part.result,
    }
  }
  return null
}
