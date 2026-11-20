// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The slides viewer page (SHO-426).
 *
 * The security properties are the point: the page must arrive with an opaque
 * origin and no network, and it must be cached only for the build it names.
 * A deck's bytes never appear here — they are posted in by the host — so the
 * assertions are about headers and the inlined renderer, not about a file.
 */

import { describe, expect, test } from 'bun:test'
import {
  SLIDES_VIEWER_CACHE_CONTROL,
  SLIDES_VIEWER_CSP,
  SLIDES_VIEWER_UNCACHED,
  buildSlidesViewerHtml,
  resetSlidesViewerCache,
  slidesViewerDocument,
  slidesViewerRoutes,
} from '../slides-viewer'

const app = slidesViewerRoutes()

describe('GET /api/viewers/slides', () => {
  test('serves an opaque-origin, network-free document', async () => {
    const response = await app.request('/slides')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toBe(SLIDES_VIEWER_CSP)

    const csp = SLIDES_VIEWER_CSP.toLowerCase()
    expect(csp).toContain('sandbox allow-scripts')
    // `allow-same-origin` would hand the deck's HTML our origin.
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain('connect-src \'none\'')
    expect(csp).toContain('default-src \'none\'')
  })

  test('is cached forever only for the build it names', async () => {
    const page = slidesViewerDocument()
    expect(page).not.toBeNull()

    const pinned = await app.request(`/slides?v=${page!.version}`)
    expect(pinned.headers.get('cache-control')).toBe(SLIDES_VIEWER_CACHE_CONTROL)

    const bare = await app.request('/slides')
    expect(bare.headers.get('cache-control')).toBe(SLIDES_VIEWER_UNCACHED)

    const stale = await app.request('/slides?v=0.0.1-not-this-build')
    expect(stale.headers.get('cache-control')).toBe(SLIDES_VIEWER_UNCACHED)
  })

  test('inlines the renderer and hands it to the page', async () => {
    const html = (await (await app.request('/slides')).text())
    expect(html).toContain('__shogoPptx')
    expect(html).toContain('PptxViewer')
    expect(html).toContain('RECOMMENDED_ZIP_LIMITS')
    // The host transport is in the document, not fetched.
    expect(html).toContain('__shogoSlidesReceive')
    expect(html).toContain('postMessage')
    // The bundle's own `export { … }` cannot survive inside an inline module.
    expect(html).not.toMatch(/\nexport \{/)
  })
})

describe('buildSlidesViewerHtml', () => {
  test('maps the bundle export list onto one object', () => {
    const html = buildSlidesViewerHtml(
      'var a = 1;\nvar b = 2;\nexport { a as PptxViewer, b as RECOMMENDED_ZIP_LIMITS };\n',
    )
    expect(html).toContain('PptxViewer: a')
    expect(html).toContain('RECOMMENDED_ZIP_LIMITS: b')
  })

  test('refuses a bundle it does not recognise instead of shipping a blank page', () => {
    expect(() => buildSlidesViewerHtml('var a = 1;\nexport { a as Something };\n')).toThrow(/PptxViewer/)
    expect(() => buildSlidesViewerHtml('var a = 1;\n')).toThrow(/export/)
  })

  test('a `</script>` inside the bundle cannot end the inline script early', () => {
    const html = buildSlidesViewerHtml(
      'var s = "</script>";\nexport { s as PptxViewer, s as RECOMMENDED_ZIP_LIMITS };\n',
    )
    expect(html).not.toContain('</script>";')
    expect(html).toContain('<\\/script')
  })
})

describe('slidesViewerDocument', () => {
  test('reports the installed renderer version', () => {
    resetSlidesViewerCache()
    const page = slidesViewerDocument()
    expect(page?.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
