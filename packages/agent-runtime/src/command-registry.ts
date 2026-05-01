// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandRegistry — per-session bookkeeping for backgrounded shell commands.
 *
 * When the `exec` tool soft-times-out after 30s, the underlying child process
 * keeps running. We hand the agent a short `run_id` it can pass to `exec_wait`
 * to keep waiting, or use to look up the pid for `exec("kill <pid>")`.
 *
 * Entries linger for ~10 minutes after completion so a follow-up `exec_wait`
 * can still retrieve the final output. On session disposal every still-running
 * entry is forcefully killed.
 */

import { randomBytes } from 'crypto'
import type { CommandHandle } from './sandbox-exec'

/** How long to keep finished entries around so post-hoc `exec_wait` works. */
const COMPLETED_RETENTION_MS = 10 * 60 * 1000

export interface CommandEntry {
  runId: string
  command: string
  handle: CommandHandle
  finishedAt?: number
  finalResult?: { exitCode: number; stdout: string; stderr: string; killed: boolean; timedOut: boolean }
}

export class CommandRegistry {
  private entries = new Map<string, CommandEntry>()

  /** Register a freshly spawned handle and return its run id. */
  register(command: string, handle: CommandHandle): CommandEntry {
    const runId = `cmd_${randomBytes(4).toString('hex')}`
    const entry: CommandEntry = { runId, command, handle }
    this.entries.set(runId, entry)

    handle.done.then((result) => {
      entry.finishedAt = Date.now()
      entry.finalResult = result
      const cleanupTimer = setTimeout(() => {
        this.entries.delete(runId)
      }, COMPLETED_RETENTION_MS)
      cleanupTimer.unref?.()
    }).catch(() => {
      entry.finishedAt = Date.now()
    })

    return entry
  }

  get(runId: string): CommandEntry | undefined {
    return this.entries.get(runId)
  }

  /** Number of entries (running + recently finished). For tests/diagnostics. */
  size(): number {
    return this.entries.size
  }

  /** Forcefully terminate every still-running command. Used on session shutdown. */
  killAll(): void {
    for (const entry of this.entries.values()) {
      if (!entry.handle.exited()) {
        try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    this.entries.clear()
  }
}
