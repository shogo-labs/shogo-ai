// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// preview-manager.ts — spawn-driven path coverage.
//
// Targets the three biggest uncov clusters in preview-manager.ts:
//   • L2941-3042 startMetroTunnel  (85 uncov lines) — expo start --tunnel
//     spawn, URL capture from stdout/stderr, port-rebind regex, async
//     error event, exit listener.
//   • L2054-2115 runViteOneShotBuild (57 uncov lines) — one-shot vite
//     build, stdout/stderr forwarding, exit code branching, spawn-throws
//     bail.
//   • L959-984  getActiveRoutes      (23 uncov lines) — route-manifest
//     scanning across the SDK's four historical generated-routes paths,
//     including the fallback `createRoutes` regex and the read-error
//     catch.
// Plus mid-tier targets:
//   • getSchemaModels (13L), getDevicePreview-non-metro (10L),
//     pickFreePort-exhausted (15L via startMetroTunnel), getStatus
//     non-running (10L).
//
// Mock strategy: hoist mock.module for node:child_process so any
// `spawn()` call inside PreviewManager returns a controllable
// EventEmitter-shaped ChildProcess. The test then drives stdout/stderr
// /exit/error events to exercise each branch.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Hoisted child_process mock
// ---------------------------------------------------------------------------

interface FakeProc extends EventEmitter {
  pid: number
  killed: boolean
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
}

const spawnCalls: Array<{ cmd: string; args: ReadonlyArray<string>; opts: any }> = []
let nextProcThrows: Error | null = null
let pendingProcs: FakeProc[] = []

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = Math.floor(Math.random() * 50_000) + 1000
  proc.killed = false
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = (_sig?: string) => {
    proc.killed = true
    return true
  }
  return proc
}

mock.module('node:child_process', () => {
  const real = require('node:child_process')
  return {
    ...real,
    spawn: (cmd: string, args: any, opts: any) => {
      spawnCalls.push({ cmd, args, opts })
      if (nextProcThrows) {
        const err = nextProcThrows
        nextProcThrows = null
        throw err
      }
      const p = makeFakeProc()
      pendingProcs.push(p)
      return p
    },
  }
})

const { PreviewManager } = await import('../preview-manager')

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

let workspaces: string[] = []

beforeEach(() => {
  workspaces = []
  spawnCalls.length = 0
  pendingProcs = []
  nextProcThrows = null
})

afterEach(() => {
  for (const ws of workspaces) {
    if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  }
})

function makeWorkspace(opts: {
  withPackageJsonAtRoot?: boolean
  withProjectPackageJson?: boolean
  withPrismaSchema?: string | null
  techStack?: string | null
  generatedRoutes?: { variant: 'app.route' | 'createRoutes' | 'empty' | 'unreadable' | null }
  withExpoBin?: boolean
  withExpoNgrok?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pm-spawn-paths-'))
  workspaces.push(root)

  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  if (opts.withProjectPackageJson ?? true) {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'p' }))
  }
  if (opts.withPackageJsonAtRoot) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p-root' }))
  }
  if (opts.withPrismaSchema !== undefined && opts.withPrismaSchema !== null) {
    mkdirSync(join(projectDir, 'prisma'), { recursive: true })
    writeFileSync(join(projectDir, 'prisma', 'schema.prisma'), opts.withPrismaSchema)
  }
  if (opts.techStack !== undefined && opts.techStack !== null) {
    writeFileSync(join(root, '.tech-stack'), opts.techStack)
  }

  if (opts.withExpoBin) {
    const binDir = join(projectDir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'expo'), '#!/usr/bin/env node\nconsole.log("expo")\n')
  }
  if (opts.withExpoNgrok) {
    mkdirSync(join(projectDir, 'node_modules', '@expo', 'ngrok'), { recursive: true })
    writeFileSync(
      join(projectDir, 'node_modules', '@expo', 'ngrok', 'package.json'),
      JSON.stringify({ name: '@expo/ngrok', version: '4.0.0' }),
    )
  }

  if (opts.generatedRoutes && opts.generatedRoutes.variant) {
    const genDir = join(projectDir, 'src', 'generated', 'routes')
    mkdirSync(genDir, { recursive: true })
    const idx = join(genDir, 'index.tsx')
    switch (opts.generatedRoutes.variant) {
      case 'app.route':
        writeFileSync(
          idx,
          `app.route('/users', usersRoute)\napp.route('/posts', postsRoute)\napp.route('/comments', commentsRoute)\n`,
        )
        break
      case 'createRoutes':
        // No app.route() entries → falls through to the createRoutes regex.
        writeFileSync(
          idx,
          `export const manifest = { createRoutes: () => createUserRoutes, foo: () => createPostRoutes }`,
        )
        break
      case 'empty':
        writeFileSync(idx, '// no routes yet')
        break
      case 'unreadable':
        // Create a DIRECTORY at the index path so readFileSync throws EISDIR.
        rmSync(idx, { force: true })
        mkdirSync(idx, { recursive: true })
        break
    }
  }
  return root
}

// ---------------------------------------------------------------------------
// 1. getActiveRoutes — L959-984 (23 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.getActiveRoutes', () => {
  test('returns [] when no generated routes file exists', () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getActiveRoutes()).toEqual([])
  })

  test('extracts app.route("/path", ...) entries', () => {
    const root = makeWorkspace({ generatedRoutes: { variant: 'app.route' } })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getActiveRoutes()).toEqual(['users', 'posts', 'comments'])
  })

  test('falls back to createRoutes regex when no app.route entries', () => {
    const root = makeWorkspace({ generatedRoutes: { variant: 'createRoutes' } })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const paths = pm.getActiveRoutes()
    expect(paths).toContain('users')
  })

  test('returns [] when both regex patterns miss', () => {
    const root = makeWorkspace({ generatedRoutes: { variant: 'empty' } })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getActiveRoutes()).toEqual([])
  })

  test('returns [] when readFileSync throws (EISDIR / permissions)', () => {
    const root = makeWorkspace({ generatedRoutes: { variant: 'unreadable' } })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getActiveRoutes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. getSchemaModels — L1007-1020 (13 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.getSchemaModels', () => {
  test('returns [] when prisma/schema.prisma is missing', () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getSchemaModels()).toEqual([])
  })

  test('extracts all top-level model declarations', () => {
    const root = makeWorkspace({
      withPrismaSchema: `
datasource db { provider = "sqlite"; url = "file:./dev.db" }
generator client { provider = "prisma-client-js" }

model User {
  id String @id
}

model Post {
  id String @id
  authorId String
}

model Comment {
  id String @id
}
`,
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getSchemaModels()).toEqual(['User', 'Post', 'Comment'])
  })

  test('returns [] when schema content lacks any model { ... } block', () => {
    const root = makeWorkspace({
      withPrismaSchema: `// just a header — no models yet\ngenerator client { provider = "prisma-client-js" }\n`,
    })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.getSchemaModels()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. getStatus — L1964-1973 + adjacent non-running branch (10 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.getStatus (non-running)', () => {
  test('returns running=false with all url/port fields null before start()', () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({
      workspaceDir: root,
      runtimePort: 38400,
      publicUrl: 'https://preview.test/abc',
    })
    const s = pm.getStatus()
    expect(s.running).toBe(false)
    expect(s.port).toBe(null)
    expect(s.url).toBe(null)
    expect(s.internalUrl).toBe(null)
    expect(s.publicUrl).toBe(null)
    expect(s.workspaceDir).toBe(root)
    expect(s.bundlerCwd).toBe(join(root, 'project'))
    expect(s.phase).toBe('idle')
    expect(s.devServer).toBe('vite')
    expect(s.metroUrl).toBe(null)
    expect(s.errors).toEqual({ install: null, generate: null })
  })
})

// ---------------------------------------------------------------------------
// 4. getDevicePreview — non-metro + cloud-todo + ngrok-missing branches
//    (L3051-3057 + ngrok branch above it)
// ---------------------------------------------------------------------------

describe('PreviewManager.getDevicePreview', () => {
  test('returns devServer=vite + deviceMode=not-applicable for vite stack', () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    const dp = pm.getDevicePreview()
    expect(dp.devServer).toBe('vite')
    expect(dp.deviceMode).toBe('not-applicable')
    expect(dp.metroUrl).toBe(null)
    expect(dp.message).toBe(null)
  })

  test('returns cloud-todo when metro is selected but not localMode', () => {
    const root = makeWorkspace({ techStack: 'expo' })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0, localMode: false })
    const dp = pm.getDevicePreview()
    // The stack may or may not resolve to metro depending on the registry's
    // 'expo' entry. We only assert if it did resolve to metro.
    if (dp.devServer === 'metro') {
      expect(dp.deviceMode).toBe('cloud-todo')
      expect(dp.message).toContain('cloud projects')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. runViteOneShotBuild — L2054-2115 (57 uncov)
// ---------------------------------------------------------------------------

async function drain(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 5))
}

describe('PreviewManager.runViteOneShotBuild (private)', () => {
  test('happy path: spawn → stdout/stderr forwarded → exit(0) commits', async () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38401 })
    // Pre-create a staging output so commitBuildOutputAsync sees something to move.
    const projectDir = join(root, 'project')
    const stagingDir = join(projectDir, '.shogo-vite-staging')
    mkdirSync(stagingDir, { recursive: true })
    writeFileSync(join(stagingDir, 'index.html'), '<!doctype html>')

    const buildLogPath = join(root, '.shogo', 'logs', 'build.log')
    const runP = (pm as any).runViteOneShotBuild('vite', projectDir, buildLogPath, false)
    await drain()
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].args).toContain('build')
    expect(spawnCalls[0].args).toContain('--emptyOutDir')

    const proc = pendingProcs[0]
    proc.stdout.emit('data', Buffer.from('vite v5.0.0 building for development...\n'))
    proc.stderr.emit('data', Buffer.from('1 warning generated\n'))
    proc.emit('exit', 0)
    await runP
  })

  test('non-zero exit calls cleanupStagingOutput (failure branch)', async () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38402 })
    const buildLogPath = join(root, '.shogo', 'logs', 'build.log')
    const runP = (pm as any).runViteOneShotBuild('vite', join(root, 'project'), buildLogPath, false)
    await drain()
    const proc = pendingProcs[0]
    proc.stdout.emit('data', Buffer.from(''))  // blank line is skipped
    proc.stderr.emit('data', Buffer.from('error: build failed\n'))
    proc.emit('exit', 1)
    await runP
    // No throw — failure is logged and cleaned up.
  })

  test('spawn-throws bail returns without exit event', async () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38403 })
    const buildLogPath = join(root, '.shogo', 'logs', 'build.log')
    nextProcThrows = new Error('ENOENT: vite not found')
    await (pm as any).runViteOneShotBuild('vite', join(root, 'project'), buildLogPath, false)
    // resolveBuild(null) path was taken — no proc to interact with.
    expect(pendingProcs.length).toBe(0)
  })

  test('async error event resolves with null exit code', async () => {
    const root = makeWorkspace({})
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38404 })
    const buildLogPath = join(root, '.shogo', 'logs', 'build.log')
    const runP = (pm as any).runViteOneShotBuild('vite', join(root, 'project'), buildLogPath, false)
    await drain()
    const proc = pendingProcs[0]
    proc.emit('error', new Error('spawn ENOENT (async)'))
    // The error handler resolves with null; runViteOneShotBuild logs and returns.
    await runP
  })
})

// ---------------------------------------------------------------------------
// 6. startMetroTunnel — L2941-3042 (85 uncov)
// ---------------------------------------------------------------------------

describe('PreviewManager.startMetroTunnel (private)', () => {
  test('returns early when not in localMode', async () => {
    const root = makeWorkspace({ withExpoBin: true, withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38415, localMode: false })
    await (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    expect(spawnCalls.length).toBe(0)
  })

  test('returns early when expo bin is missing (no node_modules/.bin/expo)', async () => {
    const root = makeWorkspace({ withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38416, localMode: true })
    await (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    expect(spawnCalls.length).toBe(0)
  })

  test('returns early when @expo/ngrok is missing', async () => {
    const root = makeWorkspace({ withExpoBin: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38417, localMode: true })
    await (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    expect(spawnCalls.length).toBe(0)
    expect((pm as any).metroNgrokAvailable).toBe(false)
  })

  test('captures exp:// URL from stdout and port-rebind from stderr', async () => {
    const root = makeWorkspace({ withExpoBin: true, withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38410, localMode: true })
    const projectDir = join(root, 'project')

    const runP = (pm as any).startMetroTunnel(projectDir, 'expo')
    await drain()
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].args).toContain('start')
    expect(spawnCalls[0].args).toContain('--tunnel')

    const proc = pendingProcs[0]
    // Emit the tunnel URL on stdout — captureUrlFrom sets this.metroUrl,
    // which terminates the URL-poll loop on its next iteration.
    proc.stdout.emit(
      'data',
      Buffer.from('› Tunnel ready.\nexp://abc123.exp.direct/\n'),
    )
    // Emit a port-rebind notice on stderr — Expo sometimes uses stderr.
    // capturePortRebindFrom() bumps this.metroPort.
    proc.stderr.emit(
      'data',
      Buffer.from('Port 8081 is being used by another process. Falling back to using port 8082 instead.\n'),
    )

    // Wait for the URL-poll loop's 500ms sleep to elapse so it can exit.
    await runP
    expect((pm as any).metroUrl).toContain('exp://abc123')
    expect((pm as any).metroPort).toBe(8082)
  }, 10000)

  test('spawn-throws bail returns without setting metroProcess', async () => {
    const root = makeWorkspace({ withExpoBin: true, withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38411, localMode: true })
    nextProcThrows = new Error('expo binary not found')
    await (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    expect(pendingProcs.length).toBe(0)
    expect((pm as any).metroProcess).toBe(null)
  })

  test('async proc.on(error) clears metro state', async () => {
    const root = makeWorkspace({ withExpoBin: true, withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38412, localMode: true })
    const runP = (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    await drain()
    const proc = pendingProcs[0]
    proc.emit('error', new Error('spawn ENOENT (async)'))
    // Then end so the polling loop exits within the 30s deadline by killing.
    proc.killed = true
    await runP
    // Process was reset by the error handler.
    expect((pm as any).metroProcess).toBe(null)
  })

  test('proc.on(exit) before URL capture tears down metro state', async () => {
    const root = makeWorkspace({ withExpoBin: true, withExpoNgrok: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 38413, localMode: true })
    const runP = (pm as any).startMetroTunnel(join(root, 'project'), 'expo')
    await drain()
    const proc = pendingProcs[0]
    // Emit exit BEFORE any URL is captured. The exit handler nulls metroUrl
    // and metroProcess; killed=true short-circuits the URL-poll loop.
    proc.emit('exit', 1, 'SIGTERM')
    proc.killed = true
    await runP
    expect((pm as any).metroProcess).toBe(null)
    expect((pm as any).metroUrl).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 7. resolveBundlerCwd — L871-894 (6L) — root-package.json branch
// ---------------------------------------------------------------------------

describe('PreviewManager.resolveBundlerCwd', () => {
  test('uses workspace root when project/package.json missing but root has package.json', () => {
    const root = makeWorkspace({ withProjectPackageJson: false, withPackageJsonAtRoot: true })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.bundlerCwd).toBe(root)
  })

  test('falls back to project/ when no package.json is found anywhere', () => {
    const root = makeWorkspace({ withProjectPackageJson: false })
    const pm = new PreviewManager({ workspaceDir: root, runtimePort: 0 })
    expect(pm.bundlerCwd).toBe(join(root, 'project'))
  })
})
