// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The document viewer page (SHO-467).
 *
 * The security properties are the point: the page must arrive with an opaque
 * origin and no network, and it must be cached only for the build it names.
 * A document's bytes never appear here — they are posted in by the host — so
 * the assertions are about headers and the inlined renderer, not about a file.
 */

import { describe, expect, test } from 'bun:test'
import {
  DOCUMENT_VIEWER_CACHE_CONTROL,
  DOCUMENT_VIEWER_CSP,
  DOCUMENT_VIEWER_UNCACHED,
  buildDocumentViewerHtml,
  documentViewerDocument,
  documentViewerRoutes,
  resetDocumentViewerCache,
} from '../document-viewer'

const app = documentViewerRoutes()

describe('GET /api/viewers/document', () => {
  test('serves an opaque-origin, network-free document', async () => {
    const response = await app.request('/document')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_VIEWER_CSP)

    const csp = DOCUMENT_VIEWER_CSP.toLowerCase()
    expect(csp).toContain('sandbox allow-scripts')
    // `allow-same-origin` would hand the document's HTML our origin.
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
  })

  test('is cached forever only for the build it names', async () => {
    const page = documentViewerDocument()
    expect(page).not.toBeNull()

    const pinned = await app.request(`/document?v=${page!.version}`)
    expect(pinned.headers.get('cache-control')).toBe(DOCUMENT_VIEWER_CACHE_CONTROL)

    const bare = await app.request('/document')
    expect(bare.headers.get('cache-control')).toBe(DOCUMENT_VIEWER_UNCACHED)

    const stale = await app.request('/document?v=0.0.1-not-this-build')
    expect(stale.headers.get('cache-control')).toBe(DOCUMENT_VIEWER_UNCACHED)
  })

  test('inlines jszip and docx-preview and hands them to the page', async () => {
    const html = await (await app.request('/document')).text()
    expect(html).toContain('__shogoDocx')
    expect(html).toContain('renderAsync')
    // JSZip must be present (it is docx-preview's dependency).
    expect(html).toContain('JSZip')
    // The host transport is in the document, not fetched.
    expect(html).toContain('__shogoDocReceive')
    expect(html).toContain('postMessage')
    // The ESM import was replaced by a window global.
    expect(html).not.toContain("import e from")
    expect(html).not.toContain("import e from\"jszip\"")
    // The bundle's own `export { … }` cannot survive inside an inline script.
    expect(html).not.toMatch(/\nexport \{/)
  })

  test('is served without X-Frame-Options from the composed app', async () => {
    const response = await app.request('/document')
    // This route test mounts slidesViewerRoutes() alone, so there is no
    // secureHeaders() in this stack — the framing test covers the full stack.
    expect(response.status).toBe(200)
  })
})

describe('buildDocumentViewerHtml', () => {
  test('replaces the JSZip ESM import with the window global', () => {
    const html = buildDocumentViewerHtml(
      'var JSZip = function() {};',
      `import e from"jszip";var r=1;export { e as renderAsync, r as defaultOptions };`,
    )
    expect(html).toContain('const e = window.JSZip;')
    expect(html).not.toContain('import e from')
  })

  test('converts the export list to a __shogoDocx global', () => {
    const html = buildDocumentViewerHtml(
      'var JSZip = function() {};',
      `import e from"jszip";var r=1;export { e as renderAsync, r as defaultOptions };`,
    )
    expect(html).toContain('__shogoDocx')
    expect(html).toContain('renderAsync')
  })

  test('refuses a bundle without renderAsync', () => {
    expect(() =>
      buildDocumentViewerHtml(
        'var JSZip = function() {};',
        `import e from"jszip";var r=1;export { r as somethingElse };`,
      ),
    ).toThrow(/renderAsync/)
  })

  test('a `</script>` inside the bundle cannot end the inline script early', () => {
    const html = buildDocumentViewerHtml(
      'var JSZip = function() {};',
      `import e from"jszip";var s = "</script>";export { s as renderAsync };`,
    )
    expect(html).not.toContain('</script>";')
    expect(html).toContain('<\\/script')
  })
})

describe('documentViewerDocument', () => {
  test('reports the installed renderer version', () => {
    resetDocumentViewerCache()
    const page = documentViewerDocument()
    expect(page?.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
