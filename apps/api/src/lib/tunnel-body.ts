// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Decoding and windowing for bodies that cross a machine's tunnel.
 *
 * Two jobs:
 *
 *   - `tunnelResponseBody` turns a non-stream `{ body, bodyEncoding }` frame
 *     back into bytes. A desktop that was told `acceptBodyEncoding: ['base64']`
 *     sends binary bodies base64-encoded; before that every JPEG and MP4 took a
 *     lossy UTF-8 round trip through `resp.text()` and arrived corrupt (SHO-526).
 *
 *   - `relayWorkspaceDownload` keeps one file request inside a single
 *     WebSocket frame budget. The cloud's tunnel socket is a JSON frame with
 *     Bun's 16 MiB `maxPayloadLength`, so a 50 MB MP4 sent whole closes the
 *     socket — which takes down every other request on that machine, not just
 *     the one that was too big. Downloads are fetched in
 *     `TUNNEL_DOWNLOAD_WINDOW_BYTES` windows instead, re-using the runtime's
 *     existing `Range` support, and streamed to the client as one response.
 */

/** A non-stream reply as it arrives off the tunnel. */
export interface TunnelFrameResponse {
  status: number
  headers?: Record<string, string>
  body?: string
  /** Present when `body` is base64 rather than text. */
  bodyEncoding?: 'base64'
}

/**
 * How much of a file one window asks for.
 *
 * 4 MiB raw is ~5.4 MiB base64, comfortably inside the frame budget even with
 * the envelope, and large enough that a 50 MB video needs a dozen round trips
 * rather than hundreds.
 */
export const TUNNEL_DOWNLOAD_WINDOW_BYTES = 4 * 1024 * 1024

/**
 * The body of a non-stream tunnel reply, as bytes when the desktop encoded it
 * and as text otherwise (an older desktop, or a textual response).
 */
export function tunnelResponseBody(resp: {
  body?: string
  bodyEncoding?: string
}): Uint8Array | string {
  const body = resp.body ?? ''
  if (resp.bodyEncoding !== 'base64') return body
  return new Uint8Array(Buffer.from(body, 'base64'))
}

/**
 * Should this request go through the download windower?
 *
 * Only `GET /agent/workspace/download/*`: it is the one path that serves whole
 * files (images, video, exports) through the tunnel, and the only one whose
 * runtime already answers ranges.
 */
export function isWorkspaceDownloadPath(method: string, cleanPath: string): boolean {
  return method === 'GET' && cleanPath.startsWith('/agent/workspace/download/')
}

function splitPathAndQuery(pathWithQuery: string): { pathname: string; search: string } {
  const q = pathWithQuery.indexOf('?')
  if (q === -1) return { pathname: pathWithQuery, search: '' }
  return { pathname: pathWithQuery.slice(0, q), search: pathWithQuery.slice(q) }
}

/** `bytes=a-b` / `bytes=a-` — anything else is left to the runtime untouched. */
function parseRangeHeader(value: string | undefined): { start: number; end: number | null } | null {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : null
  if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end < start))) return null
  return { start, end }
}

/** Total size out of `Content-Range: bytes 0-4194303/52428800`. */
function parseContentRangeTotal(value: string | undefined): number | null {
  if (!value) return null
  const match = /^bytes \d+-\d+\/(\d+)$/i.exec(value.trim())
  if (!match) return null
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : null
}

function withoutRange(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = { ...headers }
  delete next['range']
  delete next['Range']
  delete next['if-range']
  delete next['If-Range']
  return next
}

function toResponse(resp: TunnelFrameResponse): Response {
  const headers = new Headers()
  for (const [k, v] of Object.entries(resp.headers ?? {})) {
    if (v) headers.set(k, v)
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  return new Response(tunnelResponseBody(resp) as BodyInit, { status: resp.status, headers })
}

/**
 * Relay one `GET /agent/workspace/download/*` through the tunnel, keeping every
 * frame inside `TUNNEL_DOWNLOAD_WINDOW_BYTES`.
 *
 *   - The client asked for a range no bigger than a window: forward it as-is and
 *     return the runtime's `206` (Content-Range and all).
 *   - The client asked for a bigger or open-ended range: forward at most one
 *     window of it. A shorter range than requested is valid HTTP and every
 *     player (Chrome, AVPlayer, ExoPlayer) continues from the `Content-Range`.
 *   - The client asked for no range: read the total from the first window's
 *     `Content-Range`, then stream the remaining windows as one `200` with the
 *     file's real `Content-Length`.
 *
 * `send` is one tunnel round trip; the caller owns request ids, the target
 * (`projectId` / `workspaceId`) and the frame encoding negotiation.
 */
export async function relayWorkspaceDownload(opts: {
  /** Clean agent path WITH query, e.g. `/agent/workspace/download/a.png?w=2`. */
  agentPath: string
  /** Headers to forward (the client's `range`, if any, is among them). */
  headers: Record<string, string>
  send: (pathWithQuery: string, headers: Record<string, string>) => Promise<TunnelFrameResponse>
}): Promise<Response> {
  const { pathname, search } = splitPathAndQuery(opts.agentPath)
  const clientRange = parseRangeHeader(opts.headers['range'])
  const last = TUNNEL_DOWNLOAD_WINDOW_BYTES - 1

  const windowFor = (start: number, end: number) => `bytes=${start}-${end}`
  const sendWindow = (start: number, end: number, headers: Record<string, string>) =>
    opts.send(pathname + search, { ...withoutRange(headers), range: windowFor(start, end) })

  if (clientRange) {
    const wanted = clientRange.end === null ? null : clientRange.end - clientRange.start + 1
    if (wanted !== null && wanted <= TUNNEL_DOWNLOAD_WINDOW_BYTES) {
      return toResponse(await opts.send(opts.agentPath, opts.headers))
    }
    const end = clientRange.start + last
    return toResponse(await sendWindow(clientRange.start, end, opts.headers))
  }

  const first = await sendWindow(0, last, opts.headers)
  // A small file, or a runtime without range support: nothing to window.
  if (first.status !== 206) return toResponse(first)

  const firstBytes = tunnelResponseBody(first)
  if (first.bodyEncoding !== 'base64' || typeof firstBytes === 'string') {
    // An older desktop: it cannot hand us binary frames, so windowing would only
    // deliver a truncated, UTF-8-mangled file. Take today's single response.
    return toResponse(await opts.send(opts.agentPath, withoutRange(opts.headers)))
  }

  const total = parseContentRangeTotal(first.headers?.['content-range'])
  if (!total) return toResponse(first)

  const outHeaders = new Headers()
  for (const key of ['content-type', 'etag', 'last-modified', 'cache-control']) {
    const value = first.headers?.[key]
    if (value) outHeaders.set(key, value)
  }
  if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/octet-stream')
  outHeaders.set('content-length', String(total))
  outHeaders.set('accept-ranges', 'bytes')

  let next = TUNNEL_DOWNLOAD_WINDOW_BYTES
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstBytes)
    },
    async pull(controller) {
      if (next >= total) {
        controller.close()
        return
      }
      const end = Math.min(next + TUNNEL_DOWNLOAD_WINDOW_BYTES - 1, total - 1)
      try {
        const resp = await sendWindow(next, end, opts.headers)
        const bytes = tunnelResponseBody(resp)
        if (resp.status !== 206 || typeof bytes === 'string' || bytes.byteLength === 0) {
          throw new Error(`download window ${next}-${end} failed (HTTP ${resp.status})`)
        }
        controller.enqueue(bytes)
        next = end + 1
      } catch (err: any) {
        controller.error(err)
      }
    },
  })

  return new Response(body, { status: 200, headers: outHeaders })
}
