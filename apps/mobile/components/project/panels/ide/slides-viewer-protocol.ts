// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The wire between a file host and the slides viewer page (SHO-426).
 *
 * The viewer is one static document the API serves (`/api/viewers/slides`) and
 * every host frames it: an `<iframe sandbox="allow-scripts">` on web and
 * desktop, a `react-native-webview` on iOS and Android. It has an opaque origin
 * and no network, so the deck's bytes travel *in* as messages rather than in a
 * URL or a fetch:
 *
 *   host  → viewer   `load` (bytes, or name + theme for a chunked native send)
 *                    `chunk` (base64, native only) · `end` · `theme`
 *   viewer → host    `ready` · `rendered` (slide count) · `error`
 *
 * All of it lives here, with no React and no platform imports, so the chunking,
 * the size caps and the message checks are testable on their own.
 */

/** Extensions the viewer renders. Macros never run: only the XML is read. */
const SLIDES_EXTENSIONS = new Set(['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'])

/** True for an OOXML presentation we can render as real slides. */
export function isSlidesPath(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return path.includes('.') && SLIDES_EXTENSIONS.has(ext)
}

/** Where the API serves the viewer page. Public: it knows no tenant. */
export const SLIDES_VIEWER_PATH = '/api/viewers/slides'

/**
 * The renderer build the page is cached by. Bump it with the pinned
 * `@aiden0z/pptx-renderer` version — the API serves the document `immutable`
 * for this exact `?v=`, so a stale value would pin a stale page.
 */
export const SLIDES_VIEWER_VERSION = '1.4.0'

/** Web and desktop buffer the whole deck; 50 MB is a slide deck, not a video. */
export const MAX_SLIDES_BYTES = 50 * 1024 * 1024
/** Native pays for every byte twice on the JS↔WebView bridge. */
export const MAX_SLIDES_BYTES_NATIVE = 25 * 1024 * 1024
/** A page that never answers must not be an endless spinner. */
export const SLIDES_RENDER_TIMEOUT_MS = 10_000
/** Base64 on the bridge: one injection per chunk, sized to survive a big deck. */
export const NATIVE_CHUNK_BYTES = 512 * 1024

export type SlidesTheme = 'dark' | 'light'

/** viewer → host */
export type SlidesViewerMessage =
  | { type: 'ready' }
  | { type: 'rendered'; slideCount: number }
  | { type: 'error'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A message from the viewer page, or something we ignore. */
export function parseSlidesViewerMessage(value: unknown): SlidesViewerMessage | null {
  const data = typeof value === 'string' ? safeJson(value) : value
  if (!isRecord(data)) return null
  if (data.type === 'ready') return { type: 'ready' }
  if (data.type === 'rendered') {
    const count = Number(data.slideCount)
    return { type: 'rendered', slideCount: Number.isFinite(count) ? count : 0 }
  }
  if (data.type === 'error') {
    return { type: 'error', message: typeof data.message === 'string' ? data.message : 'Could not render this deck.' }
  }
  return null
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** host → viewer */
export type SlidesHostMessage =
  | { type: 'theme'; theme: SlidesTheme }
  | { type: 'load'; name: string; theme: SlidesTheme; bytes?: ArrayBuffer }
  | { type: 'chunk'; base64: string }
  | { type: 'end' }

/** The viewer's URL, pinned to the build it is cached by. */
export function slidesViewerUrl(apiBase: string, version: string = SLIDES_VIEWER_VERSION): string {
  const base = apiBase.replace(/\/+$/, '')
  return `${base}${SLIDES_VIEWER_PATH}?v=${encodeURIComponent(version)}`
}

/** Base64 in bounded slices: `String.fromCharCode(...bytes)` blows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE))
  }
  return btoa(binary)
}

/** The one message a web/desktop host posts: transferable, no encoding. */
export function slidesLoadMessage(
  name: string,
  theme: SlidesTheme,
  bytes: ArrayBuffer,
): { message: { type: 'load'; name: string; theme: SlidesTheme; bytes: ArrayBuffer }; transfer: Transferable[] } {
  return { message: { type: 'load', name, theme, bytes }, transfer: [bytes] }
}

/**
 * A native WebView cannot transfer bytes, so the deck goes over the bridge as
 * base64 chunks: `load` (name + theme), one `chunk` per slice, then `end`.
 */
export function slidesChunkMessages(
  name: string,
  theme: SlidesTheme,
  bytes: Uint8Array,
  chunkBytes: number = NATIVE_CHUNK_BYTES,
): SlidesHostMessage[] {
  const size = Math.max(1, Math.floor(chunkBytes))
  const messages: SlidesHostMessage[] = [{ type: 'load', name, theme }]
  for (let offset = 0; offset < bytes.length; offset += size) {
    messages.push({ type: 'chunk', base64: bytesToBase64(bytes.subarray(offset, offset + size)) })
  }
  messages.push({ type: 'end' })
  return messages
}

/** Deck larger than this host can buffer: say so instead of hanging. */
export class SlidesTooLargeError extends Error {
  readonly size: number
  readonly limit: number

  constructor(size: number, limit: number) {
    super(`Too large to preview here (${size} bytes > ${limit})`)
    this.name = 'SlidesTooLargeError'
    this.size = size
    this.limit = limit
  }
}

/** The bytes could not be read; `status` is the HTTP status when there was one. */
export class SlidesFetchError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'SlidesFetchError'
    this.status = status
  }
}

/**
 * The deck's bytes, the way the PDF preview reads its own: the app's
 * credentialed fetch, never a URL handed to a frame. The cap is checked on the
 * declared length first, so a 300 MB file is refused before it is buffered.
 */
export async function fetchSlidesBytes(
  url: string,
  options: { maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<ArrayBuffer> {
  const limit = options.maxBytes ?? MAX_SLIDES_BYTES
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, { credentials: 'include' })
  if (!response.ok) throw new SlidesFetchError(response.status)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) throw new SlidesTooLargeError(declared, limit)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > limit) throw new SlidesTooLargeError(bytes.byteLength, limit)
  return bytes
}

/**
 * Formats that hold slides but have no renderer here. They are honest about it
 * and name the way out, instead of the generic "no preview" line (SHO-426).
 */
export function unsupportedPresentationMessage(name: string): string | null {
  if (!name.includes('.')) return null
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'key') return "Keynote decks can't be previewed here — save as .pptx to preview."
  if (ext === 'ppt') return "PowerPoint 97–2003 decks can't be previewed here — save as .pptx to preview."
  if (ext === 'odp') return "OpenDocument decks open as text here — save as .pptx to see the slides."
  return null
}

/** What the host shows in place of the deck. */
export function slidesPreviewErrorText(error: unknown, name: string): string {
  if (error instanceof SlidesTooLargeError) return 'Too large to preview here'
  if (error instanceof SlidesFetchError) return `Could not open ${name} · ${error.message}`
  if (error instanceof Error && error.message) return error.message
  return `Could not render ${name}`
}
