// SPDX-License-Identifier: MIT
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
 * If the response body ends without ever emitting `data-turn-complete` —
 * whether by a clean premature EOF OR by a mid-stream transport failure that
 * makes `reader.read()` throw (an HTTP/2 reset surfacing as
 * `net::ERR_HTTP2_PROTOCOL_ERROR` / `TypeError: network error`, or an aborted
 * `BodyStreamBuffer`) — the turn was interrupted (proxy idle timeout, mobile
 * background, network blip, etc.) but the runtime is almost certainly still
 * producing tokens into its in-memory buffer. This wrapper transparently calls
 * the `/stream?fromSeq=N` endpoint and continues piping bytes into the
 * underlying body so the AI SDK never sees a disconnect. Only if every resume
 * attempt is exhausted does an unrecovered transport error propagate to the
 * AI SDK.
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
  /**
   * Wire-level liveness callback. Fired for EVERY chunk the wrapper
   * reads off the underlying fetch body, including SSE comment lines
   * (e.g. the API's `: proxy-keep-alive\n\n` heartbeat) that never
   * surface to the AI SDK as a `data-*` event. Use this to drive a
   * stall watchdog that needs to distinguish "stream is dead" from
   * "stream is alive but pre-text-delta".
   *
   * Receives the raw chunk byte length so callers can also use it for
   * lightweight throughput metering. Errors thrown inside the callback
   * are caught and ignored — this hook is best-effort and must never
   * break the body pipeline.
   */
  onChunk?: (info: { bytes: number; resumed: boolean }) => void
}

const DEFAULT_OPTIONS: Required<Omit<AutoResumingFetchOptions, 'buildResumeUrl' | 'logger' | 'onChunk'>> = {
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
      onChunk: options.onChunk,
      // Carry the original request's credentials mode onto the internal
      // resume GET so same-site cookies — notably Cloudflare's `__cflb`
      // load-balancer affinity cookie — ride along and keep the reconnect
      // pinned to the region that owns the turn's stream buffer. Without
      // this the resume can be geo-steered to a different region that has
      // no buffer (204) or hasn't replicated the project row yet (404).
      credentials: init?.credentials,
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
  onChunk?: (info: { bytes: number; resumed: boolean }) => void
  /**
   * Credentials mode forwarded from the original chat POST to the internal
   * resume GET so affinity cookies (e.g. Cloudflare `__cflb`) are sent and
   * the reconnect stays in the region that owns the stream buffer.
   */
  credentials?: RequestCredentials
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
    onChunk,
    credentials,
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

      const pumpBody = async (
        body: ReadableStream<Uint8Array>,
        resumed: boolean,
      ): Promise<{ bytes: number; error?: unknown }> => {
        const reader = body.getReader()
        let bytes = 0
        try {
          while (!cancelled) {
            let done: boolean
            let value: Uint8Array | undefined
            try {
              const r = await reader.read()
              done = r.done
              value = r.value
            } catch (err) {
              // Mid-stream transport failure — the underlying HTTP/2 stream was
              // reset (`net::ERR_HTTP2_PROTOCOL_ERROR` → `TypeError: network
              // error`) or the body buffer was aborted (`BodyStreamBuffer was
              // aborted`). This is NOT a clean EOF, but the runtime is almost
              // certainly still buffering the turn server-side, so treat it
              // exactly like a premature EOF: return (rather than throw) so the
              // caller's resume loop can reattach via `/stream?fromSeq=N`
              // instead of killing the whole stream. The error is surfaced so an
              // eventual give-up can still propagate it to the UI.
              return { bytes, error: err }
            }
            if (done) return { bytes }
            if (!value) continue
            bytes += value.byteLength
            inspectChunk(value)
            // Wire-level liveness signal — fire BEFORE enqueueing so a
            // downstream cancel (e.g. user-stop) that throws from
            // `controller.enqueue()` doesn't swallow the heartbeat for
            // the chunk we just successfully read. Best-effort; never
            // let a buggy callback break the body pipeline.
            if (onChunk) {
              try {
                onChunk({ bytes: value.byteLength, resumed })
              } catch {
                /* swallow — onChunk is advisory */
              }
            }
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

      // Tracks the most recent mid-stream transport error (a thrown
      // `reader.read()`), if any. A clean pump (EOF) clears it. If we
      // ultimately give up while one is still pending, we propagate it so the
      // UI surfaces the interrupted state instead of silently truncating.
      let lastTransportError: unknown = null

      try {
        const firstPump = await pumpBody(initialBody, /* resumed */ false)
        lastTransportError = firstPump.error ?? null

        while (!turnCompleted && !cancelled && resumeAttempts < maxResumeAttempts) {
          resumeAttempts++
          const backoff = Math.min(
            initialBackoffMs * Math.pow(2, resumeAttempts - 1),
            maxBackoffMs,
          )
          const reason = lastTransportError
            ? `stream errored mid-turn (${(lastTransportError as any)?.message || lastTransportError})`
            : 'stream EOF without turn-complete'
          warn(
            `${reason}; reconnecting fromSeq=${lastSeq} (attempt ${resumeAttempts}/${maxResumeAttempts}, backoff ${backoff}ms)`,
          )
          await sleep(backoff)
          if (cancelled) break

          let resumeRes: Response
          try {
            const url = `${resumeUrl}?fromSeq=${lastSeq}`
            resumeRes = await fetcher(url, { method: 'GET', credentials })
          } catch (err: any) {
            lastTransportError = err
            warn(`resume fetch threw: ${err?.message || err}`)
            continue
          }

          // Only a 200 with a body is a resumable stream. Any other status is
          // terminal: 204 = turn no longer buffered; 4xx/5xx (e.g. a 404 from
          // a region that doesn't own the session, a 401/403 auth failure, a
          // 503 from a down home-region peer) is NOT a stream and must never
          // be pumped into the AI SDK body or retried. Retrying a hard 404
          // here is what produced the observed "50-75 stream 404s/min" storm:
          // the error body has bytes > 0, which reset the attempt counter and
          // looped forever. Stop and let the UI surface a Retry instead.
          if (resumeRes.status !== 200 || !resumeRes.body) {
            log(`resume returned ${resumeRes.status} — not a resumable stream, stopping`)
            try { resumeRes.body?.cancel() } catch { /* noop */ }
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

          // Snapshot the durable seq cursor BEFORE pumping so we can tell
          // real forward progress (new frames past what we've seen) from a
          // completed buffer merely replaying its tail.
          const seqBeforeResume = lastSeq
          const { bytes, error } = await pumpBody(resumeRes.body, /* resumed */ true)
          // A resume that ended on a clean EOF clears any pending transport
          // error; one that threw again keeps it set for the (bounded) loop.
          lastTransportError = error ?? null
          // Only reset the attempt budget when the resume ADVANCED the seq
          // cursor. The old `if (bytes > 0)` check treated any bytes as
          // progress — but a turn that completed server-side WITHOUT a
          // `data-turn-complete` frame in its buffer (abnormal termination:
          // pod OOM/crash, bg-reader error, abort race) replays the same
          // tail on every `?fromSeq=N` reconnect. Since `fromSeq` never
          // advances (no new `data-turn-seq`), each replay delivered bytes,
          // reset the counter, and the loop ran until the 30s buffer grace —
          // pinning `useChat().status` at `streaming` the whole time and
          // wedging the composer on Stop/Queue. Gating the reset on seq
          // progress lets pure-duplicate replays accrue toward
          // `maxResumeAttempts` so we give up and close the body (→ ready).
          if (bytes > 0 && lastSeq > seqBeforeResume) resumeAttempts = 0
        }

        if (!turnCompleted && !cancelled) {
          warn(`gave up after ${resumeAttempts} resume attempts; closing stream`)
          // If we bailed with an unrecovered transport error still pending,
          // propagate it so the AI SDK's `onError` fires (interrupted banner +
          // stuck-tool cleanup) and the stall watchdog can probe/reattach. A
          // clean-EOF give-up closes silently and defers to the watchdog, as
          // before.
          if (lastTransportError) {
            try { controller.error(lastTransportError) } catch { /* already errored */ }
            return
          }
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
