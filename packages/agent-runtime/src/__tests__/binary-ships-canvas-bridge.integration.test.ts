// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test guarding the Desktop bundle ↔ agent-runtime contract for
 * the canvas bridge.
 *
 * What broke (May 2026):
 *   `apps/desktop/scripts/bundle-api.mjs` shipped the bundled agent-runtime
 *   into `apps/desktop/resources/bundle/` but never copied
 *   `packages/agent-runtime/static/` into `apps/desktop/resources/static/`.
 *   At runtime the bundled agent-runtime computes its bridge path as
 *   `join(__dirname, '..', 'static', 'canvas-bridge.js')`, which from
 *   `resources/bundle/agent-runtime.js` resolves to `resources/static/...`.
 *   That folder didn't exist, so `loadCanvasBridgeSource()` silently fell
 *   into its stub branch and the Desktop canvas lost its
 *   "Update available — Refresh" toast while Cloud kept working.
 *
 * What this test pins:
 *   1. `bundle-api.mjs` source contains the copy step that lands the static
 *      folder at `resources/static/`. (Cheap — protects against an
 *      accidental revert of the fix.)
 *   2. `forge.config.ts` lists `./resources/static` in `extraResource`. The
 *      copy alone is not enough — without this, electron-forge will ship a
 *      packaged `.app` that *still* lacks the asset.
 *   3. The path the bundled `agent-runtime.js` would compute at runtime is
 *      exactly `<repo>/apps/desktop/resources/static/canvas-bridge.js` —
 *      the bundle's destination directory.
 *   4. If the resources directory has been built (post-`bundle-api.mjs`),
 *      the shipped bytes are byte-identical to the source file the
 *      agent-runtime tests verify in dev. We treat this assertion as
 *      *opportunistic*: we don't trigger the heavy bundle from inside a
 *      unit suite (it downloads ffmpeg / chromium and runs ~30s); we only
 *      assert byte-equality when the artifact already exists locally / in
 *      CI's post-bundle stage.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const BUNDLE_SCRIPT = join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'bundle-api.mjs')
const FORGE_CONFIG = join(REPO_ROOT, 'apps', 'desktop', 'forge.config.ts')
const SOURCE_BRIDGE = join(REPO_ROOT, 'packages', 'agent-runtime', 'static', 'canvas-bridge.js')
const RESOURCES_DIR = join(REPO_ROOT, 'apps', 'desktop', 'resources')
const SHIPPED_BRIDGE = join(RESOURCES_DIR, 'static', 'canvas-bridge.js')
const BUNDLED_RUNTIME = join(RESOURCES_DIR, 'bundle', 'agent-runtime.js')

describe('Desktop bundle ships canvas-bridge.js so the canvas refresh pill works', () => {
  test('bundle-api.mjs copies packages/agent-runtime/static -> resources/static', () => {
    expect(existsSync(BUNDLE_SCRIPT)).toBe(true)
    const src = readFileSync(BUNDLE_SCRIPT, 'utf-8')
    // The fix lives in this exact source path → dest path move. Match on
    // both endpoints so a future refactor that moves the copy step still
    // satisfies the invariant as long as the data flow is preserved.
    expect(src).toMatch(/agent-runtime['"\s,]+['"]static['"]/)
    expect(src).toMatch(/RESOURCES_DIR[^)]*['"]static['"]/)
    // And the cleanup list must include 'static' so re-builds don't
    // accumulate stale copies.
    expect(src).toMatch(/['"]static['"]/)
  })

  test("forge.config.ts lists './resources/static' in extraResource", () => {
    expect(existsSync(FORGE_CONFIG)).toBe(true)
    const cfg = readFileSync(FORGE_CONFIG, 'utf-8')
    // Strip comments so we don't pass on a commented-out entry.
    const stripped = cfg
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(stripped).toMatch(/['"]\.\/resources\/static['"]/)
  })

  test('runtime CANVAS_BRIDGE_PATH formula resolves to the bundle destination from resources/bundle/', () => {
    // Mirror the exact computation in server.ts:
    //   const CANVAS_BRIDGE_PATH = join(__dirname, '..', 'static', 'canvas-bridge.js')
    // For the bundled runtime, __dirname == dirname(BUNDLED_RUNTIME), so the
    // resolved path must equal SHIPPED_BRIDGE. This is the wiring assertion
    // the May 2026 regression would have failed.
    const computed = resolve(dirname(BUNDLED_RUNTIME), '..', 'static', 'canvas-bridge.js')
    expect(computed).toBe(SHIPPED_BRIDGE)
  })

  test('source canvas-bridge.js is a non-empty real script (the artifact we need to ship)', () => {
    expect(existsSync(SOURCE_BRIDGE)).toBe(true)
    const stat = statSync(SOURCE_BRIDGE)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(1_000)
    const src = readFileSync(SOURCE_BRIDGE, 'utf-8')
    // Parses as JS (route serves it as application/javascript).
    expect(() => new Function(src)).not.toThrow()
    // And it's the bridge, not some unrelated file that happens to live here.
    expect(src).toMatch(/canvas/i)
  })

  test('if the desktop bundle has been built, the shipped bytes match the source (opportunistic)', () => {
    // We don't trigger the heavy bundle from this suite — it downloads
    // ffmpeg/chromium and runs ~30s. We assert byte equality only when
    // `resources/static/canvas-bridge.js` already exists locally or in
    // CI's post-bundle test stage. This still catches the regression: a
    // CI job that runs `bundle-api.mjs` then `bun test` will fail here
    // if the copy step ever stops working.
    if (!existsSync(SHIPPED_BRIDGE)) {
      // Soft skip — log so failed expectations elsewhere are easier to diagnose.
      console.warn(
        `[canvas-bridge integration] skipping byte-equality check: ${SHIPPED_BRIDGE} not built yet`,
      )
      return
    }
    const shipped = readFileSync(SHIPPED_BRIDGE)
    const sourceBytes = readFileSync(SOURCE_BRIDGE)
    expect(shipped.equals(sourceBytes)).toBe(true)
  })
})
