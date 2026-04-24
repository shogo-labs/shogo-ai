// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-memory stream buffer for SSE reconnect support.
 *
 * Stores raw SSE bytes keyed by chatSessionId so that a reconnecting client
 * can replay the buffered events and continue receiving live events.
 *
 * Each server process (agent-runtime pod, API server) creates its own
 * StreamBufferStore singleton — no shared state between processes.
 */

import type {
  DurableStreamLedger,
  DurableStreamReplayOptions,
  DurableStreamStartOptions,
  DurableStreamMeta,
} from './durable-stream-ledger'

const CLEANUP_INTERVAL_MS = 60_000
const MAX_BUFFER_AGE_MS = Number(process.env.STREAM_BUFFER_MAX_AGE_MS || 30 * 60_000)
const COMPLETED_GRACE_MS = Number(process.env.STREAM_BUFFER_COMPLETED_GRACE_MS || 30_000)

interface StreamBuffer {
  chunks: Uint8Array[]
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
  status: 'active' | 'completed'
  createdAt: number
  completedAt: number | null
  turnId?: string
  runtimeId?: string
  lastSeq: number
}

/**
 * A writer bound to a specific buffer instance. If the buffer is replaced
 * (e.g. a new stream starts for the same key), writes become no-ops
 * so a stale background reader can't corrupt the new buffer.
 */
export interface StreamBufferWriter {
  append(chunk: Uint8Array): void
  complete(): void
  readonly turnId?: string
}

export interface StreamBufferStoreOptions {
  durableLedger?: DurableStreamLedger
}

export class StreamBufferStore {
  private buffers = new Map<string, StreamBuffer>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private readonly durableLedger?: DurableStreamLedger

  constructor(options: StreamBufferStoreOptions = {}) {
    this.durableLedger = options.durableLedger
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Create (or replace) a buffer for the given key.
   * Any existing buffer for the same key is completed and discarded.
   *
   * Returns a writer bound to this specific buffer instance.
   */
  create(key: string, options: DurableStreamStartOptions = {}): StreamBufferWriter {
    const existing = this.buffers.get(key)
    if (existing && existing.status === 'active') {
      this.completeBuffer(existing)
    }
    const durableMeta = this.durableLedger?.start(key, options)
    const buf: StreamBuffer = {
      chunks: [],
      subscribers: new Set(),
      status: 'active',
      createdAt: Date.now(),
      completedAt: null,
      turnId: durableMeta?.turnId ?? options.turnId,
      runtimeId: options.runtimeId,
      lastSeq: 0,
    }
    this.buffers.set(key, buf)

    return {
      get turnId() {
        return buf.turnId
      },
      append: (chunk: Uint8Array) => {
        if (buf.status !== 'active') return
        buf.lastSeq = this.durableLedger?.appendChunk(key, chunk) ?? (buf.lastSeq + 1)
        buf.chunks.push(chunk)
        for (const ctrl of buf.subscribers) {
          try {
            ctrl.enqueue(chunk)
          } catch {
            buf.subscribers.delete(ctrl)
          }
        }
      },
      complete: () => {
        this.completeBuffer(buf)
      },
    }
  }

  /**
   * Append a chunk by key. Useful for simple pass-through transforms
   * where binding to a specific buffer instance isn't needed.
   */
  append(key: string, chunk: Uint8Array): void {
    const buf = this.buffers.get(key)
    if (!buf || buf.status !== 'active') return

    buf.lastSeq = this.durableLedger?.appendChunk(key, chunk) ?? (buf.lastSeq + 1)
    buf.chunks.push(chunk)
    for (const ctrl of buf.subscribers) {
      try {
        ctrl.enqueue(chunk)
      } catch {
        buf.subscribers.delete(ctrl)
      }
    }
  }

  /**
   * Mark a buffer as completed by key.
   */
  complete(key: string): void {
    const buf = this.buffers.get(key)
    if (!buf) return
    this.completeBuffer(buf)
  }

  /**
   * Abort a stream: complete all subscribers and remove the buffer entirely.
   * Future resume/replay requests for this key will return null (→ 204).
   * The bound StreamBufferWriter stays safe (no-ops via closure ref).
   */
  abort(key: string): void {
    const buf = this.buffers.get(key)
    this.durableLedger?.abort(key)
    if (!buf) return
    this.completeBuffer(buf)
    this.buffers.delete(key)
  }

  has(key: string): boolean {
    return this.buffers.has(key) || !!this.durableLedger?.has(key)
  }

  getStatus(key: string): DurableStreamMeta | {
    key: string
    turnId?: string
    runtimeId?: string
    status: 'active' | 'completed'
    createdAt: number
    updatedAt: number
    completedAt?: number
    lastSeq: number
  } | null {
    const buf = this.buffers.get(key)
    if (buf) {
      return {
        key,
        turnId: buf.turnId,
        runtimeId: buf.runtimeId,
        status: buf.status,
        createdAt: buf.createdAt,
        updatedAt: buf.completedAt ?? Date.now(),
        completedAt: buf.completedAt ?? undefined,
        lastSeq: buf.lastSeq,
      }
    }
    return this.durableLedger?.getMeta(key) ?? null
  }

  /**
   * Create a ReadableStream that first replays all buffered chunks,
   * then subscribes for any further live chunks until the stream completes.
   *
   * Returns null if no buffer exists for the key.
   */
  createReplayStream(key: string, options: DurableStreamReplayOptions = {}): ReadableStream<Uint8Array> | null {
    const buf = this.buffers.get(key)
    if (!buf) return this.durableLedger?.createReplayStream(key, options) ?? null
    if (options.turnId && buf.turnId && options.turnId !== buf.turnId) return null

    let subscribedController: ReadableStreamDefaultController<Uint8Array> | null = null
    const rawFromSeq = options.fromSeq ?? 0
    const fromSeq = Number.isFinite(rawFromSeq) ? Math.max(0, rawFromSeq) : 0

    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = fromSeq; i < buf.chunks.length; i++) {
          try {
            controller.enqueue(buf.chunks[i])
          } catch {
            return
          }
        }

        if (buf.status === 'completed') {
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
    this.durableLedger?.cleanup()
    for (const [key, buf] of this.buffers) {
      if (buf.status === 'completed' && buf.completedAt && now - buf.completedAt > COMPLETED_GRACE_MS) {
        this.buffers.delete(key)
      } else if (now - buf.createdAt > MAX_BUFFER_AGE_MS && buf.subscribers.size === 0) {
        this.completeBuffer(buf)
        this.buffers.delete(key)
      }
    }
  }

  dispose(options: { interruptActive?: boolean } = {}): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    for (const [key, buf] of this.buffers) {
      if (options.interruptActive && buf.status === 'active') {
        this.durableLedger?.interrupt(key)
        for (const ctrl of buf.subscribers) {
          try { ctrl.close() } catch { /* already closed */ }
        }
        buf.subscribers.clear()
      } else {
        this.completeBuffer(buf)
      }
    }
    this.buffers.clear()
  }

  private completeBuffer(buf: StreamBuffer): void {
    if (buf.status === 'completed') return
    buf.status = 'completed'
    buf.completedAt = Date.now()
    for (const [key, candidate] of this.buffers) {
      if (candidate === buf) {
        this.durableLedger?.complete(key)
        break
      }
    }
    for (const ctrl of buf.subscribers) {
      try { ctrl.close() } catch { /* already closed */ }
    }
    buf.subscribers.clear()
  }
}

/**
 * TransformStream that copies every chunk into a StreamBufferStore
 * while passing it through unchanged. On flush/cancel, completes the buffer.
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
