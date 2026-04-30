// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  migrateSkillServerToRoot,
  parsePrismaSchema,
  mergeSchemas,
  injectCustomRoutes,
} from '../skill-server-to-root'

const TMP_BASE = join(import.meta.dir, '..', '..', '..', '.test-tmp-skill-migration')

let tmpDir: string
let nextId = 0

function freshDir(): string {
  const dir = join(TMP_BASE, `w-${nextId++}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  tmpDir = freshDir()
})

afterEach(() => {
  if (existsSync(TMP_BASE)) {
    rmSync(TMP_BASE, { recursive: true, force: true })
  }
})

const ROOT_TEMPLATE_SCHEMA = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("users")
}
`

const ROOT_SERVER_TSX = `import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { createAllRoutes } from './src/generated/routes'
import { prisma } from './src/lib/db'

const app = new Hono()

app.use('*', cors())
app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', createAllRoutes(prisma))

const port = Number(process.env.PORT) || 3001
console.log(\`Server running on http://localhost:\${port}\`)

export default { port, fetch: app.fetch }
`

// ---------------------------------------------------------------------------
// parsePrismaSchema
// ---------------------------------------------------------------------------

describe('parsePrismaSchema', () => {
  test('extracts models and preserves preamble', () => {
    const schema = `datasource db {\n  provider = "sqlite"\n}\n\nmodel Foo {\n  id Int @id\n}\n\nmodel Bar {\n  id Int @id\n}\n`
    const parsed = parsePrismaSchema(schema)
    expect(parsed.blocks.has('Foo')).toBe(true)
    expect(parsed.blocks.has('Bar')).toBe(true)
    expect(parsed.order).toEqual(['Foo', 'Bar'])
    expect(parsed.preamble).toContain('datasource db')
  })

  test('extracts enums alongside models', () => {
    const schema = `enum Status { ACTIVE INACTIVE }\n\nmodel Foo { id Int @id status Status }\n`
    const parsed = parsePrismaSchema(schema)
    expect(parsed.blocks.get('Status')?.kind).toBe('enum')
    expect(parsed.blocks.get('Foo')?.kind).toBe('model')
  })

  test('throws on unterminated block', () => {
    expect(() => parsePrismaSchema('model Foo {\n  id Int @id\n')).toThrow(/Unterminated/)
  })

  test('throws on duplicate block name', () => {
    expect(() => parsePrismaSchema('model Foo { id Int @id }\nmodel Foo { id Int @id }')).toThrow(/Duplicate/)
  })
})

// ---------------------------------------------------------------------------
// mergeSchemas
// ---------------------------------------------------------------------------

describe('mergeSchemas', () => {
  test('appends new models from skill schema', () => {
    const root = ROOT_TEMPLATE_SCHEMA
    const skill = `datasource db { provider = "sqlite" }\nmodel Lead {\n  id String @id @default(cuid())\n  email String\n}\n`
    const { merged, appended, renamed } = mergeSchemas(root, skill)
    expect(appended).toEqual(['Lead'])
    expect(renamed).toEqual([])
    expect(merged).toContain('model User')
    expect(merged).toContain('model Lead')
  })

  test('renames root block on collision and prefers skill definition', () => {
    const skill = `model User {\n  id String @id\n  email String\n  fullName String\n  bio String?\n}\n`
    const { merged, appended, renamed } = mergeSchemas(ROOT_TEMPLATE_SCHEMA, skill)
    expect(appended).toEqual(['User'])
    expect(renamed.length).toBe(1)
    expect(renamed[0].from).toBe('User')
    expect(renamed[0].to).toBe('_TemplateUser')
    expect(merged).toContain('model _TemplateUser')
    expect(merged).toMatch(/model User\s*\{[^}]*fullName/)
  })

  test('skips identical block on collision (no rename)', () => {
    const both = `model User {\n  id String @id\n  email String\n}\n`
    const { merged, appended, renamed } = mergeSchemas(`datasource db { provider = "sqlite" }\n${both}`, both)
    expect(appended).toEqual([])
    expect(renamed).toEqual([])
    expect((merged.match(/model User/g) || []).length).toBe(1)
  })

  test('handles empty skill schema gracefully', () => {
    const skill = `datasource db { provider = "sqlite" }\n`
    const { appended, renamed } = mergeSchemas(ROOT_TEMPLATE_SCHEMA, skill)
    expect(appended).toEqual([])
    expect(renamed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// injectCustomRoutes
// ---------------------------------------------------------------------------

describe('injectCustomRoutes', () => {
  const now = new Date('2026-04-28T00:00:00Z')

  test('skips empty scaffold', () => {
    const scaffold = `import { Hono } from 'hono'\nconst app = new Hono()\n// Add custom API routes here.\nexport default app\n`
    const { result, needsReview } = injectCustomRoutes(ROOT_SERVER_TSX, scaffold, now)
    expect(result).toBe(ROOT_SERVER_TSX)
    expect(needsReview).toBe(false)
  })

  test('injects safe imports inline', () => {
    const custom = `import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/hello', (c) => c.json({ msg: 'hi' }))\nexport default app\n`
    const { result, needsReview } = injectCustomRoutes(ROOT_SERVER_TSX, custom, now)
    expect(needsReview).toBe(false)
    expect(result).toContain('MIGRATED-CUSTOM-ROUTES')
    expect(result).toContain('const customRoutesApp = new Hono()')
    expect(result).toContain("customRoutesApp.get('/hello'")
    expect(result).toContain("app.route('/api', customRoutesApp)")
  })

  test('comments out routes that import from ./db', () => {
    const custom = `import { Hono } from 'hono'\nimport { prisma } from './db'\nconst app = new Hono()\napp.get('/things', async (c) => c.json(await prisma.thing.findMany()))\nexport default app\n`
    const { result, needsReview } = injectCustomRoutes(ROOT_SERVER_TSX, custom, now)
    expect(needsReview).toBe(true)
    expect(result).toContain('MIGRATED-CUSTOM-ROUTES')
    expect(result).toContain('TODO(skill-server-migration)')
    expect(result).toMatch(/\/\*[\s\S]*from '\.\/db'[\s\S]*\*\//)
  })

  test('idempotent on already-migrated server.tsx', () => {
    const custom = `import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/x', (c) => c.text('x'))\nexport default app\n`
    const { result: once } = injectCustomRoutes(ROOT_SERVER_TSX, custom, now)
    const { result: twice } = injectCustomRoutes(once, custom, now)
    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// migrateSkillServerToRoot — end-to-end
// ---------------------------------------------------------------------------

describe('migrateSkillServerToRoot', () => {
  test('no-ops when .shogo/server/ is absent', () => {
    const result = migrateSkillServerToRoot(tmpDir)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeUndefined()
  })

  test('migrates schema, custom routes, and DB', () => {
    const skillDir = join(tmpDir, '.shogo', 'server')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(join(tmpDir, 'prisma'), { recursive: true })

    writeFileSync(join(tmpDir, 'prisma', 'schema.prisma'), ROOT_TEMPLATE_SCHEMA, 'utf-8')
    writeFileSync(join(tmpDir, 'server.tsx'), ROOT_SERVER_TSX, 'utf-8')

    const skillSchema = `datasource db { provider = "sqlite" }\n\nmodel Lead {\n  id String @id @default(cuid())\n  email String\n}\n`
    writeFileSync(join(skillDir, 'schema.prisma'), skillSchema, 'utf-8')
    writeFileSync(
      join(skillDir, 'custom-routes.ts'),
      `import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/ping', (c) => c.text('pong'))\nexport default app\n`,
      'utf-8',
    )
    writeFileSync(join(skillDir, 'skill.db'), 'binary-db-bytes', 'utf-8')

    const result = migrateSkillServerToRoot(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.mergedModels).toEqual(['Lead'])
    expect(result.customRoutesMigrated).toBe(true)
    expect(result.customRoutesNeedReview).toBe(false)
    expect(result.databaseCopied).toBe(true)

    expect(existsSync(skillDir)).toBe(false)
    expect(existsSync(result.snapshotPath!)).toBe(true)
    expect(existsSync(result.notesPath!)).toBe(true)

    const merged = readFileSync(join(tmpDir, 'prisma', 'schema.prisma'), 'utf-8')
    expect(merged).toContain('model User')
    expect(merged).toContain('model Lead')

    const server = readFileSync(join(tmpDir, 'server.tsx'), 'utf-8')
    expect(server).toContain('MIGRATED-CUSTOM-ROUTES')
    expect(server).toContain("customRoutesApp.get('/ping'")

    expect(existsSync(join(tmpDir, 'prisma', 'dev.db'))).toBe(true)
  })

  test('keeps existing root prisma/dev.db on collision', () => {
    const skillDir = join(tmpDir, '.shogo', 'server')
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(join(tmpDir, 'prisma'), { recursive: true })

    writeFileSync(join(tmpDir, 'prisma', 'schema.prisma'), ROOT_TEMPLATE_SCHEMA, 'utf-8')
    writeFileSync(join(tmpDir, 'prisma', 'dev.db'), 'root-db-content', 'utf-8')
    writeFileSync(join(skillDir, 'schema.prisma'), `datasource db { provider = "sqlite" }\n`, 'utf-8')
    writeFileSync(join(skillDir, 'skill.db'), 'skill-db-content', 'utf-8')

    const result = migrateSkillServerToRoot(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.databaseCopied).toBe(false)
    expect(readFileSync(join(tmpDir, 'prisma', 'dev.db'), 'utf-8')).toBe('root-db-content')
  })

  test('restores workspace on malformed schema', () => {
    const skillDir = join(tmpDir, '.shogo', 'server')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'schema.prisma'), `model Broken {\n  id Int @id\n  // missing closing brace`, 'utf-8')

    const result = migrateSkillServerToRoot(tmpDir)

    expect(result.migrated).toBe(false)
    expect(result.error).toMatch(/Unterminated/)
    expect(existsSync(skillDir)).toBe(true)
    expect(existsSync(join(skillDir, 'schema.prisma'))).toBe(true)
  })

  test('handles missing root prisma/schema.prisma by creating one', () => {
    const skillDir = join(tmpDir, '.shogo', 'server')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'schema.prisma'),
      `datasource db { provider = "sqlite" }\n\nmodel Note {\n  id String @id\n  body String\n}\n`,
      'utf-8',
    )

    const result = migrateSkillServerToRoot(tmpDir)

    expect(result.migrated).toBe(true)
    expect(existsSync(join(tmpDir, 'prisma', 'schema.prisma'))).toBe(true)
    const merged = readFileSync(join(tmpDir, 'prisma', 'schema.prisma'), 'utf-8')
    expect(merged).toContain('model Note')
  })

  test('handles dev.db naming variant', () => {
    const skillDir = join(tmpDir, '.shogo', 'server')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'schema.prisma'), `datasource db { provider = "sqlite" }\n`, 'utf-8')
    writeFileSync(join(skillDir, 'dev.db'), 'db-content', 'utf-8')

    const result = migrateSkillServerToRoot(tmpDir)

    expect(result.migrated).toBe(true)
    expect(result.databaseCopied).toBe(true)
    expect(existsSync(join(tmpDir, 'prisma', 'dev.db'))).toBe(true)
  })
})
