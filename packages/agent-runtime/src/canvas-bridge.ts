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

/**
 * Where the bridge lives on disk. Two resolution strategies, in order:
 *
 *  1. `CANVAS_BRIDGE_DIR` env override - an explicit absolute directory that
 *     holds `canvas-bridge.js`. Used by the Desktop microVM, where the
 *     bundled runtime boots from `/opt/shogo/server.js` and the sibling
 *     formula below would resolve to `/opt/static/...` - a path the seed ISO
 *     never populates. The VM boot (`apps/desktop/src/vm/cloud-init.ts`)
 *     extracts the bridge into `/opt/shogo/static` and points this var at it,
 *     exactly the way it injects `TREE_SITTER_WASM_DIR=/opt/shogo/wasm`.
 *
 *  2. `join(__dirname, '..', 'static', 'canvas-bridge.js')` - the
 *     sibling-of-runtime-dir layout that holds for Cloud (runs
 *     `src/server.ts`, so `packages/agent-runtime/static/...`) and the
 *     Desktop host-execution path (runs `resources/bundle/agent-runtime.js`,
 *     so `resources/static/...`, shipped by `bundle-api.mjs` per PR #677).
 *     Left untouched so those two targets behave identically to before.
 *
 * Before this override existed, the Desktop VM - the default runtime path on
 * VM-capable hardware - always fell into the empty stub, so the
 * "Update available - Refresh" pill never appeared there even though PR #677
 * fixed the host-execution path. See the integration test for the contract.
 */
export function resolveCanvasBridgePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.CANVAS_BRIDGE_DIR?.trim()
  if (override) return join(override, 'canvas-bridge.js')
  return join(__dirname, '..', 'static', 'canvas-bridge.js')
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
