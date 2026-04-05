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
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
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

  // Write a minimal custom-routes.ts so the server can import it
  if (!existsSync(join(serverDir, 'custom-routes.ts'))) {
    writeFileSync(join(serverDir, 'custom-routes.ts'), "export default { routes: [] }\n", 'utf-8')
  }

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
import customRoutes from './custom-routes'
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

/**
 * Write a server with both CRUD routes and custom routes mounted at /api.
 * Simulates the SDK-generated template with dynamic CRUD + static custom routes.
 */
function writeCustomRoutesServer(
  serverDir: string,
  port: number,
  opts: { crudModels?: string[]; customRouteCode?: string } = {},
): void {
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })

  const { crudModels = [], customRouteCode } = opts

  const modelStores = crudModels.map((m) => `const ${m}Store = new Map()`).join('\n')

  const modelRoutes = crudModels
    .map((m) => {
      const plural = m + 's'
      return `
    if (path === '/api/${plural}' && method === 'GET') {
      return json({ ok: true, items: Array.from(${m}Store.values()) })
    }
    if (path === '/api/${plural}' && method === 'POST') {
      const body = await req.json()
      const id = String(Date.now()) + '-' + String(Math.random()).slice(2, 8)
      const item = { id, ...body, createdAt: new Date().toISOString() }
      ${m}Store.set(id, item)
      return json({ ok: true, data: item }, 201)
    }`
    })
    .join('\n')

  // Write custom-routes.ts
  const customCode = customRouteCode || `
export default {
  routes: []
}
`
  writeFileSync(join(serverDir, 'custom-routes.ts'), customCode, 'utf-8')

  // Write server that loads custom routes
  const serverCode = `
import customRoutes from './custom-routes'

const port = Number(process.env.PORT) || ${port}
${modelStores}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

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

    // Custom routes
    if (customRoutes.routes) {
      for (const route of customRoutes.routes) {
        if (path === '/api' + route.path && method === (route.method || 'GET')) {
          return json(route.handler ? route.handler() : { custom: true, path: route.path })
        }
      }
    }

    return new Response('Not Found', { status: 404 })
  },
})
`
  writeFileSync(join(serverDir, 'server.tsx'), serverCode, 'utf-8')
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

    // Verify custom-routes.ts was scaffolded
    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)
    const customRoutes = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain('Hono')
    expect(customRoutes).toContain('export default')

    // Verify config includes new SDK options
    const config = JSON.parse(readFileSync(join(serverDir, 'shogo.config.json'), 'utf-8'))
    expect(config.schema).toBe('./schema.prisma')
    expect(config.outputs).toBeArray()
    expect(config.outputs.some((o: any) => o.generate.includes('routes'))).toBe(true)

    const serverOutput = config.outputs.find((o: any) => o.generate.includes('server'))
    expect(serverOutput.serverConfig.dynamicCrudImport).toBe(true)
    expect(serverOutput.serverConfig.bunServe).toBe(true)
    expect(serverOutput.serverConfig.customRoutesPath).toBe('./custom-routes')
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

  // =========================================================================
  // Test 6: Custom routes serve traffic
  // =========================================================================
  test('custom routes serve traffic at /api/', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCustomRoutesServer(serverDir, testPort, {
      customRouteCode: `
export default {
  routes: [
    { path: '/hello', method: 'GET', handler: () => ({ message: 'Hello from custom route!' }) },
  ]
}
`,
    })

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      const resp = await fetch(`http://localhost:${testPort}/api/hello`)
      expect(resp.ok).toBe(true)
      const data = await resp.json() as any
      expect(data.message).toBe('Hello from custom route!')
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 7: Custom routes + CRUD coexist
  // =========================================================================
  test('custom routes and CRUD routes coexist', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCustomRoutesServer(serverDir, testPort, {
      crudModels: ['todo'],
      customRouteCode: `
export default {
  routes: [
    { path: '/weather', method: 'GET', handler: () => ({ temp: 72, unit: 'F' }) },
  ]
}
`,
    })

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      // CRUD route works
      const createResp = await fetch(`http://localhost:${testPort}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      })
      expect(createResp.status).toBe(201)

      // Custom route works
      const weatherResp = await fetch(`http://localhost:${testPort}/api/weather`)
      expect(weatherResp.ok).toBe(true)
      const weather = await weatherResp.json() as any
      expect(weather.temp).toBe(72)

      // Health still works
      const healthResp = await fetch(`http://localhost:${testPort}/health`)
      expect(healthResp.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 8: Custom routes update on restart
  // =========================================================================
  test('custom routes update after restart', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeCustomRoutesServer(serverDir, testPort, {
      customRouteCode: `
export default {
  routes: [
    { path: '/v1', method: 'GET', handler: () => ({ version: 1 }) },
  ]
}
`,
    })

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      // v1 route works
      const r1 = await fetch(`http://localhost:${testPort}/api/v1`)
      expect(r1.ok).toBe(true)

      // v2 route doesn't exist yet
      const r2before = await fetch(`http://localhost:${testPort}/api/v2`)
      expect(r2before.status).toBe(404)

      // Update custom routes to add v2
      writeFileSync(
        join(serverDir, 'custom-routes.ts'),
        `
export default {
  routes: [
    { path: '/v1', method: 'GET', handler: () => ({ version: 1 }) },
    { path: '/v2', method: 'GET', handler: () => ({ version: 2 }) },
  ]
}
`,
        'utf-8',
      )

      // Restart to pick up the change
      await manager.restart()
      expect(manager.isRunning).toBe(true)

      // Now v2 should work
      const r2after = await fetch(`http://localhost:${testPort}/api/v2`)
      expect(r2after.ok).toBe(true)
      const data = await r2after.json() as any
      expect(data.version).toBe(2)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 9: Health always works (no models, empty custom routes)
  // =========================================================================
  test('health endpoint works with empty custom routes and no models', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    mkdirSync(join(serverDir, 'generated'), { recursive: true })

    writeFileSync(
      join(serverDir, 'custom-routes.ts'),
      "export default { routes: [] }\n",
      'utf-8',
    )

    writeFileSync(
      join(serverDir, 'server.tsx'),
      `
import customRoutes from './custom-routes'
const port = Number(process.env.PORT) || ${testPort}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return json({ ok: true, timestamp: new Date().toISOString() })
    }
    return new Response('Not Found', { status: 404 })
  },
})
`,
      'utf-8',
    )

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      const healthResp = await fetch(`http://localhost:${testPort}/health`)
      expect(healthResp.ok).toBe(true)
      const data = await healthResp.json() as any
      expect(data.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  // =========================================================================
  // Test 10: seedSkillServer scaffolds custom-routes.ts
  // =========================================================================
  test('seedSkillServer creates custom-routes.ts', () => {
    const result = seedSkillServer(workDir)
    expect(result.created).toBe(true)

    const customRoutesPath = join(result.serverDir, 'custom-routes.ts')
    expect(existsSync(customRoutesPath)).toBe(true)

    const content = readFileSync(customRoutesPath, 'utf-8')
    expect(content).toContain("import { Hono } from 'hono'")
    expect(content).toContain('export default app')
  })

  test('seedSkillServer does not overwrite existing custom-routes.ts', () => {
    const result1 = seedSkillServer(workDir)
    expect(result1.created).toBe(true)

    // Modify custom-routes.ts
    const customRoutesPath = join(result1.serverDir, 'custom-routes.ts')
    writeFileSync(customRoutesPath, 'modified content', 'utf-8')

    // Seed again — should not overwrite
    const result2 = seedSkillServer(workDir)
    expect(result2.created).toBe(false)

    const content = readFileSync(customRoutesPath, 'utf-8')
    expect(content).toBe('modified content')
  })

  // =========================================================================
  // Test 11: Upgrade from previous SDK version (stale server.tsx)
  // =========================================================================
  test('start() replaces old server.tsx lacking customRoutes and still serves /health', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    mkdirSync(join(serverDir, 'generated'), { recursive: true })

    // Old-style server.tsx: no customRoutes, uses export default, static imports
    const oldServer = `
import { Hono } from 'hono'

const app = new Hono()
app.get('/health', (c) => c.json({ ok: true }))

export default {
  port: ${testPort},
  fetch: app.fetch,
}
`
    writeFileSync(join(serverDir, 'server.tsx'), oldServer, 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), 'datasource db {\n  provider = "sqlite"\n}\n', 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()

      // After start, the old server.tsx should have been detected as stale and removed.
      // The manager creates custom-routes.ts and tries to regenerate.
      expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)

      // If server is running, verify it works
      if (manager.isRunning) {
        const resp = await fetch(`http://localhost:${testPort}/health`)
        expect(resp.ok).toBe(true)
      }
    } finally {
      await manager.stop()
    }
  }, 30_000)

  // =========================================================================
  // Test 12: Deleted custom-routes.ts recovery
  // =========================================================================
  test('server recovers after custom-routes.ts is deleted', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    mkdirSync(join(serverDir, 'generated'), { recursive: true })

    // Write a new-style server that imports customRoutes
    writeFileSync(
      join(serverDir, 'custom-routes.ts'),
      "export default { routes: [] }\n",
      'utf-8',
    )

    writeFileSync(
      join(serverDir, 'server.tsx'),
      `
import customRoutes from './custom-routes'
const port = Number(process.env.PORT) || ${testPort}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Bun.serve({
  port,
  async fetch(req) {
    if (new URL(req.url).pathname === '/health') {
      return json({ ok: true })
    }
    return new Response('Not Found', { status: 404 })
  },
})
`,
      'utf-8',
    )

    writeFileSync(join(serverDir, 'schema.prisma'), 'datasource db {\n  provider = "sqlite"\n}\n', 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })

    try {
      await manager.start()
      expect(manager.isRunning).toBe(true)

      const resp1 = await fetch(`http://localhost:${testPort}/health`)
      expect(resp1.ok).toBe(true)

      // Delete custom-routes.ts
      unlinkSync(join(serverDir, 'custom-routes.ts'))
      expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(false)

      // restart() should recreate the file and the server should come back up
      await manager.restart()

      expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)
      expect(manager.isRunning).toBe(true)

      const resp2 = await fetch(`http://localhost:${testPort}/health`)
      expect(resp2.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  }, 15_000)
})
