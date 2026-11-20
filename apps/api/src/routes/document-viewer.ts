// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The document viewer: one static page that renders a Word document as real
 * pages, served by the API so every host frames the same view (SHO-467).
 *
 * Uses `docx-preview@0.4.1` (Apache-2.0) bundled with `jszip@3`.  Both are
 * inlined into the single HTML document; the page fetches nothing at runtime.
 *
 * The same security model as the slides viewer (SHO-426):
 *   - `Content-Security-Policy: sandbox allow-scripts` → opaque origin, no
 *     network, even when a native WebView loads the page top-level;
 *   - the host fetches the file's bytes with its own credentials and posts
 *     them in as a message; the file URL never reaches the page.
 *
 * Supported: `.docx`, `.docm`, `.dotx`, `.dotm` (OOXML WordprocessingML).
 * Macros never run because only the XML is parsed.
 *
 * Unsupported: `.doc` (Binary BIFF8), `.rtf`, `.odt` — these stay as extracted
 * text in the host, as before.
 */

import { type Hono } from 'hono'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  OFFICE_VIEWER_CSP,
  OFFICE_VIEWER_CACHE_CONTROL,
  OFFICE_VIEWER_UNCACHED,
  createOfficeViewer,
  inlineRendererExports,
} from './office-viewer'

/** Where the page lives. Public: it is a static asset that knows no tenant. */
export const DOCUMENT_VIEWER_PATH = '/api/viewers/document'

export const DOCUMENT_VIEWER_CSP = OFFICE_VIEWER_CSP
export const DOCUMENT_VIEWER_CACHE_CONTROL = OFFICE_VIEWER_CACHE_CONTROL
export const DOCUMENT_VIEWER_UNCACHED = OFFICE_VIEWER_UNCACHED

/**
 * JSZip and docx-preview do not export their browser bundles via the
 * `exports` package field, so we resolve the main entry and step up to the
 * `dist/` sibling file we actually want.
 */
const JSZIP_MAIN = 'jszip'
const DOCX_PREVIEW_MAIN = 'docx-preview'
/** Exports the page cannot work without. */
const REQUIRED_EXPORTS = ['renderAsync'] as const

function requireFromHere(): NodeRequire {
  return createRequire(import.meta.url)
}

/** The page's own code: receive bytes, render, report. No network, ever. */
const VIEWER_SCRIPT = String.raw`
const statusEl = document.getElementById('status')
const bodyEl = document.getElementById('body')
const styleEl = document.getElementById('docstyle')

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

async function render(bytes, name, theme) {
  applyTheme(theme)
  if (name) document.title = name
  say('Loading document\u2026', false)
  try {
    bodyEl.innerHTML = ''
    styleEl.innerHTML = ''
    await __shogoDocx.renderAsync(bytes, bodyEl, styleEl, {
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      useBase64URL: true,
    })
    // Count rendered pages (docx-preview wraps each page in .docx-wrapper).
    const pageCount = bodyEl.querySelectorAll('.docx-wrapper').length || 1
    say('', false)
    send({ type: 'rendered', itemCount: pageCount })
  } catch (error) {
    say((error && error.message) || 'Could not render this document.', true)
    send({ type: 'error', message: (error && error.message) || 'Could not render this document.' })
  }
}

function beginLoad(message) {
  pending = { name: message.name || 'Document', theme: message.theme, parts: [], size: 0 }
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
window.__shogoDocReceive = function (json) {
  onMessage(typeof json === 'string' ? safeParse(json) : json)
}

send({ type: 'ready' })
`

/**
 * Build the full self-contained HTML document.
 *
 * JSZip ships as a UMD browser bundle that sets `window.JSZip`. docx-preview
 * imports it as an ESM peer dependency (`import e from 'jszip'`). Since we
 * are inlining both bundles into a single `<script>` (not a module), we:
 *   1. Inline the JSZip UMD bundle first (sets `window.JSZip`).
 *   2. Patch docx-preview's `import e from 'jszip'` → `const e = window.JSZip`.
 *   3. Convert docx-preview's trailing `export { … }` to `const __shogoDocx = { … }`.
 */
export function buildDocumentViewerHtml(jszipSource: string, docxSource: string): string {
  const docxInlined = inlineRendererExports(docxSource, REQUIRED_EXPORTS, '__shogoDocx', {
    jszip: 'window.JSZip',
  }).replace(/<\/script/gi, '<\\/script')

  // JSZip's UMD bundle may contain </script> too — escape it.
  const jszipSafe = jszipSource.replace(/<\/script/gi, '<\\/script')

  return `<!doctype html>
<html data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Document</title>
<style id="docstyle"></style>
<style>
  html, body { margin: 0; padding: 0; background: #e8e8e8; color: #18181b; }
  html[data-theme="dark"], html[data-theme="dark"] body { background: #2a2a2a; color: #e4e4e7; }
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    display: flex; flex-direction: column; align-items: center; padding: 12px; }
  #status { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 24px; text-align: center; color: inherit; }
  #status[data-error="true"] { color: #f87171; }
  #status[hidden] { display: none; }
  /* docx-preview page wrappers: white pages on the canvas, fit-to-width. */
  #body { width: 100%; max-width: 816px; }
  .docx-wrapper { background: #fff !important; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
  /* Keep pages white in dark mode — a Word page is always white. */
  html[data-theme="dark"] .docx-wrapper { background: #fff !important; color: #000 !important; }
</style>
</head>
<body>
<div id="status">Loading document\u2026</div>
<div id="body"></div>
<script>
${jszipSafe}
</script>
<script>
${docxInlined}
${VIEWER_SCRIPT}
</script>
</body>
</html>`
}

const _factory = createOfficeViewer({
  routePath: 'document',
  logTag: 'document-viewer',
  buildHtml(): string {
    const req = requireFromHere()
    // Resolve the main entry first (which is in `dist/`), then step to the
    // browser-specific files in the same directory.
    const jszipMain = req.resolve(JSZIP_MAIN)
    const jszipBrowserMin = join(dirname(jszipMain), '..', 'dist', 'jszip.min.js')
    const docxMain = req.resolve(DOCX_PREVIEW_MAIN)
    const docxBrowserMin = join(dirname(docxMain), 'docx-preview.min.mjs')
    return buildDocumentViewerHtml(
      readFileSync(jszipBrowserMin, 'utf8'),
      readFileSync(docxBrowserMin, 'utf8'),
    )
  },
  getVersion(): string {
    const req = requireFromHere()
    const docxMain = req.resolve(DOCX_PREVIEW_MAIN)
    const manifest = JSON.parse(
      readFileSync(join(dirname(docxMain), '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return typeof manifest.version === 'string' ? manifest.version : '0'
  },
})

/**
 * Read the installed renderer and build the page once. Returns null when the
 * package is missing — a deployment error, not a request error.
 */
export function documentViewerDocument(): { html: string; version: string } | null {
  return _factory.viewerDocument()
}

/** Test seam: forget the built page so a test can inspect a fresh build. */
export function resetDocumentViewerCache(): void {
  _factory.resetViewerCache()
}

export function documentViewerRoutes(): Hono {
  return _factory.viewerRoutes()
}
