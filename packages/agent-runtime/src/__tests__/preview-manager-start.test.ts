// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression tests for `PreviewManager.start()` non-blocking refactor.
//
// Before 2026-05-11: pm.start() awaited `runSetupTasks` on the cold path
// (no prebuilt dist/), which in turn called `pkg.prismaGenerate` and
// `pkg.prismaDbPush` via execSync. Both held the JS event loop for
// ~3-5s each, blocking /pool/assign in the warm-pool runtime pod.
//
// After: pm.start() always schedules `backgroundSetup` and returns
// immediately. These tests pin that promise:
//
//   - start() returns in <250ms even when installDeps/prisma/build each
//     take >500ms (fast return guarantee for /pool/assign callers).
//   - getStatus().phase is set synchronously before start() returns:
//     'ready' when dist/ is prebuilt, 'building' otherwise.
//   - phase eventually becomes 'ready' after the stubbed background
//     work completes.
//   - the second start() call short-circuits via the `started` guard.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PreviewManager } from '../preview-manager'

// Helper: build a minimal Vite-shaped workspace.
function makeWorkspace(opts: { prebuiltDist?: boolean; hasPrisma?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'shogo-pm-start-test-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test', dependencies: {} }),
  )
  if (opts.hasPrisma) {
    mkdirSync(join(root, 'prisma'), { recursive: true })
    writeFileSync(
      join(root, 'prisma', 'schema.prisma'),
      'generator client { provider = "prisma-client-js" }\n',
    )
  }
  if (opts.prebuiltDist) {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>')
  }
  return root
}

// Helper: replace the heavy private methods on a PreviewManager instance
// with stubs that take `delayMs` to settle. We shadow the prototype
// methods by writing to the instance, which is allowed because nothing
// in PreviewManager freezes its own instance.
function stubBackgroundWork(pm: PreviewManager, delayMs: number, hits: string[]) {
  const sleep = (label: string) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        hits.push(label)
        resolve()
      }, delayMs)
    })

  ;(pm as any).installDepsIfNeeded = async (_timings: any) => sleep('install')
  ;(pm as any).runPrismaIfNeeded = async (_timings: any) => sleep('prisma')
  // startBuildWatch / startApiServer touch real subprocesses — stub both
  // so the test never spawns vite / bun run server.tsx.
  ;(pm as any).startBuildWatch = async () => sleep('build')
  ;(pm as any).startApiServer = async () => sleep('api')
}

let workspaces: string[] = []

afterEach(() => {
  for (const ws of workspaces) {
    if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  }
  workspaces = []
})

beforeEach(() => {
  workspaces = []
})

describe('PreviewManager.start (non-blocking)', () => {
  test('returns in <250ms even when background work takes >500ms each', async () => {
    const root = makeWorkspace({ prebuiltDist: false, hasPrisma: true })
    workspaces.push(root)

    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const hits: string[] = []
    stubBackgroundWork(pm, 600, hits)

    const t0 = Date.now()
    const result = await pm.start()
    const elapsed = Date.now() - t0

    // Fast-return guarantee: this is the staging /pool/assign p95 budget.
    expect(elapsed).toBeLessThan(250)
    expect(result.mode).toBe('background-build')

    // Background work has NOT completed yet.
    expect(hits.length).toBe(0)
    expect(pm.getStatus().phase).toBe('building')

    // Wait for background setup to finish (4 stubs × 600ms = ~2.4s).
    await new Promise((r) => setTimeout(r, 3_000))

    expect(hits).toContain('install')
    expect(hits).toContain('prisma')
    expect(hits).toContain('build')
    expect(hits).toContain('api')
    expect(pm.getStatus().phase).toBe('ready')
  })

  test('prebuilt dist/ marks ready immediately and keeps it ready through bg setup', async () => {
    const root = makeWorkspace({ prebuiltDist: true, hasPrisma: true })
    workspaces.push(root)

    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const hits: string[] = []
    stubBackgroundWork(pm, 200, hits)

    const t0 = Date.now()
    const result = await pm.start()
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(250)
    expect(result.mode).toBe('prebuilt-dist')
    // Synchronous: ready BEFORE background work runs (because dist/ is
    // already on disk; the user can render the iframe immediately).
    expect(pm.getStatus().phase).toBe('ready')

    // After background work completes the phase must stay 'ready' — a
    // regression that flips it back to 'idle' / 'building' would defeat
    // the entire prebuilt-dist optimization.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(pm.getStatus().phase).toBe('ready')
    expect(hits.length).toBe(4)
  })

  test('second start() short-circuits via the already-started guard', async () => {
    const root = makeWorkspace({ prebuiltDist: true, hasPrisma: false })
    workspaces.push(root)

    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    stubBackgroundWork(pm, 50, [])

    await pm.start()
    const t0 = Date.now()
    const second = await pm.start()
    const elapsed = Date.now() - t0

    expect(second.mode).toBe('already-running')
    expect(elapsed).toBeLessThan(50)
  })

  test('no package.json → start() returns mode=no-project without scheduling bg work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-pm-no-pkg-'))
    workspaces.push(root)

    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const hits: string[] = []
    stubBackgroundWork(pm, 10, hits)

    const result = await pm.start()
    expect(result.mode).toBe('no-project')

    // Generous wait — background work would have completed in 40ms if
    // it were scheduled. We assert nothing ran.
    await new Promise((r) => setTimeout(r, 200))
    expect(hits.length).toBe(0)
  })
})
