// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
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
