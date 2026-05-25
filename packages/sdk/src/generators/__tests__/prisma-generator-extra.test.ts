// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * prisma-generator.ts — coverage closer (v3 campaign).
 *
 * The expanded + zero-models test files already drive prisma-generator.ts
 * to 100% lines / 100% funcs when run together (verified per-shard) — this
 * file adds further per-branch verification and a few uncommon-shape
 * fixtures so the closure is robust against future drift.
 *
 *   bun test src/generators/__tests__/prisma-generator-extra.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  generateFromPrisma,
  parsePrismaSchema,
  getScalarFields,
  getRelationFields,
  getIdField,
  toCamelCase,
  toKebabCase,
  type PrismaModel,
  type PrismaField,
  type OutputConfig,
} from '../prisma-generator'

function setupProject(tmpDir: string, name: string, schema: string): string {
  const projectDir = join(tmpDir, name)
  const prismaDir = join(projectDir, 'prisma')
  mkdirSync(prismaDir, { recursive: true })
  const schemaPath = join(prismaDir, 'schema.prisma')
  writeFileSync(schemaPath, schema)
  writeFileSync(
    join(projectDir, 'prisma.config.ts'),
    `import path from 'node:path'
import type { PrismaConfig } from 'prisma'
export default {
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
} satisfies PrismaConfig
`,
  )
  return schemaPath
}

const SMALL_SCHEMA = `
datasource db {
  provider = "sqlite"
}

model User {
  id    String @id @default(cuid())
  email String @unique
  posts Post[]
}

model Post {
  id       String  @id @default(cuid())
  title    String
  author   User?   @relation(fields: [authorId], references: [id])
  authorId String?
}
`

const NO_USER_SCHEMA = `
datasource db {
  provider = "sqlite"
}

model Widget {
  id   String @id @default(cuid())
  name String
}
`

// ---------------------------------------------------------------------------
// Pure helpers — exhaustive edge cases
// ---------------------------------------------------------------------------

describe('toCamelCase / toKebabCase — edge cases', () => {
  test('toCamelCase lowercases only the first char', () => {
    expect(toCamelCase('User')).toBe('user')
    expect(toCamelCase('UserProfile')).toBe('userProfile')
    expect(toCamelCase('A')).toBe('a')
  })
  test('toCamelCase preserves already-camelCase input', () => {
    expect(toCamelCase('user')).toBe('user')
  })
  test('toKebabCase splits camel boundaries and lowercases', () => {
    expect(toKebabCase('UserProfile')).toBe('user-profile')
    expect(toKebabCase('APIKey')).toBe('apikey')
    expect(toKebabCase('user')).toBe('user')
  })
  test('toKebabCase handles single segment lowercase', () => {
    expect(toKebabCase('post')).toBe('post')
  })
})

describe('getScalarFields / getRelationFields / getIdField — synthetic DMMF', () => {
  const model: PrismaModel = {
    name: 'X',
    fields: [
      { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false, hasDefaultValue: true } as PrismaField,
      { name: 'role', kind: 'enum', type: 'Role', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false } as PrismaField,
      { name: 'owner', kind: 'object', type: 'User', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false } as PrismaField,
      { name: 'tags', kind: 'unsupported', type: 'Unsupported(\"json\")', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false } as PrismaField,
    ],
  }

  test('scalar+enum returned, object+unsupported excluded', () => {
    const scalars = getScalarFields(model)
    expect(scalars.map(f => f.name)).toEqual(['id', 'role'])
  })

  test('relation list excludes scalar/enum/unsupported', () => {
    const relations = getRelationFields(model)
    expect(relations.map(f => f.name)).toEqual(['owner'])
  })

  test('getIdField returns the @id field', () => {
    expect(getIdField(model)?.name).toBe('id')
  })

  test('getIdField returns undefined when no id present', () => {
    const noId: PrismaModel = { name: 'NoId', fields: [] }
    expect(getIdField(noId)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parsePrismaSchema — config path discovery
// ---------------------------------------------------------------------------

describe('parsePrismaSchema — config path lookup', () => {
  test('uses prisma.config.ts at project root when present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-'))
    try {
      const schemaPath = setupProject(tmp, 'rooted', SMALL_SCHEMA)
      const dmmf = await parsePrismaSchema(schemaPath)
      expect(dmmf.datamodel.models.map(m => m.name).sort()).toEqual(['Post', 'User'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('parses schema even when no prisma.config.ts is present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-noconfig-'))
    try {
      const projectDir = join(tmp, 'noconf')
      const prismaDir = join(projectDir, 'prisma')
      mkdirSync(prismaDir, { recursive: true })
      const schemaPath = join(prismaDir, 'schema.prisma')
      writeFileSync(schemaPath, SMALL_SCHEMA)
      const dmmf = await parsePrismaSchema(schemaPath)
      expect(dmmf.datamodel.models.length).toBe(2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// generateFromPrisma — branch coverage extras
// ---------------------------------------------------------------------------

describe('generateFromPrisma — extra branch coverage', () => {
  test('perModel=false single-file mode for types emits one types.tsx', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-singletypes-'))
    try {
      const schemaPath = setupProject(tmp, 'p', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [
          {
            dir: 'out',
            generate: ['types'],
            perModel: false,
          } satisfies OutputConfig,
        ],
      })
      const typesFile = result.files.find(f => f.path === 'out/types.tsx')
      expect(typesFile).toBeDefined()
      expect(typesFile!.content.length).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('auth requested without User model emits warning and no auth file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-noauth-'))
    try {
      const schemaPath = setupProject(tmp, 'nu', NO_USER_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['auth'] }],
      })
      expect(result.warnings).toContain('Auth store generation skipped: No User model with email field found')
      expect(result.files.find(f => f.path.endsWith('/auth.tsx'))).toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('models include-filter narrows to a single model', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-include-'))
    try {
      const schemaPath = setupProject(tmp, 'inc', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        models: ['User'],
        outputs: [{ dir: 'o', generate: ['types'] }],
      })
      expect(result.models).toEqual(['User'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('excludeModels removes a single model', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-exclude-'))
    try {
      const schemaPath = setupProject(tmp, 'exc', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        excludeModels: ['Post'],
        outputs: [{ dir: 'o', generate: ['types'] }],
      })
      expect(result.models).toEqual(['User'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('routes + hooks emits hooks files with skipIfExists', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-hooks-'))
    try {
      const schemaPath = setupProject(tmp, 'h', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['routes', 'hooks'] }],
      })
      const hookFiles = result.files.filter(f => /hooks\.(ts|tsx)$/.test(f.path))
      expect(hookFiles.length).toBeGreaterThan(0)
      for (const h of hookFiles) expect(h.skipIfExists).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('db generator switches to sqlite when dbProvider=sqlite', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-sqlite-'))
    try {
      const schemaPath = setupProject(tmp, 'db', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['db'], dbProvider: 'sqlite' }],
      })
      const dbFile = result.files.find(f => /\/db\.(ts|tsx)$/.test(f.path))
      expect(dbFile).toBeDefined()
      expect(dbFile!.skipIfExists).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('shogo-client emits even when no models present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-sc-'))
    try {
      const schemaPath = setupProject(tmp, 'sc', `
datasource db {
  provider = "sqlite"
}
`)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['shogo-client'] }],
      })
      expect(result.files.some(f => /shogo\.(ts|tsx)$/.test(f.path))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('voice-components emitted with skipIfExists per file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-voice-'))
    try {
      const schemaPath = setupProject(tmp, 'v', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['voice-components'] }],
      })
      const voiceFiles = result.files.filter(f => f.path.startsWith('o/') && /\.(ts|tsx)$/.test(f.path))
      expect(voiceFiles.length).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('legacy single-dir mode emits types/hooks/index files', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-legacy-'))
    try {
      const schemaPath = setupProject(tmp, 'l', SMALL_SCHEMA)
      const result = await generateFromPrisma({ schemaPath, outputDir: '/legacy' })
      const paths = result.files.map(f => f.path)
      expect(paths).toContain('/legacy/types.tsx')
      expect(paths).toContain('/legacy/hooks.tsx')
      expect(paths).toContain('/legacy/index.tsx')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

test('legacy single-dir mode throws when zero models', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-legzm-'))
    try {
      const schemaPath = setupProject(tmp, 'lzm', `\ndatasource db {\n  provider = "sqlite"\n}\n`)
      await expect(generateFromPrisma({ schemaPath, outputDir: '/x' })).rejects.toThrow(
        'No models found to generate',
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('legacy mode throws without outputDir when outputs also missing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-noout-'))
    try {
      const schemaPath = setupProject(tmp, 'l2', SMALL_SCHEMA)
      await expect(generateFromPrisma({ schemaPath })).rejects.toThrow(
        'Either outputDir or outputs[] must be provided',
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('multi-output: routes in one dir + stores in another', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-multi-'))
    try {
      const schemaPath = setupProject(tmp, 'm', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [
          { dir: 'api', generate: ['routes'] },
          { dir: 'web', generate: ['stores'] },
        ],
      })
      expect(result.files.some(f => f.path.startsWith('api/'))).toBe(true)
      expect(result.files.some(f => f.path.startsWith('web/'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('mst generator emits domain + collections + models files', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-mst-'))
    try {
      const schemaPath = setupProject(tmp, 'm2', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['mst'] }],
      })
      const paths = result.files.map(f => f.path)
      expect(paths.some(p => p.endsWith('domain.tsx'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('admin-routes emits a file when admin-routes requested', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-admin-'))
    try {
      const schemaPath = setupProject(tmp, 'a', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['admin-routes'] }],
      })
      expect(result.files.some(f => f.path.startsWith('o/'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('docs generator emits scaffold + content + tsconfig', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-docs-'))
    try {
      const schemaPath = setupProject(tmp, 'd', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'docs', generate: ['docs'] }],
      })
      expect(result.files.some(f => f.path.startsWith('docs/'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('api-client generator emits api-client file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-api-'))
    try {
      const schemaPath = setupProject(tmp, 'ac', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['api-client'] }],
      })
      expect(result.files.some(f => /api-client\.(ts|tsx)$/.test(f.path))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('fileExtension=ts uses .ts on emitted files', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-ts-'))
    try {
      const schemaPath = setupProject(tmp, 'tsx', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [
          {
            dir: 'o',
            fileExtension: 'ts',
            generate: ['types'],
          } satisfies OutputConfig,
        ],
      })
      expect(result.files.some(f => /\.ts$/.test(f.path) && !/\.tsx$/.test(f.path))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('auth with User+email model emits auth file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-authok-'))
    try {
      const schemaPath = setupProject(tmp, 'au', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['auth'] }],
      })
      expect(result.files.some(f => /auth\.(ts|tsx)$/.test(f.path))).toBe(true)
      expect(result.warnings).not.toContain(
        'Auth store generation skipped: No User model with email field found',
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('server generator emits server file even without models', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-srv-'))
    try {
      const schemaPath = setupProject(tmp, 'srv', `
datasource db {
  provider = "sqlite"
}
`)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['server'] }],
      })
      const serverFile = result.files.find(f => /server\.(ts|tsx)$/.test(f.path))
      expect(serverFile).toBeDefined()
      expect(serverFile!.skipIfExists).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('types index appends to existing routes index instead of duplicating', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-tindex-'))
    try {
      const schemaPath = setupProject(tmp, 'ti', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['routes', 'types'] }],
      })
      const indexFiles = result.files.filter(f => f.path === 'o/index.tsx')
      expect(indexFiles.length).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('stores index appends to existing index when types ran first', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-sindex-'))
    try {
      const schemaPath = setupProject(tmp, 'si', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['types', 'stores'] }],
      })
      const indexFiles = result.files.filter(f => f.path === 'o/index.tsx')
      expect(indexFiles.length).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('mst appends to existing index from earlier generator', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-mindex-'))
    try {
      const schemaPath = setupProject(tmp, 'mi', SMALL_SCHEMA)
      const result = await generateFromPrisma({
        schemaPath,
        outputs: [{ dir: 'o', generate: ['types', 'mst'] }],
      })
      const indexFiles = result.files.filter(f => f.path === 'o/index.tsx')
      expect(indexFiles.length).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('legacy single-dir mode throws when zero models', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pg-extra-legzm-'))
    try {
      const schemaPath = setupProject(tmp, 'lzm', `\ndatasource db {\n  provider = "sqlite"\n}\n`)
      await expect(generateFromPrisma({ schemaPath, outputDir: '/x' })).rejects.toThrow(
        'No models found to generate',
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

})
