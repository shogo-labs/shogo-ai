// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// PreviewManager.requestWebRebuild — the per-edit Expo re-export used by
// workspace runtimes, where the root CanvasBuildManager cannot build a
// member project. The real `expo export` is stubbed; these tests pin the
// debounce / trailing-edge contract.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PreviewManager } from '../preview-manager'

const TEST_DIR = '/tmp/test-preview-manager-web-rebuild'
const SETTLE_MS = 650

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeManager(opts: { devServer?: string; started?: boolean } = {}) {
  const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080 })
  const internals = pm as any
  internals.resolveDevServer = () => opts.devServer ?? 'metro'
  internals.started = opts.started ?? true
  const exports: Array<() => void> = []
  let count = 0
  const testExportKey = 'test-export'
  internals.runExpoExportWeb = () => {
    count++
    const p = new Promise<void>((resolve) => exports.push(resolve))
    internals.expoExportInFlight.set(testExportKey, p)
    void p.finally(() => {
      internals.expoExportInFlight.delete(testExportKey)
    })
    return p
  }
  return {
    pm,
    exportCount: () => count,
    finishExport: () => exports.shift()?.(),
  }
}

describe('PreviewManager.requestWebRebuild', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'fixture' }))
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('coalesces a burst of edits into one export', async () => {
    const { pm, exportCount, finishExport } = makeManager()
    for (let i = 0; i < 5; i++) pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(1)
    finishExport()
  })

  test('an edit during a running export queues exactly one more export', async () => {
    const { pm, exportCount, finishExport } = makeManager()
    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(1)

    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(1)

    finishExport()
    await sleep(10)
    expect(exportCount()).toBe(2)
    finishExport()
    await sleep(10)
    expect(exportCount()).toBe(2)
  })

  test('waits for a lifecycle export already in flight, then re-exports', async () => {
    const { pm, exportCount, finishExport } = makeManager({ started: false })
    let releaseBoot!: () => void
    const internals = pm as any
    const bootExport = new Promise<void>((r) => { releaseBoot = r })
    internals.expoExportInFlight.set('boot-export', bootExport)

    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(0)

    internals.expoExportInFlight.delete('boot-export')
    releaseBoot()
    await sleep(10)
    expect(exportCount()).toBe(1)
    finishExport()
  })

  test('no-op for a manager that was never started', async () => {
    const { pm, exportCount } = makeManager({ started: false })
    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(0)
  })

  test('no-op for Vite stacks', async () => {
    const { pm, exportCount } = makeManager({ devServer: 'vite' })
    pm.requestWebRebuild()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(0)
  })

  test('stop() cancels a pending debounced rebuild', async () => {
    const { pm, exportCount } = makeManager()
    pm.requestWebRebuild()
    pm.stop()
    await sleep(SETTLE_MS)
    expect(exportCount()).toBe(0)
  })
})

describe('PreviewManager.requestWebRebuild — app.json base-path self-writes', () => {
  const APP_JSON = JSON.stringify({ expo: { name: 'fixture' } }, null, 2) + '\n'
  const COUNT_FILE = join(TEST_DIR, 'export-count')
  const PATCHED_SEEN = join(TEST_DIR, 'patched-seen')

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'fixture' }))
    writeFileSync(join(TEST_DIR, 'app.json'), APP_JSON)
    const fakeExpo = join(TEST_DIR, 'fake-expo')
    // Args: export --platform web --output-dir <dir>
    writeFileSync(
      fakeExpo,
      [
        '#!/bin/sh',
        `cp app.json "${PATCHED_SEEN}"`,
        `echo x >> "${COUNT_FILE}"`,
        'mkdir -p "$5" && echo "<html></html>" > "$5/index.html"',
      ].join('\n'),
    )
    chmodSync(fakeExpo, 0o755)
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function makeRealExportManager() {
    const pm = new PreviewManager({ workspaceDir: TEST_DIR, runtimePort: 8080, basePath: '/workspace-preview/p1/' })
    const internals = pm as any
    internals.resolveDevServer = () => 'metro'
    internals.started = true
    internals.resolveExpoBin = () => join(TEST_DIR, 'fake-expo')
    const exportCount = () =>
      existsSync(COUNT_FILE) ? readFileSync(COUNT_FILE, 'utf8').trim().split('\n').length : 0
    return { pm, exportCount }
  }

  test('the export patching and restoring app.json does not queue another export', async () => {
    const { pm, exportCount } = makeRealExportManager()
    pm.requestWebRebuild('src/App.tsx')
    await sleep(SETTLE_MS + 500)
    expect(exportCount()).toBe(1)
    expect(readFileSync(PATCHED_SEEN, 'utf8')).toContain('"baseUrl": "/workspace-preview/p1"')
    expect(readFileSync(join(TEST_DIR, 'app.json'), 'utf8')).toBe(APP_JSON)

    // The watcher reports both self-writes once they settle.
    pm.requestWebRebuild('app.json')
    pm.requestWebRebuild('app.json')
    await sleep(SETTLE_MS + 500)
    expect(exportCount()).toBe(1)
  })

  test('a real app.json edit still triggers an export', async () => {
    const { pm, exportCount } = makeRealExportManager()
    pm.requestWebRebuild('src/App.tsx')
    await sleep(SETTLE_MS + 500)
    expect(exportCount()).toBe(1)

    writeFileSync(join(TEST_DIR, 'app.json'), JSON.stringify({ expo: { name: 'renamed' } }, null, 2) + '\n')
    pm.requestWebRebuild('app.json')
    await sleep(SETTLE_MS + 500)
    expect(exportCount()).toBe(2)
  })
})
