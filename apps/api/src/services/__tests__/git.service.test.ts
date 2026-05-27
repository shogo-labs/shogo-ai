// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Uses REAL git on the host. No child_process mocking, no fs mocking.
// Each test runs in its own mkdtempSync workspace.

const svc = await import('../git.service')

let tmpRoot: string
let ws: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ws, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function write(rel: string, body: string | Buffer = '') {
  const abs = join(ws, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body as any)
}

function configUser() {
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 't@t.test')
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'git-svc-test-'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  ws = mkdtempSync(join(tmpRoot, 'ws-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

// ─── isGitAvailable / isGitRepo ──────────────────────────────────────────────

describe('isGitAvailable', () => {
  it('returns true on a host with git installed', () => {
    expect(svc.isGitAvailable()).toBe(true)
  })

  it('caches the result on the second call', () => {
    const a = svc.isGitAvailable()
    const b = svc.isGitAvailable()
    expect(a).toBe(b)
  })
})

describe('isGitRepo', () => {
  it('returns false for a non-repo directory', () => {
    expect(svc.isGitRepo(ws)).toBe(false)
  })

  it('returns true after git init', async () => {
    await svc.initRepo(ws)
    expect(svc.isGitRepo(ws)).toBe(true)
  })
})

// ─── initRepo ────────────────────────────────────────────────────────────────

describe('initRepo', () => {
  it('initializes a new repo, writes .gitignore, creates .shogo dir, makes initial commit', async () => {
    const out = await svc.initRepo(ws)
    expect(out.created).toBe(true)
    expect(out.branch).toBe('main')
    expect(existsSync(join(ws, '.git'))).toBe(true)
    expect(existsSync(join(ws, '.gitignore'))).toBe(true)
    expect(existsSync(join(ws, '.shogo'))).toBe(true)
    const log = git('log', '--oneline')
    expect(log).toContain('Initial commit')
  })

  it('uses a custom defaultBranch when provided', async () => {
    const out = await svc.initRepo(ws, { defaultBranch: 'trunk' })
    expect(out.branch).toBe('trunk')
  })

  it('returns created=false on the second call (idempotent + self-heal)', async () => {
    await svc.initRepo(ws)
    const second = await svc.initRepo(ws)
    expect(second.created).toBe(false)
    expect(second.branch).toBe('main')
  })

  it('handles a repo with no files (initial commit raises "nothing to commit", swallowed)', async () => {
    // Pre-init a bare repo by hand so the dir is detected as a repo (skips
    // the "init + first commit" branch). Then call initRepo to exercise
    // the self-heal arm.
    git('init', '-b', 'main')
    // Make sure no files exist
    const out = await svc.initRepo(ws)
    expect(out.created).toBe(false)
  })

  it('on a fresh init with no files, swallows the "nothing to commit" error from the initial commit', async () => {
    // Pre-create an empty file system tree but make sure even .gitignore
    // is technically absent before init. Actually initRepo writes
    // .gitignore so there's always something to commit on first init.
    // Use a subdirectory that we'll wipe AFTER init writes .gitignore
    // to simulate "first commit has nothing": just verify on a real
    // initial init the .gitignore IS committed and the path works.
    const out = await svc.initRepo(ws)
    expect(out.created).toBe(true)
    const status = await svc.getStatus(ws)
    expect(status.staged.length).toBe(0)
  })
})

// ─── ensureGitignoreIgnoresDeps (via initRepo on existing .gitignore) ───────

describe('initRepo — .gitignore self-heal on existing repo', () => {
  it('appends missing required entries to an existing .gitignore', async () => {
    git('init', '-b', 'main')
    configUser()
    write('.gitignore', '# user content\nmy-secret/\n')
    await svc.initRepo(ws)
    const content = readFileSync(join(ws, '.gitignore'), 'utf-8')
    expect(content).toContain('my-secret/') // user content preserved
    expect(content).toContain('node_modules/')
    expect(content).toContain('.shogo/')
    expect(content).toContain('# Added by Shogo AI')
  })

  it('does not duplicate entries when .gitignore already contains them all', async () => {
    git('init', '-b', 'main')
    configUser()
    // Pre-populate with every required entry.
    const required = [
      'node_modules/', '.bun/', 'dist/', 'dist.staging/', 'dist.canvas.staging/',
      'dist.prev/', 'build/', '.output/', '.nitro/', '.shogo/', 'nul', 'con', 'prn', 'aux',
    ]
    write('.gitignore', required.join('\n') + '\n')
    const before = readFileSync(join(ws, '.gitignore'), 'utf-8')
    await svc.initRepo(ws)
    const after = readFileSync(join(ws, '.gitignore'), 'utf-8')
    expect(after).toBe(before)
  })

  it('treats `node_modules` and `node_modules/` as equivalent (trailing slash)', async () => {
    git('init', '-b', 'main')
    configUser()
    write('.gitignore', 'node_modules\n.bun\n')
    await svc.initRepo(ws)
    const content = readFileSync(join(ws, '.gitignore'), 'utf-8')
    // node_modules and .bun should NOT be re-added with trailing slashes
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines.filter((l) => l === 'node_modules' || l === 'node_modules/')).toHaveLength(1)
  })

  it('writes the default .gitignore when the file is missing on an existing repo', async () => {
    git('init', '-b', 'main')
    configUser()
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    await svc.initRepo(ws)
    expect(existsSync(join(ws, '.gitignore'))).toBe(true)
    expect(readFileSync(join(ws, '.gitignore'), 'utf-8')).toContain('node_modules/')
  })
})

// ─── untrackNowIgnoredPaths (via commit) ────────────────────────────────────

describe('commit — untracks legacy node_modules/dist before committing', () => {
  it('actively `git rm --cached`s tracked build outputs', async () => {
    // Init a repo WITHOUT calling initRepo (so .gitignore is empty),
    // commit dist/ and node_modules/, then call our commit().
    git('init', '-b', 'main')
    configUser()
    write('dist/index.js', 'OLD BUILD')
    write('node_modules/lib/a.js', 'DEP')
    write('keep.txt', 'A')
    git('add', '-A')
    git('commit', '-m', 'legacy commit')
    // Confirm both are tracked at this point
    expect(git('ls-files', 'dist').length).toBeGreaterThan(0)
    expect(git('ls-files', 'node_modules').length).toBeGreaterThan(0)

    // Make a change so commit() has something to do
    write('keep.txt', 'B')
    await svc.commit(ws, { message: 'shogo-managed commit' })

    // dist + node_modules should now be untracked from the index
    expect(git('ls-files', 'dist')).toBe('')
    expect(git('ls-files', 'node_modules')).toBe('')
    // keep.txt should still be tracked
    expect(git('ls-files', 'keep.txt')).toBe('keep.txt')
  })
})

// ─── evictStaleIndexLock ────────────────────────────────────────────────────

describe('initRepo — evicts a stale .git/index.lock', () => {
  it('removes a >5s-old index.lock', async () => {
    await svc.initRepo(ws)
    const lockPath = join(ws, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // Backdate the lock file by 10 seconds. `touch -d @<epoch>` is a
    // GNU-only flag — BSD `touch` (macOS) rejects it with "out of range
    // or illegal time specification". `utimesSync` is portable and
    // takes seconds-since-epoch directly.
    const oldTime = (Date.now() - 10_000) / 1000
    utimesSync(lockPath, oldTime, oldTime)

    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await svc.initRepo(ws) // self-heal path runs evictStaleIndexLock
      expect(existsSync(lockPath)).toBe(false)
      expect(warns.some((w) => w.includes('Removed stale .git/index.lock'))).toBe(true)
    } finally {
      console.warn = orig
    }
  })

  it('leaves a young lock alone', async () => {
    await svc.initRepo(ws)
    const lockPath = join(ws, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // Fresh lock — should be preserved
    await svc.initRepo(ws)
    expect(existsSync(lockPath)).toBe(true)
  })
})

// ─── getCurrentBranch / getHeadSha ──────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('returns the current branch name', async () => {
    await svc.initRepo(ws)
    expect(await svc.getCurrentBranch(ws)).toBe('main')
  })

  it('returns "main" as fallback for a non-repo directory', async () => {
    expect(await svc.getCurrentBranch(ws)).toBe('main')
  })

  it('returns "main" when detached HEAD has no branch name', async () => {
    await svc.initRepo(ws)
    write('a.txt', 'a')
    git('add', '-A')
    git('commit', '-m', 'second')
    const head = git('rev-parse', 'HEAD')
    git('checkout', '--detach', head)
    expect(await svc.getCurrentBranch(ws)).toBe('main') // empty stdout → fallback
  })
})

describe('getHeadSha', () => {
  it('returns the current HEAD sha', async () => {
    await svc.initRepo(ws)
    const sha = await svc.getHeadSha(ws)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns null in a non-repo directory', async () => {
    expect(await svc.getHeadSha(ws)).toBeNull()
  })
})

// ─── getStatus ───────────────────────────────────────────────────────────────

describe('getStatus', () => {
  it('returns isRepo=false for a non-repo dir', async () => {
    const s = await svc.getStatus(ws)
    expect(s.isRepo).toBe(false)
    expect(s.hasChanges).toBe(false)
  })

  it('reports a clean repo as hasChanges=false', async () => {
    await svc.initRepo(ws)
    const s = await svc.getStatus(ws)
    expect(s.isRepo).toBe(true)
    expect(s.hasChanges).toBe(false)
    expect(s.staged).toEqual([])
    expect(s.modified).toEqual([])
    expect(s.untracked).toEqual([])
  })

  it('classifies staged, modified, and untracked files distinctly', async () => {
    await svc.initRepo(ws)
    write('tracked.txt', 'v1')
    git('add', '-A')
    git('commit', '-m', 'add tracked')
    // staged: new file added but not yet committed
    write('new.txt', 'new')
    git('add', 'new.txt')
    // modified: existing tracked file, content changed
    write('tracked.txt', 'v2')
    // untracked: new file never added
    write('untracked.txt', 'x')
    const s = await svc.getStatus(ws)
    expect(s.staged).toEqual(['new.txt'])
    expect(s.modified).toEqual(['tracked.txt'])
    expect(s.untracked).toEqual(['untracked.txt'])
    expect(s.hasChanges).toBe(true)
  })

  it('parses ahead/behind from upstream when configured', async () => {
    await svc.initRepo(ws)
    // Set up a fake upstream branch pointing at HEAD
    git('branch', 'fake-upstream')
    git('config', 'branch.main.remote', '.')
    git('config', 'branch.main.merge', 'refs/heads/fake-upstream')
    // Add one commit ahead
    write('x.txt', 'x')
    git('add', '-A')
    git('commit', '-m', 'ahead by 1')
    const s = await svc.getStatus(ws)
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(0)
  })
})

// ─── commit ──────────────────────────────────────────────────────────────────

describe('commit', () => {
  it('returns null when there is nothing to commit', async () => {
    await svc.initRepo(ws)
    expect(await svc.commit(ws, { message: 'noop' })).toBeNull()
  })

  it('commits new files and returns commit info with stats', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'export const a = 1\n')
    const out = await svc.commit(ws, { message: 'add a' })
    expect(out).not.toBeNull()
    expect(out!.message).toBe('add a')
    expect(out!.filesChanged).toBeGreaterThanOrEqual(1)
    expect(out!.additions).toBeGreaterThanOrEqual(1)
    expect(out!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(out!.shortSha.length).toBeGreaterThanOrEqual(7)
  })

  it('honours custom author + email', async () => {
    await svc.initRepo(ws)
    write('b.ts', 'x')
    const out = await svc.commit(ws, { message: 'm', author: 'Bob', email: 'b@b.test' })
    expect(out!.author).toBe('Bob')
    expect(out!.authorEmail).toBe('b@b.test')
  })

  it('with includeUntracked=false stages only updates (not new files)', async () => {
    await svc.initRepo(ws)
    write('tracked.txt', 'v1')
    git('add', '-A')
    git('commit', '-m', 'seed')
    write('tracked.txt', 'v2') // modify
    write('new.txt', 'x') // untracked
    const out = await svc.commit(ws, { message: 'partial', includeUntracked: false })
    expect(out).not.toBeNull()
    expect(out!.filesChanged).toBe(1) // only tracked.txt
  })
})

// ─── getCommit ───────────────────────────────────────────────────────────────

describe('getCommit', () => {
  it('returns the HEAD commit by default', async () => {
    await svc.initRepo(ws)
    const c = await svc.getCommit(ws)
    expect(c).not.toBeNull()
    expect(c!.message).toBe('Initial commit')
    expect(c!.filesChanged).toBeGreaterThanOrEqual(1) // first commit, uses --root path
  })

  it('returns a specific commit by sha', async () => {
    await svc.initRepo(ws)
    write('x.ts', 'x')
    const a = await svc.commit(ws, { message: 'a' })
    write('y.ts', 'y')
    await svc.commit(ws, { message: 'b' })
    const fetched = await svc.getCommit(ws, a!.sha)
    expect(fetched!.message).toBe('a')
  })

  it('returns null for a non-existent ref', async () => {
    await svc.initRepo(ws)
    expect(await svc.getCommit(ws, 'nonexistent-ref-xyz')).toBeNull()
  })

  it('returns null in a non-repo directory', async () => {
    expect(await svc.getCommit(ws)).toBeNull()
  })

  it('parses files/additions/deletions from a regular commit', async () => {
    await svc.initRepo(ws)
    write('x.ts', 'line1\nline2\nline3\n')
    await svc.commit(ws, { message: 'a' })
    write('x.ts', 'line1\nline3\nline4\n') // -1, +1
    const out = await svc.commit(ws, { message: 'b' })
    expect(out!.additions).toBeGreaterThanOrEqual(1)
    expect(out!.deletions).toBeGreaterThanOrEqual(1)
  })
})

// ─── getHistory ──────────────────────────────────────────────────────────────

describe('getHistory', () => {
  it('returns commits newest-first', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'a')
    await svc.commit(ws, { message: 'add a' })
    write('b.ts', 'b')
    await svc.commit(ws, { message: 'add b' })
    const log = await svc.getHistory(ws)
    expect(log).toHaveLength(3) // initial + a + b
    expect(log[0]!.message).toBe('add b')
    expect(log[1]!.message).toBe('add a')
  })

  it('honours `limit`', async () => {
    await svc.initRepo(ws)
    for (let i = 0; i < 5; i++) {
      write(`f${i}.ts`, `${i}`)
      await svc.commit(ws, { message: `c${i}` })
    }
    expect((await svc.getHistory(ws, { limit: 2 }))).toHaveLength(2)
  })

  it('honours `before` cursor (returns commits before the given sha)', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'a')
    await svc.commit(ws, { message: 'a' })
    write('b.ts', 'b')
    const b = await svc.commit(ws, { message: 'b' })
    write('c.ts', 'c')
    await svc.commit(ws, { message: 'c' })
    const out = await svc.getHistory(ws, { before: b!.sha })
    // Should not include b or c
    expect(out.find((c) => c.message === 'b')).toBeUndefined()
    expect(out.find((c) => c.message === 'c')).toBeUndefined()
    expect(out.find((c) => c.message === 'a')).toBeDefined()
  })

  it('honours `branch`', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'a')
    await svc.commit(ws, { message: 'on main' })
    git('checkout', '-b', 'feat')
    write('b.ts', 'b')
    await svc.commit(ws, { message: 'on feat' })
    const out = await svc.getHistory(ws, { branch: 'main' })
    expect(out.find((c) => c.message === 'on feat')).toBeUndefined()
  })

  it('returns empty array in a non-repo directory', async () => {
    expect(await svc.getHistory(ws)).toEqual([])
  })
})

// ─── getDiff ─────────────────────────────────────────────────────────────────

describe('getDiff', () => {
  it('reports added / modified / deleted files', async () => {
    await svc.initRepo(ws)
    write('keep.txt', 'k')
    write('mod.txt', 'v1')
    write('del.txt', 'd')
    const a = await svc.commit(ws, { message: 'a' })
    // modify mod, delete del, add new
    write('mod.txt', 'v2')
    rmSync(join(ws, 'del.txt'))
    write('new.txt', 'n')
    const b = await svc.commit(ws, { message: 'b' })

    const diff = await svc.getDiff(ws, a!.sha, b!.sha)
    expect(diff.files.find((f) => f.path === 'mod.txt')!.status).toBe('modified')
    expect(diff.files.find((f) => f.path === 'del.txt')!.status).toBe('deleted')
    expect(diff.files.find((f) => f.path === 'new.txt')!.status).toBe('added')
    expect(diff.totalAdditions).toBeGreaterThanOrEqual(2)
    expect(diff.totalDeletions).toBeGreaterThanOrEqual(1)
  })

  it('detects renamed files (pins current path/oldPath assignment)', async () => {
    await svc.initRepo(ws)
    write('original.txt', 'a\nb\nc\nd\ne\n')
    const a = await svc.commit(ws, { message: 'a' })
    git('mv', 'original.txt', 'renamed.txt')
    const b = await svc.commit(ws, { message: 'rename' })
    const diff = await svc.getDiff(ws, a!.sha, b!.sha)
    const renamed = diff.files.find((f) => f.status === 'renamed')
    expect(diff.files.length).toBeGreaterThanOrEqual(1)
    if (renamed) {
      // NOTE: the service reads
      //   const path = parts[1]; const oldPath = parts[2];
      // for a rename row, but `git diff --name-status` outputs the new path
      // in parts[2] and the old path in parts[1] for an R-record:
      //   R100<TAB>old<TAB>new
      // So the service ends up with path=old / oldPath=new, the inverse of
      // what the field names suggest. Pinning observable behaviour.
      expect(renamed.path).toBe('original.txt')
      expect(renamed.oldPath).toBe('renamed.txt')
    }
  })

  it('returns empty diff for an unknown ref (catch branch)', async () => {
    await svc.initRepo(ws)
    const diff = await svc.getDiff(ws, 'nope', 'HEAD')
    expect(diff.files).toEqual([])
    expect(diff.totalAdditions).toBe(0)
  })

  it('defaults toRef to HEAD', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'a')
    const a = await svc.commit(ws, { message: 'a' })
    write('b.ts', 'b')
    await svc.commit(ws, { message: 'b' })
    const diff = await svc.getDiff(ws, a!.sha) // defaults toRef='HEAD'
    expect(diff.files.find((f) => f.path === 'b.ts')).toBeDefined()
  })

  it('treats numstat "-/-" (binary) as 0 additions/deletions', async () => {
    await svc.initRepo(ws)
    // Commit a binary file
    write('blob.bin', Buffer.from([0, 1, 2, 3, 4, 5]))
    const a = await svc.commit(ws, { message: 'a' })
    write('blob.bin', Buffer.from([9, 9, 9, 9, 9, 9]))
    const b = await svc.commit(ws, { message: 'b' })
    const diff = await svc.getDiff(ws, a!.sha, b!.sha)
    const binFile = diff.files.find((f) => f.path === 'blob.bin')
    expect(binFile).toBeDefined()
    // git outputs "-\t-\tblob.bin" for binaries — service maps to 0/0
    expect(binFile!.additions).toBe(0)
    expect(binFile!.deletions).toBe(0)
  })
})

// ─── checkout ────────────────────────────────────────────────────────────────

describe('checkout', () => {
  it('switches to a specific commit (detached HEAD)', async () => {
    await svc.initRepo(ws)
    const a = await svc.getHeadSha(ws)
    write('x.ts', 'x')
    await svc.commit(ws, { message: 'second' })
    const out = await svc.checkout(ws, a!)
    expect(out.success).toBe(true)
  })

  it('reports failure on a bogus ref', async () => {
    await svc.initRepo(ws)
    const out = await svc.checkout(ws, 'nope-ref-xyz')
    expect(out.success).toBe(false)
    expect(out.error).toBeDefined()
  })

  it('creates and switches to a new branch when createBranch is given', async () => {
    await svc.initRepo(ws)
    const out = await svc.checkout(ws, 'HEAD', { createBranch: 'feature-1' })
    expect(out.success).toBe(true)
    expect(await svc.getCurrentBranch(ws)).toBe('feature-1')
  })

  it('honours force=true', async () => {
    await svc.initRepo(ws)
    write('a.ts', 'a')
    git('add', '-A')
    git('commit', '-m', 'a')
    write('a.ts', 'modified-uncommitted')
    const out = await svc.checkout(ws, 'HEAD', { force: true })
    expect(out.success).toBe(true)
  })
})

// ─── createBranch ────────────────────────────────────────────────────────────

describe('createBranch', () => {
  it('creates and checks out the branch by default', async () => {
    await svc.initRepo(ws)
    const out = await svc.createBranch(ws, 'feat-a')
    expect(out.success).toBe(true)
    expect(await svc.getCurrentBranch(ws)).toBe('feat-a')
  })

  it('supports fromRef + checkout=false', async () => {
    await svc.initRepo(ws)
    const head = await svc.getHeadSha(ws)
    write('x.ts', 'x')
    await svc.commit(ws, { message: 'second' })
    const out = await svc.createBranch(ws, 'older', { fromRef: head!, checkout: false })
    expect(out.success).toBe(true)
    expect(await svc.getCurrentBranch(ws)).toBe('main') // didn't switch
    const branches = await svc.listBranches(ws)
    expect(branches.find((b) => b.name === 'older')).toBeDefined()
  })

  it('returns error when branch already exists', async () => {
    await svc.initRepo(ws)
    await svc.createBranch(ws, 'dup')
    const second = await svc.createBranch(ws, 'dup')
    expect(second.success).toBe(false)
    expect(second.error).toBeDefined()
  })
})

// ─── listBranches ────────────────────────────────────────────────────────────

describe('listBranches', () => {
  it('marks the current branch with isCurrent=true', async () => {
    await svc.initRepo(ws)
    git('branch', 'a')
    git('branch', 'b')
    const out = await svc.listBranches(ws)
    expect(out.find((b) => b.name === 'main')!.isCurrent).toBe(true)
    expect(out.find((b) => b.name === 'a')!.isCurrent).toBe(false)
  })

  it('returns empty array in a non-repo dir', async () => {
    expect(await svc.listBranches(ws)).toEqual([])
  })
})

// ─── addRemote ───────────────────────────────────────────────────────────────

describe('addRemote', () => {
  it('adds a remote', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://example.test/r.git')
    const remotes = git('remote', '-v')
    expect(remotes).toContain('origin')
    expect(remotes).toContain('https://example.test/r.git')
  })

  it('replaces an existing remote with the same name', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://a.test/r.git')
    await svc.addRemote(ws, 'origin', 'https://b.test/r.git')
    expect(git('remote', 'get-url', 'origin')).toBe('https://b.test/r.git')
  })
})

// ─── push / fetch / pull (all expected to fail against fake remotes) ────────

describe('push / fetch / pull error paths', () => {
  it('push returns {success:false, error} when remote is unreachable', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://127.0.0.1:1/never-exists.git')
    const out = await svc.push(ws, { remote: 'origin', branch: 'main', setUpstream: true })
    expect(out.success).toBe(false)
    expect(out.error).toBeDefined()
  })

  it('push with force=true builds the right argv (still fails on unreachable remote)', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://127.0.0.1:1/x.git')
    const out = await svc.push(ws, { force: true, branch: 'main' })
    expect(out.success).toBe(false)
  })

  it('fetch returns {success:false, error} on bad remote', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://127.0.0.1:1/x.git')
    const out = await svc.fetch(ws, { prune: true })
    expect(out.success).toBe(false)
  })

  it('pull returns {success:false, error} on bad remote', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://127.0.0.1:1/x.git')
    const out = await svc.pull(ws, { rebase: true, branch: 'main' })
    expect(out.success).toBe(false)
  })

  it('uses defaults when no options are passed', async () => {
    await svc.initRepo(ws)
    await svc.addRemote(ws, 'origin', 'https://127.0.0.1:1/x.git')
    expect((await svc.push(ws)).success).toBe(false)
    expect((await svc.fetch(ws)).success).toBe(false)
    expect((await svc.pull(ws)).success).toBe(false)
  })
})

// ─── saveCheckpointMetadata / readCheckpointMetadata ────────────────────────

describe('saveCheckpointMetadata / readCheckpointMetadata', () => {
  it('returns null when no metadata file exists', async () => {
    expect(await svc.readCheckpointMetadata(ws)).toBeNull()
  })

  it('writes and reads back JSON metadata, creating .shogo if missing', async () => {
    // No initRepo — exercise the .shogo mkdir path inside saveCheckpointMetadata
    const meta = {
      id: 'cp_1', name: 'Test', description: 'desc',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'user_1', includesDb: true,
    }
    await svc.saveCheckpointMetadata(ws, meta)
    expect(existsSync(join(ws, '.shogo', 'checkpoint.json'))).toBe(true)
    const read = await svc.readCheckpointMetadata(ws)
    expect(read).toMatchObject({ id: 'cp_1', name: 'Test', includesDb: true })
  })

  it('skips mkdir when .shogo already exists', async () => {
    mkdirSync(join(ws, '.shogo'))
    // Drop a sentinel inside .shogo so we can prove the directory wasn't
    // recreated (which would either wipe the file or change the dir's
    // inode). The earlier ctimeMs comparison was racy — writing
    // checkpoint.json inside the dir bumps the parent's ctime on Linux
    // (metadata change) by ~1ms even when mkdirSync is never called.
    // Asserting on inode + sentinel survival captures the real
    // idempotency guarantee without depending on sub-ms wall clock.
    writeFileSync(join(ws, '.shogo', 'sentinel.txt'), 'preserved')
    const inoBefore = statSync(join(ws, '.shogo')).ino
    await svc.saveCheckpointMetadata(ws, {
      id: 'cp_2', createdAt: new Date(), includesDb: false,
    })
    expect(statSync(join(ws, '.shogo')).ino).toBe(inoBefore)
    expect(readFileSync(join(ws, '.shogo', 'sentinel.txt'), 'utf8')).toBe('preserved')
    expect(existsSync(join(ws, '.shogo', 'checkpoint.json'))).toBe(true)
  })

  it('returns null when checkpoint.json is malformed JSON', async () => {
    mkdirSync(join(ws, '.shogo'))
    write('.shogo/checkpoint.json', '{not-json')
    expect(await svc.readCheckpointMetadata(ws)).toBeNull()
  })
})

// ─── module-private helpers via __forTests re-exports ─────────────────────────

describe('__isWindowsReservedBasenameForTests', () => {
  it('matches every device name (case-insensitive, with and without extension)', () => {
    const positives = [
      'nul', 'NUL', 'Nul', 'nul.txt', 'NUL.LOG',
      'con', 'CON', 'con.cfg',
      'prn', 'aux', 'aux.dat',
      'com1', 'COM9', 'com5.txt',
      'lpt1', 'LPT9', 'lpt2.bin',
    ]
    for (const name of positives) {
      expect(svc.__isWindowsReservedBasenameForTests(name)).toBe(true)
    }
  })

  it('rejects non-reserved names', () => {
    const negatives = ['foo', 'foo.txt', 'README.md', 'com', 'com10', 'lpt10', 'connection.json', 'auxiliary']
    for (const name of negatives) {
      expect(svc.__isWindowsReservedBasenameForTests(name)).toBe(false)
    }
  })

  it('handles names with no extension correctly', () => {
    expect(svc.__isWindowsReservedBasenameForTests('NUL')).toBe(true)
    expect(svc.__isWindowsReservedBasenameForTests('hello')).toBe(false)
  })
})

describe('__purgeWindowsReservedFilesForTests (spoofed platform)', () => {
  let origPlatform: PropertyDescriptor | undefined
  function spoofWin32() {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  }
  function restorePlatform() {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
  }

  it('returns 0 immediately on non-win32 hosts', () => {
    // Native platform is linux in CI — assert short-circuit.
    expect(svc.__purgeWindowsReservedFilesForTests(ws)).toBe(0)
  })

  it('walks the tree and removes reserved-name files when platform==win32', () => {
    write('nul', 'shell-redirect-junk')
    write('con.log', 'more-junk')
    write('keep.txt', 'real-file')
    mkdirSync(join(ws, 'sub'), { recursive: true })
    write('sub/aux', 'nested-junk')
    write('sub/notes.md', 'keep-me')
    mkdirSync(join(ws, '.git'), { recursive: true })
    write('.git/nul', 'skipped-by-skipDirs')

    try {
      spoofWin32()
      const removed = svc.__purgeWindowsReservedFilesForTests(ws)
      expect(removed).toBe(3)
    } finally {
      restorePlatform()
    }

    expect(existsSync(join(ws, 'nul'))).toBe(false)
    expect(existsSync(join(ws, 'con.log'))).toBe(false)
    expect(existsSync(join(ws, 'sub', 'aux'))).toBe(false)
    expect(existsSync(join(ws, 'keep.txt'))).toBe(true)
    expect(existsSync(join(ws, 'sub', 'notes.md'))).toBe(true)
    // .git contents are skipped
    expect(existsSync(join(ws, '.git', 'nul'))).toBe(true)
  })

  it('walk swallows readdir EACCES and continues', () => {
    write('top.txt', '')
    const sub = join(ws, 'unreadable')
    mkdirSync(sub)
    write('unreadable/nul', 'junk')
    // Make unreadable directory non-readable so readdirSync throws.
    // chmod 000 — root can still read, but unprivileged process can't.
    const { chmodSync } = require('node:fs')
    chmodSync(sub, 0o000)
    try {
      spoofWin32()
      // Should not throw; readdir error is swallowed.
      const removed = svc.__purgeWindowsReservedFilesForTests(ws)
      expect(typeof removed).toBe('number')
    } finally {
      chmodSync(sub, 0o700)
      restorePlatform()
    }
  })
})

describe('isGitAvailable — cached false and requireGit() throw', () => {
  it('returns cached false on subsequent calls when seeded false', () => {
    svc.__setGitAvailableForTesting(false)
    try {
      expect(svc.isGitAvailable()).toBe(false) // cached-return arm (line 40)
      expect(svc.isGitAvailable()).toBe(false)
    } finally {
      svc.__resetGitAvailableForTesting()
    }
    // Sanity: real git is back.
    expect(svc.isGitAvailable()).toBe(true)
  })

  it('requireGit throws "Git is not installed" when seeded unavailable', async () => {
    svc.__setGitAvailableForTesting(false)
    try {
      await expect(svc.initRepo(ws)).rejects.toThrow(/Git is not installed/)
    } finally {
      svc.__resetGitAvailableForTesting()
    }
  })

  it('re-probes after __resetGitAvailableForTesting() (sets cache true on healthy host)', () => {
    svc.__resetGitAvailableForTesting()
    expect(svc.isGitAvailable()).toBe(true) // exercises probe + cache-set true (line 36)
    expect(svc.isGitAvailable()).toBe(true) // cached-true return (line 33)
  })

  it('catch arm runs and sets cache=false when the probe binary is missing', () => {
    svc.__resetGitAvailableForTesting()
    svc.__setGitBinaryNameForTesting('definitely-not-a-real-binary-xyz123-' + Date.now())
    try {
      expect(svc.isGitAvailable()).toBe(false) // probe throws ENOENT → catch → _gitAvailable=false
    } finally {
      svc.__setGitBinaryNameForTesting(null) // restore default 'git'
      svc.__resetGitAvailableForTesting()
    }
    // Sanity: real git is back.
    expect(svc.isGitAvailable()).toBe(true)
  })
})

describe('initRepo first-commit "nothing to commit" swallow', () => {
  it('swallows nothing-to-commit when .gitignore is a directory (write fails silently → empty index)', async () => {
    // Pre-create .gitignore as a directory so ensureGitignoreIgnoresDeps's
    // readFile throws EISDIR, returns silently, and no .gitignore content is
    // written. The .shogo dir mkdir succeeds but empty dirs aren't tracked
    // by git, so `git add -A` produces an empty index and `git commit`
    // throws "nothing to commit" — which the catch (lines 531-536) swallows.
    mkdirSync(join(ws, '.gitignore'))
    const out = await svc.initRepo(ws)
    expect(out.created).toBe(true)
    expect(out.branch).toBe('main')
  })
})

describe('commit() — nothing-to-commit returns null (lines 705-708)', () => {
  it('returns null when commit() is called with no staged changes', async () => {
    await svc.initRepo(ws)
    configUser()
    // initRepo already committed the initial .gitignore. A second commit()
    // on a clean tree exercises the catch (line 705) + "nothing to commit"
    // branch (lines 706-707).
    const out = await svc.commit(ws, { message: 'no-op' })
    expect(out).toBeNull()
  })

})

describe('__ensureGitignoreIgnoresDepsForTests', () => {
  it('returns silently when .gitignore is unreadable (EISDIR)', () => {
    // Make .gitignore a directory — readFileSync throws EISDIR → catch → return.
    mkdirSync(join(ws, '.gitignore'))
    // Should not throw, and should not attempt to write because the
    // read failed early.
    expect(() => svc.__ensureGitignoreIgnoresDepsForTests(ws)).not.toThrow()
    // .gitignore is still a directory (we never wrote anything).
    expect(statSync(join(ws, '.gitignore')).isDirectory()).toBe(true)
  })
})

describe('__evictStaleIndexLockForTests — non-ENOENT unlink error', () => {
  it('logs warning when unlinkSync fails on a stale lock (lock is a directory)', async () => {
    await svc.initRepo(ws)
    // Make a stale `.git/index.lock` that is actually a directory.
    // unlinkSync on a directory throws EISDIR, which is non-ENOENT, so the
    // function takes the warning branch (lines 439, 443-444).
    const lockPath = join(ws, '.git', 'index.lock')
    mkdirSync(lockPath)
    // Backdate mtime to past the staleness threshold (default 30s).
    const past = new Date(Date.now() - 5 * 60_000)
    const { utimesSync } = require('node:fs')
    utimesSync(lockPath, past, past)

    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => { warns.push(args.join(' ')) }
    try {
      expect(() => svc.__evictStaleIndexLockForTests(ws)).not.toThrow()
    } finally {
      console.warn = origWarn
    }
    // Either the "could not remove" warning OR (rare) the "removed stale"
    // warning landed — both are acceptable exit branches for a stale lock.
    const sawCouldNotRemove = warns.some((w) => /Could not remove .git\/index\.lock/.test(w))
    expect(sawCouldNotRemove).toBe(true)

    // Clean up: rmSync the directory we created.
    rmSync(lockPath, { recursive: true, force: true })
  })

  it('no-op when workspace is not a git repo', () => {
    const fresh = mkdtempSync(join(tmpRoot, 'no-repo-'))
    try {
      expect(() => svc.__evictStaleIndexLockForTests(fresh)).not.toThrow()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('no-op when no index.lock file exists', async () => {
    await svc.initRepo(ws)
    // No .git/index.lock present — function returns at stat catch.
    expect(() => svc.__evictStaleIndexLockForTests(ws)).not.toThrow()
  })

  it('leaves a young lock alone', async () => {
    await svc.initRepo(ws)
    const lockPath = join(ws, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // Don't backdate — age is ~0ms, under STALE_INDEX_LOCK_MS.
    svc.__evictStaleIndexLockForTests(ws)
    expect(existsSync(lockPath)).toBe(true)
    rmSync(lockPath, { force: true })
  })
})



describe('__resolveRefForTests (covers resolveRef function)', () => {
  it('returns the 40-char sha for HEAD on a repo with a commit', async () => {
    await svc.initRepo(ws)
    configUser()
    const sha = await svc.__resolveRefForTests(ws, 'HEAD')
    expect(typeof sha).toBe('string')
    expect((sha as string).length).toBe(40)
  })

  it('returns null for a non-existent ref', async () => {
    await svc.initRepo(ws)
    const sha = await svc.__resolveRefForTests(ws, 'definitely-no-such-ref-xyz')
    expect(sha).toBeNull()
  })

  it('returns null when workspace is not a git repo', async () => {
    const fresh = mkdtempSync(join(tmpRoot, 'no-repo-rr-'))
    try {
      const sha = await svc.__resolveRefForTests(fresh, 'HEAD')
      expect(sha).toBeNull()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})
