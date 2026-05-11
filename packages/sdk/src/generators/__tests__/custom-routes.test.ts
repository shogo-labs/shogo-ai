// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { ensureCustomRoutes, CUSTOM_ROUTES_SCAFFOLD } from '../custom-routes'

const TMP_ROOT = join(__dirname, '..', '..', '..', '.test-tmp-custom-routes')
let tmpDir: string
let counter = 0

function makeProjectDir(): string {
  counter++
  const dir = join(TMP_ROOT, `p-${counter}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  tmpDir = makeProjectDir()
})

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('ensureCustomRoutes', () => {
  it('seeds custom-routes.ts when neither .ts nor .tsx is present', () => {
    const result = ensureCustomRoutes(tmpDir)

    expect(result.created).toBe(true)
    expect(result.path).toBe('./custom-routes')
    expect(result.absolutePath).toBe(join(tmpDir, 'custom-routes.ts'))
    expect(existsSync(join(tmpDir, 'custom-routes.ts'))).toBe(true)

    const content = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')
    expect(content).toBe(CUSTOM_ROUTES_SCAFFOLD)
  })

  it('emits a valid Hono module with the canonical exports', () => {
    ensureCustomRoutes(tmpDir)
    const content = readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')

    // Must be a working Hono app the SDK can import.
    expect(content).toContain("import { Hono } from 'hono'")
    expect(content).toContain('const app = new Hono()')
    expect(content).toContain('export default app')
  })

  it('no-ops (created=false) when custom-routes.ts already exists', () => {
    const userContent = `import { Hono } from 'hono'
const app = new Hono()
app.get('/hello', (c) => c.json({ msg: 'world' }))
export default app
`
    writeFileSync(join(tmpDir, 'custom-routes.ts'), userContent, 'utf-8')

    const result = ensureCustomRoutes(tmpDir)

    expect(result.created).toBe(false)
    expect(result.path).toBe('./custom-routes')
    expect(result.absolutePath).toBe(join(tmpDir, 'custom-routes.ts'))
    // User's content is preserved byte-for-byte.
    expect(readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')).toBe(userContent)
  })

  it('no-ops when custom-routes.tsx already exists (prefers existing .tsx)', () => {
    const userContent = `import { Hono } from 'hono'
const app = new Hono<{ Variables: { user: { id: string } } }>()
export default app
`
    writeFileSync(join(tmpDir, 'custom-routes.tsx'), userContent, 'utf-8')

    const result = ensureCustomRoutes(tmpDir)

    expect(result.created).toBe(false)
    expect(result.path).toBe('./custom-routes')
    expect(result.absolutePath).toBe(join(tmpDir, 'custom-routes.tsx'))
    // Did NOT create a sibling custom-routes.ts.
    expect(existsSync(join(tmpDir, 'custom-routes.ts'))).toBe(false)
    expect(readFileSync(join(tmpDir, 'custom-routes.tsx'), 'utf-8')).toBe(userContent)
  })

  it('is idempotent across multiple calls', () => {
    const r1 = ensureCustomRoutes(tmpDir)
    expect(r1.created).toBe(true)

    const r2 = ensureCustomRoutes(tmpDir)
    expect(r2.created).toBe(false)
    expect(r2.path).toBe('./custom-routes')

    const r3 = ensureCustomRoutes(tmpDir)
    expect(r3.created).toBe(false)

    // Content is the original scaffold the first call wrote — subsequent
    // calls never re-write it.
    expect(readFileSync(join(tmpDir, 'custom-routes.ts'), 'utf-8')).toBe(CUSTOM_ROUTES_SCAFFOLD)
  })

  it('returns a relative path ready to plug into ServerGeneratorConfig.customRoutesPath', () => {
    // The return path is intentionally relative — `generateServer()`
    // emits `import customRoutes from '<path>'` literally, so the
    // value must work as a TypeScript module specifier.
    const result = ensureCustomRoutes(tmpDir)
    expect(result.path).toBe('./custom-routes')
    expect(result.path.startsWith('./')).toBe(true)
    // No extension — TS would 404 on `from './custom-routes.ts'`.
    expect(result.path.endsWith('.ts')).toBe(false)
    expect(result.path.endsWith('.tsx')).toBe(false)
  })
})
