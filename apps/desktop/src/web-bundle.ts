// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure logic for the `shogo://app/` protocol handler and the packaged
 * web-bundle integrity check. Lives in its own file (rather than
 * `main.ts`) so the desktop unit-test suite can import it without
 * dragging in electron — see `apps/desktop/test-web-bundle.ts`.
 *
 * Three building blocks:
 *
 *  1. STATIC_ASSET_PREFIXES — the URL path roots that hold real on-disk
 *     assets the renderer references by exact filename (Monaco's AMD
 *     chunks under `vs/`, Expo's JS bundles under `_expo/`, the RN
 *     asset registry under `assets/`, and Vite/Rollup hashed output
 *     under `static/`). A miss under any of these is a packaging bug,
 *     not an SPA route.
 *
 *  2. routeShogoRequest(urlPath, webDir, fileExists) — given a URL path
 *     and a web-dir root, decide what the handler should do:
 *       - serve a file from disk,
 *       - return a 404 (asset-shaped path, file missing),
 *       - or fall through to index.html for SPA client-side routing.
 *     Pure function; `fileExists` is injected so tests can fake it.
 *
 *  3. verifyWebBundleIntegrity(webDir, fileStat) — assert the small set
 *     of files the renderer absolutely cannot start without. Pure
 *     function; `fileStat` is injected for testability.
 *
 * Why all this rigour for a static-file handler?  Before the
 * fix/desktop-ide-tab-files-not-loading branch, the protocol handler
 * silently fell through to index.html for *any* missing path. A missing
 * `vs/loader.js` meant Monaco's loader received an HTML payload, parsed
 * it as JS, and rejected with an opaque `error: Event` — and the user
 * saw the IDE editor stuck on "Loading…" forever. The asset-prefix
 * branch in `routeShogoRequest` turns that into a clean 404 at the
 * request line; the integrity check turns it into a clear startup
 * dialog. The unit tests below pin both behaviours.
 */
import path from 'node:path'

export const STATIC_ASSET_PREFIXES = ['vs/', '_expo/', 'assets/', 'static/'] as const

export type RouteDecision =
  | { kind: 'file'; absolutePath: string }
  | { kind: 'not-found'; urlPath: string }
  | { kind: 'spa-fallback'; absolutePath: string }

/**
 * Decide how a `shogo://app/...` request should be served.
 *
 * @param rawUrlPath  The `pathname` of the incoming request (with or without leading slash).
 * @param webDir      Filesystem root that backs the protocol (`resources/web/`).
 * @param fileExists  Predicate that returns true for absolute paths that exist *and are regular files*.
 *                    Injected for testability — production wiring passes a function backed by
 *                    `fs.existsSync(p) && fs.statSync(p).isFile()`.
 */
export function routeShogoRequest(
  rawUrlPath: string,
  webDir: string,
  fileExists: (absolutePath: string) => boolean,
): RouteDecision {
  let urlPath = rawUrlPath.startsWith('/') ? rawUrlPath.slice(1) : rawUrlPath

  // A `shogo://app/` request with no path resolves to index.html — the SPA
  // entry point. There is no `index.html` asset prefix to bypass first.
  if (urlPath === '') {
    return { kind: 'spa-fallback', absolutePath: path.join(webDir, 'index.html') }
  }

  // Defence against `..` traversal. After joining, the resolved absolute
  // path MUST still be inside webDir. We refuse to serve anything that
  // escapes — Electron's protocol handler isn't responsible for this in
  // theory (renderers can't naturally produce `..` in URL paths) but
  // belt-and-suspenders against any future code path that builds requests
  // from untrusted input.
  const absolutePath = path.resolve(webDir, urlPath)
  const webDirResolved = path.resolve(webDir)
  const isInside =
    absolutePath === webDirResolved || absolutePath.startsWith(webDirResolved + path.sep)
  if (!isInside) {
    return { kind: 'not-found', urlPath }
  }

  if (fileExists(absolutePath)) {
    return { kind: 'file', absolutePath }
  }

  // Asset-shaped paths must NOT fall through to index.html. The full
  // history of why is in this file's header. We return a real 404 so the
  // failure is visible at the request line in DevTools instead of being
  // laundered into a downstream parse error.
  if (STATIC_ASSET_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) {
    return { kind: 'not-found', urlPath }
  }

  // Everything else is an SPA client-side route — let the React renderer
  // handle it by serving the app shell.
  return { kind: 'spa-fallback', absolutePath: path.join(webDir, 'index.html') }
}

export interface IntegrityFileStat {
  exists: boolean
  isFile: boolean
  size: number
}

/**
 * Required files under `resources/web/` that the renderer cannot boot
 * without. Sizes calibrated against the monaco-editor version pinned in
 * `apps/mobile/package.json` — see `scripts/sync-web.mjs` for the
 * companion build-time check that uses the same list.
 */
export const REQUIRED_WEB_FILES: ReadonlyArray<{ rel: string; minBytes: number }> = [
  { rel: 'index.html', minBytes: 100 },
  { rel: path.join('vs', 'loader.js'), minBytes: 20_000 },
  { rel: path.join('vs', 'editor', 'editor.main.js'), minBytes: 40_000 },
]

export type IntegrityResult = { ok: true } | { ok: false; missing: string[] }

/**
 * Assert that the packaged web bundle has the files the renderer needs.
 *
 * @param webDir    Path to `resources/web/` (or equivalent dev mirror).
 * @param fileStat  Injected stat function. Production wiring uses
 *                  `fs.existsSync + fs.statSync`; tests pass a fake map.
 */
export function verifyWebBundleIntegrity(
  webDir: string,
  fileStat: (absolutePath: string) => IntegrityFileStat,
): IntegrityResult {
  const missing: string[] = []
  for (const { rel, minBytes } of REQUIRED_WEB_FILES) {
    const absolutePath = path.join(webDir, rel)
    const st = fileStat(absolutePath)
    if (!st.exists || !st.isFile) {
      missing.push(rel)
      continue
    }
    if (st.size < minBytes) {
      missing.push(`${rel} (truncated: ${st.size} bytes < ${minBytes})`)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
