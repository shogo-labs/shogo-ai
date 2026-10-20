// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance gate for SHO-98 — commit attribution is enforced by tracked
 * code, not by a prompt.
 *
 * Every case drives *real* `git` processes in throwaway repositories whose
 * `core.hooksPath` points at this checkout's tracked `.githooks/` (exactly how
 * `bun install`'s `prepare` wires a fresh clone). Nothing about the hook, the
 * normalizer or the guard is mocked: the hooks are the thing under test.
 *
 * The last case is the one that keeps the guards from blocking the team: a
 * feature branch that has merged `main` still has to be pushable, because
 * `main` is authored by people.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOKS_PATH = join(REPO_ROOT, '.githooks')
const CANONICAL = 'Co-authored-by: Shogo Agent <agent@shogo.ai>'
const HUMAN = 'Russell LaCour <russelllacour@gmail.com>'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  tempDirs.push(dir)
  return dir
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  // The identity reaches git through the checkout config, never through the
  // agent's own environment — that is the path under test.
  delete out.SHOGO_AGENT_GIT_NAME
  delete out.SHOGO_AGENT_GIT_EMAIL
  delete out.GIT_AUTHOR_NAME
  delete out.GIT_AUTHOR_EMAIL
  delete out.GIT_COMMITTER_NAME
  delete out.GIT_COMMITTER_EMAIL
  return { ...out, ...overrides }
}

type Result = { code: number; stdout: string; stderr: string }

function run(cwd: string, args: string[], overrides: Record<string, string> = {}): Result {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: env(overrides),
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

function ok(cwd: string, args: string[], overrides: Record<string, string> = {}): string {
  const result = run(cwd, args, overrides)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** A repo wired to the real tracked hooks, like `prepare` leaves a clone. */
function repo(email: string, name: string, hooks = true): string {
  const dir = tempDir('sho98')
  ok(dir, ['init', '-q', '-b', 'main'])
  if (hooks) ok(dir, ['config', 'core.hooksPath', HOOKS_PATH])
  ok(dir, ['config', 'user.name', name])
  ok(dir, ['config', 'user.email', email])
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  ok(dir, ['add', '-A'])
  return dir
}

function bareRemote(): string {
  const dir = tempDir('sho98-remote')
  ok(dir, ['init', '-q', '--bare'])
  return dir
}

function message(dir: string): string {
  return ok(dir, ['log', '-1', '--format=%B'])
}

function canonicalCount(dir: string): number {
  return message(dir).split(CANONICAL).length - 1
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('SHO-98 acceptance — the hook is the enforcement point', () => {
  test('AC1: a plain `git commit -m` in an agent checkout is canonical, exactly once', () => {
    const dir = repo('agent@shogo.ai', 'Shogo Agent')
    expect(run(dir, ['commit', '-q', '-m', 'feat: plain commit']).code).toBe(0)

    expect(canonicalCount(dir)).toBe(1)
    expect(message(dir).trimEnd().endsWith(CANONICAL)).toBe(true)
    expect(ok(dir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Shogo Agent <agent@shogo.ai>')
    expect(ok(dir, ['log', '-1', '--format=%cn <%ce>']).trim()).toBe('Shogo Agent <agent@shogo.ai>')
  }, 30_000)

  test('AC2: a hand-written Shogo co-author is replaced and a human co-author survives', () => {
    const withWrong = repo('agent@shogo.ai', 'Shogo Agent')
    expect(
      run(withWrong, [
        'commit', '-q', '-m', 'fix: no gray avatar',
        '--trailer', 'Co-authored-by: Shogo Dev 2 <dev2@shogo.local>',
      ]).code,
    ).toBe(0)
    const wrong = message(withWrong)
    expect(wrong).not.toContain('dev2@shogo.local')
    expect(canonicalCount(withWrong)).toBe(1)

    const withHuman = repo('agent@shogo.ai', 'Shogo Agent')
    expect(
      run(withHuman, ['commit', '-q', '-m', 'feat: pair', '--trailer', `Co-authored-by: ${HUMAN}`]).code,
    ).toBe(0)
    const paired = message(withHuman)
    expect(paired).toContain(`Co-authored-by: ${HUMAN}`)
    expect(canonicalCount(withHuman)).toBe(1)
    expect(paired.trimEnd().endsWith(CANONICAL)).toBe(true)
  }, 30_000)

  test('AC3+AC6: -F, bash -c and amend are attributed; a bad identity is refused', () => {
    const fromFile = repo('agent@shogo.ai', 'Shogo Agent')
    writeFileSync(
      join(fromFile, 'msg.txt'),
      'chore: from a file\n\nA body paragraph.\n\nCo-authored-by: Shogo <noreply@shogo.ai>\n',
    )
    expect(run(fromFile, ['commit', '-q', '-F', join(fromFile, 'msg.txt')]).code).toBe(0)
    expect(message(fromFile)).not.toContain('noreply@shogo.ai')
    expect(message(fromFile)).toContain('A body paragraph.')
    expect(canonicalCount(fromFile)).toBe(1)

    const fromScript = repo('agent@shogo.ai', 'Shogo Agent')
    execFileSync('bash', ['-c', 'git commit -q -m "chore: from a script"'], {
      cwd: fromScript,
      encoding: 'utf-8',
      env: env(),
    })
    expect(canonicalCount(fromScript)).toBe(1)

    const amended = repo('agent@shogo.ai', 'Shogo Agent')
    ok(amended, ['commit', '-q', '-m', 'feat: amend me'])
    writeFileSync(join(amended, 'file.txt'), 'two\n')
    ok(amended, ['add', '-A'])
    ok(amended, ['commit', '-q', '--amend', '--no-edit'])
    expect(canonicalCount(amended)).toBe(1)

    for (const [label, args, overrides] of [
      ['--author', ['commit', '-q', '-m', 'x', '--author', 'Shogo Dev 2 <dev2@shogo.local>'], {}],
      ['GIT_AUTHOR_EMAIL', ['commit', '-q', '-m', 'x'], {
        GIT_AUTHOR_EMAIL: 'dev2@shogo.local',
        GIT_COMMITTER_EMAIL: 'dev2@shogo.local',
      }],
      ['-c user.email', ['-c', 'user.email=russelllacour@gmail.com', 'commit', '-q', '-m', 'x'], {}],
    ] as const) {
      const refused = repo('agent@shogo.ai', 'Shogo Agent')
      const result = run(refused, [...args], overrides)
      expect(`${label}: ${result.code}`).not.toBe(`${label}: 0`)
      expect(result.stderr).toContain('[pre-commit] Refusing to commit as')
      expect(result.stderr).toContain('agent@shogo.ai')
      expect(ok(refused, ['rev-list', '--count', '--all']).trim()).toBe('0')
    }
  }, 30_000)

  test('AC4: a human checkout is never refused and never gets a trailer', () => {
    const dir = repo('russelllacour@gmail.com', 'Russell LaCour')
    expect(run(dir, ['commit', '-q', '-m', 'docs: a human commit']).code).toBe(0)
    expect(message(dir).trim()).toBe('docs: a human commit')

    const remote = bareRemote()
    ok(dir, ['remote', 'add', 'origin', remote])
    expect(run(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/human']).code).toBe(0)
    expect(ok(remote, ['rev-parse', '--verify', 'refs/heads/human']).trim()).not.toBe('')
  }, 30_000)

  test('AC3b: a --no-verify commit with a wrong identity cannot leave the box', () => {
    const dir = repo('agent@shogo.ai', 'Shogo Agent')
    const remote = bareRemote()
    ok(dir, ['remote', 'add', 'origin', remote])

    ok(dir, ['commit', '-q', '-m', 'chore: attributed', '--no-verify'])
    writeFileSync(join(dir, 'file.txt'), 'two\n')
    ok(dir, ['add', '-A'])
    ok(dir, ['commit', '-q', '-m', 'chore: sneaky', '--no-verify'], {
      GIT_AUTHOR_EMAIL: 'dev2@shogo.local',
      GIT_COMMITTER_EMAIL: 'dev2@shogo.local',
    })

    const push = run(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/attribution'])
    expect(push.code).not.toBe(0)
    expect(push.stderr).toContain('[pre-push] Refusing to push')
    expect(ok(remote, ['for-each-ref']).trim()).toBe('')
  }, 30_000)

  test('AC7: a fresh clone is guarded by `prepare` alone — no hand-installed hooks', () => {
    // The hook must ship executable in the tracked tree, or a clone is inert.
    const mode = ok(REPO_ROOT, ['ls-files', '-s', '.githooks/commit-msg']).trim().split(/\s+/)[0]
    expect(mode).toBe('100755')
    expect(existsSync(HOOKS_PATH)).toBe(true)

    const cloneDir = tempDir('sho98-clone')
    ok(cloneDir, ['clone', '--shared', '--quiet', REPO_ROOT, join(cloneDir, 'c')])
    const clone = join(cloneDir, 'c')
    const beforePrepare = run(clone, ['config', '--get', 'core.hooksPath'])
    expect(beforePrepare.code === 0 ? beforePrepare.stdout.trim() : 'unset').toBe('unset')

    // `bun install` runs `prepare`; running that script is the whole wiring.
    execFileSync('bun', ['run', 'prepare'], { cwd: clone, encoding: 'utf-8', env: env() })
    expect(ok(clone, ['config', '--get', 'core.hooksPath']).trim()).toBe('.githooks')

    // The identity is installed by code (git-bootstrap / github-workspace-git).
    ok(clone, ['config', 'user.name', 'Shogo Agent'])
    ok(clone, ['config', 'user.email', 'agent@shogo.ai'])
    writeFileSync(join(clone, 'guard.txt'), 'x\n')
    ok(clone, ['add', 'guard.txt'])
    expect(run(clone, ['commit', '-q', '-m', 'chore: guarded from the first commit']).code).toBe(0)
    expect(canonicalCount(clone)).toBe(1)
  }, 30_000)

  test('call sites never write a caller-supplied co-author', async () => {
    const { withShogoCommitTrailer, normalizeAgentAttribution } = await import(
      '../../packages/shared-runtime/src/agent-attribution'
    )
    const plain = withShogoCommitTrailer(['commit', '-m', 'chore: x'])
    expect(plain).toContain('--trailer')
    expect(plain).toContain(CANONICAL)

    const repaired = withShogoCommitTrailer([
      'commit', '-m', 'chore: y\n\nCo-authored-by: Shogo Dev 2 <dev2@shogo.local>',
    ])
    expect(repaired.join(' ')).not.toContain('dev2@shogo.local')

    const twice = normalizeAgentAttribution('chore: z\n\nCo-authored-by: Shogo <noreply@shogo.ai>')
    expect(twice.changed).toBe(true)
    const again = normalizeAgentAttribution(twice.message)
    expect(again.changed).toBe(false)
    expect(again.message.split(CANONICAL).length - 1).toBe(1)
  }, 30_000)

  test('a branch that merged upstream human history is still pushable', () => {
    const remote = bareRemote()
    const agent = repo('agent@shogo.ai', 'Shogo Agent')
    ok(agent, ['remote', 'add', 'origin', remote])
    writeFileSync(join(agent, 'seed.txt'), 'seed\n')
    ok(agent, ['add', '-A'])
    ok(agent, ['commit', '-q', '-m', 'chore: seed'])
    ok(agent, ['push', '-q', 'origin', 'HEAD:refs/heads/trunk'])
    ok(agent, ['push', '-q', 'origin', 'HEAD:refs/heads/feature'])

    // A person's commit lands on upstream (in production that branch is `main`;
    // the guard keys off identity, not the branch name) from a plain clone with
    // no hooks installed.
    const humanDir = tempDir('sho98-human')
    ok(humanDir, ['clone', '--quiet', '--branch', 'trunk', remote, join(humanDir, 'h')])
    const human = join(humanDir, 'h')
    ok(human, ['config', 'user.name', 'Russell LaCour'])
    ok(human, ['config', 'user.email', 'russelllacour@gmail.com'])
    writeFileSync(join(human, 'human.txt'), 'h\n')
    ok(human, ['add', '-A'])
    ok(human, ['commit', '-q', '-m', 'feat: a person built this'])
    ok(human, ['push', '-q', 'origin', 'HEAD:refs/heads/trunk'])

    // The agent syncs main into its feature branch — the everyday flow.
    ok(agent, ['fetch', '-q', 'origin'])
    const merge = run(agent, ['merge', '-q', '--no-edit', 'origin/trunk'])
    expect(merge.code).toBe(0)

    const push = run(agent, ['push', '-q', 'origin', 'HEAD:refs/heads/feature'])
    expect(push.stderr).not.toContain('[pre-push] Refusing to push')
    expect(push.code).toBe(0)
    expect(ok(remote, ['rev-parse', 'refs/heads/feature']).trim()).toBe(
      ok(agent, ['rev-parse', 'HEAD']).trim(),
    )
  }, 30_000)
})
