// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server Integration Tests
 *
 * Tests the full lifecycle: server creation, CRUD operations, schema evolution,
 * hooks, and workspace seeding. Uses hand-crafted Hono servers that simulate
 * what `shogo generate` produces, keeping tests fast and dependency-free.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillServerManager } from '../skill-server-manager'
import { seedSkillServer } from '../workspace-defaults'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomPort(): number {
  return 15000 + Math.floor(Math.random() * 5000)
}

/**
 * Write a self-contained Hono-like CRUD server backed by an in-memory Map.
 * Simulates what `shogo generate` produces for a Todo model.
 */
function writeCrudServer(serverDir: string, port: number, models: string[] = ['todo']): void {
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })

  const modelStores = models.map((m) => `const ${m}Store = new Map()`).join('\n')

  const modelRoutes = models
    .map((m) => {
      const plural = m + 's'
      return `
    // ${m} CRUD
    if (path === '/api/${plural}' && method === 'GET') {
      return json({ ok: true, items: Array.from(${m}Store.values()) })
    }
    if (path === '/api/${plural}' && method === 'POST') {
      const body = await req.json()
      ${m === 'todo' ? `if (hooks.beforeCreate) { const h = hooks.beforeCreate(body); if (h && !h.ok) return json(h, 400) }` : ''}
      const id = String(Date.now()) + '-' + String(Math.random()).slice(2, 8)
      const item = { id, ...body, createdAt: new Date().toISOString() }
      ${m}Store.set(id, item)
      return json({ ok: true, data: item }, 201)
    }
    if (path.startsWith('/api/${plural}/') && method === 'GET') {
      const id = path.split('/').pop()
      const item = ${m}Store.get(id)
      if (!item) return json({ error: { code: 'not_found' } }, 404)
      return json({ ok: true, data: item })
    }
    if (path.startsWith('/api/${plural}/') && method === 'PATCH') {
      const id = path.split('/').pop()
      const item = ${m}Store.get(id)
      if (!item) return json({ error: { code: 'not_found' } }, 404)
      const body = await req.json()
      const updated = { ...item, ...body }
      ${m}Store.set(id, updated)
      return json({ ok: true, data: updated })
    }
    if (path.startsWith('/api/${plural}/') && method === 'DELETE') {
      const id = path.split('/').pop()
      if (!${m}Store.has(id)) return json({ error: { code: 'not_found' } }, 404)
      ${m}Store.delete(id)
      return json({ ok: true })
    }
`
    })
    .join('\n')

  const serverCode = `
const port = Number(process.env.PORT) || ${port}

${modelStores}

const hooks = {}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Allow hooks to be injected via env-encoded file
try {
  const hookPath = process.env.HOOKS_FILE
  if (hookPath) {
    const mod = require(hookPath)
    Object.assign(hooks, mod)
  }
} catch {}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    if (path === '/health') {
      return json({ ok: true, timestamp: new Date().toISOString() })
    }

    ${modelRoutes}

    return new Response('Not Found', { status: 404 })
  },
})
console.log('Skill server running on port ' + port)
`
  writeFileSync(join(serverDir, 'server.ts'), serverCode, 'utf-8')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Skill Server Integration', () => {
  let workDir: string
  let testPort: number

  beforeEach(() => {
    workDir = join(tmpdir(), `shogo-skill-int-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    testPort = randomPort()
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  // =========================================================================
  // Test 1: Full CRUD lifecycle
  // =========================================================================
  test('full CRUD lifecycle with todo model', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCrudServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      const base = `http://localhost:${testPort}/api/todos`

      // CREATE
      const createResp = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Buy groceries', done: false }),
      })
      expect(createResp.status).toBe(201)
      const created = await createResp.json() as any
      expect(created.ok).toBe(true)
      expect(created.data.title).toBe('Buy groceries')
      const todoId = created.data.id

      // LIST
      const listResp = await fetch(base)
      const listed = await listResp.json() as any
      expect(listed.ok).toBe(true)
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0].id).toBe(todoId)

      // GET by ID
      const getResp = await fetch(`${base}/${todoId}`)
      const got = await getResp.json() as any
      expect(got.ok).toBe(true)
      expect(got.data.title).toBe('Buy groceries')

      // UPDATE
      const updateResp = await fetch(`${base}/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: true }),
      })
      const updated = await updateResp.json() as any
      expect(updated.ok).toBe(true)
      expect(updated.data.done).toBe(true)
      expect(updated.data.title).toBe('Buy groceries')

      // DELETE
      const deleteResp = await fetch(`${base}/${todoId}`, { method: 'DELETE' })
      const deleted = await deleteResp.json() as any
      expect(deleted.ok).toBe(true)

      // Verify deleted
      const afterDelete = await fetch(base)
      const afterList = await afterDelete.json() as any
      expect(afterList.items).toHaveLength(0)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 2: Schema evolution (adding a new model)
  // =========================================================================
  test('schema evolution: add a new model and restart', async () => {
    const serverDir = join(workDir, '.shogo', 'server')

    // Start with just 'todo'
    writeCrudServer(serverDir, testPort, ['todo'])
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      // Create a todo
      await fetch(`http://localhost:${testPort}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'First todo' }),
      })

      // "Evolve" the schema by writing a new server with both todo and tag
      writeCrudServer(serverDir, testPort, ['todo', 'tag'])
      await manager.restart()
      expect(manager.isRunning).toBe(true)

      // Verify the new 'tag' endpoint works
      const createTag = await fetch(`http://localhost:${testPort}/api/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'urgent', color: 'red' }),
      })
      expect(createTag.status).toBe(201)
      const tag = await createTag.json() as any
      expect(tag.data.name).toBe('urgent')

      // Verify tags list works
      const listTags = await fetch(`http://localhost:${testPort}/api/tags`)
      const tags = await listTags.json() as any
      expect(tags.items).toHaveLength(1)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 3: Hooks (beforeCreate validation)
  // =========================================================================
  test('hooks: beforeCreate rejects invalid input', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCrudServer(serverDir, testPort)

    // Write a hooks file that rejects empty titles
    const hooksPath = join(serverDir, 'hooks', 'todo.hooks.js')
    mkdirSync(join(serverDir, 'hooks'), { recursive: true })
    writeFileSync(
      hooksPath,
      `module.exports = {
  beforeCreate: function(input) {
    if (!input.title || input.title.trim() === '') {
      return { ok: false, error: 'Title is required' }
    }
    return { ok: true }
  }
}`,
      'utf-8',
    )

    const manager = new SkillServerManager({
      workspaceDir: workDir,
      port: testPort,
    })

    // Override env to inject hooks
    const origEnv = process.env.HOOKS_FILE
    process.env.HOOKS_FILE = hooksPath

    try {
      // Need to re-write the server to pick up the hooks env
      writeCrudServer(serverDir, testPort)
      await manager.start()
      expect(manager.isRunning).toBe(true)

      // Valid request should work
      const validResp = await fetch(`http://localhost:${testPort}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Valid todo' }),
      })
      expect(validResp.status).toBe(201)

      // Invalid request (empty title) should be rejected
      const invalidResp = await fetch(`http://localhost:${testPort}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      })
      expect(invalidResp.status).toBe(400)
    } finally {
      process.env.HOOKS_FILE = origEnv
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 4: seedSkillServer helper
  // =========================================================================
  test('seedSkillServer creates the skeleton', () => {
    const result = seedSkillServer(workDir)
    expect(result.created).toBe(true)

    const serverDir = result.serverDir
    expect(existsSync(join(serverDir, 'schema.prisma'))).toBe(true)
    expect(existsSync(join(serverDir, 'shogo.config.json'))).toBe(true)
    expect(existsSync(join(serverDir, 'generated'))).toBe(true)
    expect(existsSync(join(serverDir, 'hooks'))).toBe(true)

    // Verify schema content
    const schema = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(schema).toContain('provider = "sqlite"')
    expect(schema).toContain('env("DATABASE_URL")')

    // Verify config
    const config = JSON.parse(readFileSync(join(serverDir, 'shogo.config.json'), 'utf-8'))
    expect(config.schema).toBe('./schema.prisma')
    expect(config.outputs).toBeArray()
    expect(config.outputs.some((o: any) => o.generate.includes('routes'))).toBe(true)
  })

  test('seedSkillServer is idempotent', () => {
    const result1 = seedSkillServer(workDir)
    expect(result1.created).toBe(true)

    const result2 = seedSkillServer(workDir)
    expect(result2.created).toBe(false)
    expect(result2.serverDir).toBe(result1.serverDir)
  })

  // =========================================================================
  // Test 5: Multiple concurrent requests
  // =========================================================================
  test('handles concurrent CRUD requests', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCrudServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      const base = `http://localhost:${testPort}/api/todos`

      // Create 10 todos concurrently
      const creates = Array.from({ length: 10 }, (_, i) =>
        fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: `Todo ${i}`, index: i }),
        }).then((r) => r.json()),
      )

      const results = await Promise.all(creates) as any[]
      expect(results.every((r) => r.ok)).toBe(true)

      // Verify all 10 exist
      const listResp = await fetch(base)
      const listed = await listResp.json() as any
      expect(listed.items).toHaveLength(10)
    } finally {
      await manager.stop()
    }
  }, 15_000)
})
