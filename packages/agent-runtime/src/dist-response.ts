// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Serving a `dist/` tree: streamed, ranged, and — on a published pod — with
 * LFS objects read from object storage on request instead of from disk.
 *
 * Two things used to make this the wrong shape for a media-heavy project:
 *
 *   1. every file was `readFileSync`-ed whole, so a 300 MB video cost 300 MB of
 *      heap per concurrent request and `<video>` could not seek (SHO-485 §1b);
 *   2. a published pod materialized every LFS object onto its 2 Gi
 *      `project-data` volume at boot, so cold-start cost and disk use grew with
 *      the project's media (SHO-485 §1c).
 *
 * Now a non-HTML file is a `Bun.file` response (ranged when asked), and a file
 * whose content is an LFS pointer is answered with the object's bytes streamed
 * from `<projectId>/lfs/objects/…`. Memory stays flat either way.
 *
 * Extracted from `server.ts` so a test can drive the real function against a
 * real directory and a fake store — the same reason `publish-endpoints.ts`
 * lives outside `server.ts`.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { extname, join, resolve } from 'path'
import { Readable } from 'node:stream'
import {
  fileRangeResponse,
  openLfsObjectStream,
  parseLfsPointer,
  staticAssetCacheControl,
  type LfsObjectStore,
} from '@shogo/shared-runtime'
import { resolveDistFile, shouldServeSpaFallback } from './static-asset-cache'

// Marker header stamped on every response the agent-runtime itself produces for
// a preview document. The Cloudflare preview-router Worker uses its presence to
// distinguish an *infra* error (Kourier "no healthy upstream" 404, activator/pod
// 503 — no marker) from the *app's own* response (404 page, building placeholder
// — marked). Infra errors get swapped for the "waking up" interstitial; marked
// responses pass through untouched so a genuine app 404 is never masked or
// reload-looped.
export const RUNTIME_MARKER_HEADER = 'x-shogo-runtime'
export const RUNTIME_MARKER_VALUE = '1'

/** Shared MIME map for static file serving. */
export const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.mjs': 'application/javascript',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
}

/**
 * The MIME a `dist/` path is served with. Shared with the publish path, which
 * stamps the same type onto the object (a published pod serves the object's own
 * `Content-Type`).
 */
export function staticMimeFor(pathOrExt: string): string {
  const dot = pathOrExt.lastIndexOf('.')
  const ext = dot >= 0 ? pathOrExt.slice(dot).toLowerCase() : ''
  return STATIC_MIME[ext] || 'application/octet-stream'
}

export interface DistStaticRequest {
  /** The directory to serve out of. */
  distDir: string
  /** The request path *relative to the dist root*. */
  requestPath: string
  buildInFlight: boolean
  /** HTTP method — `HEAD` answers headers only. */
  method: string
  /** Raw `Range` request header. */
  range?: string | null
  /** Raw `If-None-Match` request header. */
  ifNoneMatch?: string | null
}

export interface DistServeContext {
  /** Published pod: read LFS objects from the store instead of from disk. */
  lfs?: { store: LfsObjectStore; projectId: string } | null
  /** Server-owned HTML transform (canvas bridge + preview base path). */
  injectHtml(html: string): string
  /** Self-refreshing "Building preview…" page. */
  renderBuildingPlaceholder(): Response
}

/** Hono marks a response with a `null` body for HEAD; the store's stream is then dropped, unread. */
function headResponse(response: Response, request: DistStaticRequest): Response {
  if (request.method.toUpperCase() !== 'HEAD') return response
  return new Response(null, { status: response.status, headers: response.headers })
}

/** Turn an SDK `Body` (web stream under bun, node stream elsewhere) into a `Response` body. */
function toBodyInit(body: unknown): BodyInit | null {
  if (!body) return null
  if (typeof (body as ReadableStream).getReader === 'function') return body as ReadableStream
  if (typeof (body as any).pipe === 'function') return Readable.toWeb(body as any) as unknown as BodyInit
  return null
}

/** A `Response` for one file on disk, streamed and ranged. */
function serveFileOnDisk(
  filePath: string,
  request: DistStaticRequest,
  mime: string,
  safePath: string,
): Response {
  const size = statSync(filePath).size
  return fileRangeResponse({
    file: Bun.file(filePath),
    size,
    rangeHeader: request.range ?? null,
    headers: {
      'Content-Type': mime,
      'Cache-Control': staticAssetCacheControl(safePath),
      [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
    },
  })
}

/**
 * Serve a pointer's object from the store.
 *
 * A **length-known** body (`Bun.s3` file) is returned bare: `Bun.serve` answers
 * it with `Content-Length`, applies `Range` itself, and takes
 * `Content-Type`/`ETag`/`Last-Modified` from the object. It cannot be combined
 * with headers at all — `new Response(s3File, init)` throws — so the publish
 * path stamps the object's `Content-Type` and `Cache-Control` at upload
 * (`publish-artifact-filter.ts`), and those *are* the headers a browser sees.
 *
 * The piped fallback (a host without `Bun.S3Client`) does carry our headers and
 * loses `Content-Length` to chunked encoding; `lengthKnown` is what keeps the
 * two apart.
 *
 * Never answers with the pointer text: pointer text served as media is a
 * corrupt-looking image the user cannot explain, and it hides the real
 * problem — an object that was never made durable.
 */
async function serveLfsPointer(
  filePath: string,
  pointer: { oid: string; size: number },
  request: DistStaticRequest,
  lfs: { store: LfsObjectStore; projectId: string },
  mime: string,
  safePath: string,
): Promise<Response> {
  const result = await openLfsObjectStream({
    projectId: lfs.projectId,
    oid: pointer.oid,
    size: pointer.size,
    store: lfs.store,
    range: request.range ?? null,
    ifNoneMatch: request.ifNoneMatch ?? null,
    head: request.method.toUpperCase() === 'HEAD',
  })
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': staticAssetCacheControl(safePath),
    'Accept-Ranges': 'bytes',
    ETag: result.etag,
    [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
  }
  if (result.status === 'not-modified') return new Response(null, { status: 304, headers })
  if (result.status === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${result.totalSize}` },
    })
  }
  if (result.status === 'missing') {
    console.warn(
      `[agent-runtime] LFS object missing: ${safePath} → ${lfs.projectId}/lfs/objects/${pointer.oid} ` +
        `(${pointer.size} bytes declared)`,
    )
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE },
    })
  }

  if (result.lengthKnown && result.body) {
    // Bun answers this body itself: `Content-Length`, `Content-Type`, `ETag`,
    // `Last-Modified`, `Accept-Ranges` and the `206` all come from the store.
    if (request.method.toUpperCase() === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          ...headers,
          'Content-Length': String(result.contentLength),
          ...(result.contentRange ? { 'Content-Range': result.contentRange } : {}),
        },
      })
    }
    return new Response(result.body as BodyInit)
  }

  const body = toBodyInit(result.body)
  return new Response(body, {
    status: result.contentRange ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(result.contentLength),
      ...(result.contentRange ? { 'Content-Range': result.contentRange } : {}),
    },
  })
}

/**
 * Serve a request out of a `dist/` directory with SPA fallback.
 *
 * Shared by the root static handler (single-project: serves
 * `<WORKSPACE_DIR>/dist`) and the workspace per-project handler (serves
 * `<WORKSPACE_DIR>/<projectId>/dist`). Returns `null` when there is genuinely
 * nothing to serve (no matching file, no `index.html`, no build in flight) so
 * the caller can fall through to `c.notFound()`.
 */
export async function serveDistResponse(
  request: DistStaticRequest,
  context: DistServeContext,
): Promise<Response | null> {
  const safePath = request.requestPath.replace(/\.\./g, '').replace(/\/+/g, '/')
  const filePath = join(request.distDir, safePath === '/' ? 'index.html' : safePath)

  if (!filePath.startsWith(resolve(request.distDir))) {
    return null
  }

  const resolvedFile = resolveDistFile(filePath)
  if (resolvedFile) {
    const ext = extname(resolvedFile).toLowerCase()
    const mime = STATIC_MIME[ext] || 'application/octet-stream'
    if (ext === '.html') {
      const html = context.injectHtml(readFileSync(resolvedFile, 'utf-8'))
      return new Response(html, {
        headers: {
          'Content-Type': mime,
          // no-store (not no-cache): no-cache still allows a client to keep a
          // cached copy and revalidate, and browsers commonly serve a
          // stale-while-revalidate copy on flaky preview connections. HTML is
          // the one response that points at content-hashed asset URLs, so it
          // must never be served from cache once those hashes change.
          'Cache-Control': 'no-store',
          [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
        },
      })
    }

    // A published pod builds its image from pointer text instead of media
    // bytes (SHO-485 §2), and the same rule covers a `public/` file and a
    // Vite-hashed import: if what is on disk is a pointer, the bytes live in
    // the object store.
    if (context.lfs) {
      const size = statSync(resolvedFile).size
      if (size > 0 && size <= 1024) {
        const pointer = parseLfsPointer(readFileSync(resolvedFile, 'utf-8'))
        if (pointer) {
          return serveLfsPointer(resolvedFile, pointer, request, context.lfs, mime, safePath)
        }
      }
    }

    return headResponse(serveFileOnDisk(resolvedFile, request, mime, safePath), request)
  }

  // The file doesn't exist. Static-asset paths (hashed JS/CSS, images,
  // fonts, etc.) must 404 here rather than silently fall back to
  // `index.html` — see `shouldServeSpaFallback` for why: a stale HTML
  // document requesting an asset hash that an atomic rebuild already
  // removed would otherwise get a 200 HTML body back for what the browser
  // expects to be a JS module, producing a blank white page with no
  // visible error. Only real SPA routes (extension-less paths, `.html`)
  // fall back below.
  if (!shouldServeSpaFallback(safePath)) {
    return null
  }

  // SPA fallback
  const indexPath = join(request.distDir, 'index.html')
  if (existsSync(indexPath)) {
    const html = context.injectHtml(readFileSync(indexPath, 'utf-8'))
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
      },
    })
  }

  // No dist yet. If a build is in flight, render a self-refreshing
  // "Building..." placeholder so the user doesn't stare at a raw 404
  // during the first build of a fresh workspace. After the first
  // successful build the atomic-swap pipeline keeps `dist/` populated,
  // so this only matters pre-first-build (or after a fresh wipe).
  if (request.buildInFlight) {
    return context.renderBuildingPlaceholder()
  }

  return null
}
