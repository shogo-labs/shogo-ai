// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A durable ledger of the detached process groups a runtime started, so
 * whoever outlives the runtime can reap them (SHO-144).
 *
 * Every exec shell and the preview API sidecar are spawned `detached: true` on
 * POSIX (SHO-26 for execs, `killApiServer` for the sidecar), which makes each
 * one its own process-group leader. That is what keeps `kill -9 -<pgid>` from
 * an agent shell off the runtime — and it is also why `killProcessGroup(runtime)`
 * can never reach them: they are outside the runtime's group. A graceful
 * `stop()` sweeps them via `killAll`/`PreviewManager.stop()`, but a SIGKILL,
 * a jetsam kill or a crash leaves them orphaned to launchd/init.
 *
 * The vite-watch pidfile solved this for exactly one process. This is the same
 * idea generalised: `<workspaceDir>/.shogo/run/children.json` lists every group
 * we started, and a reaper (`shogo-worker`'s runtime manager, apps/api's boot
 * sweep) kills each entry whose command line still matches what we recorded.
 * The command-line check is what makes a reused PID safe — it is the same guard
 * `killViteWatchFromPidfile` uses.
 *
 * Entries are advisory: a stale one is dropped, never signalled.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as childProcess from './child-process'
import { dirname, join } from 'node:path'

const LEDGER_NAME = join('.shogo', 'run', 'children.json')

/** How much of the leader's command line is kept as its identity. */
const FINGERPRINT_MAX = 160

/** A lock older than this was left behind by a process that died holding it. */
const LOCK_STALE_MS = 5_000
/** ~100 ms of contention at most, then we write unlocked rather than block. */
const LOCK_ATTEMPTS = 20
const LOCK_RETRY_MS = 5

export interface ChildLedgerEntry {
  /** Process-group id of the group the child leads (`pid` on POSIX). */
  pgid: number
  /** The group leader's pid. */
  pid: number
  /** Who started it — `exec`, `api-sidecar`, `vite-watch`. */
  label: string
  /**
   * A normalized fragment of the leader's command line, captured when the
   * entry was written. Empty when it could not be read; such an entry is
   * only reaped while its pid is still alive *and* `pid === pgid`.
   */
  commandFingerprint: string
  startedAt: number
}

export interface ChildLedgerOptions {
  logger?: Pick<Console, 'warn' | 'log'>
}

export function childLedgerPath(workspaceDir: string): string {
  return join(workspaceDir, LEDGER_NAME)
}

function isEntry(value: unknown): value is ChildLedgerEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ChildLedgerEntry>
  return (
    Number.isInteger(entry.pgid) && (entry.pgid as number) > 0 &&
    Number.isInteger(entry.pid) && (entry.pid as number) > 0 &&
    typeof entry.label === 'string' &&
    typeof entry.commandFingerprint === 'string' &&
    typeof entry.startedAt === 'number'
  )
}

/**
 * Read the ledger. A malformed file is treated as empty — the entries in it are
 * advisory, and a half-written file must never block the next spawn.
 */
export function readChildLedger(workspaceDir: string): ChildLedgerEntry[] {
  const path = childLedgerPath(workspaceDir)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { children?: unknown })?.children
    if (!Array.isArray(entries)) return []
    return entries.filter(isEntry)
  } catch {
    return []
  }
}

function writeAll(workspaceDir: string, entries: ChildLedgerEntry[]): void {
  const path = childLedgerPath(workspaceDir)
  try {
    if (entries.length === 0) {
      // An empty ledger is no ledger: leaving `[]` behind would show up as an
      // untracked file in the workspace's git status (SHO-139 AC 4).
      rmSync(path, { force: true })
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename so a concurrent reader never sees a partial file.
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entries) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch {
    // A ledger we cannot write only costs us the reap of this one group.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // No shared memory in this runtime: skip the back-off, keep the retry.
  }
}

/**
 * Run a read-modify-write of the ledger under a cross-process lock.
 *
 * The ledger is shared: the runtime appends an entry per spawn while the worker
 * sweeps it on start and stop, and an unlocked overwrite from either side loses
 * the other's entry — a group nobody then reaps. A lock we cannot take within
 * ~100 ms degrades to the previous unlocked behaviour rather than blocking a
 * spawn, because a lost entry is cheaper than a stalled runtime.
 */
function withLedgerLock<T>(workspaceDir: string, fn: () => T): T {
  const lockPath = `${childLedgerPath(workspaceDir)}.lock`
  let fd: number | null = null
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch {
    // A directory we cannot make is a ledger we cannot write either.
  }
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err: any) {
      if (err?.code !== 'EEXIST') break
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          // Whoever held it is gone; take it over on the next attempt.
          rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        // Released between the open and the stat — retry immediately.
        continue
      }
      sleepSync(LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* nothing to close */ }
      try { rmSync(lockPath, { force: true }) } catch { /* already released */ }
    }
  }
}

/** Record a group we just started. Replaces any entry for the same pid. */
export function addChildLedgerEntry(workspaceDir: string, entry: ChildLedgerEntry): void {
  withLedgerLock(workspaceDir, () => {
    const existing = readChildLedger(workspaceDir).filter(
      (candidate) => candidate.pid !== entry.pid && candidate.pgid !== entry.pgid && isAlive(candidate.pid),
    )
    writeAll(workspaceDir, [...existing, entry])
  })
}

/** Drop the entry for `pid` after a clean exit. */
export function removeChildLedgerEntry(workspaceDir: string, pid: number): void {
  withLedgerLock(workspaceDir, () => {
    const entries = readChildLedger(workspaceDir)
    if (entries.length === 0) return
    const kept = entries.filter((entry) => entry.pid !== pid)
    if (kept.length === entries.length) return
    writeAll(workspaceDir, kept)
  })
}

/** Collapse a command line to a stable, comparable fragment. */
export function commandFingerprint(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim()
  return normalized.length > FINGERPRINT_MAX ? normalized.slice(0, FINGERPRINT_MAX) : normalized
}

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * True when a live process's command line is still the one we recorded for
 * this entry.
 *
 * One direction only: the *live* line must contain the recorded fingerprint.
 * The reverse comparison is what a recycled pid slips through — a reused pid now
 * running `sh`, `bash`, `bun` or `node` is a substring of a recorded
 * `/bin/sh -c bun run dev …`, so accepting it would SIGKILL an unrelated group
 * (Planner review, SHO-144 AC 5). A live line that arrives shorter than the
 * fingerprint (a `ps` that truncated) is therefore not a match: the entry is
 * dropped, which is the safe direction because a dropped entry is never
 * signalled.
 */
export function matchesFingerprint(currentCommand: string | null, entry: ChildLedgerEntry): boolean {
  if (!currentCommand) return false
  const current = normalizeCommand(currentCommand)
  if (current.length === 0) return false
  const fingerprint = normalizeCommand(entry.commandFingerprint)
  // No fingerprint captured: fall back to the group-leader invariant, which
  // still cannot hit an unrelated process unless it reused the exact pid as a
  // group leader — and we never signal that case anyway.
  if (!fingerprint) return false
  return current.includes(fingerprint)
}

export interface ReapChildLedgerOptions {
  /** Current command line of `pid`, or `null` when it no longer exists. */
  readProcessCommand?: (pid: number) => string | null
  /** Kill a recorded group. Defaults to `kill(-pgid, SIGKILL)` then the pid. */
  killGroup?: (entry: ChildLedgerEntry) => void
  logger?: Pick<Console, 'warn' | 'log'>
}

export interface ReapChildLedgerResult {
  /** Entries whose tree was signalled. */
  reaped: ChildLedgerEntry[]
  /** Entries dropped because their process is gone or their pid was reused. */
  dropped: ChildLedgerEntry[]
}

function defaultReadProcessCommand(pid: number): string | null {
  try {
    const out = childProcess.execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const command = String(out).trim()
    return command.length > 0 ? command : null
  } catch {
    return null
  }
}

function defaultKillGroup(entry: ChildLedgerEntry): void {
  try {
    process.kill(-entry.pgid, 'SIGKILL')
  } catch {
    // ESRCH — the group already collapsed. The leader may still be there if it
    // left its group (setsid), so try it directly too.
  }
  try {
    process.kill(entry.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Reap every group in `workspaceDir`'s ledger whose command line still matches
 * its recorded fingerprint, and drop the rest.
 *
 * Called by whoever outlives the runtime: `WorkerRuntimeManager.stop()` and
 * `handleExit()`, plus the boot sweeps in apps/api and the worker. Safe to call
 * concurrently — each pass rewrites the ledger with what it did not keep.
 */
export function reapChildLedger(
  workspaceDir: string,
  opts: ReapChildLedgerOptions = {},
): ReapChildLedgerResult {
  const entries = readChildLedger(workspaceDir)
  const result: ReapChildLedgerResult = { reaped: [], dropped: [] }
  if (entries.length === 0) return result

  const readCommand = opts.readProcessCommand ?? defaultReadProcessCommand
  const kill = opts.killGroup ?? defaultKillGroup

  for (const entry of entries) {
    // Our own group is never in the ledger; skip anything that resolved to us.
    if (entry.pgid === process.pid || entry.pid === process.pid) {
      result.dropped.push(entry)
      continue
    }
    if (!isAlive(entry.pid)) {
      result.dropped.push(entry)
      continue
    }
    let command: string | null = null
    try {
      command = readCommand(entry.pid)
    } catch (err: any) {
      opts.logger?.warn(`[child-ledger] could not inspect pid ${entry.pid}: ${err?.message ?? err}`)
      // Unreadable process table: keep the entry for a later pass rather than
      // risk signalling a reused PID.
      continue
    }
    if (!matchesFingerprint(command, entry)) {
      // The pid now belongs to something else. Never signal it (SHO-144 AC 5).
      result.dropped.push(entry)
      continue
    }
    try {
      kill(entry)
      result.reaped.push(entry)
    } catch (err: any) {
      opts.logger?.warn(`[child-ledger] could not kill group ${entry.pgid}: ${err?.message ?? err}`)
      // Not reaped: the entry stays so the next pass tries again. Dropping it
      // here would strand the group with nothing left pointing at it.
    }
  }

  // Only the entries this pass finished are removed; re-reading under the lock
  // keeps a group the runtime recorded while we were killing.
  const handled = new Set([...result.reaped, ...result.dropped].map((entry) => entry.pid))
  if (handled.size > 0) {
    withLedgerLock(workspaceDir, () => {
      const current = readChildLedger(workspaceDir)
      const kept = current.filter((entry) => !handled.has(entry.pid))
      if (kept.length !== current.length) writeAll(workspaceDir, kept)
    })
  }
  return result
}
