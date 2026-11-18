// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `entrypoint.sh` is the first thing a container runs, so it decides whether a
 * standalone pod boots at all. Two things it must get right (SHO-421):
 *
 * 1. `SHOGO_STANDALONE` defaults `PROJECT_ID` **before** the guard. The
 *    `standalone` default in `src/server.ts` is only reached once the server
 *    starts, and the guard exits first — so the Quick start, the smoke script
 *    and the release `smoke` job all died on "PROJECT_ID environment variable
 *    is required".
 * 2. Standalone creates no `project/` child. The file tools and the default
 *    file API root at `$WORKSPACE_DIR`, and `?scope=project` resolves to the
 *    same folder, so `project/` would be an empty directory nothing reads.
 *
 * The script is run for real (not grepped) against a temp `WORKSPACE_DIR` and a
 * fake `bun` that reports the `PROJECT_ID` it was handed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ENTRYPOINT = resolve(import.meta.dir, '../../entrypoint.sh')

interface RunResult {
  exitCode: number
  output: string
  workspaceDir: string
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Run the entrypoint with exactly `env` — nothing inherited, so a
 * `SHOGO_STANDALONE` or `PROJECT_ID` in the test runner's own environment
 * cannot leak into a case.
 */
function runEntrypoint(env: Record<string, string>): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'sho-421-entrypoint-'))
  tempDirs.push(root)

  const bin = join(root, 'bin')
  const appDir = join(root, 'app')
  const workspaceDir = join(root, 'workspace')
  mkdirSync(bin, { recursive: true })
  mkdirSync(appDir, { recursive: true })

  // Fake bun: report the PROJECT_ID the entrypoint exported, then exit 0.
  const fakeBun = join(bin, 'bun')
  writeFileSync(fakeBun, '#!/bin/bash\necho "FAKE_BUN PROJECT_ID=${PROJECT_ID:-<unset>}"\nexit 0\n')
  chmodSync(fakeBun, 0o755)

  // `log_timing` uses `date +%s%3N`, which GNU date supports and BSD date does
  // not — without this shim the script dies on `set -e` on a macOS host.
  const fakeDate = join(bin, 'date')
  writeFileSync(
    fakeDate,
    '#!/bin/bash\nif [ "$1" = "+%s%3N" ]; then echo "$(( $(/bin/date +%s) * 1000 ))"; exit 0; fi\nexec /bin/date "$@"\n',
  )
  chmodSync(fakeDate, 0o755)

  // The real script `cd`s into the image's /app/packages/agent-runtime; point
  // that at the temp dir so a run never touches the checkout.
  const script = join(root, 'entrypoint.sh')
  const source = readFileSync(ENTRYPOINT, 'utf8')
  const rewritten = source.replace(/^cd \/app\/packages\/agent-runtime$/m, `cd ${appDir}`)
  expect(rewritten).not.toBe(source)
  writeFileSync(script, rewritten)
  chmodSync(script, 0o755)

  const proc = Bun.spawnSync(['bash', script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, WORKSPACE_DIR: workspaceDir, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return {
    exitCode: proc.exitCode ?? -1,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    workspaceDir,
  }
}

describe('entrypoint.sh in standalone mode', () => {
  test('defaults PROJECT_ID to standalone and creates no project/ folder', () => {
    const run = runEntrypoint({ SHOGO_STANDALONE: '1' })

    expect(run.exitCode).toBe(0)
    expect(run.output).toContain('FAKE_BUN PROJECT_ID=standalone')
    expect(run.output).toContain("defaulting PROJECT_ID to 'standalone'")
    expect(existsSync(join(run.workspaceDir, 'project'))).toBe(false)
    expect(existsSync(run.workspaceDir)).toBe(true)
  })

  test('keeps an explicit PROJECT_ID', () => {
    const run = runEntrypoint({ SHOGO_STANDALONE: '1', PROJECT_ID: 'odin' })

    expect(run.exitCode).toBe(0)
    expect(run.output).toContain('FAKE_BUN PROJECT_ID=odin')
    expect(run.output).not.toContain("defaulting PROJECT_ID to 'standalone'")
    expect(existsSync(join(run.workspaceDir, 'project'))).toBe(false)
  })

  test('accepts the same truthy values as isTruthyEnv()', () => {
    for (const value of ['true', 'TRUE', 'yes', 'on', ' 1 ']) {
      const run = runEntrypoint({ SHOGO_STANDALONE: value })
      expect(run.exitCode).toBe(0)
      expect(run.output).toContain('FAKE_BUN PROJECT_ID=standalone')
    }
  })

  test('a non-truthy SHOGO_STANDALONE is not standalone', () => {
    const run = runEntrypoint({ SHOGO_STANDALONE: '0', PROJECT_ID: 'odin' })

    expect(run.exitCode).toBe(0)
    expect(run.output).toContain('FAKE_BUN PROJECT_ID=odin')
    // Legacy single-project shape: the `project/` working dir is still created.
    expect(existsSync(join(run.workspaceDir, 'project'))).toBe(true)
  })
})

describe('entrypoint.sh outside standalone mode', () => {
  test('still refuses to boot without PROJECT_ID', () => {
    const run = runEntrypoint({})

    expect(run.exitCode).toBe(1)
    expect(run.output).toContain('ERROR: PROJECT_ID environment variable is required')
    expect(run.output).not.toContain('FAKE_BUN')
  })

  test('a single-project runtime keeps the legacy project/ working dir', () => {
    const run = runEntrypoint({ PROJECT_ID: 'odin' })

    expect(run.exitCode).toBe(0)
    expect(run.output).toContain('FAKE_BUN PROJECT_ID=odin')
    expect(existsSync(join(run.workspaceDir, 'project'))).toBe(true)
  })

  test('a workspace runtime needs no PROJECT_ID and creates no project/ folder', () => {
    const run = runEntrypoint({ WORKSPACE_RUNTIME: 'true', WORKSPACE_ID: 'ws-1' })

    expect(run.exitCode).toBe(0)
    expect(run.output).toContain('FAKE_BUN PROJECT_ID=<unset>')
    expect(existsSync(join(run.workspaceDir, 'project'))).toBe(false)
  })
})
