// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tracked `.githooks/` are the enforcement point for commit attribution, so
 * these tests drive the real hooks with real `git` processes in throwaway
 * repositories: no mocks, no stubs of the thing under test.
 *
 * Each case builds a temp repo whose `core.hooksPath` is this checkout's
 * `.githooks/` — exactly how `bun install` (`prepare`) wires a fresh clone — and
 * then commits as an agent, as a wrong Shogo identity, or as a human.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOKS_PATH = join(REPO_ROOT, '.githooks')
const CANONICAL = 'Co-authored-by: Shogo Agent <agent@shogo.ai>'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function gitEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  // The agent identity reaches git through the checkout config in these tests,
  // never through inherited env — that is the path being tested.
  delete env.SHOGO_AGENT_GIT_NAME
  delete env.SHOGO_AGENT_GIT_EMAIL
  return env
}

function git(cwd: string, args: string[], overrides: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv(overrides) })
}

function gitResult(
  cwd: string,
  args: string[],
  overrides: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: gitEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error: any) {
    return {
      code: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    }
  }
}

/** A throwaway repo wired to the real tracked hooks, like `prepare` does. */
function repo(userEmail: string, userName = 'Shogo Agent'): string {
  const dir = tempDir('attribution')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'core.hooksPath', HOOKS_PATH])
  git(dir, ['config', 'user.name', userName])
  git(dir, ['config', 'user.email', userEmail])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(dir, ['add', '-A'])
  return dir
}

function commitMessage(dir: string): string {
  return git(dir, ['log', '-1', '--format=%B'])
}

function canonicalCount(message: string): number {
  return message.split(CANONICAL).length - 1
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('agent checkout', () => {
  test('a plain commit gets exactly one canonical co-author', () => {
    const dir = repo('agent@shogo.ai')
    const result = gitResult(dir, ['commit', '-q', '-m', 'fix(hooks): attribute every commit'])
    expect(result.code).toBe(0)

    const message = commitMessage(dir)
    expect(canonicalCount(message)).toBe(1)
    expect(message.trimEnd().endsWith(CANONICAL)).toBe(true)
    expect(git(dir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Shogo Agent <agent@shogo.ai>')
  })

  test('a hand-written wrong co-author is replaced, not joined by a second line', () => {
    const dir = repo('agent@shogo.ai')
    gitResult(dir, [
      'commit',
      '-q',
      '-m',
      'fix(hooks): drop the gray avatar',
      '--trailer',
      'Co-authored-by: Shogo Dev 2 <dev2@shogo.local>',
    ])

    const message = commitMessage(dir)
    expect(message).not.toContain('dev2@shogo.local')
    expect(message).not.toContain('noreply@shogo.ai')
    expect(canonicalCount(message)).toBe(1)
  })

  test('a message file (-F) and a script invocation are attributed too', () => {
    const dir = repo('agent@shogo.ai')
    const messageFile = join(dir, 'msg.txt')
    writeFileSync(messageFile, 'chore: from a file\n\nCo-authored-by: Shogo <noreply@shogo.ai>\n')
    git(dir, ['commit', '-q', '-F', messageFile])

    const fromFile = commitMessage(dir)
    expect(fromFile).not.toContain('noreply@shogo.ai')
    expect(canonicalCount(fromFile)).toBe(1)

    writeFileSync(join(dir, 'file.txt'), 'two\n')
    git(dir, ['add', '-A'])
    execFileSync('bash', ['-c', 'git commit -q -m "chore: from a script"'], {
      cwd: dir,
      encoding: 'utf-8',
      env: gitEnv(),
    })
    expect(canonicalCount(commitMessage(dir))).toBe(1)
  })

  test('refuses GIT_AUTHOR_EMAIL and --author that are not the agent identity', () => {
    const dir = repo('agent@shogo.ai')

    const envOverride = gitResult(dir, ['commit', '-q', '-m', 'x'], {
      GIT_AUTHOR_EMAIL: 'dev2@shogo.local',
      GIT_COMMITTER_EMAIL: 'dev2@shogo.local',
    })
    expect(envOverride.code).not.toBe(0)
    expect(envOverride.stderr).toContain('[pre-commit] Refusing to commit as')
    expect(envOverride.stderr).toContain('Shogo Agent <agent@shogo.ai>')

    const authorFlag = gitResult(dir, [
      'commit',
      '-q',
      '-m',
      'x',
      '--author',
      'Shogo Dev 2 <dev2@shogo.local>',
    ])
    expect(authorFlag.code).not.toBe(0)
    expect(authorFlag.stderr).toContain('dev2@shogo.local')

    const configOverride = gitResult(dir, [
      '-c',
      'user.email=russelllacour@gmail.com',
      'commit',
      '-q',
      '-m',
      'x',
    ])
    expect(configOverride.code).not.toBe(0)
    expect(configOverride.stderr).toContain('russelllacour@gmail.com')

    expect(git(dir, ['rev-list', '--count', '--all']).trim()).toBe('0')
  })

  test('refuses to push a --no-verify commit made with a wrong identity', () => {
    const dir = repo('agent@shogo.ai')
    const remote = tempDir('attribution-remote')
    git(remote, ['init', '-q', '--bare'])
    git(dir, ['remote', 'add', 'origin', remote])

    git(dir, ['commit', '-q', '-m', 'chore: attributed', '--no-verify'])
    expect(canonicalCount(commitMessage(dir))).toBe(0)

    writeFileSync(join(dir, 'file.txt'), 'two\n')
    git(dir, ['add', '-A'])
    const bad = gitResult(dir, ['commit', '-q', '-m', 'chore: unattributed', '--no-verify'], {
      GIT_AUTHOR_EMAIL: 'dev2@shogo.local',
      GIT_COMMITTER_EMAIL: 'dev2@shogo.local',
    })
    expect(bad.code).toBe(0)

    const push = gitResult(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/attribution-test'])
    expect(push.code).not.toBe(0)
    expect(push.stderr).toContain('[pre-push] Refusing to push')
    expect(git(remote, ['for-each-ref']).trim()).toBe('')
  })
})

describe('human checkout', () => {
  test('is never refused and never gets a trailer', () => {
    const dir = repo('russelllacour@gmail.com', 'Russell LaCour')

    const commit = gitResult(dir, ['commit', '-q', '-m', 'docs: a human commit'])
    expect(commit.code).toBe(0)
    expect(commitMessage(dir).trim()).toBe('docs: a human commit')

    writeFileSync(join(dir, 'file.txt'), 'two\n')
    git(dir, ['add', '-A'])
    const push = gitResult(dir, ['commit', '-q', '-m', 'docs: another'], {
      GIT_AUTHOR_EMAIL: 'russelllacour@gmail.com',
    })
    expect(push.code).toBe(0)
    expect(commitMessage(dir).trim()).toBe('docs: another')
  })
})
