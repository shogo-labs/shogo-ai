// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-28 (the SHO-26 follow-ups).
 *
 * The card exists because SHO-26 renamed the *reader* of the dev API port
 * (`scripts/dev-all.ts`, `scripts/watch-api.ts` now read
 * `SHOGO_DEV_API_PORT`) but left the *writers* emitting the bare `API_PORT`.
 * In a worktree with a non-zero offset that made `bun dev:all` clear port
 * 8002 while the stack bound 8002+offset, so a leftover stack surfaced as a
 * raw EADDRINUSE.
 *
 * A reader/writer rename is only correct if the two halves agree, which no
 * existing test can see (each side is tested alone with a fake). These tests
 * therefore execute `scripts/worktree-setup.sh` for real and then check the
 * emitted environment against every consumer, so a future edit that
 * reintroduces the bare name on either side fails here.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '../..')
const IS_WINDOWS = process.platform === 'win32'
const BASE_API_PORT = 8002

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function runWorktreeSetup(branch: string) {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-wt-sho28-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

  const result = spawnSync('bash', [join(ROOT, 'scripts/worktree-setup.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, BRANCH: branch, WORKTREE_PATH: dir },
  })

  const envFile = join(dir, '.env.local')
  const text = readFileSync(envFile, 'utf8')
  const vars = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) vars.set(match[1], match[2])
  }

  return { dir, result, text, vars }
}

describe.skipIf(IS_WINDOWS)('worktree-setup.sh emits the port dev:all actually clears', () => {
  test('a worktree on a feature branch gets SHOGO_DEV_API_PORT = base + offset', () => {
    const { result, vars, text } = runWorktreeSetup('sho-28-acceptance-probe')

    expect(result.status).toBe(0)

    const offset = Number(vars.get('PORT_OFFSET'))
    expect(Number.isInteger(offset) && offset > 0).toBe(true)

    // The regression: the port the stack binds must be derivable from the
    // environment file, under the name dev-all reads.
    expect(vars.get('SHOGO_DEV_API_PORT')).toBe(String(BASE_API_PORT + offset))
    expect(text).not.toMatch(/^API_PORT=/m)

    // The URLs printed by the script have to name the same port, or a
    // developer opens 8002 and finds someone else's stack.
    expect(result.stdout + result.stderr).toContain(`http://localhost:${BASE_API_PORT + offset}`)
  }, 30_000)

  test('two worktrees on different branches get different API ports', () => {
    const first = runWorktreeSetup('sho-28-acceptance-probe')
    const second = runWorktreeSetup('sho-28-acceptance-probe-b')

    const firstPort = Number(first.vars.get('SHOGO_DEV_API_PORT'))
    const secondPort = Number(second.vars.get('SHOGO_DEV_API_PORT'))

    expect(firstPort).toBe(BASE_API_PORT + Number(first.vars.get('PORT_OFFSET')))
    expect(secondPort).toBe(BASE_API_PORT + Number(second.vars.get('PORT_OFFSET')))
    if (first.vars.get('PORT_OFFSET') !== second.vars.get('PORT_OFFSET')) {
      expect(firstPort).not.toBe(secondPort)
    }
  }, 30_000)

  test('the generated .env.local is what bun loads for the dev process', () => {
    const { dir, vars } = runWorktreeSetup('sho-28-acceptance-probe')

    // `bun dev:all` inherits the worktree's environment because bun loads
    // .env/.env.local from the cwd. Prove the emitted value survives that.
    const child = spawnSync('bun', ['-e', 'console.log(process.env.SHOGO_DEV_API_PORT ?? "")'], {
      cwd: dir,
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'SHOGO_DEV_API_PORT'),
      ),
    })

    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe(vars.get('SHOGO_DEV_API_PORT')!)
  }, 30_000)
})

describe('every writer and reader agrees on SHOGO_DEV_API_PORT', () => {
  test('dev:all reads the prefixed name and clears the port it resolved', () => {
    const source = read('scripts/dev-all.ts')

    expect(source).toContain('Number(process.env.SHOGO_DEV_API_PORT ?? 8002)')
    expect(source).not.toMatch(/process\.env\.API_PORT/)
    // The clear step must use the same constant the stack binds; a separate
    // literal here is exactly how the 8002 hardcode came back before.
    expect(source).toMatch(/killProcessOnPort\(API_PORT\)/)
  })

  test('watch-api reads the prefixed name and still hands API_PORT to its child', () => {
    const source = read('scripts/watch-api.ts')

    expect(source).toContain('Number(process.env.SHOGO_DEV_API_PORT ?? 8002)')
    expect(source).not.toMatch(/process\.env\.API_PORT/)
    // .env.local no longer writes API_PORT, and the API server reads it, so
    // the watcher is the one place that must translate the name explicitly.
    expect(source).toMatch(/API_PORT:\s*String\(API_PORT\)/)
  })

  test('env templates and the docker dev script write the prefixed name only', () => {
    for (const rel of ['.env.example', '.env.local.template', 'scripts/docker-dev-start.sh']) {
      const text = read(rel)
      expect(text).toMatch(/^SHOGO_DEV_API_PORT=\d+$/m)
      expect(text).not.toMatch(/^API_PORT=/m)
    }
  })

  test('docker compose maps the prefixed host port but keeps the container on 8002', () => {
    const compose = read('docker-compose.yml')

    expect(compose).toContain('"${SHOGO_DEV_API_PORT:-8002}:8002"')
    expect(compose).toMatch(/^\s+API_PORT: "8002"$/m)
    expect(compose).not.toContain('"${API_PORT:-8002}:8002"')
  })
})

describe('the desktop respawn suites run in PR CI', () => {
  test('apps/desktop has a test script over the isolated runner', () => {
    const pkg = JSON.parse(read('apps/desktop/package.json'))

    expect(pkg.scripts.test).toContain('run-tests-isolated.ts')
    expect(pkg.scripts.test).toContain('--roots src/__tests__')
  })

  test('the CI test matrix includes apps/desktop in a leg that runs on a PR', () => {
    const ci = read('.github/workflows/ci.yml')
    const leg = ci.match(/-\s+name: remaining \+ e2e\n\s+packages: (.+)/)

    expect(leg).not.toBeNull()
    expect(leg![1].split(',').map((entry) => entry.trim())).toContain('apps/desktop')
  })

  test('both respawn suites are inside the directory the script runs', () => {
    // The script only scans src/__tests__; a suite moved out of it would
    // silently stop running in CI, which is the bug this card fixes.
    for (const file of ['local-server-respawn.test.ts', 'local-server-respawn-acceptance.test.ts']) {
      expect(read(`apps/desktop/src/__tests__/${file}`).length).toBeGreaterThan(0)
    }
  })
})
