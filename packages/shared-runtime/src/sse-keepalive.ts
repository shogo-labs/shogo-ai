// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const DEFAULT_KEEPALIVE = new TextEncoder().encode(': proxy-keep-alive\n\n')

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b
  if (b.byteLength === 0) return a
  const result = new Uint8Array(a.byteLength + b.byteLength)
  result.set(a)
  result.set(b, a.byteLength)
  return result
}

function findDelimiterEnd(bytes: Uint8Array, start = 0): number {
  for (let i = start; i + 1 < bytes.byteLength; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2
  }
  return -1
}

/**
 * Add SSE keep-alives without ever inserting a comment inside an event.
 *
 * A blind timer enqueue can corrupt a large `data:` JSON event when the
 * upstream ReadableStream splits that event across chunks. The AI SDK then
 * sees the comment as part of the JSON payload and reports AI_JSONParseError.
 * This wrapper holds only the trailing incomplete frame and emits the
 * comment immediately at a known `\n\n` boundary.
 */
export function wrapSseStreamWithKeepalive(
  upstream: ReadableStream<Uint8Array>,
  intervalMs = 15_000,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false
  let pending = new Uint8Array(0)
  let keepalivePending = false

  const cleanup = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const enqueue = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0 || closed || !controller) return
    try {
      controller.enqueue(bytes)
    } catch {
      closed = true
      cleanup()
    }
  }

  const emitKeepalive = () => {
    if (closed || !controller) return
    if (pending.byteLength === 0) {
      enqueue(DEFAULT_KEEPALIVE)
    } else {
      // A frame is currently open. Defer until the next delimiter rather
      // than emitting invalid bytes into the JSON payload.
      keepalivePending = true
    }
  }

  const forwardChunk = (chunk: Uint8Array) => {
    const combined = concatBytes(pending, chunk)
    const completeEnd = findDelimiterEnd(combined)
    if (completeEnd === -1) {
      pending = combined
      return
    }

    const complete = combined.slice(0, completeEnd)
    pending = combined.slice(completeEnd)

    if (keepalivePending) {
      const firstFrameEnd = findDelimiterEnd(complete)
      if (firstFrameEnd !== -1) {
        enqueue(complete.slice(0, firstFrameEnd))
        enqueue(DEFAULT_KEEPALIVE)
        enqueue(complete.slice(firstFrameEnd))
      } else {
        enqueue(complete)
      }
      keepalivePending = false
    } else {
      enqueue(complete)
    }
  }

  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
      timer = setInterval(emitKeepalive, intervalMs)
    },
    async pull() {
      if (closed) return
      try {
        const { done, value } = await reader.read()
        if (done) {
          // Preserve an upstream incomplete frame. This wrapper is only
          // responsible for keepalive placement; durable-resume decides how
          // to handle an incomplete frame after a transport interruption.
          if (pending.byteLength > 0) enqueue(pending)
          pending = new Uint8Array(0)
          closed = true
          cleanup()
          controller?.close()
          return
        }
        if (value) forwardChunk(value)
      } catch (error) {
        closed = true
        cleanup()
        controller?.error(error)
      }
    },
    cancel(reason) {
      closed = true
      cleanup()
      return reader.cancel(reason)
    },
  })
}
