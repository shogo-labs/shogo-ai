// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas iframe bridge — file lookup helpers.
 *
 * This module owns the *very small* contract between the runtime and the
 * `canvas-bridge.js` asset it serves at `/agent/canvas/bridge.js`:
 *
 *   - `CANVAS_BRIDGE_PATH` is the filesystem path the runtime expects the
 *     bridge to live at, resolved relative to `__dirname` of this module.
 *     In dev that's `packages/agent-runtime/src/`, so the path is
 *     `packages/agent-runtime/static/canvas-bridge.js`. In a bundled binary
 *     it's `dist/static/canvas-bridge.js`, in the Desktop electron bundle
 *     it's `resources/static/canvas-bridge.js`.
 *   - `loadCanvasBridgeSource(path?)` reads that file and returns its
 *     contents, or — if the file is missing — a valid-JS stub IIFE plus a
 *     `console.warn`. The stub keeps `GET /agent/canvas/bridge.js` honest
 *     (200 with parseable JS) but silently disables the "Update available
 *     — Refresh" pill inside every workspace iframe.
 *
 * Lives in its own module (not `server.ts`) so unit + integration tests
 * can exercise it without booting the agent runtime, config layer, AI
 * proxy, etc. See `__tests__/canvas-bridge-loader.test.ts` for the
 * loader-level invariants and
 * `__tests__/binary-ships-canvas-bridge.integration.test.ts` for the
 * Desktop bundle ↔ runtime wiring assertion.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CANVAS_BRIDGE_URL = '/agent/canvas/bridge.js'
export const CANVAS_BRIDGE_SCRIPT_TAG = `<script src="${CANVAS_BRIDGE_URL}" defer></script>`

/**
 * Where the bridge lives on disk. Three resolution strategies, in order:
 *
 *  1. `CANVAS_BRIDGE_DIR` env override - an explicit absolute directory that
 *     holds `canvas-bridge.js`, for runtime layouts where the formulas below
 *     don't resolve correctly (e.g. non-standard bundle roots). Set by the
 *     Desktop shell (`apps/desktop/src/local-server.ts`) so the location is
 *     observable via `env | grep CANVAS_BRIDGE` when debugging.
 *
 *  2. `join(__dirname, '..', 'static', 'canvas-bridge.js')` - the
 *     sibling-of-runtime-dir layout that holds for Cloud (runs
 *     `src/server.ts`, so `packages/agent-runtime/static/...`) and the
 *     Desktop JS-bundle path (runs `resources/bundle/agent-runtime.js`,
 *     so `resources/static/...`, shipped by `bundle-api.mjs` per PR #677).
 *
 *  3. `join(dirname(process.execPath), '..', 'static', 'canvas-bridge.js')` -
 *     the compiled-binary layout. Desktop ships the runtime as a standalone
 *     `bun build --compile` executable (`resources/bundle/agent-runtime`),
 *     and inside such a binary `__dirname` is the *build machine's* source
 *     path (e.g. `/Users/runner/work/shogo-ai/.../packages/agent-runtime/src`),
 *     which does not exist on the user's disk. Strategy 2 therefore fails,
 *     the loader served the `canvas-bridge.js missing` stub, the iframe
 *     never posted `canvas-ready`, and the Desktop canvas sat on
 *     "Loading preview…" forever even though the app was served fine at
 *     its localhost URL (Sept 2026). `process.execPath` IS the real binary
 *     path at runtime, and `resources/static/` is its sibling directory.
 *
 * Strategies 2 and 3 are only chosen when the file actually exists; if
 * neither does we fall back to the strategy-2 path so the loader's
 * missing-file warning names the location we expected to ship to.
 *
 * See the integration test for the contract.
 */
export function resolveCanvasBridgePath(
  env: Record<string, string | undefined> = process.env,
  {
    execPath = process.execPath,
    moduleDir = __dirname,
  }: { execPath?: string; moduleDir?: string } = {},
): string {
  const override = env.CANVAS_BRIDGE_DIR?.trim()
  if (override) return join(override, 'canvas-bridge.js')

  const sibling = join(moduleDir, '..', 'static', 'canvas-bridge.js')
  if (existsSync(sibling)) return sibling

  // Compiled-binary sidecar candidate. Guarded so a stubbed `process` in
  // tests (or an exotic host without `execPath`) can't crash the runtime.
  try {
    if (execPath) {
      const adjacent = join(dirname(execPath), '..', 'static', 'canvas-bridge.js')
      if (existsSync(adjacent)) return adjacent
    }
  } catch { /* execPath unavailable */ }

  return sibling
}

export const CANVAS_BRIDGE_PATH = resolveCanvasBridgePath()

/**
 * Canonical fallback body served when `CANVAS_BRIDGE_PATH` cannot be read.
 * Kept stable so ops can grep for `canvas-bridge.js missing` in shipped
 * builds to diagnose this regression class. Don't reshape casually — the
 * loader unit test pins the exact string.
 */
export const CANVAS_BRIDGE_MISSING_STUB = '/* canvas-bridge.js missing */ (function () {})();\n'

export function loadCanvasBridgeSource(path: string = CANVAS_BRIDGE_PATH): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    console.warn(`[canvas-bridge] Failed to load ${path}:`, (err as Error).message)
    // Empty IIFE keeps the route honest (returns 200 with valid JS) even
    // when the bridge file is missing — the canvas just won't show update
    // toasts. The Desktop bundle regression (May 2026) hid behind exactly
    // this fallback: `bundle-api.mjs` shipped the runtime without
    // `static/canvas-bridge.js`, so this branch fired silently in
    // production and the "Update available — Refresh" pill never appeared.
    return CANVAS_BRIDGE_MISSING_STUB
  }
}
