// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { generateServer } from '../server-generator'

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
})
