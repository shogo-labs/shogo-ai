// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The slides viewer: one static page that renders a PowerPoint deck as slides,
 * served by the API so every host (IDE tab, workspace viewer, `share_file`
 * panel, team-chat attachment, and the phone app's WebView) frames the same
 * document (SHO-426).
 *
 * The renderer (`@aiden0z/pptx-renderer`) writes untrusted deck content into
 * the DOM with `innerHTML`, so it never runs on the app's origin:
 *
 *   - the response carries `Content-Security-Policy: sandbox allow-scripts`,
 *     which gives the document an opaque origin with no network at all — even
 *     when a native WebView loads it top-level;
 *   - the host posts the deck's bytes in as a message, so the file never
 *     travels in a URL and the page never fetches anything.
 *
 * The bundle is inlined: one cached document, no second request, and nothing
 * the page could fetch even if it tried.
 */

import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'

/** Where the page lives. Public: it is a static asset that knows no tenant. */
export const SLIDES_VIEWER_PATH = '/api/viewers/slides'

/**
 * Opaque origin, no network. `img-src blob: data:` and `font-src data:` are
 * what the renderer needs for embedded media and fonts; scripts and styles are
 * inline because the whole page is one document.
 */
export const SLIDES_VIEWER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src blob: data:; font-src data:; connect-src 'none'"

/** A pinned renderer is cached forever; `?v=` is the version it was built from. */
export const SLIDES_VIEWER_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const SLIDES_VIEWER_UNCACHED = 'no-cache'

/** The package's standalone browser build: one file, no imports to resolve. */
const RENDERER_ENTRY = '@aiden0z/pptx-renderer/browser'
/** The exports the page cannot work without. */
const REQUIRED_EXPORTS = ['PptxViewer', 'RECOMMENDED_ZIP_LIMITS'] as const

interface SlidesViewerDocument {
  html: string
  version: string
}

let document: SlidesViewerDocument | null = null
let documentError: string | null = null

function requireFromHere(): NodeRequire {
  return createRequire(import.meta.url)
}

/**
 * Inline the ESM bundle and hand its exports to the page.
 *
 * The build ends with a single `export { local as exported, … }` list. An
 * inline module cannot be imported, so that list is rewritten into an object
 * the page's own code reads. A build without it is refused loudly at startup
 * rather than shipped as a page that silently renders nothing.
 */
function inlineRendererExports(source: string): string {
  const match = /export\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(source)
  if (!match) throw new Error(`${RENDERER_ENTRY} has no trailing export list to inline`)
  const pairs = match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/).map((part) => part.trim())
      return `${exported ?? local}: ${local}`
    })
  const exported = new Set(
    pairs.map((pair) => pair.slice(0, pair.indexOf(':')).replace(/["']/g, '')),
  )
  for (const name of REQUIRED_EXPORTS) {
    if (!exported.has(name)) throw new Error(`${RENDERER_ENTRY} no longer exports ${name}`)
  }
  const body = source.slice(0, match.index)
  return `${body}\nconst __shogoPptx = { ${pairs.join(', ')} };\n`
}

/** The page's own code: receive bytes, render, report. No network, ever. */
const VIEWER_SCRIPT = String.raw`
const statusEl = document.getElementById('status')
const slidesEl = document.getElementById('slides')
const counterEl = document.getElementById('counter')

let viewer = null
let total = 0
let pending = null

function send(message) {
  try {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(message))
      return
    }
  } catch (error) {}
  try { parent.postMessage(message, '*') } catch (error) {}
}

function say(text, isError) {
  if (!text) { statusEl.hidden = true; return }
  statusEl.textContent = text
  statusEl.hidden = false
  statusEl.dataset.error = isError ? 'true' : 'false'
}

function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

function showCounter(index) {
  if (!total) return
  counterEl.textContent = 'Slide ' + (index + 1) + ' of ' + total
  counterEl.hidden = false
}

async function render(bytes, name, theme) {
  applyTheme(theme)
  if (name) document.title = name
  say('Loading slides…', false)
  try {
    if (viewer && typeof viewer.destroy === 'function') viewer.destroy()
    viewer = null
    total = 0
    slidesEl.textContent = ''
    counterEl.hidden = true
    viewer = await __shogoPptx.PptxViewer.open(bytes, slidesEl, {
      zipLimits: __shogoPptx.RECOMMENDED_ZIP_LIMITS,
      externalMedia: 'block',
      lazySlides: true,
      lazyMedia: true,
      listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
      onSlideChange: function (index) { showCounter(index) },
    })
    total = viewer.slideCount || 0
    if (!total) throw new Error('This deck has no slides')
    showCounter(0)
    say('', false)
    send({ type: 'rendered', slideCount: total })
  } catch (error) {
    viewer = null
    say((error && error.message) || 'Could not render this deck.', true)
    send({ type: 'error', message: (error && error.message) || 'Could not render this deck.' })
  }
}

function beginLoad(message) {
  pending = { name: message.name || 'Slides', theme: message.theme, parts: [], size: 0 }
}

function finishLoad() {
  if (!pending) return
  const parts = pending.parts
  const size = pending.size
  const merged = new Uint8Array(size)
  let offset = 0
  for (let i = 0; i < parts.length; i++) { merged.set(parts[i], offset); offset += parts[i].length }
  const name = pending.name
  const theme = pending.theme
  pending = null
  render(merged.buffer, name, theme)
}

function onMessage(data) {
  if (!data || typeof data !== 'object') return
  if (data.type === 'load') {
    beginLoad(data)
    if (data.bytes instanceof ArrayBuffer || ArrayBuffer.isView(data.bytes)) {
      const bytes = data.bytes instanceof ArrayBuffer ? data.bytes : data.bytes.buffer
      pending.parts = [new Uint8Array(bytes)]
      pending.size = new Uint8Array(bytes).length
      finishLoad()
    }
    return
  }
  if (data.type === 'chunk') {
    if (!pending) return
    const bytes = base64ToBytes(String(data.base64 || ''))
    pending.parts.push(bytes)
    pending.size += bytes.length
    return
  }
  if (data.type === 'end') { finishLoad(); return }
  if (data.type === 'theme') { applyTheme(data.theme); return }
}

window.addEventListener('message', function (event) {
  if (!event || !event.data) return
  onMessage(typeof event.data === 'string' ? safeParse(event.data) : event.data)
})

function safeParse(value) {
  try { return JSON.parse(value) } catch (error) { return null }
}

// A native WebView cannot postMessage into the page, so the host calls this.
window.__shogoSlidesReceive = function (json) {
  onMessage(typeof json === 'string' ? safeParse(json) : json)
}

// ←/→ and PgUp/PgDn page through the list, the way a deck's own viewer does.
window.addEventListener('keydown', function (event) {
  const page = Math.max(1, window.innerHeight * 0.9)
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
    window.scrollBy({ top: page, behavior: 'smooth' }); event.preventDefault()
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    window.scrollBy({ top: -page, behavior: 'smooth' }); event.preventDefault()
  }
})

send({ type: 'ready' })
`

export function buildSlidesViewerHtml(rendererSource: string): string {
  // A `</script>` inside the bundle would end the inline script early.
  const inlined = inlineRendererExports(rendererSource).replace(/<\/script/gi, '<\\/script')
  return `<!doctype html>
<html data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slides</title>
<style>
  html, body { margin: 0; padding: 0; background: #f4f4f5; color: #18181b; }
  html[data-theme="dark"], html[data-theme="dark"] body { background: #111113; color: #e4e4e7; }
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  #status { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center; color: inherit; }
  #status[data-error="true"] { color: #f87171; }
  #status[hidden] { display: none; }
  #slides { display: flex; flex-direction: column; gap: 12px; padding: 12px; align-items: center; }
  #slides > * { background: #fff; border-radius: 4px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.24); }
  #counter { position: fixed; right: 12px; bottom: 12px; padding: 4px 10px; border-radius: 999px;
    background: rgba(0,0,0,.66); color: #fff; font-size: 11px; pointer-events: none; }
  #counter[hidden] { display: none; }
</style>
</head>
<body>
<div id="status">Loading slides…</div>
<div id="slides"></div>
<div id="counter" hidden></div>
<script type="module">
${inlined}
${VIEWER_SCRIPT}
</script>
</body>
</html>`
}

/**
 * Read the installed renderer and build the page once. Returns null (with the
 * reason kept for the route's 503) when the package is missing, which is a
 * deployment error rather than a request error.
 */
export function slidesViewerDocument(): SlidesViewerDocument | null {
  if (document) return document
  if (documentError) return null
  try {
    const entry = requireFromHere().resolve(RENDERER_ENTRY)
    const source = readFileSync(entry, 'utf8')
    const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    document = {
      html: buildSlidesViewerHtml(source),
      version: typeof manifest.version === 'string' ? manifest.version : '0',
    }
    return document
  } catch (error: any) {
    documentError = error?.message || String(error)
    console.error('[slides-viewer] renderer unavailable:', documentError)
    return null
  }
}

/** Test seam: forget the built page so a test can inspect a fresh build. */
export function resetSlidesViewerCache(): void {
  document = null
  documentError = null
}

export function slidesViewerRoutes(): Hono {
  const app = new Hono()

  // The inlined renderer makes this the largest HTML document the API serves
  // (2.4 MB, ~470 KB compressed). Nothing else in the app compresses, so the
  // page asks for it itself.
  app.use('/slides', compress())

  app.get('/slides', (c) => {
    const page = slidesViewerDocument()
    if (!page) {
      return c.text('Slides preview is unavailable in this build.', 503, { 'Cache-Control': 'no-store' })
    }
    const requested = c.req.query('v')
    return c.body(page.html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SLIDES_VIEWER_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Only a request that named this build's version may be cached forever;
      // a bare or stale `v` still gets the page, freshly.
      'Cache-Control': requested === page.version ? SLIDES_VIEWER_CACHE_CONTROL : SLIDES_VIEWER_UNCACHED,
      'X-Robots-Tag': 'noindex',
    })
  })

  return app
}
