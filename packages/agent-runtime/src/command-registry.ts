// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandRegistry — per-session bookkeeping for backgrounded shell commands.
 *
 * When the `exec` tool soft-times-out after 30s, the underlying child process
 * keeps running. We hand the agent a short `run_id` it can pass to `exec_wait`
 * to keep waiting, or use to look up the pid for `exec("kill <pid>")`.
 *
 * The registry also exposes the thread's currently-running processes:
 *   - `listRunning()` powers the `exec_list` tool, the HTTP process endpoint,
 *     and the UI process panel.
 *   - `onChange()` lets the gateway stream live `data-process-update` frames
 *     and persist a snapshot into the session so the list survives restarts.
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
  finalResult?: { exitCode: number; stdout: string; stderr: string; killed: boolean }
  /**
   * True for entries restored from a persisted snapshot after a runtime
   * restart. The OS child belonged to the dead gateway and cannot be
   * re-attached, so the entry is read-only (not pollable, only dismissable).
   */
  stale?: boolean
}

/** Live view of a still-running (or stale) background command. */
export interface RunningProcess {
  runId: string
  command: string
  pid: number | undefined
  sandboxed: boolean
  containerName?: string
  startedAt: number
  elapsedMs: number
  /** True if restored from a snapshot after a restart (state unknown). */
  stale?: boolean
}

/** Serializable subset persisted into session metadata so the list survives restart. */
export interface RunningProcessSnapshot {
  runId: string
  command: string
  pid: number | undefined
  sandboxed: boolean
  containerName?: string
  startedAt: number
}

type ChangeListener = (running: RunningProcess[]) => void

export class CommandRegistry {
  private entries = new Map<string, CommandEntry>()
  private listeners = new Set<ChangeListener>()

  /** Register a freshly spawned handle and return its run id. */
  register(command: string, handle: CommandHandle): CommandEntry {
    const runId = `cmd_${randomBytes(4).toString('hex')}`
    const entry: CommandEntry = { runId, command, handle }
    this.entries.set(runId, entry)

    handle.done.then((result) => {
      entry.finishedAt = Date.now()
      entry.finalResult = result
      this.emitChange()
      const cleanupTimer = setTimeout(() => {
        this.entries.delete(runId)
      }, COMPLETED_RETENTION_MS)
      cleanupTimer.unref?.()
    }).catch(() => {
      entry.finishedAt = Date.now()
      this.emitChange()
    })

    this.emitChange()
    return entry
  }

  get(runId: string): CommandEntry | undefined {
    return this.entries.get(runId)
  }

  /** Number of entries (running + recently finished). For tests/diagnostics. */
  size(): number {
    return this.entries.size
  }

  /**
   * Subscribe to running-list changes (a command starts, exits, is killed, or
   * stale entries are restored). Returns an unsubscribe function.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return
    const running = this.listRunning()
    for (const listener of this.listeners) {
      // A listener throwing must never corrupt registry bookkeeping.
      try { listener(running) } catch { /* ignore */ }
    }
  }

  /** Currently-running (or stale) commands. Finished entries are excluded. */
  listRunning(): RunningProcess[] {
    const now = Date.now()
    const out: RunningProcess[] = []
    for (const entry of this.entries.values()) {
      const isRunning = entry.stale || !entry.handle.exited()
      if (!isRunning) continue
      out.push({
        runId: entry.runId,
        command: entry.command,
        pid: entry.handle.pid,
        sandboxed: entry.handle.sandboxed,
        containerName: entry.handle.containerName,
        startedAt: entry.handle.startedAt,
        elapsedMs: now - entry.handle.startedAt,
        stale: entry.stale || undefined,
      })
    }
    return out
  }

  /** Serializable snapshot of the running list for persistence. */
  snapshot(): RunningProcessSnapshot[] {
    return this.listRunning().map((p) => ({
      runId: p.runId,
      command: p.command,
      pid: p.pid,
      sandboxed: p.sandboxed,
      containerName: p.containerName,
      startedAt: p.startedAt,
    }))
  }

  /**
   * Re-seed the registry from a persisted snapshot after a runtime restart.
   * The OS child that backed each run belonged to the dead gateway and cannot
   * be re-attached, so entries are flagged `stale` and carry a synthetic
   * already-exited handle. They show up in `listRunning` until dismissed.
   */
  restoreStale(snapshots: RunningProcessSnapshot[]): void {
    if (!snapshots?.length) return
    let changed = false
    for (const snap of snapshots) {
      if (!snap?.runId || this.entries.has(snap.runId)) continue
      this.entries.set(snap.runId, {
        runId: snap.runId,
        command: snap.command,
        handle: makeStaleHandle(snap),
        stale: true,
      })
      changed = true
    }
    if (changed) this.emitChange()
  }

  /**
   * Kill a running command, or dismiss a stale placeholder. Returns true if an
   * entry with `runId` existed.
   */
  kill(runId: string): boolean {
    const entry = this.entries.get(runId)
    if (!entry) return false
    if (entry.stale) {
      // The child is gone (restart); just drop the placeholder.
      this.entries.delete(runId)
      this.emitChange()
      return true
    }
    if (!entry.handle.exited()) {
      try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
    }
    return true
  }

  /** Forcefully terminate every still-running command. Used on session shutdown. */
  killAll(): void {
    for (const entry of this.entries.values()) {
      if (!entry.stale && !entry.handle.exited()) {
        try { entry.handle.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    this.entries.clear()
    this.emitChange()
  }
}

/** Build a synthetic, already-exited handle for a restored (stale) entry. */
function makeStaleHandle(snap: RunningProcessSnapshot): CommandHandle {
  return {
    pid: snap.pid,
    containerName: snap.containerName,
    sandboxed: snap.sandboxed,
    stdout: () => '',
    stderr: () => '',
    done: Promise.resolve({ exitCode: -1, stdout: '', stderr: '', killed: false }),
    kill: () => { /* stale: the OS child is gone, nothing to signal */ },
    exited: () => true,
    startedAt: snap.startedAt,
  }
}
