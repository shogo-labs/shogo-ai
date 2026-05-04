// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runtimeTerminalRoutes } from '../runtime-terminal-routes'
import { buildQuickCommands } from '../quick-commands'

function withWorkspace<T>(fn: (workspaceDir: string) => Promise<T>): Promise<T> {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-runtime-terminal-test-'))
  return fn(workspaceDir).finally(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })
}

function writePackageJson(workspaceDir: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(workspaceDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8')
}

// `printf` is a bash builtin and not a PowerShell cmdlet, so use Node to emit
// fixed bytes instead. This keeps the test portable across the bash launcher
// (Unix) and the PowerShell launcher (Windows).
const PORTABLE_OK_CMD = `node -e "process.stdout.write('ok')"`

/**
 * Pull the meta sentinel out of a /terminal/run streamed body. Mirrors the
 * client-side parser in apps/mobile/components/project/panels/ide/Terminal.tsx
 * so we can assert on the post-command cwd / exit code without copying the
 * decoder into the test.
 */
function readMeta(body: string): { cwd?: string; exitCode?: number | null } | null {
  const m = /\u001eSHOGO_TERM_META:([A-Za-z0-9+/=]+)\u001e\n?/.exec(body)
  if (!m) return null
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
  } catch {
    return null
  }
}

describe('runtimeTerminalRoutes', () => {
  test('serves preset commands as JSON at the runtime-local path', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, { name: 'demo' })
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')

      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }
      expect(body.commands.package.some(cmd => cmd.id === 'bun-install')).toBe(true)
    })
  })

  test('omits bun-install when the workspace has no package.json', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }
      const all = Object.values(body.commands).flat()
      expect(all.some((c) => c.id === 'bun-install')).toBe(false)
    })
  })

  test('serves cd completion entries from the workspace root', async () => {
    await withWorkspace(async (workspaceDir) => {
      mkdirSync(join(workspaceDir, 'files'))
      mkdirSync(join(workspaceDir, 'fixtures'))
      writeFileSync(join(workspaceDir, 'final.txt'), 'nope', 'utf-8')
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: 'fi', onlyDirectories: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { entries: Array<{ name: string; type: string }> }
      expect(body.entries).toEqual([
        { name: 'files', type: 'directory' },
        { name: 'fixtures', type: 'directory' },
      ])
    })
  })

  test('keeps terminal completion bounded to the workspace', async () => {
    await withWorkspace(async (workspaceDir) => {
      mkdirSync(join(workspaceDir, 'files'))
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: '../', onlyDirectories: true }),
      })

      expect(res.status).toBe(200)
      const body = await res.json() as { entries: unknown[] }
      expect(body.entries).toEqual([])
    })
  })

  test('hides dot directories unless the prefix starts with a dot', async () => {
    await withWorkspace(async (workspaceDir) => {
      mkdirSync(join(workspaceDir, '.config'))
      mkdirSync(join(workspaceDir, 'components'))
      const app = runtimeTerminalRoutes({ workspaceDir })

      const hidden = await app.request('/terminal/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: 'c', onlyDirectories: true }),
      })
      const hiddenBody = await hidden.json() as { entries: Array<{ name: string }> }
      expect(hiddenBody.entries.map((entry) => entry.name)).toEqual(['components'])

      const dot = await app.request('/terminal/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pathPrefix: '.c', onlyDirectories: true }),
      })
      const dotBody = await dot.json() as { entries: Array<{ name: string }> }
      expect(dotBody.entries.map((entry) => entry.name)).toEqual(['.config'])
    })
  })

  test('includes symlinked directories only when they stay inside the workspace', async () => {
    await withWorkspace(async (workspaceDir) => {
      mkdirSync(join(workspaceDir, 'real-dir'))
      symlinkSync(join(workspaceDir, 'real-dir'), join(workspaceDir, 'real-link'))
      const outside = mkdtempSync(join(tmpdir(), 'shogo-runtime-terminal-outside-'))
      try {
        symlinkSync(outside, join(workspaceDir, 'outside-link'))
        const app = runtimeTerminalRoutes({ workspaceDir })

        const res = await app.request('/terminal/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pathPrefix: '', onlyDirectories: true }),
        })

        const body = await res.json() as { entries: Array<{ name: string }> }
        expect(body.entries.map((entry) => entry.name)).toContain('real-link')
        expect(body.entries.map((entry) => entry.name)).not.toContain('outside-link')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('serves free-form command endpoint as a terminal stream', async () => {
    await withWorkspace(async (workspaceDir) => {
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('http://runtime.test/terminal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: PORTABLE_OK_CMD }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')

      const text = await res.text()
      expect(text).toContain('SHOGO_TERM_META:')
      const meta = readMeta(text)
      expect(meta?.exitCode).toBe(0)
    })
  })

  test('cd into a subdirectory updates the reported cwd', async () => {
    await withWorkspace(async (workspaceDir) => {
      const sub = join(workspaceDir, 'files')
      mkdirSync(sub)
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('http://runtime.test/terminal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'cd files' }),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      const meta = readMeta(text)
      expect(meta).not.toBeNull()
      expect(meta?.exitCode).toBe(0)
      // PowerShell reports `C:\...\files`, bash reports `/tmp/.../files`. Both
      // resolve to the same realpath; just check the trailing segment to stay
      // platform-agnostic without dragging fs.realpathSync into the test.
      expect(meta?.cwd?.endsWith('files')).toBe(true)
    })
  })

  test('failing cd reports a non-zero exit code', async () => {
    // Regression guard: PowerShell's Invoke-Expression masks cmdlet
    // failures because the IE call itself succeeds — `$?` stays True
    // and `$LASTEXITCODE` stays 0. The launcher must use `$Error.Count`
    // to surface those as non-zero exits, otherwise users get a
    // misleading "exit 0" after `cd nonexistent`. The same path on
    // Unix is just `cd missing` returning rc=1 from bash directly.
    await withWorkspace(async (workspaceDir) => {
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('http://runtime.test/terminal/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'cd this_directory_should_not_exist_xyz' }),
      })

      expect(res.status).toBe(200)
      const meta = readMeta(await res.text())
      expect(meta).not.toBeNull()
      expect(meta?.exitCode).not.toBe(0)
    })
  })
})

describe('buildQuickCommands (dynamic per-workspace presets)', () => {
  test('maps known package.json scripts to friendly chip metadata', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, {
        name: 'demo',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      })

      const cmds = buildQuickCommands(workspaceDir)
      const byId = new Map(cmds.map((c) => [c.id, c]))

      expect(byId.get('script-dev')?.label).toBe('Start Dev Server')
      expect(byId.get('script-dev')?.command).toBe('bun run dev')
      expect(byId.get('script-dev')?.category).toBe('server')

      expect(byId.get('script-build')?.label).toBe('Rebuild')
      expect(byId.get('script-build')?.category).toBe('build')

      expect(byId.get('script-test')?.category).toBe('test')
      expect(byId.get('script-lint')?.category).toBe('lint')
      expect(byId.get('script-typecheck')?.category).toBe('build')
    })
  })

  test('falls through unknown script names with a title-cased label', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, {
        name: 'demo',
        scripts: { 'seed:dev': 'bun seed.ts' },
      })

      const cmd = buildQuickCommands(workspaceDir).find((c) => c.id === 'script-seed:dev')
      expect(cmd).toBeDefined()
      expect(cmd?.label).toBe('Seed Dev')
      expect(cmd?.command).toBe('bun run seed:dev')
      expect(cmd?.category).toBe('package')
    })
  })

  test('includes Prisma presets only when prisma/schema.prisma exists', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, { name: 'demo' })

      let cmds = buildQuickCommands(workspaceDir)
      expect(cmds.some((c) => c.id === 'prisma-generate')).toBe(false)

      mkdirSync(join(workspaceDir, 'prisma'), { recursive: true })
      writeFileSync(join(workspaceDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "sqlite" url = "file:./dev.db" }', 'utf-8')

      cmds = buildQuickCommands(workspaceDir)
      expect(cmds.some((c) => c.id === 'prisma-generate')).toBe(true)
      expect(cmds.some((c) => c.id === 'prisma-push')).toBe(true)
      expect(cmds.find((c) => c.id === 'prisma-reset')?.dangerous).toBe(true)
    })
  })

  test('includes Playwright presets only when playwright.config.* exists', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, { name: 'demo' })

      let cmds = buildQuickCommands(workspaceDir)
      expect(cmds.some((c) => c.id === 'playwright-test')).toBe(false)

      writeFileSync(join(workspaceDir, 'playwright.config.ts'), 'export default {}', 'utf-8')

      cmds = buildQuickCommands(workspaceDir)
      expect(cmds.some((c) => c.id === 'playwright-test')).toBe(true)
      expect(cmds.some((c) => c.id === 'playwright-test-headed')).toBe(true)
    })
  })

  test('python-data stack defaults appear when .tech-stack is set, with stack quickCommands winning over file-probe collisions', async () => {
    await withWorkspace(async (workspaceDir) => {
      writeFileSync(join(workspaceDir, '.tech-stack'), 'python-data', 'utf-8')
      writeFileSync(join(workspaceDir, 'requirements.txt'), 'pandas\n', 'utf-8')

      const cmds = buildQuickCommands(workspaceDir)
      const pip = cmds.find((c) => c.id === 'pip-install-requirements')
      const jupyter = cmds.find((c) => c.id === 'jupyter-lab')

      expect(pip).toBeDefined()
      expect(pip?.command).toBe('pip install -r requirements.txt')
      // Stack-defined timeout (300_000) wins over the file-probe timeout (180_000).
      expect(pip?.timeout).toBe(300_000)

      expect(jupyter).toBeDefined()
      expect(jupyter?.category).toBe('server')
    })
  })

  test('endpoint groups dynamic commands by category in the legacy shape', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, {
        name: 'demo',
        scripts: { dev: 'vite', build: 'vite build', lint: 'eslint .' },
      })
      const app = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }

      expect(body.commands.server?.some((c) => c.id === 'script-dev')).toBe(true)
      expect(body.commands.build?.some((c) => c.id === 'script-build')).toBe(true)
      expect(body.commands.lint?.some((c) => c.id === 'script-lint')).toBe(true)
    })
  })

  test('exec endpoint resolves dynamically-derived script commands', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, { name: 'demo', scripts: { dev: 'vite' } })
      const app = runtimeTerminalRoutes({ workspaceDir })

      // Unknown id still 400s.
      const bad = await app.request('http://runtime.test/terminal/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: 'no-such-id' }),
      })
      expect(bad.status).toBe(400)

      // Known dynamic id is accepted (200 + streamed body). We don't actually
      // wait for the spawned `bun run dev` to finish — just that the route
      // accepts the id and starts streaming.
      const ok = await app.request('http://runtime.test/terminal/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: 'script-dev' }),
      })
      expect(ok.status).toBe(200)
      // Drain to release resources without waiting for dev server steady state.
      ok.body?.cancel?.().catch(() => {})
    })
  })
})
