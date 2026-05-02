// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Build a `Response` whose body is a `ReadableStream` that yields the given
 * string chunks. Used to mock the streaming bodies of the runtime terminal
 * endpoints (`/terminal/exec`, `/terminal/run`) without pulling in MSW.
 *
 * Each chunk is emitted on its own microtask so the SUT's reader observes
 * realistic backpressure. Pass `delayMs > 0` between chunks to simulate
 * slow streams; tests should keep this 0 by default.
 */
export interface StreamingResponseOptions {
  status?: number
  contentType?: string
  delayMs?: number
}

export function streamingResponse(
  chunks: string[],
  opts: StreamingResponseOptions = {},
): Response {
  const { status = 200, contentType = 'text/plain; charset=utf-8', delayMs = 0 } = opts
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status,
    headers: { 'Content-Type': contentType },
  })
}

/**
 * Like `streamingResponse` but holds the stream open until the caller
 * resolves it — useful for testing abort / cancellation paths.
 */
export function pendingStreamingResponse(
  initialChunks: string[] = [],
  opts: { contentType?: string; status?: number } = {},
): {
  response: Response
  push: (chunk: string) => void
  end: () => void
} {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of initialChunks) c.enqueue(encoder.encode(chunk))
    },
  })
  const response = new Response(stream, {
    status: opts.status ?? 200,
    headers: { 'Content-Type': opts.contentType ?? 'text/plain; charset=utf-8' },
  })
  return {
    response,
    push: (chunk) => controller?.enqueue(encoder.encode(chunk)),
    end: () => controller?.close(),
  }
}
