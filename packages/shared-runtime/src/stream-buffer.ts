// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-memory stream buffer + turn ledger for SSE reconnect support.
 *
 * Stores raw SSE bytes keyed by chatSessionId so that a reconnecting client
 * can replay buffered events and continue receiving live events. Every
 * buffered chunk is tagged with a monotonically increasing `seq` so a client
 * can resume from the last frame it has already seen via `?fromSeq=N` style
 * resume.
 *
 * Each server process (agent-runtime pod, API server) creates its own
 * StreamBufferStore singleton — no shared state between processes. For
 * cross-process durability a higher layer (e.g. a Postgres-backed turn
 * ledger) would wrap this store; this in-memory variant is the hot cache.
 */

const CLEANUP_INTERVAL_MS = 60_000
const MAX_BUFFER_AGE_MS = parseInt(
  (typeof process !== 'undefined' && process.env?.STREAM_BUFFER_MAX_AGE_MS) || String(90 * 60_000),
  10,
)
const COMPLETED_GRACE_MS = parseInt(
  (typeof process !== 'undefined' && process.env?.STREAM_BUFFER_COMPLETED_GRACE_MS) || String(2 * 60_000),
  10,
)

export type TurnStatus = 'active' | 'completed' | 'aborted' | 'failed'

export interface TurnTerminal {
  reason?: string
  error?: string
}

interface BufferedFrame {
  seq: number
  chunk: Uint8Array
}

interface StreamBuffer {
  turnId: string
  frames: BufferedFrame[]
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
  status: TurnStatus
  terminal: TurnTerminal | null
  createdAt: number
  completedAt: number | null
  lastEventAt: number
  /** Next seq number to assign to a new chunk. Monotonic, never reset. */
  nextSeq: number
}

export interface StreamBufferWriter {
  /** Append a raw byte chunk and return the seq assigned to it. */
  append(chunk: Uint8Array): number
  /** Mark the turn as cleanly completed. Optional terminal reason. */
  complete(reason?: string): void
  /**
   * Mark the turn as failed (still keeps the buffer around for the grace
   * window so a reconnecting client can see the terminal state).
   */
  fail(error: string): void
  /** The turnId this writer is bound to. */
  readonly turnId: string
  /** Last seq written so far (0 if nothing has been appended). */
  readonly lastSeq: number
}

export interface ReplayOptions {
  /**
   * Skip frames with seq <= fromSeq. Use 0 (or omit) to replay from the start.
   */
  fromSeq?: number
}

export interface TurnSnapshot {
  turnId: string
  status: TurnStatus
  lastSeq: number
  terminal: TurnTerminal | null
  createdAt: number
  completedAt: number | null
  lastEventAt: number
}

export class StreamBufferStore {
  private buffers = new Map<string, StreamBuffer>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Create (or replace) a buffer for the given key. Any existing active
   * buffer is completed and discarded. Returns a writer bound to this
   * specific buffer instance, including the new `turnId`.
   */
  create(key: string, opts?: { turnId?: string }): StreamBufferWriter {
    const existing = this.buffers.get(key)
    if (existing && existing.status === 'active') {
      this.completeBuffer(existing, 'replaced')
    }
    const now = Date.now()
    const turnId = opts?.turnId || generateTurnId()
    const buf: StreamBuffer = {
      turnId,
      frames: [],
      subscribers: new Set(),
      status: 'active',
      terminal: null,
      createdAt: now,
      completedAt: null,
      lastEventAt: now,
      nextSeq: 1,
    }
    this.buffers.set(key, buf)

    return {
      get turnId() { return buf.turnId },
      get lastSeq() { return buf.nextSeq - 1 },
      append: (chunk: Uint8Array) => {
        if (buf.status !== 'active') return -1
        const seq = buf.nextSeq++
        buf.frames.push({ seq, chunk })
        buf.lastEventAt = Date.now()
        for (const ctrl of buf.subscribers) {
          try {
            ctrl.enqueue(chunk)
          } catch {
            buf.subscribers.delete(ctrl)
          }
        }
        return seq
      },
      complete: (reason?: string) => {
        this.completeBuffer(buf, reason)
      },
      fail: (error: string) => {
        this.failBuffer(buf, error)
      },
    }
  }

  /**
   * Append a chunk by key (loose, untyped writer). Returns the seq assigned,
   * or -1 if the buffer is unknown/inactive.
   */
  append(key: string, chunk: Uint8Array): number {
    const buf = this.buffers.get(key)
    if (!buf || buf.status !== 'active') return -1
    const seq = buf.nextSeq++
    buf.frames.push({ seq, chunk })
    buf.lastEventAt = Date.now()
    for (const ctrl of buf.subscribers) {
      try {
        ctrl.enqueue(chunk)
      } catch {
        buf.subscribers.delete(ctrl)
      }
    }
    return seq
  }

  /** Mark a buffer as completed by key. Optional terminal reason. */
  complete(key: string, reason?: string): void {
    const buf = this.buffers.get(key)
    if (!buf) return
    this.completeBuffer(buf, reason)
  }

  /**
   * Abort a stream: complete subscribers and remove the buffer entirely.
   * Future resume/replay requests for this key will return null (→ 204).
   */
  abort(key: string): void {
    const buf = this.buffers.get(key)
    if (!buf) return
    this.completeBuffer(buf, 'aborted')
    buf.status = 'aborted'
    this.buffers.delete(key)
  }

  has(key: string): boolean {
    return this.buffers.has(key)
  }

  /** Read-only metadata about a buffered turn. Useful for resume responses. */
  snapshot(key: string): TurnSnapshot | null {
    const buf = this.buffers.get(key)
    if (!buf) return null
    return {
      turnId: buf.turnId,
      status: buf.status,
      lastSeq: buf.nextSeq - 1,
      terminal: buf.terminal,
      createdAt: buf.createdAt,
      completedAt: buf.completedAt,
      lastEventAt: buf.lastEventAt,
    }
  }

  /**
   * Create a ReadableStream that first replays all buffered chunks past
   * `opts.fromSeq` (default: 0 → replay everything), then subscribes for
   * any further live chunks until the stream completes.
   *
   * Returns null if no buffer exists for the key.
   */
  createReplayStream(
    key: string,
    opts: ReplayOptions = {},
  ): ReadableStream<Uint8Array> | null {
    const buf = this.buffers.get(key)
    if (!buf) return null

    const fromSeq = Math.max(0, opts.fromSeq ?? 0)
    let subscribedController: ReadableStreamDefaultController<Uint8Array> | null = null

    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of buf.frames) {
          if (frame.seq <= fromSeq) continue
          try {
            controller.enqueue(frame.chunk)
          } catch {
            return
          }
        }

        if (buf.status !== 'active') {
          try { controller.close() } catch { /* already closed */ }
          return
        }

        subscribedController = controller
        buf.subscribers.add(controller)
      },
      cancel() {
        if (subscribedController) {
          buf.subscribers.delete(subscribedController)
          subscribedController = null
        }
      },
    })
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, buf] of this.buffers) {
      if (buf.status !== 'active' && buf.completedAt && now - buf.completedAt > COMPLETED_GRACE_MS) {
        this.buffers.delete(key)
      } else if (now - buf.createdAt > MAX_BUFFER_AGE_MS && buf.subscribers.size === 0) {
        this.completeBuffer(buf, 'expired')
        this.buffers.delete(key)
      }
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    for (const buf of this.buffers.values()) {
      this.completeBuffer(buf, 'disposed')
    }
    this.buffers.clear()
  }

  private completeBuffer(buf: StreamBuffer, reason?: string): void {
    if (buf.status !== 'active') return
    buf.status = 'completed'
    buf.terminal = { reason }
    buf.completedAt = Date.now()
    buf.lastEventAt = buf.completedAt
    for (const ctrl of buf.subscribers) {
      try { ctrl.close() } catch { /* already closed */ }
    }
    buf.subscribers.clear()
  }

  private failBuffer(buf: StreamBuffer, error: string): void {
    if (buf.status !== 'active') return
    buf.status = 'failed'
    buf.terminal = { error }
    buf.completedAt = Date.now()
    buf.lastEventAt = buf.completedAt
    for (const ctrl of buf.subscribers) {
      try { ctrl.close() } catch { /* already closed */ }
    }
    buf.subscribers.clear()
  }
}

function generateTurnId(): string {
  // Lightweight random id — we don't need cryptographic strength here, just
  // uniqueness within the store's lifetime. Fall back to Math.random in
  // environments without crypto.randomUUID (older bundlers / RN).
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * TransformStream that copies every chunk into a StreamBufferStore while
 * passing it through unchanged. On flush/cancel, completes the buffer.
 *
 * Note: this convenience helper does NOT propagate seq numbers back to the
 * caller. Use `store.create(key)` directly if you need the writer's seq.
 */
export function createBufferingTransform(
  store: StreamBufferStore,
  key: string,
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      store.append(key, chunk)
      controller.enqueue(chunk)
    },
    flush() {
      store.complete(key)
    },
  })
}
