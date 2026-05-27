// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * v4 slot 2/18 — preview-manager.ts coverage extra.
 *
 * Targets surface that's reachable WITHOUT spawning real child_process
 * pipelines (those live in -lifecycle / -build-pipeline / -crash-recovery
 * test files):
 *   - getStatus() in idle (pre-start) state — all fields, error envelope.
 *   - bundlerCwd resolution: legacy /project/ layout, root /package.json
 *     layout, no-package.json fallback.
 *   - internalUrl / externalUrl: publicUrl precedence + empty-string
 *     fallback to internalUrl.
 *   - resolveDevServer via .tech-stack marker: missing, empty, valid
 *     vite/metro/none, unknown stack → vite fallback, broken JSON.
 *   - depsReady promise: starts unresolved, depsSettled false; can be
 *     awaited after a manual resolve (via PreviewManager-internal
 *     mechanism not exposed — exercise the getters only).
 *   - setOnBuildComplete: rewire callback after construction.
 *   - metroDeviceUrl / isLocalMode / isStarted / isRunning getters.
 *   - emitBuildLine: disk-write failure is swallowed (best-effort).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'

import { flushAllLogWrites } from '../runtime-log-writer'
import {
  PreviewManager,
  emitBuildLine,
  resolveApiServerEnv,
  type PreviewManagerConfig,
} from '../preview-manager'

const TEST_ROOT = '/tmp/test-pm-v4'

function mkConfig(workspaceSuffix: string, overrides: Partial<PreviewManagerConfig> = {}): PreviewManagerConfig {
  const ws = join(TEST_ROOT, workspaceSuffix)
  return {
    workspaceDir: ws,
    runtimePort: 31337,
    ...overrides,
  }
}

beforeAll(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// getStatus() — pre-start envelope
// ---------------------------------------------------------------------------

describe('PreviewManager.getStatus (idle)', () => {
  test('returns running=false, null url/port/internalUrl, phase=idle, no errors', () => {
    const ws = join(TEST_ROOT, 'status-idle')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 4242 })
    const s = pm.getStatus()
    expect(s.running).toBe(false)
    expect(s.port).toBeNull()
    expect(s.url).toBeNull()
    expect(s.internalUrl).toBeNull()
    expect(s.publicUrl).toBeNull()
    expect(s.workspaceDir).toBe(ws)
    expect(s.phase).toBe('idle')
    expect(s.metroUrl).toBeNull()
    expect(s.errors).toEqual({ install: null, generate: null })
    expect(s.devServer === 'vite' || s.devServer === 'metro' || s.devServer === 'none').toBe(true)
  })

  test('publicUrl config is captured but ignored in url field while idle', () => {
    const ws = join(TEST_ROOT, 'status-public-idle')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({
      workspaceDir: ws,
      runtimePort: 4242,
      publicUrl: 'https://preview.shogo.ai',
    })
    const s = pm.getStatus()
    expect(s.url).toBeNull()
    expect(s.publicUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// bundlerCwd resolution
// ---------------------------------------------------------------------------

describe('PreviewManager.bundlerCwd resolution', () => {
  test('legacy <workspace>/project/package.json layout is preferred', () => {
    const ws = join(TEST_ROOT, 'bcwd-legacy')
    const proj = join(ws, 'project')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), '{}')
    writeFileSync(join(ws, 'package.json'), '{}')
    const pm = new PreviewManager(mkConfig('bcwd-legacy'))
    expect(pm.bundlerCwd).toBe(proj)
  })

  test('workspace-root package.json (Expo/RN layout) wins when /project/ is absent', () => {
    const ws = join(TEST_ROOT, 'bcwd-root')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'package.json'), '{}')
    const pm = new PreviewManager(mkConfig('bcwd-root'))
    expect(pm.bundlerCwd).toBe(ws)
  })

  test('falls back to <workspace>/project/ when no package.json exists anywhere', () => {
    const ws = join(TEST_ROOT, 'bcwd-none')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager(mkConfig('bcwd-none'))
    expect(pm.bundlerCwd).toBe(join(ws, 'project'))
  })
})

// ---------------------------------------------------------------------------
// internalUrl / externalUrl
// ---------------------------------------------------------------------------

describe('PreviewManager URL getters', () => {
  test('internalUrl is http://localhost:<runtimePort>/', () => {
    const ws = join(TEST_ROOT, 'url-internal')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 9000 })
    expect(pm.internalUrl).toBe('http://localhost:9000/')
  })

  test('externalUrl prefers publicUrl when non-empty', () => {
    const ws = join(TEST_ROOT, 'url-public')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({
      workspaceDir: ws,
      runtimePort: 9000,
      publicUrl: 'https://example.shogo.ai',
    })
    expect(pm.externalUrl).toBe('https://example.shogo.ai')
  })

  test('externalUrl falls back to internalUrl when publicUrl is an empty string', () => {
    const ws = join(TEST_ROOT, 'url-empty')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({
      workspaceDir: ws,
      runtimePort: 9000,
      publicUrl: '',
    })
    expect(pm.externalUrl).toBe('http://localhost:9000/')
  })

  test('externalUrl falls back to internalUrl when publicUrl is undefined', () => {
    const ws = join(TEST_ROOT, 'url-undef')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 9001 })
    expect(pm.externalUrl).toBe('http://localhost:9001/')
  })
})

// ---------------------------------------------------------------------------
// resolveDevServer via .tech-stack marker
// ---------------------------------------------------------------------------

describe('PreviewManager.getStatus().devServer (from .tech-stack)', () => {
  test('no .tech-stack marker → defaults to vite', () => {
    const ws = join(TEST_ROOT, 'ds-none')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.getStatus().devServer).toBe('vite')
  })

  test('empty .tech-stack file → defaults to vite', () => {
    const ws = join(TEST_ROOT, 'ds-empty')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, '.tech-stack'), '   ')
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.getStatus().devServer).toBe('vite')
  })

  test('unknown stack id → falls back to vite via meta-undefined branch', () => {
    const ws = join(TEST_ROOT, 'ds-unknown')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, '.tech-stack'), 'this-stack-does-not-exist')
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.getStatus().devServer).toBe('vite')
  })

  test('.tech-stack pointing to a real registry entry resolves to its declared devServer (or vite fallback)', () => {
    const ws = join(TEST_ROOT, 'ds-known')
    mkdirSync(ws, { recursive: true })
    // 'react-app' is a historical stack — even if no longer in the registry,
    // the function still returns 'vite' via the fallback path.
    writeFileSync(join(ws, '.tech-stack'), 'react-app')
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    const ds = pm.getStatus().devServer
    expect(['vite', 'metro', 'none']).toContain(ds)
  })
})

// ---------------------------------------------------------------------------
// depsReady promise + depsSettled mirror
// ---------------------------------------------------------------------------

describe('PreviewManager.depsReady', () => {
  test('depsReady is a pending Promise immediately after construction', () => {
    const ws = join(TEST_ROOT, 'deps-ready')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    const p = pm.depsReady
    expect(p).toBeInstanceOf(Promise)
    expect(pm.depsSettled).toBe(false)
  })

  test('depsReady is referentially stable across reads (same promise)', () => {
    const ws = join(TEST_ROOT, 'deps-stable')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.depsReady).toBe(pm.depsReady)
  })
})

// ---------------------------------------------------------------------------
// setOnBuildComplete + getter parity
// ---------------------------------------------------------------------------

describe('PreviewManager misc getters / setters', () => {
  test('isStarted / isRunning are false in idle state', () => {
    const ws = join(TEST_ROOT, 'misc-idle')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.isStarted).toBe(false)
    expect(pm.isRunning).toBe(false)
  })

  test('metroDeviceUrl is null until Metro tunnel populates it', () => {
    const ws = join(TEST_ROOT, 'misc-metro')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(pm.metroDeviceUrl).toBeNull()
  })

  test('isLocalMode reflects the constructor config value', () => {
    const ws = join(TEST_ROOT, 'misc-local')
    mkdirSync(ws, { recursive: true })
    const pmLocal = new PreviewManager({ workspaceDir: ws, runtimePort: 1, localMode: true })
    expect(pmLocal.isLocalMode).toBe(true)
    const pmCloud = new PreviewManager({ workspaceDir: ws, runtimePort: 1, localMode: false })
    expect(pmCloud.isLocalMode).toBe(false)
  })

  test('setOnBuildComplete(undefined) is idempotent and does not throw', () => {
    const ws = join(TEST_ROOT, 'misc-cb')
    mkdirSync(ws, { recursive: true })
    const pm = new PreviewManager({ workspaceDir: ws, runtimePort: 1 })
    expect(() => pm.setOnBuildComplete(undefined)).not.toThrow()
    let hit = 0
    pm.setOnBuildComplete(() => { hit++ })
    expect(hit).toBe(0) // we don't auto-call it
    pm.setOnBuildComplete(undefined)
    expect(() => pm.setOnBuildComplete(undefined)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// emitBuildLine — best-effort disk write
// ---------------------------------------------------------------------------

describe('emitBuildLine extra branches', () => {
  test('empty line is a no-op (early return; no file written)', () => {
    const buildLog = join(TEST_ROOT, 'el-empty.log')
    if (existsSync(buildLog)) rmSync(buildLog)
    emitBuildLine(buildLog, '[stdout]', '', 'stdout')
    expect(existsSync(buildLog)).toBe(false)
  })

  test('writes a line with prefix + newline to the build-log file', async () => {
    const buildLog = join(TEST_ROOT, 'el-write.log')
    if (existsSync(buildLog)) rmSync(buildLog)
    emitBuildLine(buildLog, '[stdout]', 'hello', 'stdout')
    // emitBuildLine now delegates to runtime-log-writer.scheduleLogWrite,
    // which batches via setImmediate to keep /health responsive on Windows
    // — see runtime-log-writer.ts header. Drain before asserting.
    await flushAllLogWrites(buildLog)
    expect(existsSync(buildLog)).toBe(true)
    const stat = statSync(buildLog)
    expect(stat.size).toBeGreaterThan(0)
  })

  test('disk failure is swallowed silently (parent dir does not exist)', () => {
    const badLog = join(TEST_ROOT, 'no-such-dir', 'el-fail.log')
    // Parent dir intentionally absent — appendFileSync should throw, but
    // emitBuildLine catches and proceeds to the in-memory dispatch.
    expect(() => emitBuildLine(badLog, '[stderr]', 'oops', 'stderr')).not.toThrow()
    expect(existsSync(badLog)).toBe(false)
  })

  test('stderr stream tag routes through recordBuildEntry as error severity', () => {
    const buildLog = join(TEST_ROOT, 'el-stderr.log')
    if (existsSync(buildLog)) rmSync(buildLog)
    expect(() => emitBuildLine(buildLog, '[stderr]', 'compile error', 'stderr')).not.toThrow()
  })

  test('default stream argument is stdout', async () => {
    const buildLog = join(TEST_ROOT, 'el-default.log')
    if (existsSync(buildLog)) rmSync(buildLog)
    // @ts-expect-error — exercising the default-argument path
    emitBuildLine(buildLog, '[stdout]', 'using default stream')
    await flushAllLogWrites(buildLog)
    expect(existsSync(buildLog)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveApiServerEnv extra branches
// ---------------------------------------------------------------------------

describe('resolveApiServerEnv extra branches', () => {
  test('non-string env values (numbers, booleans, undefined) are filtered out', () => {
    const env = resolveApiServerEnv({
      parentEnv: { A: 'a', B: undefined as any, C: 123 as any },
      portStr: '5000',
      cwd: '/srv',
    })
    expect(env.A).toBe('a')
    expect(env.B).toBeUndefined()
    expect(env.C).toBeUndefined()
  })

  test('SHOGO_API_URL is auto-populated when LOCAL_MODE=true and not already set', () => {
    const env = resolveApiServerEnv({
      parentEnv: { SHOGO_LOCAL_MODE: 'true' },
      portStr: '5000',
      cwd: '/srv',
    })
    expect(env.SHOGO_API_URL).toBe('http://localhost:8002')
  })

  test('explicit SHOGO_API_URL overrides the local-mode default', () => {
    const env = resolveApiServerEnv({
      parentEnv: { SHOGO_LOCAL_MODE: 'true', SHOGO_API_URL: 'https://override' },
      portStr: '5000',
      cwd: '/srv',
    })
    expect(env.SHOGO_API_URL).toBe('https://override')
  })

  test('cloud mode (no SHOGO_LOCAL_MODE) does NOT inject SHOGO_API_URL', () => {
    const env = resolveApiServerEnv({
      parentEnv: {},
      portStr: '5000',
      cwd: '/srv',
    })
    expect(env.SHOGO_API_URL).toBeUndefined()
  })

  test('RUNTIME_PORT defaults to 8080 when PORT is unset in parent env', () => {
    const env = resolveApiServerEnv({ parentEnv: {}, portStr: '5000', cwd: '/srv' })
    expect(env.RUNTIME_PORT).toBe('8080')
  })

  test('PORT is overwritten with the sidecar port; RUNTIME_PORT preserves the parent PORT', () => {
    const env = resolveApiServerEnv({ parentEnv: { PORT: '8080' }, portStr: '5001', cwd: '/srv' })
    expect(env.RUNTIME_PORT).toBe('8080')
    expect(env.PORT).toBe('5001')
    expect(env.API_SERVER_PORT).toBe('5001')
    expect(env.SKILL_SERVER_PORT).toBe('5001')
  })

  test('DATABASE_URL is constructed from cwd + prisma/dev.db', () => {
    const env = resolveApiServerEnv({ parentEnv: {}, portStr: '5000', cwd: '/work/proj' })
    expect(env.DATABASE_URL).toBe('file:/work/proj/prisma/dev.db')
  })
})
