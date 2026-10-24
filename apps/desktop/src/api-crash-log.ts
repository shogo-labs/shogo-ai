// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-60: the desktop app's API supervisor only ever logged to `console.log`,
 * which is the app's stdout — nothing survives the process, so a bug report
 * could not carry `API server exited: code=null, signal=SIGKILL` or the stderr
 * that came with it.
 *
 * This module keeps a small append-only JSONL file of supervisor events and a
 * ring buffer of the child's last stderr lines, so the events that matter
 * (spawn / exit / restart attempt / gave up / a wedged API we had to kill) can
 * be read back after the fact, and the banner's "Open log" button has
 * something to open.
 *
 * Deliberately free of the `electron` import (the default path is resolved
 * lazily) so the ring buffer and rotation can be unit-tested in a pod.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Rotate `api-supervisor.log` to `.1` once it would exceed this. */
export const API_CRASH_LOG_MAX_BYTES = 1_000_000

/** How many trailing stderr lines travel with an exit/give-up entry. */
export const API_STDERR_TAIL_LINES = 100

export type ApiSupervisorEvent =
  | 'spawn'
  | 'exit'
  | 'restart_attempt'
  | 'restarted'
  | 'gave_up'
  | 'health_watchdog_tripped'
  | 'manual_restart'

export interface ApiCrashLogOptions {
  /** Absolute path of the JSONL file. */
  filePath: string
  maxBytes?: number
  maxStderrLines?: number
  now?: () => Date
}

export interface ApiCrashLogEntry {
  ts: string
  event: ApiSupervisorEvent
  [key: string]: unknown
}

export class ApiCrashLog {
  private readonly filePath: string
  private readonly maxBytes: number
  private readonly maxStderrLines: number
  private readonly now: () => Date
  private stderrLines: string[] = []

  constructor(options: ApiCrashLogOptions) {
    this.filePath = options.filePath
    this.maxBytes = options.maxBytes ?? API_CRASH_LOG_MAX_BYTES
    this.maxStderrLines = options.maxStderrLines ?? API_STDERR_TAIL_LINES
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Append one event. Logging must never be the reason the supervisor throws,
   * so every fs error is swallowed: a lost log line is better than a dead app.
   */
  append(event: ApiSupervisorEvent, data: Record<string, unknown> = {}): void {
    const entry: ApiCrashLogEntry = { ts: this.now().toISOString(), event, ...data }
    const line = `${JSON.stringify(entry)}\n`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      this.rotateIfNeeded(Buffer.byteLength(line))
      appendFileSync(this.filePath, line)
    } catch {
      // Best effort — see above.
    }
  }

  /**
   * Keep a bounded tail of the child's stderr. Chunks arrive on arbitrary byte
   * boundaries, so they are split into lines and blank lines dropped before
   * they land in the buffer.
   */
  appendStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      this.stderrLines.push(trimmed)
    }
    const overflow = this.stderrLines.length - this.maxStderrLines
    if (overflow > 0) this.stderrLines.splice(0, overflow)
  }

  stderrTail(limit?: number): string[] {
    const count = limit ?? this.maxStderrLines
    return count >= this.stderrLines.length
      ? [...this.stderrLines]
      : this.stderrLines.slice(-count)
  }

  clearStderr(): void {
    this.stderrLines = []
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0
    try {
      size = statSync(this.filePath).size
    } catch {
      // No file yet: nothing to rotate.
      return
    }
    if (size + incomingBytes <= this.maxBytes) return
    try {
      // One generation is enough for a bug report; the previous run's tail
      // lives on as `.1` instead of growing the live file without bound.
      renameSync(this.filePath, `${this.filePath}.1`)
    } catch {
      // A locked file (Windows) just means we keep appending to the old one.
    }
  }
}

// --- Process-wide instance used by local-server.ts ---

let defaultLog: ApiCrashLog | null = null
let defaultLogResolved = false

/**
 * `app.getPath('userData')` needs Electron, which the unit tests do not have.
 * Resolve it once, lazily, and fall back to `null` (events become console-only)
 * when there is no Electron around.
 */
function getDefaultApiCrashLog(): ApiCrashLog | null {
  if (defaultLogResolved) return defaultLog
  defaultLogResolved = true
  try {
    defaultLog = new ApiCrashLog({ filePath: getApiCrashLogPath() })
  } catch {
    defaultLog = null
  }
  return defaultLog
}

/** Absolute path of the supervisor log. Throws when there is no Electron. */
export function getApiCrashLogPath(): string {
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'logs', 'api-supervisor.log')
}

export function appendApiCrashLog(
  event: ApiSupervisorEvent,
  data: Record<string, unknown> = {},
): void {
  getDefaultApiCrashLog()?.append(event, data)
}

export function appendApiStderr(chunk: string): void {
  getDefaultApiCrashLog()?.appendStderr(chunk)
}

export function apiStderrTail(): string[] {
  return getDefaultApiCrashLog()?.stderrTail() ?? []
}
