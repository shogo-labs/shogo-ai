// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

describe('runtimeTerminalRoutes — preset commands', () => {
  test('serves preset commands as JSON at the runtime-local path', async () => {
    await withWorkspace(async (workspaceDir) => {
      writePackageJson(workspaceDir, { name: 'demo' })
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')

      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }
      expect(body.commands.package.some(cmd => cmd.id === 'bun-install')).toBe(true)
      manager.shutdown()
    })
  })

  test('omits bun-install when the workspace has no package.json', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }
      const all = Object.values(body.commands).flat()
      expect(all.some((c) => c.id === 'bun-install')).toBe(false)
      manager.shutdown()
    })
  })
})

describe('runtimeTerminalRoutes — PTY session lifecycle (REST)', () => {
  test('POST /terminal/sessions creates a session with defaults', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; cols: number; rows: number; cwd: string }
      expect(body.id).toMatch(/^t/)
      expect(body.cols).toBe(80)
      expect(body.rows).toBe(24)
      expect(body.cwd).toBe(workspaceDir)
      expect(manager.list()).toHaveLength(1)
      manager.shutdown()
    })
  })

  test('POST /terminal/sessions clamps cols/rows', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })
      const res = await app.request('/terminal/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 5000, rows: 9999 }),
      })
      const body = await res.json() as { cols: number; rows: number }
      expect(body.cols).toBe(1000)
      expect(body.rows).toBe(1000)
      manager.shutdown()
    })
  })

  test('POST /terminal/sessions returns 400 with max_sessions_reached', async () => {
    await withWorkspace(async (workspaceDir) => {
      const manager = new (await import('../pty-session-manager')).PtySessionManager({
        workspaceDir, maxSessions: 1, sweepIntervalMs: 0,
      })
      const { router: app } = runtimeTerminalRoutes({ workspaceDir, manager })
      const ok = await app.request('/terminal/sessions', { method: 'POST', body: '{}' })
      expect(ok.status).toBe(200)
      const fail = await app.request('/terminal/sessions', { method: 'POST', body: '{}' })
      expect(fail.status).toBe(400)
      const body = await fail.json() as { error: { code: string } }
      expect(body.error.code).toBe('max_sessions_reached')
      manager.shutdown()
    })
  })

  test('GET /terminal/sessions lists active sessions', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })
      await app.request('/terminal/sessions', { method: 'POST', body: '{}' })
      await app.request('/terminal/sessions', { method: 'POST', body: '{}' })
      const res = await app.request('/terminal/sessions')
      const body = await res.json() as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(2)
      manager.shutdown()
    })
  })

  test('DELETE /terminal/sessions/:id kills the session', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })
      const created = await (await app.request('/terminal/sessions', { method: 'POST', body: '{}' })).json() as { id: string }
      const del = await app.request(`/terminal/sessions/${created.id}`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      expect(manager.list()).toHaveLength(0)
      manager.shutdown()
    })
  })

  test('DELETE on unknown id returns 404', async () => {
    await withWorkspace(async (workspaceDir) => {
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })
      const res = await app.request('/terminal/sessions/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
      manager.shutdown()
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
      const { router: app, manager } = runtimeTerminalRoutes({ workspaceDir })

      const res = await app.request('/terminal/commands')
      const body = await res.json() as { commands: Record<string, Array<{ id: string }>> }

      expect(body.commands.server?.some((c) => c.id === 'script-dev')).toBe(true)
      expect(body.commands.build?.some((c) => c.id === 'script-build')).toBe(true)
      expect(body.commands.lint?.some((c) => c.id === 'script-lint')).toBe(true)
      manager.shutdown()
    })
  })
})
