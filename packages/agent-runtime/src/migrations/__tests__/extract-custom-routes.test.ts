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

  // A previous `generateServer()` output that predates the
  // `customRoutesPath` config addition. Has the SDK auto-gen header
  // but lacks `import customRoutes`. Safe to delete because the file
  // was machine-written — the next `shogo generate` will re-emit a
  // correctly-wired one.
  test('removes a stale SDK-generated server.tsx that lacks the customRoutes import', () => {
    const staleSdkServer = `/**
 * Hono Server
 *
 * Auto-generated by @shogo-ai/sdk
 * This file can be customized - it will not be overwritten if it exists.
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated'
import { prisma } from './src/lib/db'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
Bun.serve({ port, fetch: app.fetch })
`
    writeFileSync(join(tmpDir, 'server.tsx'), staleSdkServer, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(false)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(false)
    expect(result.snapshotPath).toBeDefined()
    expect(existsSync(join(result.snapshotPath!, 'server.tsx'))).toBe(true)
    // The original file is preserved verbatim in the snapshot.
    const snapshot = readFileSync(join(result.snapshotPath!, 'server.tsx'), 'utf-8')
    expect(snapshot).toBe(staleSdkServer)
  })

  // Regression test for the comment-nesting bug. The earlier merge
  // branch appended a `/* ... */` wrapper around `customRoutesBody`,
  // which (for the hand-edited path) contained a JSDoc `*/` that
  // prematurely closed the outer wrapper and dumped a second
  // `const app = new Hono()` + `export default app` as live code.
  // Fixed by leaving the existing file alone.
  test('existing custom-routes.ts is preserved byte-for-byte when server.tsx is hand-edited', () => {
    const existingCustomRoutes = [
      "// SPDX-License-Identifier: Apache-2.0",
      "import { Hono } from 'hono'",
      "",
      "const app = new Hono()",
      "",
      "app.get('/runway/balance', (c) => c.json({ balance: 42 }))",
      "",
      "export default app",
      "",
    ].join('\n')

    writeFileSync(join(tmpDir, 'server.tsx'), HAND_EDITED_SERVER_TSX, 'utf-8')
    writeFileSync(join(tmpDir, 'custom-routes.ts'), existingCustomRoutes, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(false)
    expect(result.needsReview).toBe(true)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(false)

    // The user file is preserved BYTE-FOR-BYTE — no appended trailer,
    // no duplicate `const app = new Hono()`, no commented-out
    // placeholder dump.
    const after = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(after).toBe(existingCustomRoutes)

    // The snapshot still captures what we found for manual review.
    expect(result.snapshotPath).toBeDefined()
    const snapshot = readFileSync(join(result.snapshotPath!, 'server.tsx'), 'utf-8')
    expect(snapshot).toBe(HAND_EDITED_SERVER_TSX)
  })

  // The marker case used to splice the extracted block into the
  // existing custom-routes.ts via the same broken `/* ... */` wrap.
  // It now writes the extracted body to a sibling file under the
  // snapshot dir so the user can copy it in without breaking
  // anything.
  test('marker case writes extracted block to a sibling file, not into existing custom-routes.ts', () => {
    const existingCustomRoutes = [
      "import { Hono } from 'hono'",
      "",
      "const app = new Hono()",
      "",
      "app.get('/keepme', (c) => c.text('preserved'))",
      "",
      "export default app",
      "",
    ].join('\n')

    writeFileSync(join(tmpDir, 'server.tsx'), MIGRATED_SERVER_TSX, 'utf-8')
    writeFileSync(join(tmpDir, 'custom-routes.ts'), existingCustomRoutes, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(true)
    expect(result.needsReview).toBe(true)

    // Existing file is unchanged.
    const after = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(after).toBe(existingCustomRoutes)

    // The extracted block lands at <snapshotDir>/extracted-routes.ts.
    expect(result.snapshotPath).toBeDefined()
    const extractedPath = join(result.snapshotPath!, 'extracted-routes.ts')
    expect(existsSync(extractedPath)).toBe(true)
    const extracted = readFileSync(extractedPath, 'utf-8')
    expect(extracted).toContain("import { Hono } from 'hono'")
    expect(extracted).toContain("app.get('/hello'")
    expect(extracted).toContain("app.post('/llm'")
    expect(extracted).toContain('export default app')
  })

  // Workspaces corrupted by the previous buggy merge branch (e.g.
  // 8bfafbf0-...) end with a `/* Extracted from server.tsx on ... */`
  // trailer whose inner JSDoc `*/` closes the wrapper early. The
  // heal helper truncates that trailer back off so the file compiles
  // again. Real route code above the trailer is preserved verbatim.
  test('repair helper strips the broken trailer from a corrupted custom-routes.ts idempotently', () => {
    const realRoutes = [
      "// SPDX-License-Identifier: Apache-2.0",
      "import { Hono } from 'hono'",
      "",
      "const app = new Hono()",
      "",
      "app.get('/runway/balance', (c) => c.json({ balance: 42 }))",
      "",
      "export default app",
      "",
    ].join('\n')

    // The exact trailer shape the buggy merge branch wrote. The
    // inner JSDoc `*/` is what broke parsing; the heal helper just
    // strips the whole trailer.
    const brokenTrailer = [
      "",
      "/* Extracted from server.tsx on 2026-05-11",
      "   Review and merge by hand. The original server.tsx is at:",
      "   /tmp/.shogo/server-tsx-extracted-2026-05-11T08-33-19-293Z/server.tsx",
      "// SPDX-License-Identifier: Apache-2.0",
      "/**",
      " * Custom API Routes (extracted from a hand-edited server.tsx —",
      " * needs manual review).",
      " */",
      "",
      "import { Hono } from 'hono'",
      "",
      "const app = new Hono()",
      "",
      "// TODO(extract-custom-routes): port routes from snapshot server.tsx",
      "",
      "export default app",
      "",
      "*/",
      "",
    ].join('\n')

    writeFileSync(join(tmpDir, 'custom-routes.ts'), realRoutes + brokenTrailer, 'utf-8')

    // Run the migration. No server.tsx → the migration would
    // otherwise return early, but the heal helper at the top should
    // still fire before that check.
    const first = extractCustomRoutes(tmpDir)
    expect(first.migrated).toBe(false)

    const afterFirst = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    // Trailer is gone.
    expect(afterFirst).not.toContain('Extracted from server.tsx on')
    expect(afterFirst).not.toContain('TODO(extract-custom-routes)')
    // Real routes above the trailer survive verbatim.
    expect(afterFirst).toContain("app.get('/runway/balance'")
    expect(afterFirst).toContain('export default app')
    // Exactly one `const app = new Hono()` (the bug duplicated it).
    const appDecls = afterFirst.match(/const app = new Hono\(\)/g) ?? []
    expect(appDecls.length).toBe(1)

    // Second run is a no-op: no trailer, no change.
    const second = extractCustomRoutes(tmpDir)
    expect(second.migrated).toBe(false)
    const afterSecond = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(afterSecond).toBe(afterFirst)
  })

  // Regression test for "still happens on restart": a healthy
  // workspace (correctly-wired SDK server.tsx + populated
  // custom-routes.ts) was triggering the hand-edited extraction
  // path on every boot — because `isStockServerTsx` returns false
  // for any SDK output that also mounts the tools proxy at
  // `/api/tools/execute` + `/api/tools/schemas`, and
  // `isStaleGeneratedServerTsx` returns false once the file has
  // `import customRoutes`. Neither short-circuit fired, so the
  // migration snapshotted + deleted server.tsx on every boot and
  // `bun run generate` re-emitted an identical copy. The new
  // `isCorrectlyWiredSdkServerTsx` check fixes this.
  test('no-ops on a correctly-wired SDK server.tsx (the steady state)', () => {
    const correctlyWiredSdkServer = `// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hono Server
 *
 * Auto-generated by @shogo-ai/sdk
 * This file can be customized - it will not be overwritten if it exists.
 */

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import customRoutes from './custom-routes'
import { createToolsHandlers } from '@shogo-ai/sdk/tools/server'

const app = new Hono()

app.use('*', async (c, next) => {
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  await next()
})

app.get('/health', (c) => c.json({ ok: true }))

try {
  const { createAllRoutes } = await import('./src/generated')
  const { prisma } = await import('./src/lib/db')
  app.route('/api', createAllRoutes(prisma))
} catch {}

app.route('/api', customRoutes)

const tools = createToolsHandlers({})
app.post('/api/tools/execute', (c) => tools.execute(c.req.raw))
app.get('/api/tools/schemas', (c) => tools.list(c.req.raw))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

Bun.serve({ port: 3001, fetch: app.fetch })
`
    const existingCustomRoutes = [
      "import { Hono } from 'hono'",
      "",
      "const app = new Hono()",
      "",
      "app.get('/runway/balance', (c) => c.json({ balance: 42 }))",
      "",
      "export default app",
      "",
    ].join('\n')

    writeFileSync(join(tmpDir, 'server.tsx'), correctlyWiredSdkServer, 'utf-8')
    writeFileSync(join(tmpDir, 'custom-routes.ts'), existingCustomRoutes, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const first = extractCustomRoutes(tmpDir)
    expect(first.migrated).toBe(false)

    // server.tsx is preserved verbatim — not snapshotted, not deleted.
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(true)
    expect(readFileSync(join(tmpDir, 'server.tsx'), 'utf-8')).toBe(correctlyWiredSdkServer)

    // custom-routes.ts is preserved verbatim.
    expect(readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')).toBe(existingCustomRoutes)

    // No snapshot dir was created.
    expect(existsSync(join(tmpDir, '.shogo'))).toBe(false)

    // Idempotent across repeated runs — second invocation is also a no-op.
    const second = extractCustomRoutes(tmpDir)
    expect(second.migrated).toBe(false)
    expect(existsSync(join(tmpDir, 'server.tsx'))).toBe(true)
    expect(existsSync(join(tmpDir, '.shogo'))).toBe(false)
  })

  // The same SDK template with `// MIGRATED-CUSTOM-ROUTES` injected
  // (e.g. by `migrateSkillServerToRoot`) must NOT be treated as
  // correctly-wired — the marker block still needs to be extracted.
  test('correctly-wired SDK output with MIGRATED-CUSTOM-ROUTES marker still extracts', () => {
    const markedSdkServer = `/**
 * Auto-generated by @shogo-ai/sdk
 */
import { Hono } from 'hono'
import customRoutes from './custom-routes'

const app = new Hono()
app.route('/api', customRoutes)

// MIGRATED-CUSTOM-ROUTES — from .shogo/server/custom-routes.ts on 2026-04-29
import { Hono as Hono2 } from 'hono'
const customRoutesApp = new Hono2()
customRoutesApp.get('/legacy', (c) => c.text('ok'))
app.route('/api', customRoutesApp)
`
    writeFileSync(join(tmpDir, 'server.tsx'), markedSdkServer, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)
    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(true)
  })

  // A hand-edited `server.tsx` (no SDK auto-gen header) that's also
  // drifted (missing customRoutes mount) is intentionally NOT
  // recognised as stale-generated. Instead it falls through to the
  // hand-edited extraction path so the user's edits are surfaced for
  // manual review. The boot-time heal helper (server-tsx-drift.ts)
  // will patch this file in place at next start without losing edits.
  test('a hand-edited drifted server.tsx is NOT recognised as stale-generated', () => {
    // Hand-edited file: no SDK header, has a custom dashboard route
    // that wouldn't appear in any generateServer() output.
    const handEditedDrifted = `import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.get('/dashboard', async (c) => {
  const stats = await prisma.user.count()
  return c.json({ stats })
})
app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const port = Number(process.env.PORT) || 3001
export default { port, fetch: app.fetch }
`
    writeFileSync(join(tmpDir, 'server.tsx'), handEditedDrifted, 'utf-8')
    writeFileSync(join(tmpDir, 'shogo.config.json'), '{"schema":"./prisma/schema.prisma","outputs":[]}', 'utf-8')

    const result = extractCustomRoutes(tmpDir)

    // Migration treats this as the regular hand-edited path: it
    // SNAPSHOTS the file and creates a custom-routes.ts for manual
    // review. The point of THIS test is that the boot-time heal
    // helper will still get a chance to patch the file in place,
    // because we don't claim the file as "stale generated" — we don't
    // shortcut into the stockOnly branch.
    expect(result.migrated).toBe(true)
    // The needs-review flag is the marker the migration uses to say
    // "this is the hand-edited extraction path, not the stale-gen
    // shortcut."
    expect(result.needsReview).toBe(true)
    expect(result.hadMarker).toBe(false)
  })
})

// NOTE: the following tests are appended by v3 coverage campaign to close
// the remaining gaps (lines 251-272, 453-455, 544-547).

describe('extractCustomRoutes — v3 gap-close', () => {
  let tmpDir2: string

  beforeEach(() => {
    tmpDir2 = makeWorkspace()
  })

  afterEach(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  // Lines 251-272: isCommented branch in extractMigratedBlock.
  test('extracts a commented-out MIGRATED-CUSTOM-ROUTES block and marks needsReview', () => {
    const commentedMarkerServer = `import { Hono } from 'hono'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()
app.route('/api', createAllRoutes(prisma))

// MIGRATED-CUSTOM-ROUTES — from .shogo/server/custom-routes.ts on 2026-04-29
/* Original custom-routes.ts content (imports were unsafe — needs manual porting)
import { someService } from '../db'

const routes = new Hono()
routes.get('/status', (c) => c.json({ ok: true }))
export default routes
*/
`
    writeFileSync(join(tmpDir2, 'server.tsx'), commentedMarkerServer, 'utf-8')
    writeFileSync(join(tmpDir2, 'shogo.config.json'), '{}', 'utf-8')

    const result = extractCustomRoutes(tmpDir2)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(true)
    expect(result.needsReview).toBe(true)
    expect(existsSync(join(tmpDir2, 'server.tsx'))).toBe(false)

    const customRoutes = readFileSync(join(tmpDir2, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain("import { Hono } from 'hono'")
    expect(customRoutes).toContain('export default app')
    expect(customRoutes).toContain('MIGRATED-CUSTOM-ROUTES')
  })

  // Lines 453-455: stock server.tsx + shogo.config.json + NO custom-routes.ts.
  // stockMatch = false (customRoutesExists=false), falls through to
  // isStockServerTsx branch and writes DEFAULT_CUSTOM_ROUTES_SCAFFOLD.
  test('writes default custom-routes scaffold when stock server.tsx has no custom-routes.ts yet', () => {
    const stockServer = `import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', createAllRoutes(prisma))

app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

export default { fetch: app.fetch }
`
    writeFileSync(join(tmpDir2, 'server.tsx'), stockServer, 'utf-8')
    writeFileSync(join(tmpDir2, 'shogo.config.json'), '{}', 'utf-8')

    const result = extractCustomRoutes(tmpDir2)

    expect(result.migrated).toBe(true)
    expect(result.hadMarker).toBe(false)
    expect(existsSync(join(tmpDir2, 'server.tsx'))).toBe(false)
    const customRoutes = readFileSync(join(tmpDir2, 'custom-routes.ts'), 'utf-8')
    expect(customRoutes).toContain('export default app')
    expect(customRoutes).toContain('Custom API Routes')
  })

  // Lines 544-547: the catch block — triggered by blocking mkdirSync
  // (place a file at .shogo so mkdirSync(.shogo/...) fails ENOTDIR).
  test('returns error result and leaves workspace unchanged when an FS operation fails', () => {
    const migratedServer = `import { Hono } from 'hono'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()
app.route('/api', createAllRoutes(prisma))

// MIGRATED-CUSTOM-ROUTES — from .shogo/server/custom-routes.ts on 2026-04-29
const customRoutesApp = new Hono()
customRoutesApp.get('/hello', (c) => c.text('hi'))
app.route('/api', customRoutesApp)
`
    writeFileSync(join(tmpDir2, 'server.tsx'), migratedServer, 'utf-8')
    writeFileSync(join(tmpDir2, 'shogo.config.json'), '{}', 'utf-8')
    // Block mkdirSync: put a file at .shogo so mkdirSync(.shogo/server-tsx-*) fails.
    writeFileSync(join(tmpDir2, '.shogo'), 'blocker', 'utf-8')

    const result = extractCustomRoutes(tmpDir2)

    expect(result.migrated).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
    expect(existsSync(join(tmpDir2, 'server.tsx'))).toBe(true)
  })
})
