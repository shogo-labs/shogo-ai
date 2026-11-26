// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateServer, generateDbModule, generateSqliteDbModule } from '../server-generator'

describe('Server Generator', () => {
  describe('default config (backward compat)', () => {
    const output = generateServer()

    it('statically imports createAllRoutes and prisma', () => {
      expect(output).toContain("import { createAllRoutes } from './src/generated'")
      expect(output).toContain("import { prisma } from './src/lib/db'")
    })

    it('does not use dynamic import', () => {
      expect(output).not.toContain('await import(')
    })

    it('uses export default (not Bun.serve)', () => {
      expect(output).toContain('export default {')
      expect(output).not.toContain('Bun.serve(')
    })

    it('does not import customRoutes', () => {
      expect(output).not.toContain('customRoutes')
    })

    it('includes health check', () => {
      expect(output).toContain("app.get('/health'")
    })

    it('includes CORS middleware', () => {
      expect(output).toContain('Access-Control-Allow-Origin')
    })

    it('serves static files by default', () => {
      expect(output).toContain("import { serveStatic } from 'hono/bun'")
    })
  })

  describe('customRoutesPath', () => {
    const output = generateServer({ customRoutesPath: './custom-routes' })

    it('imports the custom routes file', () => {
      expect(output).toContain("import customRoutes from './custom-routes'")
    })

    it('mounts custom routes at the API base path', () => {
      expect(output).toContain("app.route('/api', customRoutes)")
    })
  })

  describe('dynamicCrudImport', () => {
    const output = generateServer({ dynamicCrudImport: true })

    it('uses dynamic import for createAllRoutes', () => {
      expect(output).toContain("await import('./src/generated')")
    })

    it('uses dynamic import for prisma', () => {
      expect(output).toContain("await import('./src/lib/db')")
    })

    it('wraps CRUD imports in try/catch', () => {
      expect(output).toContain('try {')
      expect(output).toContain('} catch {')
    })

    it('does not have static CRUD imports', () => {
      expect(output).not.toContain("import { createAllRoutes }")
      expect(output).not.toContain("import { prisma }")
    })
  })

  describe('bunServe', () => {
    const output = generateServer({ bunServe: true })

    it('uses Bun.serve()', () => {
      expect(output).toContain('Bun.serve({ port, fetch: app.fetch })')
    })

    it('does not use export default', () => {
      expect(output).not.toContain('export default {')
    })
  })

  describe('all three combined (project server template)', () => {
    const output = generateServer({
      port: 4100,
      skipStatic: true,
      routesPath: './generated',
      dbPath: './db',
      customRoutesPath: './custom-routes',
      dynamicCrudImport: true,
      bunServe: true,
    })

    it('uses dynamic import for CRUD', () => {
      expect(output).toContain("await import('./generated')")
      expect(output).toContain("await import('./db')")
    })

    it('imports and mounts custom routes', () => {
      expect(output).toContain("import customRoutes from './custom-routes'")
      expect(output).toContain("app.route('/api', customRoutes)")
    })

    it('uses Bun.serve', () => {
      expect(output).toContain('Bun.serve({ port, fetch: app.fetch })')
    })

    it('does not serve static files', () => {
      expect(output).not.toContain('serveStatic')
    })

    it('has health check', () => {
      expect(output).toContain("app.get('/health'")
    })

    it('custom routes are mounted after CRUD', () => {
      const crudIdx = output.indexOf('await import(')
      const customIdx = output.indexOf("app.route('/api', customRoutes)")
      expect(crudIdx).toBeGreaterThan(-1)
      expect(customIdx).toBeGreaterThan(crudIdx)
    })
  })

  describe('customRoutesPath without dynamicCrudImport', () => {
    const output = generateServer({
      customRoutesPath: './custom-routes',
      routesPath: './generated',
      dbPath: './db',
    })

    it('has static CRUD imports', () => {
      expect(output).toContain("import { createAllRoutes } from './generated'")
      expect(output).toContain("import { prisma } from './db'")
    })

    it('also has custom routes', () => {
      expect(output).toContain("import customRoutes from './custom-routes'")
      expect(output).toContain("app.route('/api', customRoutes)")
    })
  })

  describe('skipStatic', () => {
    const output = generateServer({ skipStatic: true })

    it('does not import serveStatic', () => {
      expect(output).not.toContain('serveStatic')
    })
  })

  describe('cors disabled', () => {
    const output = generateServer({ cors: false })

    it('does not include CORS middleware', () => {
      expect(output).not.toContain('Access-Control-Allow-Origin')
    })
  })

  describe('tools handler (default on)', () => {
    const output = generateServer()

    it('imports createToolsHandlers from @shogo-ai/sdk/tools/server', () => {
      expect(output).toContain(
        "import { createToolsHandlers } from '@shogo-ai/sdk/tools/server'",
      )
    })

    it('mounts execute and schemas under the API base path', () => {
      expect(output).toContain("app.post('/api/tools/execute'")
      expect(output).toContain("app.get('/api/tools/schemas'")
    })

    it('mounts tools BEFORE the static catch-all so requests do not fall through', () => {
      const toolsIdx = output.indexOf("app.post('/api/tools/execute'")
      const staticIdx = output.indexOf("app.get('*', serveStatic")
      expect(toolsIdx).toBeGreaterThan(-1)
      expect(staticIdx).toBeGreaterThan(toolsIdx)
    })
  })

  describe('runtime introspection (SHO-403)', () => {
    const output = generateServer({ customRoutesPath: './custom-routes' })

    it('mounts /__shogo/health and /__shogo/routes outside the API base path', () => {
      expect(output).toContain("app.get('/__shogo/health'")
      expect(output).toContain("app.get('/__shogo/routes'")
      expect(output).not.toContain("app.get('/api/__shogo")
    })

    it('lists the real Hono route table, de-duplicated, at request time', () => {
      expect(output).toContain('for (const route of app.routes)')
      expect(output).toContain('if (seen.has(key)) continue')
      expect(output).toContain('routes.push({ method, path: route.path })')
      // Its own endpoints are not part of the app's route table.
      expect(output).toContain("if (route.path.startsWith('/__shogo')) continue")
      // Only the API surface: `/health` and the SPA catch-all are real routes
      // but not API routes, and the runtime reports this list as `/api/<path>`.
      expect(output).toContain("if (!route.path.startsWith('/api'.replace(/\\/$/, '') + '/')) continue")
    })

    it('registers them only after custom routes so custom routes are listed', () => {
      const customIdx = output.indexOf("app.route('/api', customRoutes)")
      const routesIdx = output.indexOf("app.get('/__shogo/routes'")
      expect(customIdx).toBeGreaterThan(-1)
      expect(routesIdx).toBeGreaterThan(customIdx)
    })

    it('registers them BEFORE the static catch-all so it cannot swallow them', () => {
      const healthIdx = output.indexOf("app.get('/__shogo/health'")
      const staticIdx = output.indexOf("app.get('*', serveStatic")
      expect(staticIdx).toBeGreaterThan(healthIdx)
    })
  })

  describe('tools disabled', () => {
    const output = generateServer({ tools: false })

    it('does not import createToolsHandlers', () => {
      expect(output).not.toContain('createToolsHandlers')
    })

    it('does not mount /api/tools/* routes', () => {
      expect(output).not.toContain("'/api/tools/execute'")
      expect(output).not.toContain("'/api/tools/schemas'")
    })
  })

  describe('tools with custom apiBasePath', () => {
    const output = generateServer({ apiBasePath: '/v1', tools: true })

    it('respects the apiBasePath for tools mounts', () => {
      expect(output).toContain("app.post('/v1/tools/execute'")
      expect(output).toContain("app.get('/v1/tools/schemas'")
    })
  })
})

describe('generateDbModule', () => {
  const output = generateDbModule()

  it('imports PrismaPg adapter', () => {
    expect(output).toContain("import { PrismaPg } from '@prisma/adapter-pg'")
  })

  it('imports PrismaClient from generated path', () => {
    expect(output).toContain("import { PrismaClient } from '../generated/prisma/client'")
  })

  it('creates PrismaPg adapter with DATABASE_URL', () => {
    expect(output).toContain('connectionString: process.env.DATABASE_URL')
  })

  it('exports prisma singleton', () => {
    expect(output).toContain('export const prisma =')
    expect(output).toContain('globalForPrisma.prisma ??')
  })

  it('guards singleton with NODE_ENV check', () => {
    expect(output).toContain("if (process.env.NODE_ENV !== 'production')")
  })

  it('includes the SDK auto-gen license header', () => {
    expect(output).toContain('Auto-generated by @shogo-ai/sdk')
  })
})

describe('generateSqliteDbModule', () => {
  const output = generateSqliteDbModule()

  it('imports PrismaBunSqlite adapter', () => {
    expect(output).toContain("import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite'")
  })

  it('imports PrismaClient from ./generated path', () => {
    expect(output).toContain("import { PrismaClient } from './generated/prisma/client'")
  })

  it('defaults DATABASE_URL to file:./skill.db', () => {
    expect(output).toContain("url: process.env.DATABASE_URL ?? 'file:./skill.db'")
  })

  it('exports prisma singleton', () => {
    expect(output).toContain('export const prisma =')
    expect(output).toContain('globalForPrisma.prisma ??')
  })

  it('guards singleton with NODE_ENV check', () => {
    expect(output).toContain("if (process.env.NODE_ENV !== 'production')")
  })

  it('includes the SDK auto-gen license header', () => {
    expect(output).toContain('Auto-generated by @shogo-ai/sdk')
  })
})

// SHO-551 B: guard that refuses to down-convert a Postgres app to SQLite.
describe('databaseUrlGuard', () => {
  const { databaseUrlGuard } = require('../server-generator')

  it('recognises a postgres:// URL as Postgres', () => {
    expect(databaseUrlGuard('postgres://user:pw@host/db').isPostgres).toBe(true)
    expect(databaseUrlGuard('postgresql://user:pw@host/db').isPostgres).toBe(true)
  })

  it('recognises file: and .db as SQLite', () => {
    expect(databaseUrlGuard('file:./prisma/dev.db').isSqlite).toBe(true)
    expect(databaseUrlGuard('dev.db').isSqlite).toBe(true)
    expect(databaseUrlGuard('').isSqlite).toBe(true)
  })

  it('reports a Postgres URL as not SQLite', () => {
    expect(databaseUrlGuard('postgres://user:pw@host/db').isSqlite).toBe(false)
  })

  it('handles null and undefined gracefully', () => {
    expect(databaseUrlGuard(null).isPostgres).toBe(false)
    expect(databaseUrlGuard(undefined).isSqlite).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SHO-551 AC 3: booting a client with the wrong URL/driver pair exits with the
// mismatch error, so a bad revision fails instead of 500ing every query.
//
// These run the *generated* module for real, with its imports stubbed, because
// the guard is only worth having if it fires in the file that ships.
// ---------------------------------------------------------------------------
describe('generated client boot guard', () => {
  const dirs: string[] = []
  const cleanup = () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  function writeStubs(root: string, moduleText: string, layout: 'postgres' | 'sqlite'): string {
    // Every import the generated module makes must resolve before the guard runs.
    // The layouts mirror the real apps: `<root>/src/lib/db.tsx` for a Postgres
    // client (imports `../generated/prisma/client`), `<root>/db.tsx` for SQLite.
    const clientDir = join(root, layout === 'postgres' ? join('src', 'generated', 'prisma') : join('generated', 'prisma'))
    mkdirSync(clientDir, { recursive: true })
    writeFileSync(join(clientDir, 'client.ts'), 'export class PrismaClient {}\n')

    const stub = (name: string, body: string) => {
      const pkgDir = join(root, 'node_modules', name)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, main: 'index.js', type: 'module' }))
      writeFileSync(join(pkgDir, 'index.js'), body)
    }
    stub('prisma-adapter-bun-sqlite', 'export class PrismaBunSqlite { constructor(_o) {} }\n')
    stub('@prisma/adapter-pg', 'export class PrismaPg { constructor(_o) {} }\n')

    const entryDir = layout === 'postgres' ? join(root, 'src', 'lib') : root
    mkdirSync(entryDir, { recursive: true })
    const entry = join(entryDir, 'db.tsx')
    writeFileSync(entry, moduleText)
    return entry
  }

  function boot(moduleText: string, databaseUrl: string | undefined, layout: 'postgres' | 'sqlite') {
    const root = mkdtempSync(join(tmpdir(), 'shogo-boot-guard-'))
    dirs.push(root)
    const entry = writeStubs(root, moduleText, layout)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string' && k !== 'DATABASE_URL') env[k] = v
    }
    if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl
    const run = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: 'utf-8' })
    return { status: run.status, stderr: run.stderr ?? '' }
  }

  it('exits when the SQLite client is booted with a Postgres URL', () => {
    const result = boot(generateSqliteDbModule(), 'postgres://user:pw@projects-pg:5432/project_x', 'sqlite')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to start')
    expect(result.stderr).toContain('this client expects the SQLite client')
    // The password must not be printed.
    expect(result.stderr).not.toContain('pw@')
  })

  it('exits when the Postgres client is booted with a SQLite URL', () => {
    const result = boot(generateDbModule(), 'file:./prisma/dev.db', 'postgres')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('this client expects a Postgres URL')
  })

  it('boots normally when the URL matches the client', () => {
    expect(boot(generateSqliteDbModule(), 'file:./prisma/dev.db', 'sqlite').status).toBe(0)
    expect(boot(generateDbModule(), 'postgres://user:pw@host/db', 'postgres').status).toBe(0)
  })

  it('boots normally with no DATABASE_URL at all (local dev, CI)', () => {
    expect(boot(generateSqliteDbModule(), undefined, 'sqlite').status).toBe(0)
    expect(boot(generateDbModule(), undefined, 'postgres').status).toBe(0)
  })
})
