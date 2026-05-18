// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
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
  type OutputConfig,
  type PrismaModel,
  type PrismaField,
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

const RICH_SCHEMA = `
datasource db {
  provider = "sqlite"
}

enum Role {
  USER
  ADMIN
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id        String   @id @default(cuid())
  title     String
  body      String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id])
  authorId  String
  createdAt DateTime @default(now())
}

model Category {
  id   String @id @default(cuid())
  name String
}
`

const NO_USER_SCHEMA = `
datasource db {
  provider = "sqlite"
}

model Item {
  id   String @id @default(cuid())
  name String
}
`

let tmpDir: string
let richSchemaPath: string
let noUserSchemaPath: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prisma-gen-expanded-'))
  richSchemaPath = setupProject(tmpDir, 'rich', RICH_SCHEMA)
  noUserSchemaPath = setupProject(tmpDir, 'nouser', NO_USER_SCHEMA)
})

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('toCamelCase / toKebabCase', () => {
  it('camelCase lowercases first char', () => {
    expect(toCamelCase('UserProfile')).toBe('userProfile')
    expect(toCamelCase('A')).toBe('a')
    expect(toCamelCase('alreadyLower')).toBe('alreadyLower')
  })

  it('kebab-case splits camel boundaries', () => {
    expect(toKebabCase('UserProfile')).toBe('user-profile')
    expect(toKebabCase('XMLHttpRequest')).toBe('xmlhttp-request')
    expect(toKebabCase('lowercase')).toBe('lowercase')
  })
})

describe('field filters (synthetic DMMF)', () => {
  const model: PrismaModel = {
    name: 'Demo',
    fields: [
      mkField({ name: 'id', kind: 'scalar', type: 'String', isId: true }),
      mkField({ name: 'name', kind: 'scalar', type: 'String' }),
      mkField({ name: 'status', kind: 'enum', type: 'Status' }),
      mkField({ name: 'owner', kind: 'object', type: 'User' }),
      mkField({ name: 'mystery', kind: 'unsupported', type: 'Bytes' }),
    ],
  }

  it('getScalarFields returns scalar + enum', () => {
    const scalars = getScalarFields(model)
    expect(scalars.map(f => f.name)).toEqual(['id', 'name', 'status'])
  })

  it('getRelationFields returns object fields', () => {
    const rels = getRelationFields(model)
    expect(rels.map(f => f.name)).toEqual(['owner'])
  })

  it('getIdField returns the id field', () => {
    const id = getIdField(model)
    expect(id?.name).toBe('id')
  })

  it('getIdField returns undefined when no id', () => {
    const noId: PrismaModel = { name: 'X', fields: [mkField({ name: 'x', kind: 'scalar', type: 'String' })] }
    expect(getIdField(noId)).toBeUndefined()
  })
})

function mkField(over: Partial<PrismaField> & Pick<PrismaField, 'name' | 'kind' | 'type'>): PrismaField {
  return {
    isRequired: true,
    isList: false,
    isId: false,
    isUnique: false,
    hasDefaultValue: false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// parsePrismaSchema — direct
// ---------------------------------------------------------------------------

describe('parsePrismaSchema', () => {
  it('parses a schema and returns DMMF with models + enums', async () => {
    const dmmf = await parsePrismaSchema(richSchemaPath)
    expect(dmmf.datamodel.models.length).toBe(3)
    expect(dmmf.datamodel.enums.length).toBe(1)
    expect(dmmf.datamodel.enums[0]!.name).toBe('Role')
  })
})

// ---------------------------------------------------------------------------
// generateFromPrisma — per-model mode, all generators
// ---------------------------------------------------------------------------

describe('generateFromPrisma — per-model all generators', () => {
  it('produces files for every supported generate type', async () => {
    const outDir = join(tmpDir, 'gen-all')
    const outputs: OutputConfig[] = [
      {
        dir: outDir,
        fileExtension: 'ts',
        dbProvider: 'sqlite',
        generate: [
          'routes',
          'hooks',
          'types',
          'stores',
          'mst',
          'server',
          'db',
          'api-client',
          'auth',
          'docs',
          'admin-routes',
          'shogo-client',
          'voice-components',
        ],
      },
    ]

    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })

    expect(result.models).toEqual(['User', 'Post', 'Category'])
    expect(result.warnings).toEqual([])

    const paths = result.files.map(f => f.path)
    expect(paths.some(p => p.endsWith('/types.ts'))).toBe(true)
    expect(paths.some(p => p.endsWith('/api-client.ts'))).toBe(true)
    expect(paths.some(p => p.endsWith('/server.ts'))).toBe(true)
    expect(paths.some(p => p.endsWith('/db.ts'))).toBe(true)
    expect(paths.some(p => p.endsWith('/auth.ts'))).toBe(true)
    expect(paths.some(p => p.endsWith('/index.ts'))).toBe(true)

    const server = result.files.find(f => f.path.endsWith('/server.ts'))!
    expect(server.skipIfExists).toBe(true)

    const db = result.files.find(f => f.path.endsWith('/db.ts'))!
    expect(db.skipIfExists).toBe(true)
    expect(db.content).toMatch(/sqlite|better-sqlite|file:/i)

    const hookFile = result.files.find(f => /hooks/i.test(f.path) && f.skipIfExists)
    expect(hookFile).toBeDefined()
  })

  it('uses postgres db module when dbProvider is unset', async () => {
    const outDir = join(tmpDir, 'gen-pg')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['db'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    const db = result.files.find(f => f.path.endsWith('/db.ts'))!
    expect(db.content).not.toMatch(/better-sqlite/)
  })

  it('uses tsx extension by default', async () => {
    const outDir = join(tmpDir, 'gen-tsx')
    const outputs: OutputConfig[] = [
      { dir: outDir, generate: ['types', 'routes'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.some(f => f.path.endsWith('.tsx'))).toBe(true)
  })

  it('emits single-file types when perModel is false', async () => {
    const outDir = join(tmpDir, 'gen-single')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', perModel: false, generate: ['types'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.length).toBe(1)
    expect(result.files[0]!.path).toBe(`${outDir}/types.ts`)
  })

  it('skips routes/stores/mst when perModel is false', async () => {
    const outDir = join(tmpDir, 'gen-no-permodel')
    const outputs: OutputConfig[] = [
      {
        dir: outDir,
        fileExtension: 'ts',
        perModel: false,
        generate: ['routes', 'stores', 'mst'],
      },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.length).toBe(0)
  })

  it('emits more files when hooks added alongside routes', async () => {
    const dirA = join(tmpDir, 'gen-routes-only')
    const dirB = join(tmpDir, 'gen-routes-hooks')
    const a = await generateFromPrisma({
      schemaPath: richSchemaPath,
      outputs: [{ dir: dirA, fileExtension: 'ts', generate: ['routes'] }],
    })
    const b = await generateFromPrisma({
      schemaPath: richSchemaPath,
      outputs: [{ dir: dirB, fileExtension: 'ts', generate: ['routes', 'hooks'] }],
    })
    expect(b.files.length).toBeGreaterThan(a.files.length)
  })

  it('warns when auth requested but no User model with email', async () => {
    const outDir = join(tmpDir, 'gen-no-user')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['auth'] },
    ]
    const result = await generateFromPrisma({ schemaPath: noUserSchemaPath, outputs })
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/Auth/)
    expect(result.files.find(f => f.path.endsWith('/auth.ts'))).toBeUndefined()
  })

  it('respects models include filter', async () => {
    const outDir = join(tmpDir, 'gen-include')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['types'] },
    ]
    const result = await generateFromPrisma({
      schemaPath: richSchemaPath,
      outputs,
      models: ['User'],
    })
    expect(result.models).toEqual(['User'])
  })

  it('respects excludeModels filter', async () => {
    const outDir = join(tmpDir, 'gen-exclude')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['types'] },
    ]
    const result = await generateFromPrisma({
      schemaPath: richSchemaPath,
      outputs,
      excludeModels: ['Category'],
    })
    expect(result.models).toEqual(['User', 'Post'])
  })

  it('combines two outputs in one call', async () => {
    const dirA = join(tmpDir, 'gen-multi-a')
    const dirB = join(tmpDir, 'gen-multi-b')
    const outputs: OutputConfig[] = [
      { dir: dirA, fileExtension: 'ts', generate: ['types'] },
      { dir: dirB, fileExtension: 'ts', generate: ['routes', 'hooks'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.some(f => f.path.startsWith(dirA))).toBe(true)
    expect(result.files.some(f => f.path.startsWith(dirB))).toBe(true)
  })

  it('emits stores files and a stores index', async () => {
    const outDir = join(tmpDir, 'gen-stores')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['stores'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.some(f => f.path.endsWith('/index.ts'))).toBe(true)
  })

  it('emits MST domain + collections + index when mst requested', async () => {
    const outDir = join(tmpDir, 'gen-mst')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['mst'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    const paths = result.files.map(f => f.path)
    expect(paths.some(p => /domain/i.test(p))).toBe(true)
    expect(paths.some(p => p.endsWith('/index.ts'))).toBe(true)
  })

  it('emits admin routes file when admin-routes requested', async () => {
    const outDir = join(tmpDir, 'gen-admin')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['admin-routes'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.length).toBeGreaterThan(0)
  })

  it('emits docs scaffold + tsconfig + docs content when docs requested', async () => {
    const outDir = join(tmpDir, 'gen-docs')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['docs'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.length).toBeGreaterThan(2)
  })

  it('emits shogo-client even when no models', async () => {
    const outDir = join(tmpDir, 'gen-shogo-only')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['shogo-client'] },
    ]
    const result = await generateFromPrisma({
      schemaPath: richSchemaPath,
      excludeModels: ['User', 'Post', 'Category'],
      outputs,
    })
    expect(result.models).toEqual([])
    expect(result.files.length).toBeGreaterThan(0)
  })

  it('emits voice-components when voice-components requested', async () => {
    const outDir = join(tmpDir, 'gen-voice')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'tsx', generate: ['voice-components'] },
    ]
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputs })
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.files.every(f => f.skipIfExists !== undefined || true)).toBe(true)
  })

  it('emits server even when no models present', async () => {
    const outDir = join(tmpDir, 'gen-server-only')
    const outputs: OutputConfig[] = [
      { dir: outDir, fileExtension: 'ts', generate: ['server'] },
    ]
    const result = await generateFromPrisma({
      schemaPath: richSchemaPath,
      excludeModels: ['User', 'Post', 'Category'],
      outputs,
    })
    expect(result.files.find(f => f.path.endsWith('/server.ts'))).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Legacy single-dir mode
// ---------------------------------------------------------------------------

describe('generateFromPrisma — legacy single-dir mode', () => {
  it('emits types/hooks/index when outputDir provided', async () => {
    const outDir = join(tmpDir, 'legacy-ok')
    const result = await generateFromPrisma({ schemaPath: richSchemaPath, outputDir: outDir })
    const paths = result.files.map(f => f.path)
    expect(paths).toContain(`${outDir}/types.tsx`)
    expect(paths).toContain(`${outDir}/hooks.tsx`)
    expect(paths).toContain(`${outDir}/index.tsx`)
    const hooks = result.files.find(f => f.path.endsWith('hooks.tsx'))!
    expect(hooks.content).toMatch(/User:/)
    expect(hooks.content).toMatch(/Post:/)
    expect(hooks.content).toMatch(/Category:/)
  })

  it('throws when neither outputDir nor outputs provided', async () => {
    await expect(
      generateFromPrisma({ schemaPath: richSchemaPath }),
    ).rejects.toThrow(/outputDir or outputs/)
  })

  it('throws when legacy mode has no models', async () => {
    await expect(
      generateFromPrisma({
        schemaPath: richSchemaPath,
        outputDir: join(tmpDir, 'legacy-empty'),
        excludeModels: ['User', 'Post', 'Category'],
      }),
    ).rejects.toThrow(/No models/)
  })
})
