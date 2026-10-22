// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects a `sleep` the agent uses to wait on a background task.
 *
 * A sleep cannot see a task finish early: it always spends the whole delay, and
 * when it wakes the agent has to look again — which is where the sleep-poll
 * loops in the proxy capture came from (1,141 of them). `wait` returns the
 * instant the task settles or its output matches, so `exec` steers a sleep to
 * it, and refuses a second identical poll (exec-detach.ts refuses `&` for the
 * same reason: the agent then polls with sleep loops instead of using the task).
 *
 * Narrow on purpose. Of the 2,484 real `exec`s containing `sleep` in the same
 * capture, only ~12% wait on a task `wait` could replace; the rest wait on CI
 * (`sleep 75; gh pr checks`), a server coming up (`sleep 2 && curl localhost`),
 * a rebuild (`sleep 2 && tail .shogo/logs/build.log`), a retry, or a
 * kill-then-verify. So a sleep is only a poll when it is plainly tied to a
 * running task: the command reads that task's output (its log file, or the file
 * the task's own command redirects to), or the command does nothing but wait.
 * Everything else is left alone.
 *
 * Only a top-level `sleep` counts. A project's own script (a `run.sh`, a test
 * runner, a retry helper) is left alone, and so is a job the command
 * backgrounds itself (a trailing `&`), whose sleep nobody is waiting on.
 */

import { segmentsOf } from './exec-detach'

/** A running task, as much of it as the poll matcher needs. */
export interface RunningTaskRef {
  id: string
  /** Shell tasks: the exact command, which may redirect into its own log file. */
  command?: string
  /** The task's output file (the path `wait` reads), as `task_list` shows it. */
  outputFile?: string
}

export interface PollMatch {
  /** The running tasks this command waits on. */
  ids: string[]
  /**
   * `reads_task_output`: the command reads one of those tasks' output, so it is
   * that task it is polling. `bare_wait`: the command only sleeps, so it waits
   * on whatever is running.
   */
  reason: 'reads_task_output' | 'bare_wait'
}

/** Shell keywords that can sit in front of a loop body's real command. */
const LOOP_PREFIXES = new Set(['do', 'then', 'else', 'time'])

/**
 * The commands a command that only waits is allowed to be made of. `task_list`
 * is included because a sleep in front of it is the poll the card started from
 * (`sleep 15 && task_list`): it reads the running tasks' state, which `wait`
 * returns by itself.
 */
const WAIT_OR_POLL = new Set(['sleep', 'echo', 'task_list'])

const REDIRECT = /^(\d*>>?|&>>?)$/
const ATTACHED_REDIRECT = /^(\d*>>?|&>>?)([^&>].*)$/

function segmentCommand(words: string[]): string | undefined {
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (LOOP_PREFIXES.has(word)) continue
    return word
  }
  return undefined
}

function hasTopLevelSleep(segments: ReturnType<typeof segmentsOf>): boolean {
  return segments.some(
    // A job the command backgrounds itself (`cmd &`) is not the agent waiting,
    // and exec refuses `&` anyway.
    (segment) => segment.terminator !== '&' && segmentCommand(segment.words) === 'sleep',
  )
}

/**
 * The running tasks a sleep command is polling, or null when it is not polling
 * any of them. Callers pass every running task and steer only the ones named.
 */
export function findPolledTasks(command: string, running: RunningTaskRef[]): PollMatch | null {
  if (running.length === 0) return null
  const segments = segmentsOf(command)
  if (!hasTopLevelSleep(segments)) return null

  const words = segments.flatMap((segment) => segment.words)
  const reads = running.filter((task) => readsOutputOf(words, task))
  if (reads.length > 0) return { ids: reads.map((task) => task.id), reason: 'reads_task_output' }

  if (segments.every((segment) => WAIT_OR_POLL.has(segmentCommand(segment.words) ?? ''))) {
    return { ids: running.map((task) => task.id), reason: 'bare_wait' }
  }
  return null
}

/** Whether these words read the output of a task: its log, or its own redirect target. */
function readsOutputOf(words: string[], task: RunningTaskRef): boolean {
  return outputRefs(task).some((ref) => words.some((word) => sameFile(word, ref)))
}

/** Where a running task writes: its output file, and any file its command redirects to. */
function outputRefs(task: RunningTaskRef): string[] {
  const refs = new Set<string>()
  const output = normalize(task.outputFile ?? '')
  if (output) {
    refs.add(output)
    const scoped = output.slice(output.lastIndexOf('.shogo/'))
    if (scoped) refs.add(scoped)
  }
  for (const target of redirectTargets(task.command ?? '')) refs.add(target)
  refs.delete('')
  return [...refs]
}

/** File targets a command writes to: `> f`, `>> f`, `2> f`, and `tee f`. */
function redirectTargets(command: string): string[] {
  const targets: string[] = []
  for (const segment of segmentsOf(command)) {
    const words = segment.words
    for (const [index, word] of words.entries()) {
      if (REDIRECT.test(word)) {
        const next = words[index + 1]
        if (next) targets.push(normalize(next))
        continue
      }
      const attached = word.match(ATTACHED_REDIRECT)?.[2]
      if (attached) {
        targets.push(normalize(attached))
        continue
      }
      if (word === 'tee') {
        const next = words.slice(index + 1).find((w) => !w.startsWith('-'))
        if (next && !/^[|;&]/.test(next)) targets.push(normalize(next))
      }
    }
  }
  return targets.filter((target) => target && target !== '/dev/null' && !target.startsWith('&'))
}

function normalize(path: string): string {
  return path.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Same file, spelled absolutely or relative to the workspace. */
function sameFile(word: string, ref: string): boolean {
  const clean = normalize(word)
  if (!ref.includes('/')) return clean === ref
  return clean === ref || clean.endsWith(`/${ref}`)
}
