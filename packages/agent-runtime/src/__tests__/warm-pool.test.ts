// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Warm Pool Mode — Integration Test
 *
 * Tests the pool mode lifecycle of the agent-runtime:
 * 1. Start server with PROJECT_ID=__POOL__ (pool mode)
 * 2. Verify health check shows pool mode
 * 3. POST /pool/assign with a project identity
 * 4. Verify health check shows assigned project
 *
 * Run:
 *   bun test packages/agent-runtime/src/__tests__/warm-pool.test.ts
 *
 * Or test manually:
 *   PROJECT_ID=__POOL__ WARM_POOL_MODE=true bun run packages/agent-runtime/src/server.ts
 *   curl http://localhost:8080/health
 *   curl -X POST http://localhost:8080/pool/assign \
 *     -H 'Content-Type: application/json' \
 *     -d '{"projectId":"test-project-123","env":{}}'
 *   curl http://localhost:8080/health
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

/**
 * Tear down a server subprocess cleanly so the surrounding `afterAll`
 * hook completes within Bun's default 5s budget — even when this test
 * file is the 101st in a serial isolated-coverage run and the macOS
 * scheduler is contended.
 *
 * Why we can't just call `serverProc.kill()`:
 *
 *  1. The agent-runtime registers a SIGTERM handler in
 *     `shared-runtime/src/server-framework.ts` that schedules
 *     `process.exit(0)` after a hard 5_000ms delay. A polite SIGTERM
 *     therefore makes the child sit on the wire for a full 5 seconds
 *     before exiting — which trips Bun's hook timeout.
 *
 *  2. Even with SIGKILL, the parent's `serverProc.stdout` / `.stderr`
 *     ReadableStreams stay open until the kernel finishes reaping the
 *     process. Bun's test runner waits for those streams to drain
 *     before declaring the hook done. Under load (100+ prior test
 *     files in the same isolated run) that drain itself can take
 *     hundreds of ms. We explicitly cancel both streams *before*
 *     awaiting `.exited` so the hook doesn't get blocked on slow stdio
 *     close.
 */
async function teardownServerProc(proc: Subprocess | null, timeoutMs = 3_000): Promise<void> {
  if (!proc) return
  try {
    proc.stdout?.cancel().catch(() => {})
    proc.stderr?.cancel().catch(() => {})
  } catch { /* the streams may already be closed; ignore */ }
  proc.kill('SIGKILL')
  try {
    await Promise.race([
      proc.exited,
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ])
  } catch { /* exited may reject if already collected — that's fine */ }
}

const TEST_PORT = 18_900 + Math.floor(Math.random() * 100)
const TEST_AGENT_DIR = `/tmp/test-warm-pool-agent-${TEST_PORT}`
const SERVER_PATH = join(import.meta.dir, '..', 'server.ts')

let serverProc: Subprocess | null = null

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (resp.ok) return
    } catch {
      // not ready yet
    }
    await Bun.sleep(300)
  }
  throw new Error(`Server on port ${port} did not start within ${timeoutMs}ms`)
}

describe('Warm Pool Mode', () => {
  beforeAll(async () => {
    // Clean up any previous test data
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
    mkdirSync(TEST_AGENT_DIR, { recursive: true })

    // Start the agent-runtime in pool mode
    serverProc = spawn({
      cmd: ['bun', 'run', SERVER_PATH],
      env: {
        ...process.env,
        PROJECT_ID: '__POOL__',
        WARM_POOL_MODE: 'true',
        AGENT_DIR: TEST_AGENT_DIR,
        PROJECT_DIR: TEST_AGENT_DIR,
        PORT: String(TEST_PORT),
        // Disable things that need real infrastructure
        S3_WORKSPACES_BUCKET: '',
        S3_BUCKET: '',
        AI_PROXY_URL: '',
        AI_PROXY_TOKEN: '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await waitForServer(TEST_PORT)
  }, 20_000)

  afterAll(async () => {
    await teardownServerProc(serverProc)
    serverProc = null
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
  })

  test('health check shows pool mode', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`)
    expect(resp.ok).toBe(true)

    const data = await resp.json() as any
    expect(data.status).toBe('ok')
    expect(data.poolMode).toBe(true)
    expect(data.projectId).toBe('__POOL__')
    expect(data.runtimeType).toBe('unified')
  })

  test('ready check passes in pool mode', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/ready`)
    expect(resp.ok).toBe(true)

    const data = await resp.json() as any
    expect(data.ready).toBe(true)
  })

  test('rejects /pool/assign without projectId', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(resp.status).toBe(400)

    const data = await resp.json() as any
    expect(data.error).toContain('projectId')
  })

  test('assigns a project via /pool/assign', async () => {
    const testProjectId = `test-proj-${Date.now()}`

    const resp = await fetch(`http://localhost:${TEST_PORT}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: testProjectId,
        env: {
          SOME_CUSTOM_VAR: 'hello',
        },
      }),
    })

    expect(resp.ok).toBe(true)
    const data = await resp.json() as any
    expect(data.ok).toBe(true)
    expect(data.projectId).toBe(testProjectId)
    expect(typeof data.durationMs).toBe('number')
  }, 30_000) // gateway startup can take a few seconds

  test('health check shows assigned project after assignment', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`)
    expect(resp.ok).toBe(true)

    const data = await resp.json() as any
    expect(data.status).toBe('ok')
    expect(data.poolMode).toBe(false)
    expect(data.projectId).toContain('test-proj-')
  })

  test('rejects second /pool/assign (already assigned)', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'another-project' }),
    })
    expect(resp.status).toBe(400)

    const data = await resp.json() as any
    expect(data.error).toContain('Already assigned')
  })
})

/**
 * Regression test for the 2026-05-13 staging incident: a partial
 * /pool/assign (env that sets AI_PROXY_URL without an AI_PROXY_TOKEN)
 * called process.exit(1) inside the runtime, killing a healthy pod and
 * letting the orchestrator strand 184 promoted-but-orphaned ksvc.
 *
 * After the fix the runtime returns 400 with a "Reconfigure failed"
 * message and stays alive — so the next assign attempt with proper env
 * can recover the pod in-place.
 */
describe('Warm Pool Mode — partial /pool/assign does not crash the pod', () => {
  const TEST_PORT_3 = 19_300 + Math.floor(Math.random() * 100)
  const TEST_AGENT_DIR_3 = `/tmp/test-warm-pool-partial-assign-${TEST_PORT_3}`
  let serverProc3: Subprocess | null = null

  beforeAll(async () => {
    rmSync(TEST_AGENT_DIR_3, { recursive: true, force: true })
    mkdirSync(TEST_AGENT_DIR_3, { recursive: true })

    serverProc3 = spawn({
      cmd: ['bun', 'run', SERVER_PATH],
      env: {
        ...process.env,
        PROJECT_ID: '__POOL__',
        WARM_POOL_MODE: 'true',
        AGENT_DIR: TEST_AGENT_DIR_3,
        PROJECT_DIR: TEST_AGENT_DIR_3,
        PORT: String(TEST_PORT_3),
        S3_WORKSPACES_BUCKET: '',
        S3_BUCKET: '',
        AI_PROXY_URL: '',
        AI_PROXY_TOKEN: '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await waitForServer(TEST_PORT_3)
  }, 20_000)

  afterAll(async () => {
    await teardownServerProc(serverProc3)
    serverProc3 = null
    rmSync(TEST_AGENT_DIR_3, { recursive: true, force: true })
  })

  test('returns 400 (not exit) when env sets AI_PROXY_URL without AI_PROXY_TOKEN', async () => {
    const testProjectId = `partial-assign-${Date.now()}`

    const resp = await fetch(`http://localhost:${TEST_PORT_3}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: testProjectId,
        env: {
          AI_PROXY_URL: 'http://api.test.svc.cluster.local/api/ai/v1',
          // No AI_PROXY_TOKEN — configureAIProxy must throw.
        },
      }),
    })

    expect(resp.status).toBe(400)
    const data = await resp.json() as any
    expect(data.error).toContain('Reconfigure failed')

    // Pod must still be alive: a follow-up /health succeeds and reports
    // pool mode (the failed assign got rolled back).
    const health = await fetch(`http://localhost:${TEST_PORT_3}/health`)
    expect(health.ok).toBe(true)
    const healthData = await health.json() as any
    expect(healthData.poolMode).toBe(true)
    expect(healthData.projectId).toBe('__POOL__')
  }, 15_000)

  test('a subsequent valid /pool/assign succeeds after a partial one was rolled back', async () => {
    const testProjectId = `recovered-assign-${Date.now()}`

    const resp = await fetch(`http://localhost:${TEST_PORT_3}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: testProjectId,
        // Empty env keeps the AI proxy unconfigured — assign should succeed.
        env: {},
      }),
    })

    expect(resp.ok).toBe(true)
    const data = await resp.json() as any
    expect(data.ok).toBe(true)
    expect(data.projectId).toBe(testProjectId)
  }, 30_000)
})

/**
 * Regression test for the /pool/assign latency incident on 2026-05-11.
 *
 * Before the fix: PreviewManager.start() awaited runSetupTasks → runPrismaIfNeeded
 * → pkg.prismaGenerate (execSync) which froze the event loop for ~2.9s, and then
 * prismaDbPush for another ~1.6s. /pool/assign's onAssign handler `await`s
 * PreviewManager.start() (indirectly via initializeEssentials), so the entire
 * assign hot path stalled for 4.7s in staging.
 *
 * After the fix: PreviewManager.start() schedules its setup in the background
 * and returns immediately, so /pool/assign latency no longer scales with prisma
 * cold-start time.
 *
 * We simulate slow prisma by pointing SHOGO_BUN_PATH at a fake `bun` binary
 * that sleeps before exiting. The agent's preview-manager will spawn it via
 * `bun x prisma ...`. The fake takes 3s — well above the 1s SLA the test
 * enforces — so any regression that re-introduces awaiting prisma will fail
 * loudly here.
 */
describe('Warm Pool Mode — assign latency with slow prisma', () => {
  const TEST_PORT_2 = 19_100 + Math.floor(Math.random() * 100)
  const TEST_AGENT_DIR_2 = `/tmp/test-warm-pool-slow-prisma-${TEST_PORT_2}`
  const FAKE_BUN_PATH = join(TEST_AGENT_DIR_2, 'fake-bun.sh')
  let serverProc2: Subprocess | null = null

  beforeAll(async () => {
    if (process.platform === 'win32') return // fake-bun shell script assumes POSIX
    rmSync(TEST_AGENT_DIR_2, { recursive: true, force: true })
    mkdirSync(TEST_AGENT_DIR_2, { recursive: true })

    // Workspace with a prisma schema — triggers the slow path we are
    // explicitly testing. No dev.db, no .prisma/client → both generate
    // AND db push will run.
    mkdirSync(join(TEST_AGENT_DIR_2, 'prisma'), { recursive: true })
    writeFileSync(
      join(TEST_AGENT_DIR_2, 'prisma', 'schema.prisma'),
      'generator client { provider = "prisma-client-js" }\nmodel A { id Int @id }\n',
    )
    writeFileSync(
      join(TEST_AGENT_DIR_2, 'package.json'),
      JSON.stringify({ name: 'slow-prisma-test', dependencies: {} }),
    )

    // Pre-stage node_modules so `ensureWorkspaceDeps` short-circuits.
    // Otherwise it would spawn `bun install` (our fake bun → 3s sleep)
    // and the assign path would still be slow — but for a *different*
    // reason than the one this test is supposed to catch. We want the
    // ONLY slow thing left to be prisma generate / db push.
    const nm = join(TEST_AGENT_DIR_2, 'node_modules')
    mkdirSync(join(nm, '.bin'), { recursive: true })
    writeFileSync(join(nm, '.bin', 'vite'), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(join(nm, '.bin', 'vite'), 0o755)
    // Platform marker matching the current host so ensureWorkspaceDeps
    // doesn't trip the "wrong platform → reinstall" branch.
    writeFileSync(
      join(nm, '.shogo-platform'),
      `${process.platform}-${process.arch}\n`,
    )

    // Fake `bun` that sleeps 3s and exits. preview-manager spawns this
    // via `bun x prisma generate` / `bun x prisma db push`. We don't care
    // what the args are — we just need the child process to occupy real
    // wall-clock time so we can prove /pool/assign doesn't wait on it.
    writeFileSync(
      FAKE_BUN_PATH,
      '#!/usr/bin/env bash\nsleep 3\nexit 0\n',
    )
    chmodSync(FAKE_BUN_PATH, 0o755)

    serverProc2 = spawn({
      cmd: ['bun', 'run', SERVER_PATH],
      env: {
        ...process.env,
        PROJECT_ID: '__POOL__',
        WARM_POOL_MODE: 'true',
        AGENT_DIR: TEST_AGENT_DIR_2,
        PROJECT_DIR: TEST_AGENT_DIR_2,
        PORT: String(TEST_PORT_2),
        S3_WORKSPACES_BUCKET: '',
        S3_BUCKET: '',
        AI_PROXY_URL: '',
        AI_PROXY_TOKEN: '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key',
        // Inject our slow fake bun into pkg.bunBinary. Any call from
        // PreviewManager that goes through `bun x ...` will hit this
        // script instead of the real bun.
        SHOGO_BUN_PATH: FAKE_BUN_PATH,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await waitForServer(TEST_PORT_2)
  }, 20_000)

  afterAll(async () => {
    await teardownServerProc(serverProc2)
    serverProc2 = null
    rmSync(TEST_AGENT_DIR_2, { recursive: true, force: true })
  })

  test('/pool/assign returns in <1s even when prisma generate takes 3s', async () => {
    if (process.platform === 'win32') return
    const testProjectId = `slow-prisma-${Date.now()}`

    const t0 = Date.now()
    const resp = await fetch(`http://localhost:${TEST_PORT_2}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: testProjectId, env: {} }),
    })
    const elapsed = Date.now() - t0

    expect(resp.ok).toBe(true)
    const data = await resp.json() as any
    expect(data.ok).toBe(true)
    // The whole point of this test: even with 3s of prisma work staged in
    // the background, the HTTP round-trip MUST come back under 1s. The
    // pre-fix staging measurement was 4661ms.
    expect(elapsed).toBeLessThan(1_000)
  }, 10_000)
})
