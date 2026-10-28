// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `scripts/ci/app-code-changed.sh` decides whether a PR should run the
 * local-mode E2E matrix. It is a deny-list, so the interesting cases are the
 * ones it must NOT ignore (a new package, CI itself, an E2E spec) and the
 * fail-open one (an empty diff).
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '../ci/app-code-changed.sh')

function classify(paths: string[]) {
  const proc = Bun.spawnSync(['bash', SCRIPT], {
    stdin: new TextEncoder().encode(paths.length === 0 ? '' : `${paths.join('\n')}\n`),
    env: { PATH: process.env.PATH ?? '' },
  })
  return { app: proc.stdout.toString().trim(), code: proc.exitCode }
}

describe('app-code-changed.sh', () => {
  it('ignores a docs / markdown / non-CI-workflow diff', () => {
    const { app, code } = classify([
      'docs/getting-started.md',
      'apps/docs/src/pages/index.tsx',
      'README.md',
      'apps/api/CHANGELOG.md',
      '.github/workflows/deploy.yml',
      '.github/ISSUE_TEMPLATE/bug.yml',
      'plans/sho-104.md',
      '.githooks/pre-commit',
      'scripts/bench/project-open.ts',
      '.gitignore',
      'LICENSE',
    ])
    expect(app).toBe('app=false')
    expect(code).toBe(0)
  })

  it('counts app code, a new directory and the E2E suite itself', () => {
    for (const path of [
      'apps/api/src/server.ts',
      'packages/agent-runtime/src/path-boundary.ts',
      'e2e/local/chat-resume-on-send.test.ts',
      'e2e/local/playwright.config.ts',
      'apps/brand-new/package.json',
      'scripts/run-tests-isolated.ts',
    ]) {
      expect({ path, ...classify([path]) }.app).toBe('app=true')
    }
  })

  it('counts a docs diff as app code when one real file rides along', () => {
    expect(classify(['docs/a.md', 'apps/api/src/routes/runtime.ts']).app).toBe('app=true')
  })

  it('fails open on ci.yml itself', () => {
    expect(classify(['.github/workflows/ci.yml']).app).toBe('app=true')
  })

  // The phone workflow is the only job that runs the phone specs, so a PR that
  // edits it must still run them (SHO-222). Every other workflow stays ignored.
  it('fails open on e2e-phone.yml itself', () => {
    expect(classify(['.github/workflows/e2e-phone.yml']).app).toBe('app=true')
    expect(classify(['.github/workflows/e2e-phone.yml', 'docs/a.md']).app).toBe('app=true')
  })

  it('fails open on an empty diff', () => {
    expect(classify([]).app).toBe('app=true')
  })

  it('writes app= to $GITHUB_OUTPUT when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-code-changed-'))
    try {
      const out = join(dir, 'github-output')
      const proc = Bun.spawnSync(['bash', SCRIPT], {
        stdin: new TextEncoder().encode('docs/a.md\n'),
        env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out },
      })
      expect(proc.exitCode).toBe(0)
      expect(readFileSync(out, 'utf-8').trim()).toBe('app=false')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
