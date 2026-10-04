// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub connect / push / pull on a project workspace, against real git.
 * `https://github.com/` is rewritten to local bare repos via `url.insteadOf`
 * in a throwaway global gitconfig.
 *
 *   bun test packages/agent-runtime/src/__tests__/github-workspace-git.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detachMemberFromRootRepo,
  runGitHubWorkspaceOp,
  validateGitHubWorkspaceOpInput,
} from '../github-workspace-git'

const ROOT = '/tmp/test-github-workspace-git'
const REMOTES = join(ROOT, 'remotes')
const WS = join(ROOT, 'ws')
const TOKEN = 'ghp_secret_token_value'
const previousGlobal = process.env.GIT_CONFIG_GLOBAL

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }).trim()
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** Bare `octo/site.git` with one commit on main, plus a scratch clone to add commits. */
function makeRemote(): { seed: string; head: string } {
  const bare = join(REMOTES, 'octo', 'site.git')
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = join(ROOT, 'seed')
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'remote', 'add', 'origin', bare)
  const head = commitFile(seed, 'astro.config.mjs', 'export default {}\n', 'real site')
  git(seed, 'push', '-q', 'origin', 'main')
  return { seed, head }
}

const op = (o: 'connect' | 'push' | 'pull') => ({ op: o, repoOwner: 'octo', repoName: 'site', defaultBranch: 'main', token: TOKEN })

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  const gitconfig = join(ROOT, 'gitconfig')
  writeFileSync(gitconfig, `[url "${REMOTES}/"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = main\n`)
  process.env.GIT_CONFIG_GLOBAL = gitconfig
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = previousGlobal
})

describe('connect', () => {
  test('adopts the repo over an unrelated scaffold, keeping the scaffold (and unsaved files) on a backup branch', async () => {
    const { head } = makeRemote()
    git(WS, 'init', '-q', '-b', 'main')
    commitFile(WS, 'index.html', '<div id="root"></div>\n', 'scaffold')
    writeFileSync(join(WS, 'notes.md'), 'unsaved work\n')

    const result = await runGitHubWorkspaceOp(WS, op('connect'))

    expect(result).toMatchObject({ ok: true, connect: 'adopted', branch: 'main', sha: head })
    expect(git(WS, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(WS, 'astro.config.mjs'))).toBe(true)
    expect(existsSync(join(WS, 'index.html'))).toBe(false)
    expect(git(WS, 'show', `${result.backupBranch}:notes.md`)).toBe('unsaved work')
    expect(git(WS, 'show', `${result.backupBranch}:index.html`)).toBe('<div id="root"></div>')
    expect(git(WS, 'config', '--get', 'remote.origin.url')).toBe('https://github.com/octo/site.git')
    expect(readFileSync(join(WS, '.git', 'config'), 'utf8')).not.toContain(TOKEN)
    expect(git(WS, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
  })

  test('initializes an empty workspace from the repo', async () => {
    const { head } = makeRemote()
    const result = await runGitHubWorkspaceOp(WS, op('connect'))
    expect(result).toMatchObject({ ok: true, connect: 'adopted', sha: head })
    expect(result.backupBranch).toBeUndefined()
  })

  test('keeps local history that already contains the remote branch', async () => {
    makeRemote()
    git(WS, 'clone', '-q', 'https://github.com/octo/site.git', '.')
    const ahead = commitFile(WS, 'page.astro', '---\n---\n', 'local work')
    const result = await runGitHubWorkspaceOp(WS, op('connect'))
    expect(result).toMatchObject({ ok: true, connect: 'kept', sha: ahead })
    expect(git(WS, 'rev-parse', 'HEAD')).toBe(ahead)
  })

  test('changes nothing when local and remote have diverged', async () => {
    const { seed } = makeRemote()
    git(WS, 'clone', '-q', 'https://github.com/octo/site.git', '.')
    const local = commitFile(WS, 'a.txt', 'a\n', 'local')
    commitFile(seed, 'b.txt', 'b\n', 'remote')
    git(seed, 'push', '-q', 'origin', 'main')
    const result = await runGitHubWorkspaceOp(WS, op('connect'))
    expect(result.connect).toBe('diverged')
    expect(git(WS, 'rev-parse', 'HEAD')).toBe(local)
  })

  test('keeps local files when the remote repo is still empty', async () => {
    mkdirSync(join(REMOTES, 'octo', 'site.git'), { recursive: true })
    git(join(REMOTES, 'octo', 'site.git'), 'init', '-q', '--bare', '-b', 'main')
    git(WS, 'init', '-q', '-b', 'main')
    const local = commitFile(WS, 'index.html', 'x\n', 'scaffold')
    const result = await runGitHubWorkspaceOp(WS, op('connect'))
    expect(result).toMatchObject({ ok: true, connect: 'kept', sha: local })
  })
})

describe('push and pull', () => {
  test('push sends the current branch; pull rebases onto the default branch', async () => {
    const { seed } = makeRemote()
    await runGitHubWorkspaceOp(WS, op('connect'))

    const local = commitFile(WS, 'page.astro', '---\n---\n', 'local page')
    expect(await runGitHubWorkspaceOp(WS, op('push'))).toMatchObject({ ok: true, branch: 'main', sha: local })
    git(seed, 'pull', '-q', 'origin', 'main')
    expect(git(seed, 'rev-parse', 'HEAD')).toBe(local)

    const remote = commitFile(seed, 'remote.txt', 'r\n', 'remote change')
    git(seed, 'push', '-q', 'origin', 'main')
    expect(await runGitHubWorkspaceOp(WS, op('pull'))).toMatchObject({ ok: true, sha: remote, commits: 1 })
  })

  test('push commits pending edits first, and leaves Shogo runtime state out of the repo', async () => {
    const { seed } = makeRemote()
    await runGitHubWorkspaceOp(WS, op('connect'))
    writeFileSync(join(WS, 'edited.md'), 'agent edit\n')
    writeFileSync(join(WS, '.tech-stack'), 'custom')
    mkdirSync(join(WS, '.shogo', 'logs'), { recursive: true })
    writeFileSync(join(WS, '.shogo', 'logs', 'build.log'), 'log')
    writeFileSync(join(WS, '.shogo', 'build-output.json'), '{}')
    writeFileSync(join(WS, '.shogo', 'STACK.md'), '# stack docs')

    const result = await runGitHubWorkspaceOp(WS, op('push'))

    expect(result).toMatchObject({ ok: true, commits: 1 })
    git(seed, 'pull', '-q', 'origin', 'main')
    expect(readFileSync(join(seed, 'edited.md'), 'utf8')).toBe('agent edit\n')
    expect(existsSync(join(seed, '.shogo', 'STACK.md'))).toBe(true)
    for (const runtimeFile of ['.tech-stack', '.shogo/logs/build.log', '.shogo/build-output.json']) {
      expect(existsSync(join(seed, runtimeFile))).toBe(false)
    }
    expect(await runGitHubWorkspaceOp(WS, op('push'))).toMatchObject({ ok: true, commits: 0 })
  })

  test('pull keeps uncommitted edits', async () => {
    const { seed } = makeRemote()
    await runGitHubWorkspaceOp(WS, op('connect'))
    writeFileSync(join(WS, 'astro.config.mjs'), 'export default { local: true }\n')
    commitFile(seed, 'remote.txt', 'r\n', 'remote change')
    git(seed, 'push', '-q', 'origin', 'main')

    expect(await runGitHubWorkspaceOp(WS, op('pull'))).toMatchObject({ ok: true, commits: 1 })
    expect(readFileSync(join(WS, 'remote.txt'), 'utf8')).toBe('r\n')
    expect(readFileSync(join(WS, 'astro.config.mjs'), 'utf8')).toBe('export default { local: true }\n')
  })

  test('reports git failures without the token', async () => {
    git(WS, 'init', '-q', '-b', 'main')
    commitFile(WS, 'x.txt', 'x\n', 'x')
    git(WS, 'remote', 'add', 'origin', 'https://github.com/octo/missing.git')
    const result = await runGitHubWorkspaceOp(WS, op('push'))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/git (fetch|push) failed/)
    expect(result.error).not.toContain(TOKEN)
  })
})

describe('validation', () => {
  test('rejects unknown ops, malformed names, and a missing token', () => {
    expect(validateGitHubWorkspaceOpInput({ ...op('push'), op: 'clone' as any })).toContain('op')
    expect(validateGitHubWorkspaceOpInput({ ...op('push'), repoOwner: '-x' })).toContain('repoOwner')
    expect(validateGitHubWorkspaceOpInput({ ...op('push'), repoName: '../etc' })).toContain('repoName')
    expect(validateGitHubWorkspaceOpInput({ ...op('push'), defaultBranch: '--upload-pack=x' })).toContain('defaultBranch')
    expect(validateGitHubWorkspaceOpInput({ ...op('push'), token: '' })).toContain('token')
    expect(validateGitHubWorkspaceOpInput(op('connect'))).toBeNull()
  })
})

describe('detachMemberFromRootRepo', () => {
  test('stops the merged-root repo tracking a member that now has its own repository', async () => {
    const member = join(WS, 'proj-1')
    mkdirSync(member, { recursive: true })
    git(WS, 'init', '-q', '-b', 'main')
    writeFileSync(join(member, 'index.html'), 'x\n')
    git(WS, 'add', '-A')
    git(WS, 'commit', '-q', '-m', 'root')
    git(member, 'init', '-q', '-b', 'main')

    await detachMemberFromRootRepo(WS, member)
    await detachMemberFromRootRepo(WS, member)

    expect(readFileSync(join(WS, '.git', 'info', 'exclude'), 'utf8').match(/^\/proj-1\/$/gm)).toHaveLength(1)
    expect(git(WS, 'ls-files', 'proj-1')).toBe('')
    expect(existsSync(join(member, 'index.html'))).toBe(true)
    git(WS, 'add', '-A')
    expect(git(WS, 'ls-files', '--stage', 'proj-1')).toBe('')
  })
})
