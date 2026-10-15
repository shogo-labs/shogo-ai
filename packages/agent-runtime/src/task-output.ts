// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-task output files.
 *
 * Every background task (shell command, subagent, remote task) streams its
 * output into `.shogo/tasks/{session}/{task_id}.log` so the agent can
 * `read_file` / `search` it later instead of re-running the work. The format
 * is the same for every source:
 *
 *   ---
 *   task_id: t_1a2b3c4d
 *   source: shell
 *   title: bun test
 *   started_at: 2026-10-15T10:00:00.000Z
 *   ---
 *   ...streamed output...
 *   ---
 *   status: failed
 *   exit_code: 1
 *   elapsed_ms: 4210
 *   ---
 *
 * Files are capped: past `maxBytes` the middle is dropped and only the tail
 * is kept, written out when the task finishes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'

export const DEFAULT_TASK_OUTPUT_MAX_BYTES = 10 * 1024 * 1024
const TAIL_KEEP_BYTES = 1024 * 1024
const FLUSH_INTERVAL_MS = 200
const FLUSH_THRESHOLD_BYTES = 64 * 1024
/** Finished task logs older than this are removed by `cleanupTaskOutputs`. */
export const TASK_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000

export interface TaskOutputHeader {
  taskId: string
  source: string
  title: string
  startedAt: number
  extra?: Record<string, string | number | undefined>
}

export interface TaskOutputFooter {
  status: string
  exitCode?: number
  elapsedMs: number
}

function headerBlock(header: TaskOutputHeader): string {
  const lines = [
    '---',
    `task_id: ${header.taskId}`,
    `source: ${header.source}`,
    `title: ${oneLine(header.title)}`,
  ]
  for (const [key, value] of Object.entries(header.extra ?? {})) {
    if (value === undefined || value === '') continue
    lines.push(`${key}: ${oneLine(String(value))}`)
  }
  lines.push(`started_at: ${new Date(header.startedAt).toISOString()}`, '---', '')
  return lines.join('\n')
}

function footerBlock(footer: TaskOutputFooter): string {
  const lines = ['', '---', `status: ${footer.status}`]
  if (footer.exitCode !== undefined) lines.push(`exit_code: ${footer.exitCode}`)
  lines.push(`elapsed_ms: ${footer.elapsedMs}`, `finished_at: ${new Date().toISOString()}`, '---', '')
  return lines.join('\n')
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').slice(0, 500)
}

export class TaskOutputWriter {
  readonly path: string
  private pending = ''
  private written = 0
  private droppedBytes = 0
  private tail = ''
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private finished = false
  private failed = false

  constructor(
    path: string,
    header: TaskOutputHeader,
    private readonly maxBytes: number = DEFAULT_TASK_OUTPUT_MAX_BYTES,
  ) {
    this.path = path
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, headerBlock(header))
    } catch {
      // Output files are best-effort: a read-only or missing workspace must
      // never break the task itself.
      this.failed = true
    }
  }

  append(chunk: string): void {
    if (!chunk || this.finished || this.failed) return
    if (this.written + this.pending.length + chunk.length > this.maxBytes) {
      const room = Math.max(0, this.maxBytes - this.written - this.pending.length)
      if (room > 0) {
        this.pending += chunk.slice(0, room)
        chunk = chunk.slice(room)
      }
      this.droppedBytes += chunk.length
      this.tail = (this.tail + chunk).slice(-TAIL_KEEP_BYTES)
      this.flush()
      return
    }
    this.pending += chunk
    if (this.pending.length >= FLUSH_THRESHOLD_BYTES) {
      this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
      ;(this.flushTimer as any)?.unref?.()
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.pending || this.failed) return
    try {
      appendFileSync(this.path, this.pending)
      this.written += this.pending.length
    } catch {
      this.failed = true
    }
    this.pending = ''
  }

  finish(footer: TaskOutputFooter): void {
    if (this.finished) return
    this.flush()
    this.finished = true
    if (this.failed) return
    try {
      if (this.droppedBytes > 0) {
        const keptTail = this.tail
        const truncated = this.droppedBytes - keptTail.length
        appendFileSync(
          this.path,
          `\n\n... [${truncated > 0 ? truncated : 0} bytes truncated] ...\n\n${keptTail}`,
        )
      }
      appendFileSync(this.path, footerBlock(footer))
    } catch {
      /* best-effort */
    }
  }

  isFinished(): boolean {
    return this.finished
  }
}

/** Read an output file, or '' if it does not exist. */
export function readTaskOutput(path: string | undefined): string {
  if (!path) return ''
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Last `maxLines` lines of `text`, capped to `maxChars`. */
export function tailLines(text: string, maxLines = 40, maxChars = 4000): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  const tail = lines.slice(-maxLines).join('\n')
  return tail.length > maxChars ? tail.slice(-maxChars) : tail
}

/** Delete task logs (and empty session dirs) older than `maxAgeMs` under `rootDir`. */
export function cleanupTaskOutputs(rootDir: string, maxAgeMs: number = TASK_OUTPUT_RETENTION_MS): number {
  if (!existsSync(rootDir)) return 0
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  const sweep = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          sweep(full)
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
        } else if (name.endsWith('.log') && st.mtimeMs < cutoff) {
          rmSync(full, { force: true })
          removed++
        }
      } catch {
        /* raced with another cleanup */
      }
    }
  }
  sweep(rootDir)
  return removed
}

/** Directory for one session's task logs. */
export function taskOutputDir(workspaceDir: string, sessionId: string): string {
  return join(taskOutputRoot(workspaceDir), sessionId.replace(/[^A-Za-z0-9._-]/g, '_'))
}

export function taskOutputRoot(workspaceDir: string): string {
  return join(workspaceDir, '.shogo', 'tasks')
}
