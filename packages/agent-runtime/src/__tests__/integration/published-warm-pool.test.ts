// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Published warm-pool assignment regression coverage.
 *
 * A published Metal guest has no object-store credentials because the host
 * owns source/data hydration. Assignment must therefore only switch the
 * runtime into an inert, host-hydrated state; it must not enter the normal
 * S3/gateway/bootstrap path and wait on the cloud credential provider chain.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type Subprocess } from 'bun'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const TEST_PORT = 19_400 + Math.floor(Math.random() * 100)
const TEST_AGENT_DIR = `/tmp/test-published-warm-pool-${TEST_PORT}`
const SERVER_PATH = join(import.meta.dir, '..', '..', 'server.ts')
const RUNTIME_TOKEN = 'published-warm-pool-test-token'

let serverProc: Subprocess | null = null

async function teardownServerProc(proc: Subprocess | null): Promise<void> {
  if (!proc) return
  try {
    proc.stdout?.cancel().catch(() => {})
    proc.stderr?.cancel().catch(() => {})
  } catch {
    // The streams may already be closed.
  }
  proc.kill('SIGKILL')
  try {
    await Promise.race([
      proc.exited,
      new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
    ])
  } catch {
    // The child may already have exited.
  }
}

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${TEST_PORT}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // The runtime is still binding its listener.
    }
    await Bun.sleep(200)
  }
  throw new Error(`Published warm-pool server did not start within ${timeoutMs}ms`)
}

describe('Published warm-pool assignment', () => {
  beforeAll(async () => {
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
    mkdirSync(TEST_AGENT_DIR, { recursive: true })

    serverProc = spawn({
      cmd: ['bun', 'run', SERVER_PATH],
      env: {
        ...process.env,
        PROJECT_ID: '__POOL__',
        WARM_POOL_MODE: 'true',
        AGENT_DIR: TEST_AGENT_DIR,
        PROJECT_DIR: TEST_AGENT_DIR,
        PORT: String(TEST_PORT),
        // Deliberately configure an object store but provide no credentials.
        // The published assignment path must not touch this provider chain.
        S3_WORKSPACES_BUCKET: 'published-assignment-test-bucket',
        S3_BUCKET: 'published-assignment-test-bucket',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
        SHOGO_DURABILITY_HOST_MEDIATED: 'true',
        SHOGO_CLOUD_SYNC_MODE: 'git_only',
        RUNTIME_AUTH_SECRET: RUNTIME_TOKEN,
        AI_PROXY_URL: '',
        AI_PROXY_TOKEN: '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    await waitForServer()
  }, 20_000)

  afterAll(async () => {
    await teardownServerProc(serverProc)
    serverProc = null
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
  })

  test('assigns without storage hydration and remains awaiting host activation', async () => {
    const startedAt = Date.now()
    const response = await fetch(`http://localhost:${TEST_PORT}/pool/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'published:published-project',
        env: {
          PROJECT_ID: 'published-project',
          SHOGO_PUBLISHED_MODE: 'true',
          PUBLISHED_SUBDOMAIN: 'published-project',
          RUNTIME_AUTH_SECRET: RUNTIME_TOKEN,
          SHOGO_DURABILITY_HOST_MEDIATED: 'true',
          S3_WORKSPACES_BUCKET: 'published-assignment-test-bucket',
          S3_BUCKET: 'published-assignment-test-bucket',
        },
      }),
    })
    const elapsedMs = Date.now() - startedAt

    expect(response.ok).toBe(true)
    expect(elapsedMs).toBeLessThan(5_000)

    const status = await fetch(`http://localhost:${TEST_PORT}/pool/startup-status`, {
      headers: { 'x-runtime-token': RUNTIME_TOKEN },
    })
    expect(status.ok).toBe(true)
    expect(await status.json()).toMatchObject({
      published: true,
      phase: 'awaiting-hydration',
      subdomain: 'published-project',
      poolAssigned: true,
    })
  }, 15_000)
})
