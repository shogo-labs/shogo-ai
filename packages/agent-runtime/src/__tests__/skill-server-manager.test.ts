// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillServerManager } from '../skill-server-manager'

/**
 * Write a minimal Bun HTTP server file that responds to /health.
 * This acts as a stand-in for the real generated Hono server.
 */
function writeTestServer(serverDir: string, port: number): void {
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })

  const serverCode = `
const port = Number(process.env.PORT) || ${port}
Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log('Test server running on port ' + port)
`
  writeFileSync(join(serverDir, 'server.ts'), serverCode, 'utf-8')
}

/**
 * Write a server that crashes immediately (exits with code 1).
 */
function writeCrashingServer(serverDir: string): void {
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(
    join(serverDir, 'server.ts'),
    'process.exit(1)',
    'utf-8',
  )
}

describe('SkillServerManager', () => {
  let workDir: string
  let testPort: number

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-skill-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    // Use a random high port to avoid conflicts with parallel tests
    testPort = 14100 + Math.floor(Math.random() * 1000)
  })

  afterEach(async () => {
    // Ensure any leftover managers are stopped
    rmSync(workDir, { recursive: true, force: true })
  })

  test('no-op when .shogo/server/server.ts does not exist', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    const result = await manager.start()

    expect(result.started).toBe(false)
    expect(result.port).toBeNull()
    expect(manager.phase).toBe('idle')
    expect(manager.isRunning).toBe(false)
  })

  test('starts and stops a server successfully', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeTestServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      const result = await manager.start()
      expect(result.started).toBe(true)
      expect(result.port).toBe(testPort)
      expect(manager.phase).toBe('healthy')
      expect(manager.isRunning).toBe(true)

      // Verify the server actually responds
      const resp = await fetch(`http://localhost:${testPort}/health`)
      expect(resp.ok).toBe(true)
      const body = await resp.json()
      expect(body.ok).toBe(true)
    } finally {
      await manager.stop()
    }

    expect(manager.phase).toBe('stopped')
    expect(manager.isRunning).toBe(false)
  })

  test('start is idempotent when already running', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeTestServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      const result2 = await manager.start()
      expect(result2.started).toBe(true)
      expect(result2.port).toBe(testPort)
    } finally {
      await manager.stop()
    }
  })

  test('restart cycles the server', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeTestServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      await manager.restart()
      expect(manager.isRunning).toBe(true)

      // Verify the server still responds after restart
      const resp = await fetch(`http://localhost:${testPort}/health`)
      expect(resp.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  })

  test('port defaults from SKILL_SERVER_PORT env', async () => {
    const envPort = 14999
    process.env.SKILL_SERVER_PORT = String(envPort)

    try {
      const manager = new SkillServerManager({ workspaceDir: workDir })
      expect(manager.port).toBe(envPort)
    } finally {
      delete process.env.SKILL_SERVER_PORT
    }
  })

  test('SKILL_SERVER_PORT env overrides config.port', () => {
    process.env.SKILL_SERVER_PORT = '5555'
    try {
      const manager = new SkillServerManager({ workspaceDir: workDir, port: 9999 })
      expect(manager.port).toBe(5555)
    } finally {
      delete process.env.SKILL_SERVER_PORT
    }
  })

  test('port defaults to 4100 when no env or config', () => {
    delete process.env.SKILL_SERVER_PORT
    const manager = new SkillServerManager({ workspaceDir: workDir })
    expect(manager.port).toBe(4100)
  })

  test('url includes the configured port', () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: 9999 })
    expect(manager.url).toBe('http://localhost:9999')
  })

  test('stop is safe to call when not started', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.stop()
    expect(manager.phase).toBe('stopped')
  })

  test('restart is no-op when server entry does not exist', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.restart()
    expect(manager.isRunning).toBe(false)
  })

  test('handles server that fails to start (health check timeout)', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(
      join(serverDir, 'server.ts'),
      `Bun.serve({
        port: ${testPort},
        fetch() { return new Response('nope', { status: 500 }) },
      })`,
      'utf-8',
    )

    const manager = new SkillServerManager({
      workspaceDir: workDir,
      port: testPort,
      healthCheckRetries: 3,
      healthCheckIntervalMs: 200,
    })

    try {
      const result = await manager.start()
      expect(result.started).toBe(false)
      expect(manager.phase).toBe('crashed')
    } finally {
      await manager.stop()
    }
  }, 10_000)
})
