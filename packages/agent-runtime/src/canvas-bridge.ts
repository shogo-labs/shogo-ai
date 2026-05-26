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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CANVAS_BRIDGE_URL = '/agent/canvas/bridge.js'
export const CANVAS_BRIDGE_SCRIPT_TAG = `<script src="${CANVAS_BRIDGE_URL}" defer></script>`
export const CANVAS_BRIDGE_PATH = join(__dirname, '..', 'static', 'canvas-bridge.js')

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
