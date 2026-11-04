// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// PreviewManager.requestWebRebuild — the per-edit Expo re-export used by
// workspace runtimes, where the root CanvasBuildManager cannot build a
// member project. The real `expo export` is stubbed; these tests pin the
// debounce / trailing-edge contract.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

// ---------------------------------------------------------------------------
// The export's own writes must not queue the next export (SHO-332)
// ---------------------------------------------------------------------------
//
// A workspace preview writes the preview prefix into `app.json` before the
// export and restores it afterwards, because `expo export` has no base-path
// flag. Both writes hit a `BUILDABLE_PREFIXES` file, so the watcher reported
// them as edits and every finished export immediately started another one —
// an endless `expo export` loop. The manager now remembers the inputs of the
// last landed export and skips a watcher-driven rebuild when the tree is
// unchanged. These tests run a real `_runExpoExportWebImpl` against a fake
// `expo` shim so the app.json patch/restore (and the digest it records) is
// actually exercised.

const ECHO_ROOT = '/tmp/test-preview-manager-expo-echo'
const ECHO_PROJECT = join(ECHO_ROOT, 'project')
const ECHO_COUNTER = join(ECHO_ROOT, 'export-runs.log')
const EXPORT_SETTLE_MS = 900

function writeFakeExpo(cwd: string): void {
  const binDir = join(cwd, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('fs'), path = require('path')",
    'const cwd = process.cwd()',
    "const i = process.argv.indexOf('--output-dir')",
    'const out = path.join(cwd, process.argv[i + 1])',
    'fs.mkdirSync(out, { recursive: true })',
    "fs.writeFileSync(path.join(out, 'index.html'), '<html></html>')",
    `fs.appendFileSync(${JSON.stringify(ECHO_COUNTER)}, 'export\\n')`,
    '',
  ].join('\n')
  const bin = join(binDir, 'expo')
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
}

function exportRuns(): number {
  try {
    return readFileSync(ECHO_COUNTER, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function makeEchoManager() {
  const pm = new PreviewManager({
    workspaceDir: ECHO_PROJECT,
    runtimePort: 8080,
    basePath: '/p/echo-project',
  })
  const internals = pm as any
  internals.resolveDevServer = () => 'metro'
  internals.started = true
  return pm
}

describe('PreviewManager.requestWebRebuild — export echo', () => {
  const originalAppJson = JSON.stringify({ expo: { name: 'echo', slug: 'echo' } }, null, 2) + '\n'

  beforeEach(() => {
    rmSync(ECHO_ROOT, { recursive: true, force: true })
    mkdirSync(join(ECHO_PROJECT, 'app'), { recursive: true })
    writeFileSync(join(ECHO_PROJECT, 'package.json'), JSON.stringify({ name: 'echo-app' }))
    writeFileSync(join(ECHO_PROJECT, 'app.json'), originalAppJson)
    writeFileSync(join(ECHO_PROJECT, 'app', 'index.tsx'), 'export default function Index() { return null }\n')
    writeFakeExpo(ECHO_PROJECT)
  })

  afterEach(() => {
    rmSync(ECHO_ROOT, { recursive: true, force: true })
  })

  test('the app.json base-path patch is restored after the export', async () => {
    const pm = makeEchoManager()
    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)
    expect(exportRuns()).toBe(1)
    expect(readFileSync(join(ECHO_PROJECT, 'app.json'), 'utf8')).toBe(originalAppJson)
  })

  test('the watcher event caused by that restore does not start a second export', async () => {
    const pm = makeEchoManager()
    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)
    expect(exportRuns()).toBe(1)

    // This is exactly what server.ts does when chokidar reports the restored
    // app.json (and the build logs) after the export finished.
    pm.requestWebRebuild()
    await sleep(EXPORT_SETTLE_MS)
    expect(exportRuns()).toBe(1)
  })

  test('a real source edit after the echo is still exported exactly once', async () => {
    const pm = makeEchoManager()
    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)
    expect(exportRuns()).toBe(1)

    writeFileSync(
      join(ECHO_PROJECT, 'app', 'index.tsx'),
      'export default function Index() { return <div>changed</div> }\n',
    )
    pm.requestWebRebuild()
    await sleep(EXPORT_SETTLE_MS)
    expect(exportRuns()).toBe(2)

    // …and its own restore does not echo into a third run.
    pm.requestWebRebuild()
    await sleep(EXPORT_SETTLE_MS)
    expect(exportRuns()).toBe(2)
  })

  test('a user edit to app.json is still exported', async () => {
    const pm = makeEchoManager()
    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)

    const userEdit = JSON.stringify({ expo: { name: 'echo', slug: 'echo', version: '1.0.1' } }, null, 2) + '\n'
    writeFileSync(join(ECHO_PROJECT, 'app.json'), userEdit)
    pm.requestWebRebuild()
    await sleep(EXPORT_SETTLE_MS)

    expect(exportRuns()).toBe(2)
    expect(readFileSync(join(ECHO_PROJECT, 'app.json'), 'utf8')).toBe(userEdit)
  })

  test('an explicit export (boot / /preview/restart) always runs, unchanged inputs or not', async () => {
    const pm = makeEchoManager()
    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)
    expect(exportRuns()).toBe(1)

    await (pm as any).runExpoExportWeb({}, ECHO_PROJECT)
    expect(exportRuns()).toBe(2)
  })
})
