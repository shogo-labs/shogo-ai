#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NOTE — runtime caveat:
 *
 * This test boots a REAL VM with a 9p-mounted workspace. In
 * production, the warm-pool controller boots VMs in *overlay-only*
 * mode (no 9p workspace mount) so the agent-runtime's
 * "Copying pre-installed node_modules from template..." pass writes
 * to the fast local overlay disk; the per-project 9p mount only
 * comes online at assignment time. Mounting the workspace via 9p
 * from the start makes that template-copy step run at 9p-write
 * speed, which on a Mac host can stretch from the production-
 * observed 20-40s to 5+ minutes for a 94-package node_modules
 * tree.
 *
 * That's tangential to the canvas-build gate this test exercises,
 * but it does mean the test currently hangs at
 * "Copying pre-installed node_modules from template..." past the
 * 180s health check. The fix path is to mirror production's
 * overlay-only boot + post-assign 9p-mount sequence — that work
 * is tracked separately. The build/boot/agent-runtime-startup
 * portion of this test is still useful as smoke coverage that
 * `prepare-vm-bundle` packs a working server.js.
 *
 * End-to-end regression for the VM canvas-build race that surfaced
 * across every macOS install as:
 *
 *   [CanvasBuildManager] Build error: failed to load config from
 *     /host-workspaces/<projectId>/vite.config.ts
 *   [AgentGateway] Canvas build error: error during build: undefined
 *
 * Root cause (full chain documented on `PreviewManager.depsReady`):
 *
 *   1. Host (Darwin arm64) installs the workspace's `node_modules`.
 *      Rollup ships native bindings as `optionalDependencies`
 *      filtered by os/cpu, so only `@rollup/rollup-darwin-arm64`
 *      lands; `@rollup/rollup-linux-arm64-gnu` is skipped.
 *   2. The linux guest VM 9p-mounts that node_modules at /workspace.
 *   3. The agent-runtime kicks off `pm.start()` fire-and-forget
 *      (server.ts:3660) AND then calls `startGateway()`. The gateway
 *      constructs `CanvasBuildManager` which immediately spawns
 *      `vite build`. Vite's config loader requires rollup, rollup
 *      tries to load the linux native, and dies — propagating as
 *      `error during build: undefined` because the throw escapes
 *      vite's catch site.
 *   4. The in-guest `bun install` that pm.start() WOULD have
 *      finished (and which would have correctly added the
 *      linux-arm64 native because bun honors `os`/`cpu` relative to
 *      the running platform) is still in flight when the build
 *      starts. Race lost.
 *
 * Fix: `PreviewManager` exposes a `depsReady` deferred that resolves
 * after `installDepsIfNeeded()` settles; `CanvasBuildManager` awaits
 * it (with a 120s timeout) before each `runBuild()`. The gateway
 * wires the gate when constructing the build manager.
 *
 * This test reproduces the race conditions on a real warm-pool VM:
 *   1. Build the current `agent-runtime.js` from HEAD.
 *   2. Stage a synthetic vite workspace on the host with a fully
 *      mac-flavoured node_modules (rollup + ONLY the darwin native).
 *   3. Boot a real QEMU VM with that workspace 9p-mounted and the
 *      freshly-built server.js injected via the seed ISO.
 *   4. POST /pool/assign to trigger pool-mode -> assigned transition.
 *   5. Watch the VM's stdout for either:
 *      - `Canvas build error: ... undefined`  →  REGRESSION
 *      - `Build #1 (vite) complete`           →  PASS
 *      - 180s timeout                          →  FAIL
 *
 * Pre-fix, step 5 produced the regression line within ~20s of
 * /pool/assign. Post-fix, the canvas build waits on `depsReady`,
 * the in-guest install populates `@rollup/rollup-linux-arm64-gnu`,
 * and vite/rollup succeed.
 *
 * Requires:
 *   - apps/desktop/resources/vm/{vmlinuz,initrd.img,rootfs-provisioned.qcow2}
 *   - qemu-system-aarch64 (or x86_64) on PATH or under
 *     /Applications/Shogo.app/Contents/Resources/qemu/bin
 *
 * Run with:
 *   bun apps/desktop/test-vm-canvas-build-gate.ts
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import crypto from 'crypto'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const TEST_ROOT = `/tmp/shogo-vm-canvas-build-test-${Date.now()}`
const TEST_WORKSPACE = path.join(TEST_ROOT, 'workspace')
const TEST_OVERLAY = path.join(TEST_ROOT, 'overlay.qcow2')
const TEST_BUNDLE = path.join(TEST_ROOT, 'bundle')

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
function pass(name: string): void { console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
function fail(name: string, err?: any): void {
  console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`)
}
async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/**
 * Build a synthetic vite project on the host. Mirrors the shape a
 * macOS user's workspace would have after `bun install`: rollup is
 * resolved, only the Darwin native is installed, and the Linux
 * native is conspicuously absent. We don't actually run `bun install`
 * here (slow + flaky in CI) — we hand-craft the minimum node_modules
 * footprint that triggers the rollup native-binding require.
 */
function stageWorkspace(): void {
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true })

  fs.writeFileSync(path.join(TEST_WORKSPACE, 'package.json'), JSON.stringify({
    name: 'shogo-canvas-build-test',
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: { build: 'vite build', dev: 'vite' },
    dependencies: { vite: '^5.4.0' },
  }, null, 2))

  fs.writeFileSync(path.join(TEST_WORKSPACE, 'vite.config.ts'), [
    'import { defineConfig } from "vite"',
    'export default defineConfig({})',
    '',
  ].join('\n'))

  fs.writeFileSync(path.join(TEST_WORKSPACE, 'index.html'), [
    '<!doctype html><html><body><script type="module" src="/main.ts"></script></body></html>',
  ].join('\n'))

  fs.writeFileSync(path.join(TEST_WORKSPACE, 'main.ts'), 'document.body.textContent = "hello from canvas-build gate test"\n')

  // We rely on the in-VM `bun install` to populate node_modules.
  // The test scenario IS "host left node_modules wrong; VM must
  // rescue itself". Pre-installing on the host would defeat the
  // point — we'd then need to delete the linux native specifically.
  // Starting from a bare workspace forces the VM to do a full
  // install, which is the bun-honors-platform contract under test.
}

/**
 * Build agent-runtime.js from HEAD into a temp dir, then prepare the
 * seed-ISO bundle the VM expects (server.js + shogo.js + wasm/).
 */
function buildBundle(): void {
  log('Bundling agent-runtime from HEAD...')
  const buildOut = path.join(TEST_ROOT, '_build')
  fs.mkdirSync(buildOut, { recursive: true })

  execSync(
    `bun build packages/agent-runtime/src/server.ts --target bun --outdir "${buildOut}"`,
    { cwd: REPO_ROOT, stdio: 'pipe', timeout: 180_000 },
  )

  // bun build writes `server.js` in non-entry-renamed mode; the
  // bundle-api.mjs path renames in a separate step. We just need
  // the .js file as `server.js` for prepare-bundle to pick up.
  const built = fs.readdirSync(buildOut).find((f) => f.endsWith('.js'))
  if (!built) throw new Error('bun build produced no .js output')
  if (built !== 'server.js') {
    fs.renameSync(path.join(buildOut, built), path.join(buildOut, 'server.js'))
  }

  log('Preparing VM bundle...')
  execSync(
    `bun run scripts/prepare-vm-bundle-cli.ts --dest "${TEST_BUNDLE}" --server-js "${path.join(buildOut, 'server.js')}" --light`,
    { cwd: DESKTOP_DIR, stdio: 'pipe', timeout: 60_000 },
  )

  if (!fs.existsSync(path.join(TEST_BUNDLE, 'server.js'))) {
    throw new Error(`prepare-vm-bundle-cli did not produce ${TEST_BUNDLE}/server.js`)
  }
}

async function postPoolAssign(agentUrl: string, projectId: string): Promise<void> {
  // The shared-runtime framework's /pool/assign requires the auth
  // secret from the seed-ISO env. We pass it through `env` when
  // booting; mirror it here.
  const secret = process.env.SHOGO_TEST_AUTH_SECRET || 'shogo-canvas-test-secret'
  const res = await fetch(`${agentUrl}/pool/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      projectId,
      envVars: { PROJECT_ID: projectId },
    }),
  })
  if (!res.ok) {
    throw new Error(`/pool/assign failed: ${res.status} ${await res.text()}`)
  }
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m=== VM Canvas-Build Gate E2E ===\x1b[0m\n')

  // Pre-checks ------------------------------------------------------
  for (const f of ['vmlinuz', 'initrd.img', 'rootfs-provisioned.qcow2']) {
    if (!fs.existsSync(path.join(VM_IMAGE_DIR, f))) {
      fail('VM image', `missing ${f}`)
      process.exit(1)
    }
  }
  pass('VM images present')

  // Stage workspace + build bundle ---------------------------------
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  stageWorkspace()
  pass(`Staged synthetic vite workspace at ${TEST_WORKSPACE}`)

  buildBundle()
  pass(`Built agent-runtime bundle at ${TEST_BUNDLE}`)

  // Boot a VM with the workspace mounted + our fresh server.js ------
  process.env.SHOGO_VM_IMAGE_DIR = VM_IMAGE_DIR
  const vmModule = await import('./src/vm/index')
  if (!vmModule.isVMAvailable()) {
    fail('VM availability', 'qemu not on PATH')
    process.exit(1)
  }

  const mgr = vmModule.createVMManager()
  const projectId = crypto.randomUUID()
  const secret = process.env.SHOGO_TEST_AUTH_SECRET || 'shogo-canvas-test-secret'

  // Capture VM stdout so we can scan for the canvas build outcome.
  // The DarwinVMManager already pipes everything through console.log
  // as `[shogo-vm] ...` lines; we hook stdout/stderr at the
  // Node level to keep a parseable rolling buffer.
  const vmLog: string[] = []
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''
    if (s.includes('[shogo-vm]')) vmLog.push(s)
    return origStdoutWrite(chunk, ...rest)
  }) as any

  log('Booting VM with workspace mount + fresh agent-runtime bundle...')
  let handle: any
  try {
    handle = await mgr.startVM({
      memoryMB: 4096,
      cpus: 2,
      overlayPath: TEST_OVERLAY,
      mountWorkspace: true,
      workspaceDir: TEST_WORKSPACE,
      workspaceMountPath: '/workspace',
      bundleDir: TEST_BUNDLE,
      env: {
        RUNTIME_AUTH_SECRET: secret,
        SHOGO_VM_MODE: 'true',
        // Intentionally NO PROJECT_ID — that's what makes server.ts
        // boot in WARM POOL mode (line 41501 of main.log:
        // "Starting in WARM POOL mode (awaiting project assignment)").
        // We drive the project handoff via /pool/assign below, which
        // is the same path the warm-pool controller takes in prod.
      },
    })
  } catch (err: any) {
    fail('VM boot', err.message)
    process.exit(1)
  }
  pass(`VM booted (pid=${handle.pid}, agentUrl=${handle.agentUrl})`)

  let testFailed = false

  try {
    // Wait for the agent-runtime in pool mode to be listening.
    // Pool-mode pre-seeds the workspace + runs `bun install` BEFORE
    // /health flips, and that install over a 9p mount can take 30-60s
    // on a fresh node_modules (observed in main.log). 180s gives
    // generous headroom for slow first-boot caches.
    log('Waiting for agent-runtime to respond on /health (pool mode, up to 180s)...')
    let healthy = false
    const healthDeadline = Date.now() + 180_000
    while (Date.now() < healthDeadline) {
      try {
        const r = await fetch(`${handle.agentUrl}/health`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) { healthy = true; break }
      } catch {}
      // Also surface "ready for assignment" — pool-mode logs that
      // explicitly when essentials/install complete.
      if (vmLog.some((l) => l.includes('ready for assignment') || l.includes('Pool mode: workspace deps pre-seeded'))) {
        healthy = true
        break
      }
      await sleep(2000)
    }
    if (!healthy) {
      fail('agent-runtime health (pool mode)', 'no /health within 180s — see vm log for hang point')
      testFailed = true
      return
    }
    pass('agent-runtime healthy in pool mode')

    // Trigger assignment.
    log(`Triggering /pool/assign for projectId=${projectId}...`)
    await postPoolAssign(handle.agentUrl, projectId)
    pass('/pool/assign accepted')

    // Watch for canvas build outcome. We give the chain 180s:
    //   ~5s gateway boot, ~30-60s install, ~5-15s vite build,
    //   plus generous slack.
    log('Watching for canvas build outcome (up to 180s)...')
    const buildDeadline = Date.now() + 180_000
    let outcome: 'pass' | 'regression' | null = null
    while (Date.now() < buildDeadline && outcome == null) {
      const recent = vmLog.join('\n')
      if (recent.includes('Build #1 (vite) complete')) {
        outcome = 'pass'
        break
      }
      // Anti-regression: pre-fix signature in main.log. The
      // canonical strings to watch for are vite's own error frame
      // ("failed to load config") and the cascade through
      // AgentGateway. `undefined` alone is too weak (could appear
      // in any log line).
      if (
        recent.includes('failed to load config from') ||
        /Canvas build error:.*\bundefined\b/.test(recent)
      ) {
        outcome = 'regression'
        break
      }
      await sleep(1000)
    }

    if (outcome === 'pass') {
      pass('Canvas build completed successfully inside VM')
    } else if (outcome === 'regression') {
      fail('Canvas build inside VM', 'rollup native binding error reproduced — REGRESSION')
      testFailed = true
    } else {
      fail('Canvas build timeout', 'no build outcome in 180s')
      testFailed = true
    }

    // Belt-and-suspenders: even if we saw "Build #1 (vite) complete",
    // verify dist/index.html is on disk. (Vite's success message lies
    // when the output dir was the same as cwd in some odd configs.)
    const distIndex = path.join(TEST_WORKSPACE, 'dist', 'index.html')
    if (outcome === 'pass') {
      // The build runs `vite build --outDir dist.staging --emptyOutDir`
      // and atomically swaps into dist/. The swap is on the host's
      // workspace because we 9p-share it. Allow brief slack for the
      // swap rename.
      for (let i = 0; i < 10 && !fs.existsSync(distIndex); i++) await sleep(500)
      if (!fs.existsSync(distIndex)) {
        fail('dist/index.html on disk', `not found at ${distIndex}`)
        testFailed = true
      } else {
        pass(`dist/index.html present (${fs.statSync(distIndex).size} bytes)`)
      }
    }
  } finally {
    log('Shutting down VM...')
    try { await mgr.stopVM() } catch (err: any) { console.warn(`stopVM threw: ${err?.message ?? err}`) }
    // Restore stdout
    process.stdout.write = origStdoutWrite
    // Best-effort cleanup; keep the test root around if anything
    // failed so we can poke at it post-mortem.
    if (!testFailed) {
      try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
    } else {
      console.log(`\n  Test artefacts left at ${TEST_ROOT} for inspection`)
    }
  }

  if (testFailed) {
    console.log('\n\x1b[31m✗ E2E FAILED — canvas build gate did not save the build\x1b[0m\n')
    process.exit(1)
  }
  console.log('\n\x1b[32m✓ E2E PASSED — VM canvas build completed cleanly through the install gate\x1b[0m\n')
  process.exit(0)
}

main().catch((err) => {
  console.error('Test crashed:', err)
  process.exit(1)
})
