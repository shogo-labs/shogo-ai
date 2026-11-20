// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generated code must typecheck in a *fresh* project.
 *
 * `bun x shogo generate` writes `src/generated/*` and `server.tsx` into every
 * project Shogo creates. Nothing used to check that output with `tsc`, so a
 * generator regression shipped silently and every project was born with 35–56
 * type errors — which is why agents learned to ignore the `[typecheck] ✗` line
 * (SHO-371).
 *
 * This test builds a real project from `templates/runtime-template`, drops in a
 * schema that covers the shapes that broke generated code (1-n, n-n and self
 * relations, an enum, optional fields, `@unique`, `@map`/`@@map`), runs the real
 * `shogo generate`, and typechecks the result with the template's own
 * `tsconfig.json`.
 *
 * It is deliberately end-to-end rather than a snapshot: snapshots pin whatever
 * the generator emits, including what does not compile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const REPO_ROOT = resolve(__dirname, '../../../../..')
const TEMPLATE_DIR = join(REPO_ROOT, 'templates/runtime-template')
const SDK_CLI = join(REPO_ROOT, 'packages/sdk/bin/cli.mjs')
/** Generous: a cold `bun install` + prisma generate + tsc in CI. */
const SETUP_TIMEOUT_MS = 420_000
const FIXTURE_SCHEMA = `// Fixture for the generated-code typecheck gate.
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}
datasource db {
  provider = "sqlite"
}
enum Status {
  DRAFT
  LIVE
  ARCHIVED
}
model Author {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  status    Status   @default(DRAFT)
  bio       String?  @map("short_bio")
  createdAt DateTime @default(now()) @map("created_at")
  posts    Post[]
  mentorId String?  @map("mentor_id")
  mentor   Author?  @relation("Mentorship", fields: [mentorId], references: [id])
  mentees  Author[] @relation("Mentorship")
  tags     Tag[]
  @@map("authors")
}
model Post {
  id       String  @id @default(cuid())
  title    String
  slug     String  @unique
  body     String?
  authorId String  @map("author_id")
  author   Author  @relation(fields: [authorId], references: [id])
  tags     Tag[]
  @@map("posts")
}
model Tag {
  id      String @id @default(cuid())
  label   String @unique
  authors Author[]
  posts   Post[]
}
`
/**
 * The `@shogo-ai/sdk` version `templates/runtime-template/bun.lock` resolved.
 * Read from the lockfile so the fixture installs a published package that is
 * known to exist, instead of guessing at the in-repo (possibly unpublished)
 * version.
 */
function lockedSdkVersion(): string {
  const lock = readFileSync(join(TEMPLATE_DIR, 'bun.lock'), 'utf-8')
  const match = lock.match(/@shogo-ai\/sdk@(\d+\.\d+\.\d+)/)
  if (!match) throw new Error('could not read the @shogo-ai/sdk version from templates/runtime-template/bun.lock')
  return match[1]
}
/**
 * `DATABASE_URL` is a secret in the agent sandbox and usually a Postgres URL.
 * Handing it to a fresh SQLite project makes `prisma db push` fail; the project's
 * own `file:` fallback is what a real fresh project uses.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DATABASE_URL
  delete env.WORKSPACE_ID
  return env
}
function runBin(cmd: string, args: string[], cwd: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      env: cleanEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: true, output: stdout }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` }
  }
}
let projectDir = ''
let tscBin = ''
function typecheck(): { ok: boolean; output: string } {
  return runBin('bun', [tscBin, '--noEmit'], projectDir)
}
beforeAll(() => {
  // Layout:
  //   <root>/src                -> this checkout's packages/sdk/src
  //   <root>/fixture/proj       -> the template (the fixture project)
  // The template's own `scripts/generate.ts` prefers `../../../src/generators/index`
  // (the monorepo path) and only falls back to the published `@shogo-ai/sdk`, so
  // this layout makes the fixture run THIS checkout's generator without patching
  // a single shipped file.
  const root = mkdtempSync(join(tmpdir(), 'shogo-generated-typecheck-'))
  // `scripts/generate.ts` resolves `../../../src/generators/index` from
  // `<projectDir>/scripts/`, i.e. two levels above the project dir.
  projectDir = join(root, 'fixture/proj')
  mkdirSync(join(root, 'fixture'), { recursive: true })
  symlinkSync(join(REPO_ROOT, 'packages/sdk/src'), join(root, 'src'))
  cpSync(TEMPLATE_DIR, projectDir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  writeFileSync(join(projectDir, 'prisma/schema.prisma'), FIXTURE_SCHEMA)
  // The template pins the SDK as the `workspace:*` sentinel, which only resolves
  // from the monorepo root. Materialize it the way the ship path does, using the
  // version the template's own lockfile already resolved.
  const pkgPath = join(projectDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (pkg.dependencies['@shogo-ai/sdk'] === 'workspace:*') {
    pkg.dependencies['@shogo-ai/sdk'] = `^${lockedSdkVersion()}`
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
  const lockPath = join(projectDir, 'bun.lock')
  if (existsSync(lockPath)) unlinkSync(lockPath)
  const install = runBin('bun', ['install'], projectDir)
  if (!install.ok) {
    throw new Error(`bun install failed in the fixture project:\n${install.output}`)
  }
  tscBin = join(projectDir, 'node_modules/typescript/bin/tsc')
  expect(existsSync(tscBin)).toBe(true)
  const gen = runBin('bun', [SDK_CLI, 'generate'], projectDir)
  if (!gen.ok) {
    throw new Error(`shogo generate failed in the fixture project:\n${gen.output}`)
  }
  expect(existsSync(join(projectDir, 'src/generated/author.routes.ts'))).toBe(true)
  expect(existsSync(join(projectDir, 'server.tsx'))).toBe(true)
}, SETUP_TIMEOUT_MS)
afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true })
})
describe('generated code typechecks in a fresh project', () => {
  it(
    'tsc --noEmit reports 0 errors after `shogo generate`',
    () => {
      const result = typecheck()
      expect(result.output).toBe('')
      expect(result.ok).toBe(true)
    },
    SETUP_TIMEOUT_MS,
  )
  it(
    'the template tsconfig covers custom-routes.ts and server.tsx',
    () => {
      const tsconfig = JSON.parse(readFileSync(join(projectDir, 'tsconfig.json'), 'utf-8'))
      const include: string[] = tsconfig.include
      expect(include).toContain('custom-routes.ts')
      expect(include).toContain('server.tsx')
      expect(include).toContain('server/**/*')
      // Both are real server surfaces: a type error in either must be reported.
      const customRoutesPath = join(projectDir, 'custom-routes.ts')
      const serverPath = join(projectDir, 'server.tsx')
      const originalCustomRoutes = readFileSync(customRoutesPath, 'utf-8')
      const originalServer = readFileSync(serverPath, 'utf-8')
      try {
        writeFileSync(
          customRoutesPath,
          `${originalCustomRoutes}\nexport const sho371CustomRoutesTypeError: number = 'not a number'\n`,
        )
        writeFileSync(
          serverPath,
          `${originalServer}\nexport const sho371ServerTypeError: number = 'not a number'\n`,
        )
        const result = typecheck()
        expect(result.ok).toBe(false)
        expect(result.output).toContain('custom-routes.ts')
        expect(result.output).toContain('server.tsx')
      } finally {
        writeFileSync(customRoutesPath, originalCustomRoutes)
        writeFileSync(serverPath, originalServer)
      }
    },
    SETUP_TIMEOUT_MS,
  )
})
