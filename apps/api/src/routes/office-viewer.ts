// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared factory for office-document viewer pages (SHO-467).
 *
 * Both the slides viewer (`/api/viewers/slides`, SHO-426) and the document
 * viewer (`/api/viewers/document`, SHO-467) are one static, sandboxed HTML
 * page that the API serves once, cached forever by its `?v=` pin. The host
 * posts the file's bytes in; the page renders and reports back. All the
 * HTTP boilerplate — CSP, cache-control, compression, 503 on missing renderer
 * — lives here so each viewer only defines what is unique to its format.
 */

import { Hono } from 'hono'
import { compress } from 'hono/compress'

/**
 * Opaque origin, no network. `img-src blob: data:` and `font-src data:` are
 * what office renderers need for embedded media and fonts; scripts and styles
 * are inline because the whole page is one document.
 */
export const OFFICE_VIEWER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src blob: data:; font-src data:; connect-src 'none'"

/** A pinned renderer is cached forever; `?v=` is the version it was built from. */
export const OFFICE_VIEWER_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const OFFICE_VIEWER_UNCACHED = 'no-cache'

/**
 * Inline an ESM bundle so the page can use its exports without `import`.
 *
 * Browser bundles end with `export { local as exported, … }`. An inline
 * `<script>` cannot use ESM imports or exports, so:
 *   - Any `import X from 'pkg'` statements are replaced via `importReplacements`
 *     (a map of pkg → JS expression that provides the value, e.g.
 *     `{ jszip: 'window.JSZip' }`)
 *   - The trailing `export { … }` list is converted into an object assignment:
 *     `const __shogoGlobalName = { exported: local, … };`
 *   - Source map comments (`//# sourceMappingURL=…`) are stripped
 *
 * Throws loudly at startup rather than shipping a blank page.
 */
export function inlineRendererExports(
  source: string,
  requiredExports: readonly string[],
  globalName: string,
  importReplacements: Record<string, string> = {},
): string {
  // Strip source-map URLs — they appear after the export list and confuse $ anchoring.
  let patched = source.replace(/\n\/\/#\s+sourceMappingURL=[^\n]*/g, '')

  // Replace known ESM imports with their window-global equivalents.
  for (const [pkg, replacement] of Object.entries(importReplacements)) {
    // Handles: import X from 'pkg';  import X from "pkg";
    // Capture the local binding name for the replacement expression.
    const re = new RegExp(
      `import\\s+(\\w+)\\s+from\\s*['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*;`,
      'g',
    )
    patched = patched.replace(re, (_match, binding: string) => `const ${binding} = ${replacement};`)
  }

  // Convert the trailing export list to a named global object.
  const match = /export\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(patched)
  if (!match) throw new Error(`${globalName}: bundle has no trailing export list to inline`)

  const pairs = match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/).map((part) => part.trim())
      return `${exported ?? local}: ${local}`
    })

  const exported = new Set(
    pairs.map((pair) => pair.slice(0, pair.indexOf(':')).replace(/['"]/g, '')),
  )
  for (const name of requiredExports) {
    if (!exported.has(name)) throw new Error(`${globalName}: bundle no longer exports '${name}'`)
  }

  const body = patched.slice(0, match.index)
  return `${body}\nconst ${globalName} = { ${pairs.join(', ')} };\n`
}

export interface OfficeViewerDocument {
  html: string
  version: string
}

interface OfficeViewerConfig {
  /** Route segment inside `/api/viewers/`, e.g. `'slides'` or `'document'`. */
  routePath: string
  /** Build the full HTML document. Called once at startup; throws if unavailable. */
  buildHtml: () => string
  /** Return the renderer's semver string for the `?v=` cache pin. */
  getVersion: () => string
  /** Log prefix for console messages. */
  logTag: string
}

/**
 * Returns a minimal viewer API backed by a lazy singleton. Each caller keeps
 * its own caching state so `resetCache` is scoped to that viewer.
 */
export function createOfficeViewer(config: OfficeViewerConfig): {
  viewerDocument(): OfficeViewerDocument | null
  resetViewerCache(): void
  viewerRoutes(): Hono
} {
  let cached: OfficeViewerDocument | null = null
  let cachedError: string | null = null

  function viewerDocument(): OfficeViewerDocument | null {
    if (cached) return cached
    if (cachedError) return null
    try {
      cached = { html: config.buildHtml(), version: config.getVersion() }
      return cached
    } catch (error: any) {
      cachedError = error?.message || String(error)
      console.error(`[${config.logTag}] renderer unavailable:`, cachedError)
      return null
    }
  }

  function resetViewerCache(): void {
    cached = null
    cachedError = null
  }

  function viewerRoutes(): Hono {
    const app = new Hono()

    // The inlined renderer makes this a large HTML document. Nothing else in
    // the app compresses, so the page asks for it itself.
    app.use(`/${config.routePath}`, compress())

    app.get(`/${config.routePath}`, (c) => {
      const page = viewerDocument()
      if (!page) {
        return c.text(`${config.routePath} preview is unavailable in this build.`, 503, {
          'Cache-Control': 'no-store',
        })
      }
      const requested = c.req.query('v')
      return c.body(page.html, 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': OFFICE_VIEWER_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control':
          requested === page.version ? OFFICE_VIEWER_CACHE_CONTROL : OFFICE_VIEWER_UNCACHED,
        'X-Robots-Tag': 'noindex',
      })
    })

    return app
  }

  return { viewerDocument, resetViewerCache, viewerRoutes }
}
