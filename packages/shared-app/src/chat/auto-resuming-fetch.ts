// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fetch wrapper that makes an AI SDK chat stream durable across mid-turn
 * disconnects.
 *
 * The runtime emits three out-of-band data events on every chat turn:
 *   - `data-turn-start`    — once at the start with `{ turnId, chatSessionId }`
 *   - `data-turn-seq`      — every ~250ms with `{ seq }` (last buffered chunk)
 *   - `data-turn-complete` — exactly once at clean termination
 *
 * If the response body ends without ever emitting `data-turn-complete`, the
 * turn was interrupted (proxy idle timeout, mobile background, network
 * blip, etc.) but the runtime is almost certainly still producing tokens
 * into its in-memory buffer. This wrapper transparently calls the
 * `/stream?fromSeq=N` endpoint and continues piping bytes into the
 * underlying body so the AI SDK never sees a disconnect.
 *
 * The wrapper is invisible to the AI SDK: it returns a Response whose body
 * is a single ReadableStream that keeps yielding bytes across reconnects
 * until either `data-turn-complete` arrives or the resume budget is
 * exhausted.
 */

export interface AutoResumingFetchOptions {
  /**
   * Maximum number of automatic resume attempts after a premature EOF.
   * Each attempt uses exponential backoff capped at `maxBackoffMs`.
   * Default 8.
   */
  maxResumeAttempts?: number
  /** Initial backoff delay in ms. Default 500. */
  initialBackoffMs?: number
  /** Maximum backoff delay in ms. Default 5000. */
  maxBackoffMs?: number
  /**
   * Override the resume URL builder. By default the wrapper assumes the
   * chat POST URL ends in `/chat` and the resume URL is the same with
   * `/{chatSessionId}/stream` appended.
   */
  buildResumeUrl?: (chatPostUrl: string, chatSessionId: string) => string
  /** Optional logger; defaults to console. Pass null to silence. */
  logger?: { warn: (...args: any[]) => void; log: (...args: any[]) => void } | null
}

const DEFAULT_OPTIONS: Required<Omit<AutoResumingFetchOptions, 'buildResumeUrl' | 'logger'>> = {
  maxResumeAttempts: 8,
  initialBackoffMs: 500,
  maxBackoffMs: 5_000,
}

const TURN_HEADER = {
  TURN_ID: 'X-Turn-Id',
  CHAT_SESSION_ID: 'X-Chat-Session-Id',
} as const

/**
 * Default resume URL builder: appends `/<chatSessionId>/stream` to a chat
 * POST URL like `…/projects/<id>/chat` or `…/agent/chat`.
 */
export function defaultBuildResumeUrl(chatPostUrl: string, chatSessionId: string): string {
  // Strip a trailing slash, then append `/<chatSessionId>/stream`.
  const trimmed = chatPostUrl.replace(/\/+$/, '')
  return `${trimmed}/${encodeURIComponent(chatSessionId)}/stream`
}

/**
 * Wrap a fetch implementation so that any chat POST whose response carries
 * `X-Turn-Id` + `X-Chat-Session-Id` headers becomes auto-resuming on
 * premature stream termination.
 */
export function createAutoResumingFetch(
  baseFetch: typeof globalThis.fetch,
  options: AutoResumingFetchOptions = {},
): typeof globalThis.fetch {
  const opts = {
    ...DEFAULT_OPTIONS,
    buildResumeUrl: options.buildResumeUrl ?? defaultBuildResumeUrl,
    logger: options.logger === null ? null : (options.logger ?? console),
    ...options,
  }

  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    // Only wrap POST chat requests; GET (resume), DELETE (stop), etc. are
    // forwarded as-is.
    if (method !== 'POST') {
      return baseFetch(input as any, init)
    }

    const initialResponse = await baseFetch(input as any, init)
    if (!initialResponse.ok || !initialResponse.body) return initialResponse

    const turnId = initialResponse.headers.get(TURN_HEADER.TURN_ID)
    const chatSessionId = initialResponse.headers.get(TURN_HEADER.CHAT_SESSION_ID)
    if (!turnId || !chatSessionId) {
      // Server didn't tag this response with durable turn metadata —
      // not a chat stream we can resume. Pass through.
      return initialResponse
    }

    const chatPostUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url

    const resumeUrl = opts.buildResumeUrl(chatPostUrl, chatSessionId)
    const logger = opts.logger

    const wrappedBody = createDurableBody({
      initialBody: initialResponse.body,
      resumeUrl,
      fetcher: baseFetch,
      maxResumeAttempts: opts.maxResumeAttempts,
      initialBackoffMs: opts.initialBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      logger,
      turnId,
    })

    // Re-construct the Response so the AI SDK reads from our durable body
    // but sees the original status / headers / content-type.
    return new Response(wrappedBody, {
      status: initialResponse.status,
      statusText: initialResponse.statusText,
      headers: initialResponse.headers,
    })
  }

  return wrapped
}

interface DurableBodyOpts {
  initialBody: ReadableStream<Uint8Array>
  resumeUrl: string
  fetcher: typeof globalThis.fetch
  maxResumeAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  logger: { warn: (...args: any[]) => void; log: (...args: any[]) => void } | null
  turnId: string
}

function createDurableBody(opts: DurableBodyOpts): ReadableStream<Uint8Array> {
  const {
    initialBody,
    resumeUrl,
    fetcher,
    maxResumeAttempts,
    initialBackoffMs,
    maxBackoffMs,
    logger,
    turnId,
  } = opts

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSeq = 0
      let turnCompleted = false
      let cancelled = false
      let resumeAttempts = 0
      const decoder = new TextDecoder()
      let parseBuf = ''

      const log = (msg: string) => {
        if (logger) logger.log(`[AutoResume:${turnId.slice(0, 8)}] ${msg}`)
      }
      const warn = (msg: string) => {
        if (logger) logger.warn(`[AutoResume:${turnId.slice(0, 8)}] ${msg}`)
      }

      const inspectChunk = (chunk: Uint8Array) => {
        // Append decoded text and parse complete SSE frames separated by
        // a blank line. Any partial frame stays in `parseBuf`.
        parseBuf += decoder.decode(chunk, { stream: true })
        let nlnl: number
        while ((nlnl = parseBuf.indexOf('\n\n')) !== -1) {
          const frame = parseBuf.slice(0, nlnl)
          parseBuf = parseBuf.slice(nlnl + 2)
          parseFrame(frame)
        }
      }

      const parseFrame = (frame: string) => {
        // AI SDK / SSE frame: lines like `data: {...}` joined by \n. We
        // only care about `data:` lines whose payload looks like one of
        // our durable-turn marker events.
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          // Cheap pre-filter to avoid JSON.parse on every text-delta.
          if (
            !payload.includes('data-turn-seq') &&
            !payload.includes('data-turn-complete')
          ) {
            continue
          }
          try {
            const evt = JSON.parse(payload)
            if (evt?.type === 'data-turn-seq' && typeof evt?.data?.seq === 'number') {
              if (evt.data.seq > lastSeq) lastSeq = evt.data.seq
            } else if (evt?.type === 'data-turn-complete') {
              turnCompleted = true
            }
          } catch {
            /* ignore — wasn't actually one of our markers */
          }
        }
      }

      const pumpBody = async (body: ReadableStream<Uint8Array>): Promise<{ bytes: number }> => {
        const reader = body.getReader()
        let bytes = 0
        try {
          while (!cancelled) {
            const { done, value } = await reader.read()
            if (done) return { bytes }
            if (!value) continue
            bytes += value.byteLength
            inspectChunk(value)
            try {
              controller.enqueue(value)
            } catch {
              // Downstream consumer (AI SDK) cancelled — stop pumping.
              cancelled = true
              return { bytes }
            }
          }
        } finally {
          try { reader.releaseLock() } catch { /* noop */ }
        }
        return { bytes }
      }

      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

      try {
        await pumpBody(initialBody)

        while (!turnCompleted && !cancelled && resumeAttempts < maxResumeAttempts) {
          resumeAttempts++
          const backoff = Math.min(
            initialBackoffMs * Math.pow(2, resumeAttempts - 1),
            maxBackoffMs,
          )
          warn(
            `stream EOF without turn-complete; reconnecting fromSeq=${lastSeq} (attempt ${resumeAttempts}/${maxResumeAttempts}, backoff ${backoff}ms)`,
          )
          await sleep(backoff)
          if (cancelled) break

          let resumeRes: Response
          try {
            const url = `${resumeUrl}?fromSeq=${lastSeq}`
            resumeRes = await fetcher(url, { method: 'GET' })
          } catch (err: any) {
            warn(`resume fetch threw: ${err?.message || err}`)
            continue
          }

          if (resumeRes.status === 204 || !resumeRes.body) {
            log(`resume returned ${resumeRes.status} — turn no longer buffered, stopping`)
            break
          }

          // Confirm we're still talking about the same turn. If the
          // server has rotated to a new turnId on the same session, we
          // would corrupt the AI SDK accumulator by appending the new
          // turn's bytes onto the old one — bail out instead.
          const resumeTurnId = resumeRes.headers.get(TURN_HEADER.TURN_ID)
          if (resumeTurnId && resumeTurnId !== turnId) {
            warn(`resume returned a different turnId (${resumeTurnId}); stopping`)
            try { resumeRes.body.cancel() } catch { /* noop */ }
            break
          }

          // Only reset the attempt counter if the resume actually
          // delivered bytes — otherwise an endless loop of empty 200s
          // would never surface as "stalled".
          const { bytes } = await pumpBody(resumeRes.body)
          if (bytes > 0) resumeAttempts = 0
        }

        if (!turnCompleted && !cancelled) {
          warn(`gave up after ${resumeAttempts} resume attempts; closing stream`)
        }
      } catch (err: any) {
        warn(`durable body errored: ${err?.message || err}`)
        try { controller.error(err) } catch { /* already errored */ }
        return
      } finally {
        try { controller.close() } catch { /* already closed */ }
      }
    },
    cancel() {
      // Downstream cancelled (e.g. AI SDK got an error or user-stop).
      // The async loop above checks `cancelled` and exits its read loop;
      // we don't have direct access to it here, but pump will notice the
      // controller refusing further enqueues and stop on the next chunk.
    },
  })
}
