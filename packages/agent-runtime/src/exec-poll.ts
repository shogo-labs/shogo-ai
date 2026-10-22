// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects a `sleep` the agent uses to wait for a background task.
 *
 * A sleep cannot see a task finish early: it always spends the whole delay, and
 * when it wakes the agent has to look again — which is where the sleep-poll
 * loops in the proxy capture came from (1,141 of them). `wait` returns the
 * instant the task settles or its output matches, so `exec` steers a sleep to
 * it, and refuses a second identical poll (exec-detach.ts refuses `&` for the
 * same reason: the agent then polls with sleep loops instead of using the task).
 *
 * Only a top-level `sleep` counts. A project's own script (a `run.sh`, a test
 * runner, a retry helper) is left alone, and so is a job the command
 * backgrounds itself (a trailing `&`), whose sleep nobody is waiting on.
 */

import { segmentsOf } from './exec-detach'

export interface PollCheck {
  poll: boolean
  /** How long the poll sleeps for, when the command is a single sleep. */
  seconds?: number
  /** What makes it a poll, for the steering text. */
  how?: string
}

/** `5`, `0.5`, `2s`, `1m` → seconds. */
function sleepSeconds(arg: string | undefined): number | undefined {
  if (!arg) return undefined
  const match = arg.match(/^([\d.]+)([smhd]?)$/)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = match[2] === 'm' ? 60 : match[2] === 'h' ? 3_600 : match[2] === 'd' ? 86_400 : 1
  return value * unit
}

/** Shell keywords that can sit in front of a loop body's real command. */
const LOOP_PREFIXES = new Set(['do', 'then', 'else', 'time'])

function loopBodyCommand(words: string[]): string | undefined {
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (LOOP_PREFIXES.has(word)) continue
    return word
  }
  return undefined
}

export function checkSleepPoll(command: string): PollCheck {
  for (const segment of segmentsOf(command)) {
    // A job the command backgrounds itself (`cmd &`) is not the agent waiting,
    // and exec refuses `&` anyway.
    if (segment.terminator === '&') continue
    if (loopBodyCommand(segment.words) !== 'sleep') continue
    const arg = segment.words.find((w) => /^[\d.]+[smhd]?$/.test(w))
    return { poll: true, seconds: sleepSeconds(arg), how: '`sleep`' }
  }
  return { poll: false }
}
