// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { generateFromPrisma, type OutputConfig } from '../prisma-generator'

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

const ZERO_MODEL_SCHEMA = `
datasource db {
  provider = "sqlite"
}
`

const ONE_MODEL_SCHEMA = `
datasource db {
  provider = "sqlite"
}

model Todo {
  id        String   @id @default(cuid())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())
}
`

describe('prisma-generator: zero-model generation', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shogo-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not throw when outputs include server', async () => {
    const schemaPath = setupProject(tmpDir, 'zero-1', ZERO_MODEL_SCHEMA)

    const outputs: OutputConfig[] = [
      {
        dir: '.',
        generate: ['server'],
        serverConfig: {
          port: 4100,
          skipStatic: true,
          customRoutesPath: './custom-routes',
          dynamicCrudImport: true,
          bunServe: true,
        },
      },
    ]

    const result = await generateFromPrisma({ schemaPath, outputs })
    expect(result.models).toEqual([])
    expect(result.files.length).toBeGreaterThan(0)
  })

  it('returns server.tsx in results', async () => {
    const schemaPath = setupProject(tmpDir, 'zero-2', ZERO_MODEL_SCHEMA)

    const outputs: OutputConfig[] = [
      {
        dir: '.',
        generate: ['server', 'routes', 'db'],
        serverConfig: {
          port: 4100,
          skipStatic: true,
          dynamicCrudImport: true,
          bunServe: true,
        },
      },
    ]

    const result = await generateFromPrisma({ schemaPath, outputs })

    const serverFile = result.files.find(f => f.path.endsWith('server.tsx'))
    expect(serverFile).toBeDefined()
    expect(serverFile!.content).toContain('Hono')
  })

  it('does not return route/type/hook/db files with zero models', async () => {
    const schemaPath = setupProject(tmpDir, 'zero-3', ZERO_MODEL_SCHEMA)

    const outputs: OutputConfig[] = [
      {
        dir: '.',
        generate: ['server', 'routes', 'hooks', 'types', 'db'],
        serverConfig: { port: 4100, skipStatic: true },
      },
    ]

    const result = await generateFromPrisma({ schemaPath, outputs })

    const fileNames = result.files.map(f => f.path)
    expect(fileNames.some(f => f.endsWith('server.tsx'))).toBe(true)
    expect(fileNames.some(f => f.endsWith('db.tsx'))).toBe(false)
    expect(fileNames.some(f => f.includes('routes'))).toBe(false)
    expect(fileNames.some(f => f.includes('hooks'))).toBe(false)
    expect(fileNames.some(f => f.includes('types'))).toBe(false)
  })

  it('still throws in legacy single-dir mode with zero models', async () => {
    const schemaPath = setupProject(tmpDir, 'zero-legacy', ZERO_MODEL_SCHEMA)

    expect(
      generateFromPrisma({ schemaPath, outputDir: './out' })
    ).rejects.toThrow('No models found to generate')
  })

  it('generates all files when models exist', async () => {
    const schemaPath = setupProject(tmpDir, 'one-model', ONE_MODEL_SCHEMA)

    const outputs: OutputConfig[] = [
      {
        dir: '.',
        generate: ['server', 'routes', 'hooks', 'db'],
        dbProvider: 'sqlite',
        serverConfig: { port: 4100, skipStatic: true },
      },
    ]

    const result = await generateFromPrisma({ schemaPath, outputs })

    expect(result.models).toEqual(['Todo'])
    const fileNames = result.files.map(f => f.path)
    expect(fileNames.some(f => f.endsWith('server.tsx'))).toBe(true)
    expect(fileNames.some(f => f.endsWith('db.tsx'))).toBe(true)
    expect(fileNames.some(f => f.includes('todo'))).toBe(true)
  })
})
