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
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'

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

  afterAll(() => {
    if (serverProc) {
      serverProc.kill()
      serverProc = null
    }
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
  })

  test('health check shows pool mode', async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`)
    expect(resp.ok).toBe(true)

    const data = await resp.json() as any
    expect(data.status).toBe('ok')
    expect(data.poolMode).toBe(true)
    expect(data.projectId).toBe('__POOL__')
    expect(data.runtimeType).toBe('agent')
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
