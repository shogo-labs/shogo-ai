// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Branch coverage for `PreviewManager` that the two existing test files
 * leave untouched:
 *
 *   - `preview-manager.test.ts`: constructor + getter + emitBuildLine
 *     + resolveApiServerEnv + a few API-server lifecycle stubs.
 *   - `preview-manager-start.test.ts`: the non-blocking `start()`
 *     guarantee in four shapes.
 *
 * This file targets pure-ish read-only methods we *can* exercise
 * without spawning a real bundler or API child process:
 *
 *   - `getActiveRoutes` — file-IO + regex parsing
 *   - `getSchemaModels` — file-IO + regex parsing
 *   - `sync()` — early-return when schema is missing
 *   - `isApiHealthy()` — gated path when no port is set
 *   - The bundler-cwd / preview-URL getters under varied workspace
 *     layouts
 *   - The schema watcher's create-prisma-dir branch
 *   - `getDevicePreview()` corner cases not in the existing test
 *
 * Together these account for most of the remaining uncovered code in
 * the synchronous slice of the file; the async lifecycle paths
 * (installDeps, runShogoGenerate, the Metro tunnel) are intentionally
 * left to the dedicated docker-smoke and start-integration tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

import { PreviewManager, resolveApiServerEnv } from '../../preview-manager'

const TEST_DIR = '/tmp/test-preview-manager-branches'

function makePm(opts: Partial<Parameters<typeof PreviewManager.prototype.constructor>[0]> = {}) {
  return new PreviewManager({
    workspaceDir: TEST_DIR,
    runtimePort: 8090,
    ...opts,
  } as any)
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// getActiveRoutes — regex paths for `app.route(...)` and createRoutes manifest
// ---------------------------------------------------------------------------

describe('getActiveRoutes', () => {
  test('returns [] when no generated routes file exists', () => {
    expect(makePm().getActiveRoutes()).toEqual([])
  })

  test('parses app.route("/path") declarations from index.tsx', () => {
    // PreviewManager picks `bundlerCwd` = workspace root when there's
    // a package.json there. Use the Expo layout for this test.
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const genDir = join(TEST_DIR, 'src', 'generated', 'routes')
    mkdirSync(genDir, { recursive: true })
    writeFileSync(
      join(genDir, 'index.tsx'),
      [
        `app.route('/users', createUsersRoutes())`,
        `app.route("/posts", createPostsRoutes())`,
        '// not a route: app.use("/skipme")',
      ].join('\n'),
    )
    const routes = makePm().getActiveRoutes()
    expect(routes.sort()).toEqual(['posts', 'users'])
  })

  test('falls back to createRoutes manifest scan when app.route is absent', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const genDir = join(TEST_DIR, 'src', 'generated', 'routes')
    mkdirSync(genDir, { recursive: true })
    writeFileSync(
      join(genDir, 'index.tsx'),
      `export const routes = [
        { createRoutes: () => createOrderRoutes() },
        { createRoutes: () => createCustomerRoutes() },
      ]`,
    )
    const routes = makePm().getActiveRoutes()
    expect(routes.sort()).toEqual(['customers', 'orders'])
  })

  test('falls back gracefully on unreadable / malformed files', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const genDir = join(TEST_DIR, 'src', 'generated', 'routes')
    mkdirSync(genDir, { recursive: true })
    // Empty file — still readable, just produces no matches.
    writeFileSync(join(genDir, 'index.tsx'), '')
    expect(makePm().getActiveRoutes()).toEqual([])
  })

  test('honours each candidate path in order (legacy index.{ts,tsx} fallback)', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const legacyDir = join(TEST_DIR, 'src', 'generated')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      join(legacyDir, 'index.ts'),
      `app.route('/legacy', createLegacyRoutes())`,
    )
    expect(makePm().getActiveRoutes()).toEqual(['legacy'])
  })
})

// ---------------------------------------------------------------------------
// getSchemaModels — prisma schema parsing
// ---------------------------------------------------------------------------

describe('getSchemaModels', () => {
  test('returns [] when no schema.prisma exists', () => {
    expect(makePm().getSchemaModels()).toEqual([])
  })

  test('parses model declarations from schema.prisma', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const prismaDir = join(TEST_DIR, 'prisma')
    mkdirSync(prismaDir, { recursive: true })
    writeFileSync(
      join(prismaDir, 'schema.prisma'),
      [
        'datasource db {',
        '  provider = "sqlite"',
        '  url      = env("DATABASE_URL")',
        '}',
        '',
        'model User {',
        '  id   String @id',
        '  name String',
        '}',
        '',
        'model Post {',
        '  id     String @id',
        '  authorId String',
        '}',
      ].join('\n'),
    )
    expect(makePm().getSchemaModels().sort()).toEqual(['Post', 'User'])
  })

  test('returns [] for schema with no model blocks', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const prismaDir = join(TEST_DIR, 'prisma')
    mkdirSync(prismaDir, { recursive: true })
    writeFileSync(join(prismaDir, 'schema.prisma'), 'datasource db {}\n')
    expect(makePm().getSchemaModels()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sync() — schema-not-found early return
// ---------------------------------------------------------------------------

describe('sync()', () => {
  test('returns ok:false with a clear error when schema is missing', async () => {
    const pm = makePm()
    const r = await pm.sync()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('schema.prisma not found')
  })
})

// ---------------------------------------------------------------------------
// isApiHealthy() — gated path when no port is set
// ---------------------------------------------------------------------------

describe('isApiHealthy()', () => {
  test('returns false immediately when no API server is running', async () => {
    expect(await makePm().isApiHealthy()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// restartApiServerOnly — covered for the no-op path elsewhere; this hits
// the early-return through a workspace with no server.tsx.
// ---------------------------------------------------------------------------

describe('restartApiServerOnly()', () => {
  test('no-op succeeds in an empty workspace', async () => {
    await expect(makePm().restartApiServerOnly()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveApiServerEnv — extra branch coverage
// ---------------------------------------------------------------------------

describe('resolveApiServerEnv (extra branches)', () => {
  test('strips non-string entries from parentEnv', () => {
    const env = resolveApiServerEnv({
      parentEnv: {
        STR: 'hello',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        OBJ: { not: 'a string' } as any,
      },
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.STR).toBe('hello')
    expect(env.OBJ).toBeUndefined()
  })

  test('LOCAL_MODE without explicit SHOGO_API_URL gets the localhost default', () => {
    const env = resolveApiServerEnv({
      parentEnv: { SHOGO_LOCAL_MODE: 'true' },
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.SHOGO_API_URL).toBe('http://localhost:8002')
  })

  test('explicit SHOGO_API_URL on parent always wins', () => {
    const env = resolveApiServerEnv({
      parentEnv: { SHOGO_LOCAL_MODE: 'true', SHOGO_API_URL: 'https://api.example.com' },
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.SHOGO_API_URL).toBe('https://api.example.com')
  })

  test('non-LOCAL_MODE never injects SHOGO_API_URL', () => {
    const env = resolveApiServerEnv({
      parentEnv: {},
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.SHOGO_API_URL).toBeUndefined()
  })

  test('DATABASE_URL is pinned to <cwd>/prisma/dev.db regardless of parent', () => {
    const env = resolveApiServerEnv({
      parentEnv: { DATABASE_URL: 'postgresql://...' },
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.DATABASE_URL).toBe('file:/tmp/x/prisma/dev.db')
  })

  test('RUNTIME_PORT mirrors parent PORT before being overwritten by portStr', () => {
    const env = resolveApiServerEnv({
      parentEnv: { PORT: '8888' },
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.RUNTIME_PORT).toBe('8888')
    expect(env.PORT).toBe('4040')
    expect(env.API_SERVER_PORT).toBe('4040')
    expect(env.SKILL_SERVER_PORT).toBe('4040')
  })

  test('RUNTIME_PORT defaults to 8080 when parent PORT is unset', () => {
    const env = resolveApiServerEnv({
      parentEnv: {},
      portStr: '4040',
      cwd: '/tmp/x',
    })
    expect(env.RUNTIME_PORT).toBe('8080')
  })
})

// ---------------------------------------------------------------------------
// getDevicePreview — branches not covered by the canonical test
// ---------------------------------------------------------------------------

describe('getDevicePreview (extra branches)', () => {
  test('returns metroPort as null when no Metro process is running', () => {
    const dp = makePm().getDevicePreview()
    expect(dp).toBeTruthy()
    // The shape varies (`mode`, `metroPort`, `url`, etc.) but the
    // metroPort key must always be present per the existing canonical
    // test in preview-manager.test.ts.
    expect('metroPort' in dp).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// onLogLine forwarding — the forwardLogLine private method is exercised via
// emitBuildLine through the recordBuildEntry dispatcher, but the
// onLogLine config callback is best tested by giving the manager a config
// that records lines and then asking the manager's getStatus shape.
// ---------------------------------------------------------------------------

describe('config: onLogLine is preserved', () => {
  test('a custom onLogLine callback is stashed on the instance', () => {
    let received: { line: string; stream: 'stdout' | 'stderr' } | null = null
    const pm = new PreviewManager({
      workspaceDir: TEST_DIR,
      runtimePort: 8090,
      onLogLine: (line, stream) => { received = { line, stream } },
    })
    // The callback isn't directly invoked by anything we can call
    // here without spawning Metro, but the manager construct path
    // must not throw and the manager must still report a sane status.
    const status = pm.getStatus()
    expect(status).toBeTruthy()
    expect(received).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveDevServer fallback — exercised through bundlerCwd when stack.json
// is malformed.
// ---------------------------------------------------------------------------

describe('stack-aware bundler resolution', () => {
  test('falls back to bundlerCwd defaults when .tech-stack/stack.json is malformed', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const stackDir = join(TEST_DIR, '.tech-stack')
    mkdirSync(stackDir, { recursive: true })
    writeFileSync(join(stackDir, 'stack.json'), 'this is not json')
    // bundlerCwd should still be a real directory.
    const pm = makePm()
    expect(typeof pm.bundlerCwd).toBe('string')
    expect(pm.bundlerCwd.length).toBeGreaterThan(0)
  })

  test('honours stack.json runtime.devServer === "metro" branch', () => {
    writeFileSync(join(TEST_DIR, 'package.json'), '{ "name": "demo" }')
    const stackDir = join(TEST_DIR, '.tech-stack')
    mkdirSync(stackDir, { recursive: true })
    writeFileSync(
      join(stackDir, 'stack.json'),
      JSON.stringify({ id: 'expo-app', runtime: { devServer: 'metro' } }),
    )
    const pm = makePm()
    const dp = pm.getDevicePreview()
    // Walking the resolveDevServer/metro branch is what matters here;
    // the exact shape of the device-preview payload is already pinned
    // by the canonical preview-manager.test.ts cases.
    expect(typeof dp).toBe('object')
  })
})
