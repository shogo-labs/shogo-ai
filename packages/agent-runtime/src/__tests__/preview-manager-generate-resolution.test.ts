// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-616 — preview codegen must never leave the project.
 *
 * `runShogoGenerate()` used to fall back to `bun x shogo generate` when a
 * project had no `generate` script and no local SDK CLI. Two packages publish a
 * `shogo` bin, so in a monorepo checkout (and in every agent checkout of it)
 * that resolved to the Homebrew `@shogo-ai/worker`, whose default command is
 * `chat` — the word "generate" arrived as a *prompt* and each `/api` recovery
 * retry bought another one-shot agent turn. 3,637 of them in `main.log`.
 *
 * These tests pin the four decisions that stop it:
 *   (a) no script + no CLI → spawn nothing, say `bun install`;
 *   (b) a config that emits no server → no sidecar, no generate, no watcher,
 *       even under repeated `maybeRecoverApiServer()` / `ensureApiServer()`;
 *   (c) a real app project still runs `bun run generate`;
 *   (d) a timed-out generate leaves no surviving process.
 *
 * Fail-on-`main` check: (a) spawned `bun x shogo generate` (the fake bun below
 * records it), (b) reached the generator at all, (d) left `sleep 600` alive.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** The binary `runShogoGenerate()` spawns. Swapped per test for a fake. */
let bunBinary = 'bun'

mock.module('@shogo/shared-runtime', () => ({
  pkg: {
    get bunBinary() {
      return bunBinary
    },
    prismaGenerateAsync: async () => {},
    prismaDbPushAsync: async () => {},
  },
  resolveBinInvocation: (_cwd: string, _bin: string) => null,
}))

import { PreviewManager } from '../preview-manager'
import { emitsServerEntry } from '../shogo-app-project'

let dir: string
const managers: any[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sho616-generate-'))
  bunBinary = 'bun'
})

afterEach(() => {
  for (const m of managers) {
    try {
      m.stopSchemaWatcher?.()
    } catch {}
  }
  managers.length = 0
  rmSync(dir, { recursive: true, force: true })
})

function mk(): any {
  const m = new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38307,
    publicUrl: 'https://preview.example/sho616',
    localMode: false,
    apiPort: 38308,
  }) as any
  managers.push(m)
  return m
}

/** A project folder: `package.json` + `prisma/schema.prisma` (+ extra files). */
function project(files: Record<string, string> = {}): string {
  const p = join(dir, 'project')
  mkdirSync(join(p, 'prisma'), { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'x', ...JSON.parse(files['package.json'] ?? '{}') }))
  writeFileSync(join(p, 'prisma/schema.prisma'), 'model User {\n  id Int @id\n}\n')
  for (const [name, body] of Object.entries(files)) {
    if (name === 'package.json') continue
    writeFileSync(join(p, name), body)
  }
  return p
}

/**
 * Replace `pkg.bunBinary` with a shell script. It records its argv to
 * `<marker>` and/or runs `body`, so a test can prove the runtime either spawned
 * something (and with which arguments) or spawned nothing at all.
 */
function fakeBun(body: string): string {
  const marker = join(dir, 'spawned-args.txt')
  const path = join(dir, 'fake-bun.sh')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n${body}\n`, 'utf-8')
  chmodSync(path, 0o755)
  bunBinary = path
  return marker
}

const MONOREPO_CONFIG = JSON.stringify({
  schema: './prisma/schema.prisma',
  outputs: [
    { dir: './apps/api/src/generated', generate: ['routes', 'hooks', 'admin-routes'] },
    { dir: './packages/domain-stores/src', generate: ['types', 'mst'] },
  ],
})

const APP_CONFIG = JSON.stringify({
  schema: './prisma/schema.prisma',
  outputs: [
    { dir: './src/generated', generate: ['routes', 'hooks', 'types'] },
    { dir: '.', generate: ['server'], fileExtension: 'tsx' },
  ],
})

describe('emitsServerEntry', () => {
  it('is false for a config whose outputs generate no server (the monorepo root)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sho616-cfg-'))
    try {
      writeFileSync(join(cwd, 'shogo.config.json'), MONOREPO_CONFIG)
      expect(emitsServerEntry(cwd)).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is true when an output generates the server entry', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sho616-cfg-'))
    try {
      writeFileSync(join(cwd, 'shogo.config.json'), APP_CONFIG)
      expect(emitsServerEntry(cwd)).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is true with no config at all (the template generate script emits a server by default)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sho616-cfg-'))
    try {
      expect(existsSync(join(cwd, 'shogo.config.json'))).toBe(false)
      expect(emitsServerEntry(cwd)).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is true for an unparseable config — never disable a real app over a typo', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sho616-cfg-'))
    try {
      writeFileSync(join(cwd, 'shogo.config.json'), '{ not json')
      expect(emitsServerEntry(cwd)).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('runShogoGenerate resolution', () => {
  it('(a) spawns nothing and asks for bun install when there is no script and no SDK CLI', async () => {
    project()
    const marker = fakeBun(':')
    const m = mk()

    const ok = await m.runShogoGenerate()

    expect(ok).toBe(false)
    expect(m.apiLastGenerateError).toContain('cli.mjs')
    expect(m.apiLastGenerateError).toContain('bun install')
    expect(existsSync(marker)).toBe(false)
    expect(m.apiServerPhase).toBe('crashed')
  })

  it('(c) runs `bun run generate` for a project that declares the script', async () => {
    project({ 'package.json': JSON.stringify({ scripts: { generate: 'bun scripts/generate.ts' } }) })
    const marker = fakeBun('exit 0')
    const m = mk()

    const ok = await m.runShogoGenerate()

    expect(ok).toBe(true)
    expect(m.apiLastGenerateError).toBeNull()
    expect(readFileSync(marker, 'utf-8').trim().split('\n')).toEqual(['run', 'generate'])
  })

  it('prefers the project-local SDK CLI over anything on PATH', async () => {
    const cwd = project()
    const sdkDir = join(cwd, 'node_modules', '@shogo-ai', 'sdk', 'bin')
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, 'cli.mjs'), '// stub\n')
    const marker = fakeBun('exit 0')
    const m = mk()

    const ok = await m.runShogoGenerate()

    expect(ok).toBe(true)
    const args = readFileSync(marker, 'utf-8').trim().split('\n')
    expect(args[0]).toBe(join(sdkDir, 'cli.mjs'))
    expect(args[1]).toBe('generate')
    expect(args).not.toContain('x')
  })
})

describe('a folder whose config emits no server is not an app project', () => {
  it('(b) startApiServer leaves the sidecar idle and never generates', async () => {
    const cwd = project({ 'shogo.config.json': MONOREPO_CONFIG })
    const marker = fakeBun(':')
    const m = mk()
    // If the gate ever regresses, these would spawn instead of being called.
    let generated = 0
    m.runShogoGenerate = async () => {
      generated += 1
      return true
    }

    await m.startApiServer()

    expect(m.apiServerPhase).toBe('idle')
    expect((m as any).hasApiServer).toBe(false)
    expect(generated).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(cwd, 'prisma'))).toBe(true) // untouched, not created by a watcher
    expect((m as any).schemaWatcher).toBeNull()
  })

  it('(b) logs the skip once, and recovery / ensure never restart it', async () => {
    project({ 'shogo.config.json': MONOREPO_CONFIG })
    fakeBun(':')
    const m = mk()
    let generated = 0
    m.runShogoGenerate = async () => {
      generated += 1
      return true
    }
    const log = spyOn(console, 'log')

    try {
      await m.startApiServer()
      await m.startApiServer()
      m.startSchemaWatcher()
      expect(m.maybeRecoverApiServer()).toBe(false)

      const ensured = await m.ensureApiServer()

      expect(ensured.phase).toBe('none')
      expect(generated).toBe(0)
      const skipLines = log.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((line: string) => line.includes('API sidecar skipped'))
      expect(skipLines.length).toBe(1)
    } finally {
      log.mockRestore()
    }
  })

  it('(b) sync() refuses with a clear error instead of generating', async () => {
    project({ 'shogo.config.json': MONOREPO_CONFIG })
    fakeBun(':')
    const m = mk()
    let generated = 0
    m.runShogoGenerate = async () => {
      generated += 1
      return true
    }

    const result = await m.sync()

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not a Shogo app project')
    expect(generated).toBe(0)
    expect(m.apiServerPhase).toBe('idle')
  })

  it('an app project still generates and is not skipped', async () => {
    project({ 'shogo.config.json': APP_CONFIG, 'package.json': JSON.stringify({ scripts: { generate: 'x' } }) })
    fakeBun('exit 0')
    const m = mk()
    let generated = 0
    const real = m.runShogoGenerate.bind(m)
    m.runShogoGenerate = async () => {
      generated += 1
      return real()
    }
    m.startApiServer = async () => {}

    const result = await m.sync()

    expect(generated).toBe(1)
    expect(result.error ?? '').not.toContain('not a Shogo app project')
  })
})

describe('generate timeout', () => {
  it('(d) kills the whole tree and resolves within the timeout window', async () => {
    project({ 'package.json': JSON.stringify({ scripts: { generate: 'sh' } }) })
    const pidFile = join(dir, 'grandchild.pid')
    // The leader forks a grandchild that holds the stdio pipes and outlives it
    // (the shape of `prisma generate` under the old kill-the-leader timeout).
    fakeBun(`sleep 600 &\necho $! > '${pidFile}'\nwait`)

    const m: any = new PreviewManager({
      workspaceDir: dir,
      runtimePort: 38309,
      publicUrl: 'https://preview.example/sho616-timeout',
      localMode: false,
      apiPort: 38310,
      generateTimeoutMs: 1_000,
    })
    managers.push(m)

    const started = Date.now()
    const ok = await m.runShogoGenerate()
    const elapsed = Date.now() - started

    expect(ok).toBe(false)
    expect(m.apiLastGenerateError).toContain('timed out')
    expect(elapsed).toBeLessThan(1_000 + 5_000)

    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(Number.isFinite(grandchild)).toBe(true)
    // The group is dead: nothing answers for that pid any more.
    let alive = true
    try {
      process.kill(grandchild, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 20_000)
})
