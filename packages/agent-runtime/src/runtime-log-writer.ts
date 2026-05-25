// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Async, batched writer for runtime log files.
 *
 * Replaces the per-line `mkdirSync` + `appendFileSync` pattern that was
 * previously hit on every `emitBuildLine()` / `appendRuntimeConsoleLogLine()`
 * call. On Windows + Defender each of those sync ops costs 5–30 ms (defender
 * scans the file open and the write), and during a vite-watch initial build
 * the agent-runtime would emit thousands of stdout/stderr lines back-to-back.
 * The cumulative sync I/O saturated the event loop and made the runtime's
 * own `/health` endpoint unreachable for tens of seconds — see the
 * 2026-05 Windows cold-boot investigation.
 *
 * Design:
 *
 *   - One queue + one open file handle PER path.
 *   - First write to a path lazily `mkdirSync`s its parent (once) and
 *     `appendFileSync`s a header; that's the only sync call.
 *   - Subsequent writes append to an in-memory buffer and trigger a flush
 *     via `setImmediate` (which yields to the event loop, unlike sync I/O).
 *   - The flush concatenates everything queued for that path and runs one
 *     async `appendFile`. While the async write is in-flight, new writes
 *     keep batching into a fresh buffer.
 *
 * Failure semantics match the previous synchronous code: on disk failures
 * we swallow the error and let the in-memory dispatcher keep working. The
 * SSE/Output tab path goes through `runtime-log-dispatcher` and is
 * unaffected by this file's behaviour.
 *
 * Why not `fs.createWriteStream`? Two reasons:
 *
 *   1. The stream keeps the underlying fd open which on Windows holds an
 *      AV-friendly lock; if a user deletes `.shogo/logs/build.log` between
 *      writes the stream errors and subsequent appends silently drop.
 *      `appendFile` reopens fresh each batch — slightly more work but
 *      survives external deletion.
 *   2. We don't want backpressure on the stdout-handler caller. If disk
 *      is slow we'd rather drop the on-disk log than block the JS that
 *      forwards vite output into the in-memory ring.
 */

import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface PathState {
  /** Lines waiting to be written on next flush. */
  buffer: string
  /** Last known mkdir attempt completed (only once per path). */
  dirReady: boolean
  /** True while an `appendFile` is in-flight; new writes batch onto the next flush. */
  writing: boolean
  /** True if a flush is already scheduled (via setImmediate). */
  flushScheduled: boolean
}

const state = new Map<string, PathState>()

function getOrCreate(path: string): PathState {
  let s = state.get(path)
  if (!s) {
    s = { buffer: '', dirReady: false, writing: false, flushScheduled: false }
    state.set(path, s)
  }
  return s
}

function ensureDirOnce(path: string, s: PathState): void {
  if (s.dirReady) return
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // mkdir failures are typically permission issues — the subsequent
    // `appendFile` will surface a more useful error.
  }
  s.dirReady = true
}

function scheduleFlush(path: string, s: PathState): void {
  if (s.flushScheduled || s.writing) return
  s.flushScheduled = true
  // `setImmediate` yields to the event loop between batches — critical
  // for keeping /health responsive when log volume is high.
  setImmediate(() => {
    s.flushScheduled = false
    void flush(path, s)
  })
}

async function flush(path: string, s: PathState): Promise<void> {
  if (s.writing || s.buffer.length === 0) return
  s.writing = true
  ensureDirOnce(path, s)
  const data = s.buffer
  s.buffer = ''
  try {
    await appendFile(path, data, 'utf-8')
  } catch {
    // Best-effort: in-memory ring + SSE still see every line via
    // `runtime-log-dispatcher`, so a write failure is not user-visible.
  } finally {
    s.writing = false
    // Anything that arrived while we were writing gets a fresh flush.
    if (s.buffer.length > 0) scheduleFlush(path, s)
  }
}

/**
 * Queue a line for async append to `path`. Returns immediately (no `await`
 * needed); the actual disk write happens on the next event-loop tick.
 *
 * The 4 KiB cap below mirrors the size of a typical NTFS write batch and
 * also protects against unbounded memory growth if disk is offline for a
 * long time. Once exceeded we drop the oldest half — the in-memory
 * dispatcher still holds the canonical buffer for the UI.
 */
export function scheduleLogWrite(path: string, line: string): void {
  if (!path || !line) return
  const s = getOrCreate(path)
  if (s.buffer.length > 4 * 1024 * 1024) {
    s.buffer = s.buffer.slice(s.buffer.length / 2)
  }
  s.buffer += line
  scheduleFlush(path, s)
}

/**
 * Block until all queued writes for `path` (or all paths if undefined) have
 * been flushed to disk. Used by graceful-shutdown so we don't lose the
 * last few lines on SIGTERM.
 */
export async function flushAllLogWrites(path?: string): Promise<void> {
  const paths = path ? [path] : Array.from(state.keys())
  for (const p of paths) {
    const s = state.get(p)
    if (!s) continue
    // Drain in a loop because new writes can arrive while we await flush.
    while (s.buffer.length > 0 || s.writing) {
      if (!s.writing) await flush(p, s)
      else await new Promise<void>((r) => setImmediate(r))
    }
  }
}

/** Test-only — clears in-memory state. */
export function __resetLogWriterForTest(): void {
  state.clear()
}
