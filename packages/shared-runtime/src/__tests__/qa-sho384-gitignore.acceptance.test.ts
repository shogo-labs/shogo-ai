// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-384 acceptance — the bytes the encrypted store keeps are never in git.
 *
 * Destination in the repo: packages/shared-runtime/src/__tests__/qa-sho384-gitignore.acceptance.test.ts
 *
 * The card requires that the root `.env*` set survives a cold boot *and* that
 * "the bytes are never in git and never in a plaintext source tarball". A pod
 * commits its root with `git add -A` every turn, so that second half only holds
 * if DEFAULT_WORKSPACE_GITIGNORE ignores **every** name the shared secret rule
 * accepts. Both sides are read from the same modules the runtime uses: a name
 * one of them considers a secret and the other lets through is a plaintext
 * token in the durable repo.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { DEFAULT_WORKSPACE_GITIGNORE } from '../repo-store'
import { isWorkspaceSecretFile } from '../workspace-root-secrets'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(ignoreBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho384-git-'))
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, '.gitignore'), ignoreBody)
  return dir
}

/** Every `.env*` name an agent can plausibly drop at the workspace root. */
const SECRET_NAMES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.test',
  '.env.production.local',
]

describe('SHO-384: the default workspace gitignore covers the secret set', () => {
  test('every name the secret rule accepts is ignored, so `git add -A` stages none of them', () => {
    const dir = initRepo(DEFAULT_WORKSPACE_GITIGNORE)
    for (const name of SECRET_NAMES) {
      expect(isWorkspaceSecretFile(name)).toBe(true)
      writeFileSync(join(dir, name), 'SECRET=1\n')
    }
    writeFileSync(join(dir, 'src.ts'), 'export {}\n')

    git(dir, 'add', '-A')
    const staged = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
    expect(staged).toEqual(['.gitignore', 'src.ts'])
  })

  test('committed templates stay committable', () => {
    const dir = initRepo(DEFAULT_WORKSPACE_GITIGNORE)
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      expect(isWorkspaceSecretFile(name)).toBe(false)
      writeFileSync(join(dir, name), 'EXAMPLE=1\n')
    }
    git(dir, 'add', '-A')
    const staged = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
    expect(staged).toEqual(['.env.example', '.env.sample', '.env.template', '.gitignore'])
  })
})
