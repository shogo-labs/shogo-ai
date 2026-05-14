// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression: `runWorkspaceInstall` must guarantee that `bun install`
// runs at most once per workspace at a time, even when multiple boot
// paths invoke it concurrently.
//
// Why this matters (staging 2026-05-13, project 865f99fa)
// -------------------------------------------------------
// `agent-runtime/src/server.ts` has TWO independent code paths that
// each decide whether to run `bun install`:
//
//   Path A: initializeEssentials → fire-and-forget `pm.start()` →
//           `PreviewManager.installDepsIfNeeded` (frozen=false)
//   Path B: startGateway → `await s3Sync.waitForDeps()` →
//           `ensureWorkspaceDeps` (frozen=true)
//
// On a fresh import where the deps-cache pointer is missing (404), both
// paths observe the warm pool's stale Vite `node_modules/` (missing
// every Expo dep) and both decide to install. Bun 1.3.x's atomic
// hardlink/copy installer is NOT safe under concurrent execution
// against the same `node_modules/`; the two installs stomp on each
// other's temp files. The first install dies with:
//   "FileNotFound: copying file dist/WasmPanicRegistry.js"
// (a `@prisma/internals` dist file that the *other* install was
// mid-extracting). Without `expo` actually installed, no static
// `dist/` is produced and the iframe stays at 404.
//
// `runWorkspaceInstall` keeps a process-wide map of in-flight installs
// keyed by absolute cwd. The first caller spawns `pkg.installAsync`;
// any concurrent caller for the same dir joins that promise. This
// test pins that contract.
//
// Run: bun test packages/agent-runtime/src/__tests__/run-workspace-install-mutex.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Track each call to `pkg.installAsync` and arrange for the test to
// control when each call resolves — that's what lets us verify the
// mutex serializes overlapping callers without actually running bun.
type Pending = { dir: string; opts: any; resolve: () => void; reject: (err: Error) => void }
const installCalls: Pending[] = []

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    installAsync: (dir: string, opts: any) =>
      new Promise<void>((resolve, reject) => {
        installCalls.push({ dir, opts, resolve, reject })
      }),
    installSync: () => {
      throw new Error('test-stub: installSync should not be reached')
    },
  },
}))

const { runWorkspaceInstall, _resetWorkspaceInstallMutex } = await import(
  '../workspace-defaults'
)

let TMP: string

beforeEach(() => {
  installCalls.length = 0
  _resetWorkspaceInstallMutex()
  TMP = mkdtempSync(join(tmpdir(), 'shogo-install-mutex-'))
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('runWorkspaceInstall — concurrent-call mutex', () => {
  test('two concurrent calls for the same dir share ONE pkg.installAsync', async () => {
    const p1 = runWorkspaceInstall(TMP, { frozen: false })
    const p2 = runWorkspaceInstall(TMP, { frozen: true })

    // Give the microtask queue a tick so both calls have entered
    // `runWorkspaceInstall` and registered with the mutex.
    await Promise.resolve()
    await Promise.resolve()

    // Only one underlying install must be in flight.
    expect(installCalls.length).toBe(1)
    // The first caller's options win — the second was queued.
    expect(installCalls[0].opts).toEqual({ frozen: false })

    // Resolve the in-flight install. Both joined callers should
    // see the same successful resolution.
    installCalls[0].resolve()
    await expect(p1).resolves.toBeUndefined()
    await expect(p2).resolves.toBeUndefined()

    // Still exactly one underlying call.
    expect(installCalls.length).toBe(1)
  })

  test('a third call AFTER the in-flight one settles spawns a NEW install', async () => {
    const p1 = runWorkspaceInstall(TMP, { frozen: false })
    await Promise.resolve()
    expect(installCalls.length).toBe(1)
    installCalls[0].resolve()
    await p1

    // Once the first promise has settled, the mutex slot is released.
    // A subsequent call must spawn a fresh install (no stale joining).
    const p2 = runWorkspaceInstall(TMP, { frozen: true })
    await Promise.resolve()
    expect(installCalls.length).toBe(2)
    installCalls[1].resolve()
    await p2
  })

  test('a failure in the in-flight install propagates to ALL joined callers', async () => {
    // Capture both promises' outcomes up front. Bun (correctly) flags an
    // "unhandled rejection" if a rejection becomes observable before any
    // .catch / await chain is attached, even if a later `await
    // expect().rejects` would have caught it. Attaching `.then(ok,err)`
    // immediately after creating each promise sidesteps that race
    // without changing what we're asserting.
    const outcome = (p: Promise<void>) =>
      p.then(
        () => ({ ok: true as const }),
        (err: Error) => ({ ok: false as const, err }),
      )

    const o1 = outcome(runWorkspaceInstall(TMP, { frozen: false }))
    const o2 = outcome(runWorkspaceInstall(TMP, { frozen: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(installCalls.length).toBe(1)

    const err = new Error('FileNotFound: copying file dist/WasmPanicRegistry.js')
    installCalls[0].reject(err)

    // Both joined callers see the same rejection — the second caller
    // should NOT silently observe success while the first observes
    // failure.
    const r1 = await o1
    const r2 = await o2
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    if (!r1.ok) expect(r1.err.message).toMatch(/WasmPanicRegistry/)
    if (!r2.ok) expect(r2.err.message).toMatch(/WasmPanicRegistry/)

    // After failure the slot is released, so a recovery caller can
    // start a fresh install.
    const p3 = runWorkspaceInstall(TMP, { frozen: false })
    await Promise.resolve()
    expect(installCalls.length).toBe(2)
    installCalls[1].resolve()
    await p3
  })

  test('different workspaces do NOT share the mutex', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'shogo-install-mutex-A-'))
    const dirB = mkdtempSync(join(tmpdir(), 'shogo-install-mutex-B-'))
    try {
      const pA = runWorkspaceInstall(dirA, { frozen: false })
      const pB = runWorkspaceInstall(dirB, { frozen: false })
      await Promise.resolve()
      await Promise.resolve()
      // Two independent workspaces → two independent in-flight installs.
      expect(installCalls.length).toBe(2)
      installCalls[0].resolve()
      installCalls[1].resolve()
      await pA
      await pB
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})
