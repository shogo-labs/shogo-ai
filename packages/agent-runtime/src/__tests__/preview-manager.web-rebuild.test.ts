// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// PreviewManager.requestWebRebuild — the per-edit Expo re-export used by
// workspace runtimes, where the root CanvasBuildManager cannot build a
// member project. The real `expo export` is stubbed; these tests pin the
// debounce / trailing-edge contract.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
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
