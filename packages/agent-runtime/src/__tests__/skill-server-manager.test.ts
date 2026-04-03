// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SkillServerManager } from '../skill-server-manager'

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Unique temp dir per test to avoid cross-test interference */
function makeTempDir(): string {
  const dir = join(tmpdir(), `ssm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Random high port to avoid conflicts between parallel tests */
function randomPort(): number {
  return 14100 + Math.floor(Math.random() * 1000)
}

/** Write a minimal Bun HTTP server that registers routes from a JSON manifest.
 *  On startup it reads `routes.json` from its cwd and adds those path prefixes
 *  to the router. This lets tests add routes by updating the manifest and
 *  restarting the server — perfectly simulating what `shogo generate` does.
 */
function writeRoutableServer(serverDir: string, port: number, routes: string[] = []): void {
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })

  writeFileSync(join(serverDir, 'routes.json'), JSON.stringify(routes), 'utf-8')

  const code = `
import { readFileSync } from 'fs'
import { join } from 'path'

const port = Number(process.env.PORT) || ${port}

// Read route manifest at startup — this is the key:
// routes are loaded ONCE at import time, just like the real generated server.tsx
let routes: string[] = []
try {
  routes = JSON.parse(readFileSync(join(import.meta.dir, 'routes.json'), 'utf-8'))
} catch {}

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }
    for (const route of routes) {
      if (url.pathname === route || url.pathname.startsWith(route + '/')) {
        return Response.json({ ok: true, items: [], route })
      }
    }
    return new Response('404 Not Found', { status: 404 })
  },
})
`
  writeFileSync(join(serverDir, 'server.ts'), code, 'utf-8')
}

/** Write a simple test server that only responds to /health */
function writeHealthOnlyServer(serverDir: string, port: number): void {
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })
  writeFileSync(join(serverDir, 'server.ts'), `
Bun.serve({
  port: Number(process.env.PORT) || ${port},
  fetch(req) {
    if (new URL(req.url).pathname === '/health')
      return Response.json({ ok: true })
    return new Response('Not Found', { status: 404 })
  },
})
`, 'utf-8')
}

const SCHEMA_HEADER_CLEAN = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}
`

const SCHEMA_HEADER_WITH_URL = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider        = "prisma-client-js"
  output          = "./generated/prisma"
  previewFeatures = ["queryCompiler", "driverAdapters"]
}
`

const CLIENT_MODEL = `
model Client {
  id    String @id @default(cuid())
  name  String
}
`

const DEAL_MODEL = `
model Deal {
  id    String @id @default(cuid())
  name  String
  value Int
}
`

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// 1. Schema Sanitization (Prisma 7 compatibility)
// ---------------------------------------------------------------------------

describe('SkillServerManager — schema sanitization', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('strips url = env("DATABASE_URL") from datasource block', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_WITH_URL + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })

    // regenerate() calls sanitizeSchema() first. It will fail on runShogoGenerate
    // but we just need to verify the schema was sanitized.
    await manager.regenerate().catch(() => {})

    const content = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(content).not.toContain('url')
    expect(content).not.toContain('env("DATABASE_URL")')
    expect(content).toContain('provider = "sqlite"')
    expect(content).toContain('model Client')
  })

  test('strips directUrl from datasource block', async () => {
    const schema = `datasource db {
  provider  = "sqlite"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Foo {
  id String @id
}
`
    writeFileSync(join(serverDir, 'schema.prisma'), schema, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const content = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(content).not.toContain('url')
    expect(content).not.toContain('directUrl')
    expect(content).not.toContain('env(')
    expect(content).toContain('provider  = "sqlite"')
    expect(content).toContain('model Foo')
  })

  test('strips url = "file:./db.sqlite" (direct string, not env())', async () => {
    const schema = `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Bar {
  id String @id
}
`
    writeFileSync(join(serverDir, 'schema.prisma'), schema, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const content = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(content).not.toContain('url')
    expect(content).not.toContain('file:./dev.db')
    expect(content).toContain('model Bar')
  })

  test('leaves schema unchanged when no url present', async () => {
    const schema = SCHEMA_HEADER_CLEAN + CLIENT_MODEL
    writeFileSync(join(serverDir, 'schema.prisma'), schema, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const content = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(content).toBe(schema)
  })
})

// ---------------------------------------------------------------------------
// 2. Empty Schema Handling
// ---------------------------------------------------------------------------

describe('SkillServerManager — empty schema handling', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('start() skips generation when schema has no models', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    const result = await manager.start()

    expect(result.started).toBe(false)
    expect(result.port).toBeNull()
    // Phase should NOT be 'crashed' — it should be waiting for models
    expect(manager.phase).not.toBe('crashed')
    expect(manager.phase).not.toBe('generating')

    await manager.stop()
  })

  test('start() attempts generation when schema has models and no server exists', async () => {
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL,
      'utf-8',
    )

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    const result = await manager.start()

    // If the SDK CLI is available, generation succeeds and server starts.
    // If not, generation fails and the phase is 'crashed'.
    // Either way, we're testing that it TRIED to regenerate (not skipped).
    const attempted = manager.phase !== 'idle' && manager.phase !== 'stopped'
    expect(attempted).toBe(true)

    // Config files should have been created as part of the regeneration attempt
    expect(existsSync(join(serverDir, 'package.json'))).toBe(true)
    expect(existsSync(join(serverDir, 'shogo.config.json'))).toBe(true)
    expect(existsSync(join(serverDir, 'prisma.config.ts'))).toBe(true)

    await manager.stop()
  })

  test('start() skips generation when server.ts already exists', async () => {
    const port = randomPort()
    writeHealthOnlyServer(serverDir, port)
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })

    try {
      const result = await manager.start()
      // Server file exists, so it should start even without models in schema
      expect(result.started).toBe(true)
      expect(manager.phase).toBe('healthy')
    } finally {
      await manager.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Config File Creation
// ---------------------------------------------------------------------------

describe('SkillServerManager — config scaffolding', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('regenerate() creates package.json with pinned Prisma 7.4.1', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const pkgPath = join(serverDir, 'package.json')
    expect(existsSync(pkgPath)).toBe(true)

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    expect(pkg.dependencies.prisma).toBe('7.4.1')
    expect(pkg.dependencies['@prisma/client']).toBe('7.4.1')
  })

  test('regenerate() creates prisma.config.ts with datasource url', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const configPath = join(serverDir, 'prisma.config.ts')
    expect(existsSync(configPath)).toBe(true)

    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain("import { defineConfig } from 'prisma/config'")
    expect(content).toContain('datasource')
    expect(content).toContain('url')
  })

  test('regenerate() creates shogo.config.json', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const configPath = join(serverDir, 'shogo.config.json')
    expect(existsSync(configPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.schema).toBe('./schema.prisma')
    expect(config.outputs).toBeArray()
    expect(config.outputs.length).toBe(3)
  })

  test('regenerate() does not overwrite existing package.json', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')
    writeFileSync(join(serverDir, 'package.json'), '{"custom": true}', 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf-8'))
    expect(pkg.custom).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Server Start/Stop/Restart
// ---------------------------------------------------------------------------

describe('SkillServerManager — server lifecycle', () => {
  let workDir: string
  let testPort: number

  beforeEach(() => {
    workDir = makeTempDir()
    testPort = randomPort()
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('starts and responds to /health', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeHealthOnlyServer(serverDir, testPort)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    try {
      const result = await manager.start()
      expect(result.started).toBe(true)
      expect(manager.phase).toBe('healthy')

      const resp = await fetch(`http://localhost:${testPort}/health`)
      expect(resp.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  })

  test('restart cycles the process and serves updated routes', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeRoutableServer(serverDir, testPort, ['/api/clients'])

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    try {
      await manager.start()
      expect(manager.phase).toBe('healthy')

      // Verify /api/clients works
      const r1 = await fetch(`http://localhost:${testPort}/api/clients`)
      expect(r1.ok).toBe(true)

      // /api/deals should 404
      const r2 = await fetch(`http://localhost:${testPort}/api/deals`)
      expect(r2.status).toBe(404)

      // Update the routes manifest (simulates shogo generate adding new routes)
      writeFileSync(
        join(serverDir, 'routes.json'),
        JSON.stringify(['/api/clients', '/api/deals']),
        'utf-8',
      )

      // Restart the server
      await manager.restart()
      expect(manager.phase).toBe('healthy')

      // NOW /api/deals should work
      const r3 = await fetch(`http://localhost:${testPort}/api/deals`)
      expect(r3.ok).toBe(true)

      // And /api/clients should still work
      const r4 = await fetch(`http://localhost:${testPort}/api/clients`)
      expect(r4.ok).toBe(true)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  test('without restart, new routes return 404 (the bug)', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeRoutableServer(serverDir, testPort, ['/api/clients'])

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    try {
      await manager.start()

      // /api/clients works
      const r1 = await fetch(`http://localhost:${testPort}/api/clients`)
      expect(r1.ok).toBe(true)

      // Update routes.json but DO NOT restart
      writeFileSync(
        join(serverDir, 'routes.json'),
        JSON.stringify(['/api/clients', '/api/deals']),
        'utf-8',
      )

      // /api/deals should still 404 because the server wasn't restarted
      // (Bun caches the module at startup)
      const r2 = await fetch(`http://localhost:${testPort}/api/deals`)
      expect(r2.status).toBe(404)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  test('start is idempotent when already running', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    writeHealthOnlyServer(serverDir, testPort)

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

  test('stop is safe to call when not started', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.stop()
    expect(manager.phase).toBe('stopped')
  })

  test('restart is no-op when no server entry exists', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.restart()
    expect(manager.isRunning).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Schema Watcher Behavior
// ---------------------------------------------------------------------------

describe('SkillServerManager — schema watcher', () => {
  let workDir: string
  let serverDir: string
  let testPort: number

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    testPort = randomPort()
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('schema watcher starts when start() finds no schema', async () => {
    // No schema at all — watcher should be started for when agent creates one
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    const result = await manager.start()
    expect(result.started).toBe(false)

    // The schema dir should have been created by startSchemaWatcher
    expect(existsSync(serverDir)).toBe(true)

    await manager.stop()
  })

  test('schema watcher starts when start() finds empty schema (no models)', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    const result = await manager.start()
    expect(result.started).toBe(false)
    // phase should not be crashed — just waiting
    expect(manager.phase).not.toBe('crashed')

    await manager.stop()
  })

  test('writing schema.prisma with models triggers handleSchemaChange', async () => {
    // Start with empty schema
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.start()

    const phaseBefore = manager.phase
    expect(phaseBefore).not.toBe('generating')

    // Now write a schema WITH models — the watcher should detect this
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL,
      'utf-8',
    )

    // Wait for debounce (2s) + generation time (~3-5s) + buffer
    await sleep(8000)

    // The watcher should have triggered handleSchemaChange, which calls regenerate.
    // If SDK is available: phase transitions to generating → idle → restarting → healthy/crashed
    // If SDK is not available: phase transitions to generating → crashed
    // Either way, phase should have CHANGED from the initial idle state,
    // AND config files should have been created by regenerate().
    const phaseChanged = manager.phase !== phaseBefore
    const configCreated = existsSync(join(serverDir, 'package.json'))
    expect(phaseChanged || configCreated).toBe(true)

    await manager.stop()
  }, 15_000)

  test('writing non-schema files does not trigger regeneration', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.start()

    // Write a random file — should NOT trigger generation
    writeFileSync(join(serverDir, 'other.txt'), 'hello', 'utf-8')

    await sleep(3500)

    // Phase should still be idle-ish, not crashed from a failed generation
    expect(manager.phase).not.toBe('crashed')
    expect(manager.lastGenerateError).toBeNull()

    await manager.stop()
  }, 10_000)
})

// ---------------------------------------------------------------------------
// 6. Pending Schema Change Re-queuing
// ---------------------------------------------------------------------------

describe('SkillServerManager — pending schema changes', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('pendingSchemaChange flag is set when change arrives during generation', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })

    // Force phase to 'generating' to simulate being in the middle of regeneration
    ;(manager as any)._phase = 'generating'
    expect((manager as any).pendingSchemaChange).toBe(false)

    // Start the schema watcher
    ;(manager as any).startSchemaWatcher()

    // Give watcher time to initialize
    await sleep(200)

    // Write to schema — watcher should set pendingSchemaChange instead of starting a timer
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL + DEAL_MODEL,
      'utf-8',
    )

    // fs.watch events can be delayed — poll for the flag
    let flagSet = false
    for (let i = 0; i < 20; i++) {
      await sleep(100)
      if ((manager as any).pendingSchemaChange) {
        flagSet = true
        break
      }
    }

    expect(flagSet).toBe(true)
    // schemaTimer should NOT have been set (we're in generating phase)
    expect((manager as any).schemaTimer).toBeNull()

    await manager.stop()
  }, 10_000)

  test('pendingSchemaChange flag is set when change arrives during restart', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })

    ;(manager as any)._phase = 'restarting'
    ;(manager as any).startSchemaWatcher()

    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL + DEAL_MODEL,
      'utf-8',
    )

    await sleep(500)
    expect((manager as any).pendingSchemaChange).toBe(true)

    await manager.stop()
  }, 5_000)
})

// ---------------------------------------------------------------------------
// 7. handleSchemaChange() calls regenerate + restart
// ---------------------------------------------------------------------------

describe('SkillServerManager — handleSchemaChange lifecycle', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('handleSchemaChange skips when schema has no models', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    const phaseBefore = manager.phase

    await (manager as any).handleSchemaChange()

    // Phase should not have changed — the handler skipped
    expect(manager.phase).toBe(phaseBefore)
    expect(manager.lastGenerateError).toBeNull()
  })

  test('handleSchemaChange calls regenerate when schema has models', async () => {
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL,
      'utf-8',
    )

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await (manager as any).handleSchemaChange()

    // regenerate() was called. If SDK exists it succeeds; if not, it crashes.
    // Either way, config files were created as part of the pipeline.
    expect(existsSync(join(serverDir, 'package.json'))).toBe(true)
    expect(existsSync(join(serverDir, 'prisma.config.ts'))).toBe(true)
    // Phase should have moved past 'idle' — either 'healthy' or 'crashed'
    expect(manager.phase).not.toBe('idle')

    await manager.stop()
  })

  test('handleSchemaChange sanitizes the schema before generation', async () => {
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_WITH_URL + CLIENT_MODEL,
      'utf-8',
    )

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await (manager as any).handleSchemaChange()

    const content = readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')
    expect(content).not.toContain('env("DATABASE_URL")')
  })

  test('handleSchemaChange re-runs when pendingSchemaChange is set during generation', async () => {
    writeFileSync(
      join(serverDir, 'schema.prisma'),
      SCHEMA_HEADER_CLEAN + CLIENT_MODEL,
      'utf-8',
    )

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })

    // Simulate: during regenerate(), another schema change comes in
    const originalRegenerate = (manager as any).regenerate.bind(manager)
    let regenerateCallCount = 0
    ;(manager as any).regenerate = async function (): Promise<boolean> {
      regenerateCallCount++
      if (regenerateCallCount === 1) {
        // Simulate a schema change arriving during the first regeneration
        ;(manager as any).pendingSchemaChange = true
      }
      return originalRegenerate()
    }

    await (manager as any).handleSchemaChange()

    // regenerate should have been called at least twice:
    // once for the initial change, once for the pending change
    expect(regenerateCallCount).toBeGreaterThanOrEqual(2)

    await manager.stop()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 8. The 404 Route Bug — end-to-end with routable server
// ---------------------------------------------------------------------------

describe('SkillServerManager — route visibility after restart', () => {
  let workDir: string
  let serverDir: string
  let testPort: number

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
    testPort = randomPort()
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('routes added after server start are visible after explicit restart()', async () => {
    writeRoutableServer(serverDir, testPort, ['/api/clients'])

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    try {
      await manager.start()

      // Phase 1: Only /api/clients exists
      expect((await fetch(`http://localhost:${testPort}/api/clients`)).ok).toBe(true)
      expect((await fetch(`http://localhost:${testPort}/api/deals`)).status).toBe(404)

      // Simulate shogo generate creating new route files
      writeFileSync(
        join(serverDir, 'routes.json'),
        JSON.stringify(['/api/clients', '/api/deals', '/api/projects']),
        'utf-8',
      )

      // Explicit restart (what handleSchemaChange does)
      await manager.restart()

      // Phase 2: All routes should be visible
      expect((await fetch(`http://localhost:${testPort}/api/clients`)).ok).toBe(true)
      expect((await fetch(`http://localhost:${testPort}/api/deals`)).ok).toBe(true)
      expect((await fetch(`http://localhost:${testPort}/api/projects`)).ok).toBe(true)
    } finally {
      await manager.stop()
    }
  }, 15_000)

  test('server process PID changes after restart (proves new process)', async () => {
    writeRoutableServer(serverDir, testPort, ['/api/clients'])

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    try {
      await manager.start()
      const pid1 = (manager as any).serverProcess?.pid

      await manager.restart()
      const pid2 = (manager as any).serverProcess?.pid

      expect(pid1).toBeDefined()
      expect(pid2).toBeDefined()
      expect(pid1).not.toBe(pid2)
    } finally {
      await manager.stop()
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// 9. Crash Recovery
// ---------------------------------------------------------------------------

describe('SkillServerManager — crash recovery', () => {
  let workDir: string
  let testPort: number

  beforeEach(() => {
    workDir = makeTempDir()
    testPort = randomPort()
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('handles server that fails health check', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(
      join(serverDir, 'server.ts'),
      `Bun.serve({ port: ${testPort}, fetch() { return new Response('nope', { status: 500 }) } })`,
      'utf-8',
    )

    const manager = new SkillServerManager({
      workspaceDir: workDir,
      port: testPort,
      healthCheckRetries: 3,
      healthCheckIntervalMs: 100,
    })

    try {
      const result = await manager.start()
      expect(result.started).toBe(false)
      expect(manager.phase).toBe('crashed')
    } finally {
      await manager.stop()
    }
  }, 10_000)

  test('handles server that exits immediately', async () => {
    const serverDir = join(workDir, '.shogo', 'server')
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'server.ts'), 'process.exit(1)', 'utf-8')

    const manager = new SkillServerManager({
      workspaceDir: workDir,
      port: testPort,
      healthCheckRetries: 3,
      healthCheckIntervalMs: 100,
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

// ---------------------------------------------------------------------------
// 10. Port & URL Configuration
// ---------------------------------------------------------------------------

describe('SkillServerManager — configuration', () => {
  test('port defaults to 4100', () => {
    delete process.env.SKILL_SERVER_PORT
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test' })
    expect(manager.port).toBe(4100)
  })

  test('SKILL_SERVER_PORT env overrides config.port', () => {
    process.env.SKILL_SERVER_PORT = '5555'
    try {
      const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: 9999 })
      expect(manager.port).toBe(5555)
    } finally {
      delete process.env.SKILL_SERVER_PORT
    }
  })

  test('url includes the configured port', () => {
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: 9999 })
    expect(manager.url).toBe('http://localhost:9999')
  })
})
