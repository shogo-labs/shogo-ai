// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
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
  // Pre-create node_modules so SkillServerManager.installDeps() short-circuits
  // (it returns early when the directory already exists). This mirrors what
  // the warm-pool prewarm or the baked runtime template guarantees in
  // production but doesn't exist in local test environments. The stub server
  // we write below only uses Bun built-ins, so an empty node_modules is fine.
  mkdirSync(join(serverDir, 'node_modules'), { recursive: true })

  if (!existsSync(join(serverDir, 'custom-routes.ts'))) {
    writeFileSync(join(serverDir, 'custom-routes.ts'), "export default { routes: [] }\n", 'utf-8')
  }

  writeFileSync(join(serverDir, 'routes.json'), JSON.stringify(routes), 'utf-8')

  const code = `
import { readFileSync } from 'fs'
import { join } from 'path'
import customRoutes from './custom-routes'

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
  // See note in writeRoutableServer — short-circuits installDeps() locally.
  mkdirSync(join(serverDir, 'node_modules'), { recursive: true })

  if (!existsSync(join(serverDir, 'custom-routes.ts'))) {
    writeFileSync(join(serverDir, 'custom-routes.ts'), "export default { routes: [] }\n", 'utf-8')
  }

  writeFileSync(join(serverDir, 'server.ts'), `
import customRoutes from './custom-routes'
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

  test('start() generates server and starts even when schema has no models', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    const result = await manager.start()

    // With the SDK's dynamicCrudImport, the server starts even without models.
    // If the SDK CLI is available, generation succeeds and server starts.
    // If not, generation may fail — but it attempted.
    const attempted = manager.phase !== 'idle'
    expect(attempted).toBe(true)

    // Config files should have been created
    expect(existsSync(join(serverDir, 'shogo.config.json'))).toBe(true)

    await manager.stop()
  })

  test('start() attempts generation when no server exists (with or without models)', async () => {
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

  test('schema watcher starts when start() is called (even without schema)', async () => {
    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.start()

    // The schema dir should have been created by startSchemaWatcher
    expect(existsSync(serverDir)).toBe(true)

    await manager.stop()
  })

  test('schema watcher starts when start() finds empty schema (no models)', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: testPort })
    await manager.start()

    // Server should have attempted generation
    const attempted = manager.phase !== 'idle'
    expect(attempted).toBe(true)

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
    writeFileSync(join(serverDir, 'custom-routes.ts'), "export default { routes: [] }\n", 'utf-8')
    writeFileSync(
      join(serverDir, 'server.ts'),
      `import customRoutes from './custom-routes'\nBun.serve({ port: ${testPort}, fetch() { return new Response('nope', { status: 500 }) } })`,
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
    writeFileSync(join(serverDir, 'custom-routes.ts'), "export default { routes: [] }\n", 'utf-8')
    writeFileSync(join(serverDir, 'server.ts'), "import customRoutes from './custom-routes'\nprocess.exit(1)", 'utf-8')

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

// ---------------------------------------------------------------------------
// 11. Custom Routes Scaffolding
// ---------------------------------------------------------------------------

describe('SkillServerManager — custom routes scaffolding', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('start() creates custom-routes.ts if it does not exist', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.start()

    const customRoutesPath = join(serverDir, 'custom-routes.ts')
    expect(existsSync(customRoutesPath)).toBe(true)

    const content = readFileSync(customRoutesPath, 'utf-8')
    expect(content).toContain('Hono')
    expect(content).toContain('export default')

    await manager.stop()
  })

  test('start() does NOT overwrite existing custom-routes.ts', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const userCustomRoutes = "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/hello', (c) => c.json({ hi: true }))\nexport default app\n"
    writeFileSync(join(serverDir, 'custom-routes.ts'), userCustomRoutes, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.start()

    const content = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toBe(userCustomRoutes)

    await manager.stop()
  })

  test('shogo.config.json includes dynamicCrudImport, bunServe, customRoutesPath', async () => {
    mkdirSync(serverDir, { recursive: true })
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN + CLIENT_MODEL, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.regenerate().catch(() => {})

    const configPath = join(serverDir, 'shogo.config.json')
    expect(existsSync(configPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const serverOutput = config.outputs.find((o: any) => o.generate.includes('server'))
    expect(serverOutput).toBeDefined()
    expect(serverOutput.serverConfig.dynamicCrudImport).toBe(true)
    expect(serverOutput.serverConfig.bunServe).toBe(true)
    expect(serverOutput.serverConfig.customRoutesPath).toBe('./custom-routes')
  })
})

// ---------------------------------------------------------------------------
// 12. No Runtime Patching Artifacts
// ---------------------------------------------------------------------------

describe('SkillServerManager — no runtime patching artifacts', () => {
  let workDir: string
  let serverDir: string

  beforeEach(() => {
    workDir = makeTempDir()
    serverDir = join(workDir, '.shogo', 'server')
  })

  afterEach(async () => {
    rmSync(workDir, { recursive: true, force: true })
  })

  test('server.tsx does NOT contain old patch markers after start with existing server', async () => {
    const port = randomPort()
    writeHealthOnlyServer(serverDir, port)
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })

    try {
      await manager.start()

      const entry = existsSync(join(serverDir, 'server.tsx'))
        ? join(serverDir, 'server.tsx')
        : join(serverDir, 'server.ts')

      if (existsSync(entry)) {
        const code = readFileSync(entry, 'utf-8')
        expect(code).not.toContain('// Mount custom routes (written by agent)')
      }
    } finally {
      await manager.stop()
    }
  })

  test('SkillServerManager has no patchCustomRoutes method', () => {
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: randomPort() })
    expect((manager as any).patchCustomRoutes).toBeUndefined()
  })

  test('SkillServerManager has no patchServerForBunRun method', () => {
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: randomPort() })
    expect((manager as any).patchServerForBunRun).toBeUndefined()
  })

  test('SkillServerManager has no deleteServerEntry method', () => {
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: randomPort() })
    expect((manager as any).deleteServerEntry).toBeUndefined()
  })

  test('SkillServerManager has no ensureMinimalServer method', () => {
    const manager = new SkillServerManager({ workspaceDir: '/tmp/test', port: randomPort() })
    expect((manager as any).ensureMinimalServer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 13. Upgrade from Previous SDK Version
// ---------------------------------------------------------------------------

describe('SkillServerManager — upgrade from previous SDK version', () => {
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

  test('start() removes stale server.tsx that lacks customRoutes import', async () => {
    const port = randomPort()
    const oldServerCode = `
import { Hono } from 'hono'
import { createAllRoutes } from './generated'
import { prisma } from './db'

const app = new Hono()
app.route('/api', createAllRoutes(prisma))

export default {
  port: ${port},
  fetch: app.fetch,
}
`
    writeFileSync(join(serverDir, 'server.tsx'), oldServerCode, 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })

    // start() should detect the stale server, delete it, and attempt regeneration
    await manager.start()

    // The old server.tsx should have been replaced — either regenerated or deleted
    const entry = existsSync(join(serverDir, 'server.tsx'))
      ? readFileSync(join(serverDir, 'server.tsx'), 'utf-8')
      : existsSync(join(serverDir, 'server.ts'))
        ? readFileSync(join(serverDir, 'server.ts'), 'utf-8')
        : null

    // If regeneration succeeded, the new server should have customRoutes
    // If regeneration failed (no SDK installed), the old stale one should be gone
    if (entry) {
      expect(entry).toContain('customRoutes')
    } else {
      // Stale file was deleted even if regeneration couldn't produce a new one
      expect(existsSync(join(serverDir, 'server.tsx'))).toBe(false)
    }

    await manager.stop()
  })

  test('start() does NOT remove server.tsx that already has customRoutes', async () => {
    const port = randomPort()
    const newServerCode = `
import { Hono } from 'hono'
import customRoutes from './custom-routes'

const app = new Hono()
app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', customRoutes)

Bun.serve({ port: ${port}, fetch: app.fetch })
`
    writeFileSync(join(serverDir, 'server.tsx'), newServerCode, 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })
    await manager.start()

    // The server.tsx should NOT have been deleted
    expect(existsSync(join(serverDir, 'server.tsx'))).toBe(true)
    const content = readFileSync(join(serverDir, 'server.tsx'), 'utf-8')
    expect(content).toContain('customRoutes')
    expect(content).toContain('Bun.serve')

    await manager.stop()
  })

  test('ensureCustomRoutes creates custom-routes.ts for old workspaces', async () => {
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')
    // Simulate old workspace: schema exists but no custom-routes.ts
    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(false)

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    await manager.start()

    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)
    const content = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toContain('Hono')
    expect(content).toContain('export default')

    await manager.stop()
  })
})

// ---------------------------------------------------------------------------
// 14. Deleted custom-routes.ts Recovery
// ---------------------------------------------------------------------------

describe('SkillServerManager — deleted custom-routes.ts recovery', () => {
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

  test('restart() recreates custom-routes.ts if it was deleted', async () => {
    const port = randomPort()
    writeHealthOnlyServer(serverDir, port)
    writeFileSync(join(serverDir, 'custom-routes.ts'), "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n", 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })
    await manager.start()

    // Delete the custom routes file
    unlinkSync(join(serverDir, 'custom-routes.ts'))
    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(false)

    // restart() should recreate it
    await manager.restart()

    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)
    const content = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toContain('Hono')
    expect(content).toContain('export default')

    await manager.stop()
  })

  test('handleCustomRoutesChange recreates custom-routes.ts on deletion', async () => {
    const port = randomPort()
    writeHealthOnlyServer(serverDir, port)
    writeFileSync(join(serverDir, 'custom-routes.ts'), "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n", 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port })
    await manager.start()

    // Delete the custom routes file
    unlinkSync(join(serverDir, 'custom-routes.ts'))
    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(false)

    // Trigger the handler directly (simulating what the watcher does)
    ;(manager as any).handleCustomRoutesChange()

    // RESTART_DEBOUNCE_MS is 1000ms, plus restart needs time to complete
    await new Promise(resolve => setTimeout(resolve, 4000))

    expect(existsSync(join(serverDir, 'custom-routes.ts'))).toBe(true)
    const content = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toContain('Hono')

    await manager.stop()
  }, 10_000)

  test('ensureCustomRoutes is idempotent — does not overwrite existing file', async () => {
    const userContent = "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/my-route', (c) => c.json({ custom: true }))\nexport default app\n"
    writeFileSync(join(serverDir, 'custom-routes.ts'), userContent, 'utf-8')
    writeFileSync(join(serverDir, 'schema.prisma'), SCHEMA_HEADER_CLEAN, 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    ;(manager as any).ensureCustomRoutes()

    const content = readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toBe(userContent)

    await manager.stop()
  })
})

// ---------------------------------------------------------------------------
// 16. prewarmDeps — warm-pool boot path
// ---------------------------------------------------------------------------
//
// `SkillServerManager.prewarmDeps` is called during warm-pool pod boot to copy
// the skill-server template `node_modules` into the workspace BEFORE a project
// claims the pod. That way the ~270 MB / ~9 s sync cpSync is paid while the
// pod is idle, not during the user's first chat. These tests verify:
//
//   - We don't touch the workspace when the baked template is missing
//     (e.g. local dev without /app/templates) so calls are safe to make
//     unconditionally from the pool pre-init path.
//   - Repeat calls are no-ops once node_modules is in place.
//   - When the template exists, the copy lands at the path the runtime
//     expects (`<workspaceDir>/.shogo/server/node_modules`).
//   - The follow-on `installDeps()` short-circuits — proving the warm-pool
//     copy is reused on assignment, not redone.

describe('SkillServerManager — prewarmDeps (warm-pool boot)', () => {
  let workDir: string
  let templateDir: string
  const originalTemplateEnv = process.env.SKILL_SERVER_TEMPLATE_DIR

  beforeEach(() => {
    workDir = makeTempDir()
    templateDir = makeTempDir()
  })

  afterEach(() => {
    if (originalTemplateEnv === undefined) {
      delete process.env.SKILL_SERVER_TEMPLATE_DIR
    } else {
      process.env.SKILL_SERVER_TEMPLATE_DIR = originalTemplateEnv
    }
    rmSync(workDir, { recursive: true, force: true })
    rmSync(templateDir, { recursive: true, force: true })
  })

  test('returns false and skips when template is missing (safe in local dev)', () => {
    process.env.SKILL_SERVER_TEMPLATE_DIR = join(templateDir, 'does-not-exist')

    const result = SkillServerManager.prewarmDeps(workDir)

    expect(result).toBe(false)
    expect(existsSync(join(workDir, '.shogo', 'server', 'node_modules'))).toBe(false)
  })

  test('returns false and is idempotent when node_modules already exists', () => {
    const templateModules = join(templateDir, 'node_modules')
    mkdirSync(templateModules, { recursive: true })
    writeFileSync(join(templateModules, 'marker'), 'template', 'utf-8')
    process.env.SKILL_SERVER_TEMPLATE_DIR = templateDir

    const serverDir = join(workDir, '.shogo', 'server')
    const existingModules = join(serverDir, 'node_modules')
    mkdirSync(existingModules, { recursive: true })
    writeFileSync(join(existingModules, 'sentinel'), 'pre-existing', 'utf-8')

    const result = SkillServerManager.prewarmDeps(workDir)

    expect(result).toBe(false)
    // Pre-existing tree is preserved, NOT clobbered by a redundant copy.
    expect(readFileSync(join(existingModules, 'sentinel'), 'utf-8')).toBe('pre-existing')
    expect(existsSync(join(existingModules, 'marker'))).toBe(false)
  })

  test('copies template node_modules into <workspace>/.shogo/server/node_modules', () => {
    const templateModules = join(templateDir, 'node_modules')
    mkdirSync(join(templateModules, 'hono'), { recursive: true })
    writeFileSync(join(templateModules, 'hono', 'package.json'), '{"name":"hono","version":"4.0.0"}', 'utf-8')
    mkdirSync(join(templateModules, '.bin'), { recursive: true })
    writeFileSync(join(templateModules, '.bin', 'prisma'), '#!/usr/bin/env bun\n', 'utf-8')
    process.env.SKILL_SERVER_TEMPLATE_DIR = templateDir

    const result = SkillServerManager.prewarmDeps(workDir)

    expect(result).toBe(true)
    const seededModules = join(workDir, '.shogo', 'server', 'node_modules')
    expect(existsSync(seededModules)).toBe(true)
    expect(readFileSync(join(seededModules, 'hono', 'package.json'), 'utf-8'))
      .toBe('{"name":"hono","version":"4.0.0"}')
    expect(existsSync(join(seededModules, '.bin', 'prisma'))).toBe(true)
  })

  test('subsequent installDeps() short-circuits after prewarmDeps (the optimization)', () => {
    const templateModules = join(templateDir, 'node_modules')
    mkdirSync(join(templateModules, 'hono'), { recursive: true })
    writeFileSync(join(templateModules, 'hono', 'package.json'), '{"name":"hono"}', 'utf-8')
    process.env.SKILL_SERVER_TEMPLATE_DIR = templateDir

    expect(SkillServerManager.prewarmDeps(workDir)).toBe(true)

    const seededModules = join(workDir, '.shogo', 'server', 'node_modules')
    const seededMarker = join(seededModules, 'shogo-warm-pool-marker')
    writeFileSync(seededMarker, 'placed-by-prewarm', 'utf-8')

    const manager = new SkillServerManager({ workspaceDir: workDir, port: randomPort() })
    ;(manager as any).installDeps()

    // installDeps() must short-circuit on the existing node_modules and leave
    // our warm-pool marker untouched. If it had re-run the cpSync, the marker
    // wouldn't survive (cpSync overwrites cleanly per-file but doesn't leave
    // file_paths that aren't in the source tree alone if `force: true` were
    // ever introduced — this guards against a future regression there).
    expect(readFileSync(seededMarker, 'utf-8')).toBe('placed-by-prewarm')
  })

  test('preserves project-specific files restored from S3 alongside prewarmed node_modules', () => {
    // Simulates the warm-pool claim flow: prewarm runs first, then S3 sync
    // writes the user's schema.prisma + custom-routes.ts into .shogo/server.
    // The two should coexist — prewarm only ever touches node_modules.
    const templateModules = join(templateDir, 'node_modules')
    mkdirSync(join(templateModules, 'hono'), { recursive: true })
    writeFileSync(join(templateModules, 'hono', 'index.js'), 'module.exports = {}', 'utf-8')
    process.env.SKILL_SERVER_TEMPLATE_DIR = templateDir

    expect(SkillServerManager.prewarmDeps(workDir)).toBe(true)

    const serverDir = join(workDir, '.shogo', 'server')
    const userSchema = 'datasource db {\n  provider = "sqlite"\n}\nmodel Client { id String @id }\n'
    const userRoutes = "import { Hono } from 'hono'\nexport default new Hono().get('/x', (c) => c.text('user'))\n"
    writeFileSync(join(serverDir, 'schema.prisma'), userSchema, 'utf-8')
    writeFileSync(join(serverDir, 'custom-routes.ts'), userRoutes, 'utf-8')

    expect(readFileSync(join(serverDir, 'schema.prisma'), 'utf-8')).toBe(userSchema)
    expect(readFileSync(join(serverDir, 'custom-routes.ts'), 'utf-8')).toBe(userRoutes)
    expect(existsSync(join(serverDir, 'node_modules', 'hono', 'index.js'))).toBe(true)
  })
})
