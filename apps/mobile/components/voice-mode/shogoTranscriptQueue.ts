// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * shogoTranscriptQueue — in-memory pending-write queue for Shogo Mode
 * voice transcript persistence.
 *
 * The original implementation called `POST /api/voice/transcript/:id`
 * fire-and-forget for every turn, logging any failure to `console.warn`
 * and dropping the row on the floor. That silently lost conversations
 * whenever the network flapped, auth briefly expired, the tab was
 * hidden, or the user refreshed mid-turn.
 *
 * This module replaces that with a serial worker:
 *
 *   1. Every turn is `enqueue`d as a `TranscriptTask` keyed by a stable
 *      client id (same id the server upserts by — retries are safe).
 *   2. A single draining worker POSTs tasks in order. On HTTP failure:
 *        - 4xx (except 408 + 429)  → permanent; drop + surface via
 *                                    `onTaskDropped`.
 *        - 5xx / 408 / 429 / network / abort → transient; keep the task
 *                                    at the head of the queue, back off
 *                                    exponentially (1s → 2s → 4s, cap
 *                                    30s) and retry forever.
 *   3. Every state transition fires `onStateChange`, so the UI can show
 *      a "Syncing…" / "Retrying…" banner instead of silently dropping
 *      data.
 *   4. `flushBeacon()` fires `navigator.sendBeacon` for every pending
 *      task. Callers invoke it from `pagehide` / `beforeunload` so a
 *      mid-turn refresh still lands the remaining writes best-effort.
 *
 * The queue is chatSession-agnostic — every task carries its own
 * `chatSessionId`. That keeps the worker stable across session
 * changes and lets the consumer re-enqueue tasks from a previous
 * session (e.g. when the SDK's session-end transcript fires for a
 * session that just ended).
 */

export type TranscriptKind = 'voice-user' | 'voice-agent' | 'agent-activity'

export interface TranscriptTask {
  chatSessionId: string
  kind: TranscriptKind
  text: string
  /**
   * Stable client id. The server upserts by this id, so resubmitting the
   * same task is safe (both after retry and after session-end replay).
   */
  id: string
  /** Epoch ms — pinned to when the event actually happened, not the POST time. */
  ts: number
}

export interface TranscriptQueueState {
  /** Tasks still waiting to land, including whatever is currently in flight. */
  pendingCount: number
  /** `true` while an HTTP POST is currently outstanding. */
  inFlight: boolean
  /** `true` while the worker is sleeping between retry attempts. */
  backoffActive: boolean
  /**
   * Most-recent transient failure reason. Cleared on the next successful
   * send so the UI only nags while there's something still wrong.
   */
  lastError: string | null
}

export interface TranscriptQueueOptions {
  /** Base URL for the API (typically `API_URL` from `apps/mobile/lib/api`). */
  apiUrl: string
  /** `credentials` mode for the fetch call. Default `'include'`. */
  credentials?: RequestCredentials
  /** Called after every state transition. */
  onStateChange?: (state: TranscriptQueueState) => void
  /** Fired once per task that successfully lands. */
  onTaskPersisted?: (task: TranscriptTask) => void
  /**
   * Fired once per task that is permanently dropped (validation / authz
   * failure that retrying won't fix). The consumer typically surfaces
   * this as a visible error — the transcript row is GONE from server
   * storage's perspective until the user retries.
   */
  onTaskDropped?: (task: TranscriptTask, reason: string) => void
  /** Optional verbose logger. Called on every enqueue / POST / failure. */
  debug?: (msg: string, data?: unknown) => void
}

export class ShogoTranscriptQueue {
  private tasks: TranscriptTask[] = []
  /** Dedupe: enqueueing the same id twice is a no-op until it finishes/drops. */
  private known = new Set<string>()
  private working = false
  private inFlight = false
  private backoffMs = 0
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private lastError: string | null = null
  private disposed = false

  constructor(private readonly opts: TranscriptQueueOptions) {}

  /**
   * Add a task to the queue. Idempotent on `task.id` (a re-enqueue of
   * the same id is dropped — the server upsert covers the rewind case
   * if the original ever fails permanently).
   */
  enqueue(task: TranscriptTask): void {
    if (this.disposed) return
    if (this.known.has(task.id)) {
      this.opts.debug?.('[shogoQueue] enqueue skipped — duplicate id', {
        id: task.id,
      })
      return
    }
    this.known.add(task.id)
    this.tasks.push(task)
    this.opts.debug?.('[shogoQueue] enqueue', {
      id: task.id,
      kind: task.kind,
      chatSessionId: task.chatSessionId,
      pending: this.tasks.length,
    })
    this.emitState()
    void this.drain()
  }

  /** Current pending snapshot — use this to render the banner. */
  getState(): TranscriptQueueState {
    return {
      pendingCount: this.tasks.length,
      inFlight: this.inFlight,
      backoffActive: this.backoffMs > 0,
      lastError: this.lastError,
    }
  }

  /**
   * Best-effort flush of every remaining task using `navigator.sendBeacon`.
   * Returns the number of tasks flushed. After calling, the queue is
   * empty — beacon delivery is assumed (it's the browser's job to honor
   * it best-effort during unload).
   *
   * Safe to call on non-web platforms; it no-ops when `navigator` or
   * `sendBeacon` is unavailable.
   */
  flushBeacon(): number {
    if (this.disposed) return 0
    if (
      typeof navigator === 'undefined' ||
      typeof (navigator as Navigator).sendBeacon !== 'function'
    ) {
      return 0
    }
    const count = this.tasks.length
    if (count === 0) return 0
    for (const task of this.tasks) {
      try {
        const url = `${this.opts.apiUrl}/api/voice/transcript/${encodeURIComponent(task.chatSessionId)}`
        // sendBeacon with a typed Blob usually preserves the content-type,
        // but some browsers strip it to "text/plain". The server is
        // tolerant of both, so we set the right type here and rely on
        // the server to accept either on the receiving side.
        const blob = new Blob(
          [
            JSON.stringify({
              kind: task.kind,
              text: task.text,
              id: task.id,
              ts: task.ts,
            }),
          ],
          { type: 'application/json' },
        )
        navigator.sendBeacon(url, blob)
      } catch {
        // Beacons are best-effort by definition.
      }
    }
    this.opts.debug?.('[shogoQueue] flushBeacon', { count })
    this.tasks = []
    this.known.clear()
    this.emitState()
    return count
  }

  /** Cancel any pending retry and clear internal state. */
  dispose(): void {
    this.disposed = true
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
    this.tasks = []
    this.known.clear()
    this.working = false
    this.inFlight = false
    this.backoffMs = 0
    this.lastError = null
  }

  // -----------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------

  private emitState() {
    if (this.disposed) return
    try {
      this.opts.onStateChange?.(this.getState())
    } catch (err) {
      this.opts.debug?.('[shogoQueue] onStateChange threw', { err })
    }
  }

  private async drain() {
    if (this.working || this.disposed) return
    this.working = true

    try {
      while (this.tasks.length > 0 && !this.disposed) {
        const task = this.tasks[0]
        this.inFlight = true
        this.emitState()

        const result = await this.postOnce(task)
        this.inFlight = false

        if (this.disposed) return

        if (result.ok) {
          this.tasks.shift()
          this.backoffMs = 0
          this.lastError = null
          this.emitState()
          try {
            this.opts.onTaskPersisted?.(task)
          } catch (err) {
            this.opts.debug?.('[shogoQueue] onTaskPersisted threw', { err })
          }
          continue
        }

        if (result.drop) {
          this.tasks.shift()
          this.known.delete(task.id)
          this.lastError = result.reason
          this.emitState()
          try {
            this.opts.onTaskDropped?.(task, result.reason)
          } catch (err) {
            this.opts.debug?.('[shogoQueue] onTaskDropped threw', { err })
          }
          continue
        }

        // Transient — back off and retry the same task.
        this.lastError = result.reason
        this.backoffMs = this.nextBackoff()
        this.emitState()
        await this.wait(this.backoffMs)
      }
    } finally {
      this.working = false
      this.inFlight = false
      this.emitState()
    }
  }

  private nextBackoff(): number {
    if (this.backoffMs === 0) return 1000
    return Math.min(this.backoffMs * 2, 30_000)
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null
        resolve()
      }, ms)
    })
  }

  private async postOnce(
    task: TranscriptTask,
  ): Promise<{ ok: true } | { ok: false; drop: boolean; reason: string }> {
    const url = `${this.opts.apiUrl}/api/voice/transcript/${encodeURIComponent(task.chatSessionId)}`
    try {
      this.opts.debug?.('[shogoQueue] POST', { id: task.id, url })
      const res = await fetch(url, {
        method: 'POST',
        credentials: this.opts.credentials ?? 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: task.kind,
          text: task.text,
          id: task.id,
          ts: task.ts,
        }),
      })
      if (res.ok) {
        this.opts.debug?.('[shogoQueue] POST ok', {
          id: task.id,
          status: res.status,
        })
        return { ok: true }
      }
      // Hono validation errors + 401/403/404 → permanent.
      // 408 + 429 + 5xx → retry.
      const permanent =
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408 &&
        res.status !== 429
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        // no-op
      }
      this.opts.debug?.('[shogoQueue] POST failed', {
        id: task.id,
        status: res.status,
        permanent,
        detail,
      })
      return {
        ok: false,
        drop: permanent,
        reason: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      }
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'network error'
      this.opts.debug?.('[shogoQueue] POST threw', { id: task.id, reason })
      return { ok: false, drop: false, reason }
    }
  }
}
