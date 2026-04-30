// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { extractCustomRoutes } from '../extract-custom-routes'

const TMP_ROOT = join(__dirname, '..', '..', '..', '.test-tmp-extract-custom-routes')
let tmpDir: string
let counter = 0

function makeWorkspace(): string {
  counter++
  const dir = join(TMP_ROOT, `w-${counter}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  tmpDir = makeWorkspace()
})

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

const STOCK_SERVER_TSX = `import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(\`Server running on http://localhost:\${port}\`)

export default { port, fetch: app.fetch }
`

const MIGRATED_SERVER_TSX = `import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
console.log(\`Server running on http://localhost:\${port}\`)

export default { port, fetch: app.fetch }

// MIGRATED-CUSTOM-ROUTES — from .shogo/server/custom-routes.ts on 2026-04-29
// Review and integrate; left intact for behavioural parity.

// Original custom routes (mounted under /api/). The original used
// \`import { Hono } from 'hono'\` and exported a Hono instance named
// \`app\`. We rename it \`customRoutesApp\` to avoid clobbering the root
// app instance, then mount it at /api/.

import { Hono } from 'hono'

const customRoutesApp = new Hono()

customRoutesApp.get('/hello', (c) => c.json({ message: 'Hello world' }))
customRoutesApp.post('/llm', async (c) => {
  const body = await c.req.json()
  return c.json({ echo: body })
})

// export default app — replaced with mount below

app.route('/api', customRoutesApp)
`

const HAND_EDITED_SERVER_TSX = `import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'
import { myCustomMiddleware } from './src/middleware'

const app = new Hono()

app.use('*', myCustomMiddleware())

app.get('/health', (c) => c.json({ ok: true }))
app.get('/dashboard', async (c) => {
  const stats = await prisma.user.count()
  return c.json({ stats })
})
app.route('/api', createAllRoutes(prisma))

const port = Number(process.env.PORT) || 3001
export default { port, fetch: app.fetch }
`

describe('extractCustomRoutes', () => {
  test('no-ops on a workspace without server.tsx', () => {
    const result = extractCustomRoutes(tmpDir)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeUndefined()
  })

  test('no-ops when shogo.config.json is absent (pre-new-template workspace)', () => {
    writeFileSync(join(tmpDir, 'server.tsx'), STOCK_SERVER_TSX, 'utf-8')

    const result = extractCustomRoutes(tmpDir)
    expect(result.migrated).toBe(false)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(true)
  })

  test('extracts // MIGRATED-CUSTOM-ROUTES block into custom-routes.ts and deletes server.tsx', () => {
    writeFileSync(join(tmpDir, 'server.tsx'), MIGRATED_SERVER_TSX, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(true)
    expect(result.needsReview).toBe(false)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(false)
    expect(result.snapshotPath).toBeDefined()
    expect(existsSync(result.snapshotPath!)).toBe(true)
    expect(existsSync(join(result.snapshotPath!, 'server.tsx'))).toBe(true)
    expect(existsSync(result.notesPath!)).toBe(true)

    const customRoutes = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain("import { Hono } from 'hono'")
    expect(customRoutes).toContain('const app = new Hono()')
    expect(customRoutes).toContain("app.get('/hello'")
    expect(customRoutes).toContain("app.post('/llm'")
    expect(customRoutes).toContain('export default app')
    // The mount line should be stripped from the extracted body.
    expect(customRoutes).not.toContain('customRoutesApp')
    expect(customRoutes).not.toMatch(/app\.route\(\s*['"]\/api['"]/)
  })

  test('removes a stock server.tsx when a populated custom-routes.ts already exists', () => {
    writeFileSync(join(tmpDir, 'server.tsx'), STOCK_SERVER_TSX, 'utf-8')
    writeFileSync(
      join(tmpDir, 'custom-routes.ts'),
      "import { Hono } from 'hono'\nconst app = new Hono()\nexport default app\n",
      'utf-8',
    )
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(false)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(false)
    // We did NOT clobber the existing custom-routes.ts when server.tsx
    // was just stock template.
    const customRoutes = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain('export default app')
  })

  test('preserves a hand-edited server.tsx for manual review', () => {
    writeFileSync(join(tmpDir, 'server.tsx'), HAND_EDITED_SERVER_TSX, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(false)
    expect(result.needsReview).toBe(true)
    expect(existsSync(join(tmpDir, 'custom-routes.ts'))).toBe(true)
    // Snapshot keeps the original verbatim.
    const snapshot = readFileSync(join(result.snapshotPath!, 'server.tsx'), 'utf-8')
    expect(snapshot).toBe(HAND_EDITED_SERVER_TSX)
    // Custom-routes.ts has a TODO marker the agent can grep for.
    const customRoutes = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain('TODO(extract-custom-routes)')
  })

  test('idempotent — second run on a clean workspace is a no-op', () => {
    writeFileSync(join(tmpDir, 'server.tsx'), MIGRATED_SERVER_TSX, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const first = extractCustomRoutes(tmpDir)
    expect(first.migrated).toBe(true)

    const second = extractCustomRoutes(tmpDir)
    expect(second.migrated).toBe(false)
    expect(existsSync(join(tmpDir, 'custom-routes.ts'))).toBe(true)
  })
})
