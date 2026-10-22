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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as childProcess from './child-process'
import { dirname, join } from 'node:path'

const LEDGER_NAME = join('.shogo', 'run', 'children.json')

/** How much of the leader's command line is kept as its identity. */
const FINGERPRINT_MAX = 160

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
    mkdirSync(dirname(path), { recursive: true })
    if (entries.length === 0) {
      writeFileSync(path, '[]\n', 'utf8')
      return
    }
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

/** Record a group we just started. Replaces any entry for the same pid. */
export function addChildLedgerEntry(workspaceDir: string, entry: ChildLedgerEntry): void {
  const existing = readChildLedger(workspaceDir).filter(
    (candidate) => candidate.pid !== entry.pid && candidate.pgid !== entry.pgid && isAlive(candidate.pid),
  )
  writeAll(workspaceDir, [...existing, entry])
}

/** Drop the entry for `pid` after a clean exit. */
export function removeChildLedgerEntry(workspaceDir: string, pid: number): void {
  const entries = readChildLedger(workspaceDir)
  if (entries.length === 0) return
  const kept = entries.filter((entry) => entry.pid !== pid)
  if (kept.length === entries.length) return
  writeAll(workspaceDir, kept)
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
 * this entry. A truncated fingerprint matches as a prefix-substring, which is
 * how a long `bash -c …` line survives both the capture and the re-read.
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
  return current.includes(fingerprint) || fingerprint.includes(current)
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
  const survivors: ChildLedgerEntry[] = []

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
      survivors.push(entry)
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
    }
  }

  if (result.reaped.length > 0 || result.dropped.length > 0) {
    // Anything left in `survivors` is a group we could not inspect; keep it so
    // the next sweep tries again. A reaped group's entry is gone.
    const remaining = survivors.filter(
      (entry) => !result.reaped.some((reaped) => reaped.pid === entry.pid),
    )
    writeAll(workspaceDir, remaining)
  }
  return result
}
