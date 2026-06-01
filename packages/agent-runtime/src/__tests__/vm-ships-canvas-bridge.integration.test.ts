// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test guarding the Desktop microVM <-> agent-runtime contract for
 * the canvas bridge.
 *
 * What broke (and survived PR #677):
 *   PR #677 fixed the Desktop *host-execution* path - it shipped
 *   `canvas-bridge.js` into `resources/static/` so the runtime launched from
 *   `resources/bundle/agent-runtime.js` could find it. But the default
 *   runtime path on VM-capable hardware is the microVM: the bundled runtime
 *   boots from `/opt/shogo/server.js`, where
 *   `join(__dirname, '..', 'static', 'canvas-bridge.js')` resolves to
 *   `/opt/static/canvas-bridge.js` - a path the seed ISO never populated.
 *   So the in-VM runtime fell into the empty-IIFE stub and the
 *   "Update available - Refresh" pill never appeared on real Desktop installs
 *   even after PR #677 shipped (it's present in v1.9.1, yet still broken).
 *
 * Root fix (pinned here):
 *   1. `prepare-bundle.ts` copies `static/canvas-bridge.js` into the VM
 *      bundle's `static/` dir so it can be embedded in the seed ISO.
 *   2. Both VM managers embed `canvas-bridge.js` into the seed ISO.
 *   3. `cloud-init.ts` extracts it into `/opt/shogo/static` AND sets
 *      `CANVAS_BRIDGE_DIR=/opt/shogo/static`.
 *   4. The loader honors `CANVAS_BRIDGE_DIR` (covered in the unit suite), so
 *      these three values line up end-to-end.
 *
 * These are source-level assertions (same approach as
 * `binary-ships-canvas-bridge.integration.test.ts`): cheap, and they fail the
 * moment any leg of the wiring is reverted.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const VM_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src', 'vm')
const PREPARE_BUNDLE = join(VM_DIR, 'prepare-bundle.ts')
const CLOUD_INIT = join(VM_DIR, 'cloud-init.ts')
const DARWIN_MGR = join(VM_DIR, 'darwin-vm-manager.ts')
const WIN32_MGR = join(VM_DIR, 'win32-vm-manager.ts')

const GUEST_STATIC_DIR = '/opt/shogo/static'

describe('Desktop microVM ships canvas-bridge.js so the in-VM canvas refresh pill works', () => {
  test('prepare-bundle.ts copies static/canvas-bridge.js into the VM bundle', () => {
    expect(existsSync(PREPARE_BUNDLE)).toBe(true)
    const src = readFileSync(PREPARE_BUNDLE, 'utf-8')
    expect(src).toMatch(/agent-runtime\/static\/canvas-bridge\.js/)
    // Lands in a `static/` subdir of the bundle (where the managers look).
    expect(src).toMatch(/join\(\s*destDir\s*,\s*['"]static['"]\s*\)/)
  })

  test('both VM managers embed canvas-bridge.js into the seed ISO', () => {
    for (const mgr of [DARWIN_MGR, WIN32_MGR]) {
      expect(existsSync(mgr)).toBe(true)
      const src = readFileSync(mgr, 'utf-8')
      // Reads <bundleDir>/static/canvas-bridge.js and keys it as the flat
      // seed-ISO filename the cloud-init extraction loop matches on.
      expect(src).toMatch(/['"]static['"]\s*,\s*['"]canvas-bridge\.js['"]/)
      expect(src).toMatch(/files\[['"]canvas-bridge\.js['"]\]/)
    }
  })

  test('cloud-init.ts routes canvas-bridge.js to /opt/shogo/static', () => {
    expect(existsSync(CLOUD_INIT)).toBe(true)
    const src = readFileSync(CLOUD_INIT, 'utf-8')
    // The seed-extraction case must have a dedicated branch for the bridge
    // that lands it in /opt/shogo/static (not the /opt/shogo catch-all).
    expect(src).toMatch(/\*canvas-bridge\.js\)\s*cp\s+"\$f"\s+\/opt\/shogo\/static\//)
    // The dir must be created before files are copied into it.
    expect(src).toMatch(/mkdir -p \/opt\/shogo\/wasm \/opt\/shogo\/static/)
  })

  test('cloud-init.ts injects CANVAS_BRIDGE_DIR matching the extraction dir', () => {
    const src = readFileSync(CLOUD_INIT, 'utf-8')
    expect(src).toContain(`CANVAS_BRIDGE_DIR=${GUEST_STATIC_DIR}`)
    // And it's whitelisted out of the skip set so a caller-supplied env can't
    // silently shadow / drop it.
    expect(src).toMatch(/skip\s*=\s*new Set\([^)]*['"]CANVAS_BRIDGE_DIR['"]/s)
  })

  test('loader override target equals the dir cloud-init populates (no drift)', () => {
    // The dir cloud-init copies the bridge into must be the same dir it tells
    // the runtime to read from - otherwise the file ships but is never found.
    const cloud = readFileSync(CLOUD_INIT, 'utf-8')
    const copiesInto = /cp\s+"\$f"\s+(\/opt\/shogo\/static)\//.exec(cloud)?.[1]
    const pointsAt = /CANVAS_BRIDGE_DIR=(\/opt\/shogo\/static)\b/.exec(cloud)?.[1]
    expect(copiesInto).toBe(GUEST_STATIC_DIR)
    expect(pointsAt).toBe(GUEST_STATIC_DIR)
    expect(copiesInto).toBe(pointsAt)
  })
})
