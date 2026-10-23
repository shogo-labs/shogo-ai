// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Plan continuation (SHO-121).
 *
 * A turn can end normally while the todo list it wrote during that turn still
 * has open items: the transcript then looks finished, but the work is not, and
 * the only way to restart it is a person typing "continue". These helpers keep
 * that decision out of the gateway — what counts as an unfinished plan, when a
 * finished turn should keep going, and the prompt it continues with.
 */

/** One `todo_write` item, as the model writes it. */
export interface SessionTodo {
  id: string
  content: string
  status: string
}

/** A session's todo list plus when it was last written. */
export interface SessionTodosSnapshot {
  todos: SessionTodo[]
  updatedAt: number
}

/** Default passes a single turn may spend on its own open plan. */
export const PLAN_CONTINUATION_DEFAULT = 2

/**
 * `AGENT_MAX_PLAN_CONTINUATIONS` — `0` disables the loop entirely (the
 * rollback switch), an unset or unparseable value keeps the default.
 */
export function planContinuationLimit(raw: string | undefined = process.env.AGENT_MAX_PLAN_CONTINUATIONS): number {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return PLAN_CONTINUATION_DEFAULT
  const parsed = Number.parseInt(text, 10)
  if (!Number.isFinite(parsed)) return PLAN_CONTINUATION_DEFAULT
  return Math.max(0, parsed)
}

/** Items still to do, in list order. */
export function openPlanItems(todos: readonly SessionTodo[] | undefined): SessionTodo[] {
  if (!todos?.length) return []
  return todos.filter((todo) => todo.status === 'pending' || todo.status === 'in_progress')
}

/** What the turn left behind, from the loop's own result. */
export interface PlanContinuationSurface {
  isHeartbeat: boolean
  isChannelTurn: boolean
  interactionMode: 'agent' | 'plan' | 'ask'
}

/**
 * A heartbeat exists to run on a timer and end; a channel turn answers a
 * message that is not a plan; plan/ask mode may not act on what it would
 * continue. None of them may spend extra model calls on an unfinished list.
 */
export function planContinuationAllowedFor(surface: PlanContinuationSurface): boolean {
  return !surface.isHeartbeat && !surface.isChannelTurn && surface.interactionMode === 'agent'
}

export interface PlanContinuationTurn {
  error?: unknown
  usageLimit?: unknown
  loopBreak?: unknown
  maxIterationsExhausted?: boolean
  abortReason?: unknown
  lastStopReason?: string
  toolCalls: readonly { name: string }[]
}

export interface PlanContinuationInput {
  turn: PlanContinuationTurn
  /** Open items from a todo list written during *this* turn. */
  open: readonly SessionTodo[]
  /** The turn was stopped (user Stop, runtime shutdown). */
  aborted: boolean
  /** A finished background task is about to wake the session anyway. */
  pendingWake: boolean
  /** A background task is still running — the agent may be waiting on it. */
  runningTask: boolean
}

/**
 * Keep going? Every guard is a reason the turn ended correctly and must not be
 * restarted: a failure of any kind, a truncated answer, a question handed to
 * the user, an abort, work that will wake the session on its own, and a stale
 * or completed list.
 */
export function shouldContinuePlan(input: PlanContinuationInput): boolean {
  const { turn } = input
  if (input.aborted || input.pendingWake || input.runningTask) return false
  if (turn.error || turn.usageLimit || turn.loopBreak) return false
  if (turn.maxIterationsExhausted || turn.abortReason) return false
  // A cut-off answer is not a finished turn; the iteration ceiling (and its own
  // continuation) owns that case.
  if (turn.lastStopReason === 'length') return false
  // The turn ended to hand the user a question or a plan. That is the work
  // stopping where it should.
  if (turn.toolCalls[turn.toolCalls.length - 1]?.name === 'ask_user') return false
  return input.open.length > 0
}

/** The synthetic user message a continuation pass starts from. */
export function buildPlanContinuationPrompt(open: readonly SessionTodo[]): string {
  const items = open.map((todo) => `- ${todo.content} (${todo.status})`)
  return [
    'Keep working — you have not finished these yet:',
    ...items,
    '',
    "Do not post a status report as the final answer while items are open. If you are blocked on the user's decision or on a background task, say that in one line and stop.",
  ].join('\n')
}
