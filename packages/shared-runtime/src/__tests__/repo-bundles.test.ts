// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for the incremental durable repo format (`repo-bundles.ts`).
 * Every test drives real git in temp directories; nothing is mocked.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  buildRepoBundle,
  materializeRepoFromBundles,
  needsCompaction,
  nextBundleChain,
  parseRepoManifest,
  readRepoSnapshotFields,
  RepoBundleError,
  REPO_MANIFEST_VERSION,
  type RepoManifest,
  type RepoManifestBundle,
} from '../repo-bundles'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

function tmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `repo-bundles-${label}-`))
}

function commitFile(repo: string, name: string, body: string, msg: string): string {
  writeFileSync(join(repo, name), body)
  git(repo, 'add', name)
  git(repo, 'commit', '-q', '-m', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

function newRepo(root: string): string {
  const repo = join(root, 'work')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'lfs.url', 'https://example.invalid/lfs')
  commitFile(repo, 'a.txt', 'a0\n', 'root')
  return repo
}

/** Fake transport: bundles live in a directory, fetched by sha like S3 would. */
function store(dir: string) {
  const bundles = new Map<string, string>()
  return {
    put(path: string, entry: RepoManifestBundle) {
      const dest = join(dir, `${entry.sha256}.bundle`)
      copyFileSync(path, dest)
      bundles.set(entry.sha256, dest)
    },
    fetch: async (entry: RepoManifestBundle) => {
      const p = bundles.get(entry.sha256)
      if (!p) throw new Error(`missing bundle ${entry.sha256}`)
      return p
    },
    drop(sha: string) {
      bundles.delete(sha)
    },
    replace(sha: string, path: string) {
      bundles.set(sha, path)
    },
  }
}

/** Build a manifest the way the writer will: bundle (if any) + snapshot fields. */
async function commitState(
  repo: string,
  work: string,
  prev: RepoManifest | null,
  objects: ReturnType<typeof store>,
): Promise<RepoManifest> {
  // The writer diffs against the tips the stored manifest recorded, not the live repo.
  const previousTips = prev ? Object.values(prev.refs) : null
  const built = await buildRepoBundle(repo, { previous: previousTips, workDir: work })
  const bundles = [...(prev?.bundles ?? [])]
  if (built) {
    objects.put(built.path, built.entry)
    // A new full base restarts the chain.
    if (built.entry.kind === 'base') bundles.length = 0
    bundles.push(built.entry)
  }
  const fields = await readRepoSnapshotFields(repo)
  return parseRepoManifest({
    v: REPO_MANIFEST_VERSION,
    head: fields.head,
    refs: fields.refs,
    config: fields.config,
    rootCommitAt: null,
    bundles,
  })
}

async function restore(manifest: RepoManifest, objects: ReturnType<typeof store>): Promise<string> {
  const dest = join(tmp('restore'), 'out')
  await materializeRepoFromBundles(dest, manifest, objects.fetch)
  return dest
}

describe('repo bundles: round trip', () => {
  test('full base restores refs, HEAD, config and history', async () => {
    const root = tmp('base')
    const repo = newRepo(root)
    git(repo, 'branch', 'feature')
    git(repo, 'tag', '-a', 'v1', '-m', 'annotated')
    git(repo, 'update-ref', 'refs/shogo/pre-hydrate/x', git(repo, 'rev-parse', 'HEAD'))
    const objects = store(tmp('objs'))

    const manifest = await commitState(repo, join(root, 'w'), null, objects)
    expect(manifest.bundles).toHaveLength(1)
    expect(manifest.bundles[0].kind).toBe('base')

    const restored = await restore(manifest, objects)
    expect(git(restored, 'rev-parse', 'refs/heads/main')).toBe(git(repo, 'rev-parse', 'refs/heads/main'))
    expect(git(restored, 'rev-parse', 'refs/shogo/pre-hydrate/x')).toBe(git(repo, 'rev-parse', 'HEAD'))
    expect(git(restored, 'cat-file', '-t', 'refs/tags/v1')).toBe('tag')
    expect(git(restored, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git(restored, 'config', '--get', 'lfs.url')).toBe('https://example.invalid/lfs')
    expect(git(restored, 'rev-list', '--count', 'HEAD')).toBe('1')
    // The import namespace must not leak into the restored repo.
    expect(git(restored, 'for-each-ref', 'refs/shogo-import/')).toBe('')
  })

  test('incremental adds only the new objects and restores the full history', async () => {
    const root = tmp('incr')
    const repo = newRepo(root)
    // Random bytes do not compress, so the base is genuinely large.
    const big = randomBytes(300_000).toString('hex') + '\n'
    commitFile(repo, 'big.txt', big, 'big')
    const objects = store(tmp('objs'))
    const work = join(root, 'w')

    const base = await commitState(repo, work, null, objects)
    commitFile(repo, 'small.txt', 'tiny\n', 'small change')
    const next = await commitState(repo, work, base, objects)

    expect(next.bundles.map((b) => b.kind)).toEqual(['base', 'incr'])
    expect(next.bundles[1].bytes).toBeLessThan(next.bundles[0].bytes / 10)

    const restored = await restore(next, objects)
    expect(git(restored, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
    expect(git(restored, 'rev-list', '--count', 'HEAD')).toBe('3')
    expect(git(restored, 'cat-file', '-p', 'HEAD:big.txt').length).toBe(big.length - 1)
  })

  test('detached HEAD round-trips as a sha', async () => {
    const root = tmp('detached')
    const repo = newRepo(root)
    const first = git(repo, 'rev-parse', 'HEAD')
    commitFile(repo, 'b.txt', 'b\n', 'second')
    git(repo, 'checkout', '-q', '--detach', first)
    const objects = store(tmp('objs'))

    const manifest = await commitState(repo, join(root, 'w'), null, objects)
    expect(manifest.head).toEqual({ sha: first })

    const restored = await restore(manifest, objects)
    expect(git(restored, 'rev-parse', 'HEAD')).toBe(first)
    expect(() => git(restored, 'symbolic-ref', '-q', 'HEAD')).toThrow()
  })

  test('restores a repo the head was force-reset behind (refs move backwards)', async () => {
    const root = tmp('reset')
    const repo = newRepo(root)
    const first = git(repo, 'rev-parse', 'HEAD')
    commitFile(repo, 'b.txt', 'b\n', 'second')
    const objects = store(tmp('objs'))
    const work = join(root, 'w')

    const base = await commitState(repo, work, null, objects)
    git(repo, 'reset', '-q', '--hard', first)
    // Previous tip still exists (reflog/objects), so this stays incremental-capable,
    // but the restored branch must point back at the older commit.
    const next = await commitState(repo, work, base, objects)
    const restored = await restore(next, objects)
    expect(git(restored, 'rev-parse', 'refs/heads/main')).toBe(first)
  })
})

describe('repo bundles: chain rules', () => {
  test('no new objects returns null, but manifest refs still move', async () => {
    const root = tmp('nothing')
    const repo = newRepo(root)
    const first = git(repo, 'rev-parse', 'HEAD')
    commitFile(repo, 'b.txt', 'b\n', 'second')
    const objects = store(tmp('objs'))
    const work = join(root, 'w')
    const base = await commitState(repo, work, null, objects)

    // Move the branch back; the commit it leaves behind is already in the chain.
    git(repo, 'branch', '-f', 'old', first)
    const built = await buildRepoBundle(repo, {
      previous: Object.values(base.refs),
      workDir: work,
    })
    expect(built).toBeNull()

    git(repo, 'update-ref', 'refs/heads/main', first)
    const next = await commitState(repo, work, base, objects)
    expect(next.bundles).toEqual(base.bundles)
    expect(next.refs['refs/heads/main']).toBe(first)
    const restored = await restore(next, objects)
    expect(git(restored, 'rev-parse', 'refs/heads/main')).toBe(first)
  })

  test('empty repo produces no bundle', async () => {
    const root = tmp('empty')
    const repo = join(root, 'work')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    const built = await buildRepoBundle(repo, { previous: null, workDir: join(root, 'w') })
    expect(built).toBeNull()
  })

  test('falls back to a full base when a previous tip is missing (rewritten history)', async () => {
    const root = tmp('rewrite')
    const repo = newRepo(root)
    commitFile(repo, 'b.txt', 'b\n', 'second')
    const objects = store(tmp('objs'))
    const work = join(root, 'w')
    const base = await commitState(repo, work, null, objects)

    // Pretend the chain recorded a tip the guest does not have.
    const ghost = 'f'.repeat(40)
    const built = await buildRepoBundle(repo, { previous: [ghost], workDir: work })
    expect(built?.entry.kind).toBe('base')
    expect(base.bundles[0].kind).toBe('base')
  })

  test('an incremental on top of a base restores when prerequisites are present', async () => {
    const root = tmp('prereq')
    const repo = newRepo(root)
    const objects = store(tmp('objs'))
    const work = join(root, 'w')
    const base = await commitState(repo, work, null, objects)
    commitFile(repo, 'b.txt', 'b\n', 'second')
    const next = await commitState(repo, work, base, objects)
    expect(next.bundles[1].kind).toBe('incr')
    const restored = await restore(next, objects)
    expect(git(restored, 'rev-list', '--count', 'HEAD')).toBe('2')
  })
})

describe('repo bundles: fail closed', () => {
  test('a bundle whose bytes changed fails its checksum and is not used', async () => {
    const root = tmp('corrupt')
    const repo = newRepo(root)
    const objects = store(tmp('objs'))
    const manifest = await commitState(repo, join(root, 'w'), null, objects)
    const entry = manifest.bundles[0]

    const bad = join(root, 'bad.bundle')
    const good = await objects.fetch(entry)
    const bytes = readFileSync(good)
    writeFileSync(bad, Buffer.concat([bytes, Buffer.from('junk')]))
    objects.replace(entry.sha256, bad)

    await expect(restore(manifest, objects)).rejects.toThrow(/checksum|bytes/)
  })

  test('a missing bundle fails the restore', async () => {
    const root = tmp('missing')
    const repo = newRepo(root)
    const objects = store(tmp('objs'))
    const manifest = await commitState(repo, join(root, 'w'), null, objects)
    objects.drop(manifest.bundles[0].sha256)
    await expect(restore(manifest, objects)).rejects.toThrow(/missing bundle/)
  })

  test('a ref the bundles do not supply fails the connectivity check', async () => {
    const root = tmp('dangling')
    const repo = newRepo(root)
    const objects = store(tmp('objs'))
    const manifest = await commitState(repo, join(root, 'w'), null, objects)
    const forged = parseRepoManifest({
      ...manifest,
      refs: { ...manifest.refs, 'refs/heads/ghost': 'e'.repeat(40) },
    })
    await expect(restore(forged, objects)).rejects.toThrow(RepoBundleError)
    expect(existsSync(join(root, 'nope'))).toBe(false)
  })
})

describe('repo bundles: chain bookkeeping', () => {
  const base = { sha256: 'a'.repeat(64), bytes: 10, kind: 'base' as const }
  const incr = { sha256: 'c'.repeat(64), bytes: 2, kind: 'incr' as const }

  test('a base restarts the chain', () => {
    expect(nextBundleChain([base, incr], base)).toEqual([base])
  })

  test('an incremental extends the chain', () => {
    expect(nextBundleChain([base], incr)).toEqual([base, incr])
  })

  test('no new bundle keeps the chain as it was', () => {
    expect(nextBundleChain([base, incr], null)).toEqual([base, incr])
    expect(nextBundleChain(null, null)).toEqual([])
  })
})

describe('repo bundles: compaction rule', () => {
  const b = (kind: 'base' | 'incr', bytes: number) => ({ sha256: 'd'.repeat(64), bytes, kind })

  test('a lone base never compacts', () => {
    expect(needsCompaction([b('base', 1_000_000)])).toBe(false)
  })

  test('small incrementals keep appending', () => {
    expect(needsCompaction([b('base', 1_000_000), b('incr', 100_000), b('incr', 100_000)])).toBe(false)
  })

  test('incrementals beyond a quarter of the base trigger a full base', () => {
    expect(needsCompaction([b('base', 1_000_000), b('incr', 200_000), b('incr', 100_000)])).toBe(true)
  })

  test('more than fifty bundles trigger a full base regardless of size', () => {
    const chain = [b('base', 1e9), ...Array.from({ length: 49 }, () => b('incr', 1))]
    expect(chain).toHaveLength(50)
    expect(needsCompaction(chain)).toBe(false)
    expect(needsCompaction([...chain, b('incr', 1)])).toBe(true)
  })
})

describe('repo bundles: manifest validation', () => {
  const valid = {
    v: REPO_MANIFEST_VERSION,
    head: { ref: 'refs/heads/main' },
    refs: { 'refs/heads/main': 'a'.repeat(40) },
    config: '[core]\n',
    rootCommitAt: 1,
    bundles: [{ sha256: 'b'.repeat(64), bytes: 10, kind: 'base' }],
  }

  test('accepts a well-formed manifest', () => {
    expect(parseRepoManifest(valid).bundles).toHaveLength(1)
  })

  test('rejects an unknown version', () => {
    expect(() => parseRepoManifest({ ...valid, v: 2 })).toThrow(/version/)
  })

  test('rejects a chain that does not start with a base', () => {
    expect(() => parseRepoManifest({ ...valid, bundles: [{ ...valid.bundles[0], kind: 'incr' }] })).toThrow(/must be base/)
  })

  test('rejects refs outside refs/ and non-hex object ids', () => {
    expect(() => parseRepoManifest({ ...valid, refs: { HEAD: 'a'.repeat(40) } })).toThrow(/outside refs/)
    expect(() => parseRepoManifest({ ...valid, refs: { 'refs/heads/x': 'zz' } })).toThrow(/object id/)
  })

  test('rejects refs with no bundles to supply them', () => {
    expect(() => parseRepoManifest({ ...valid, bundles: [] })).toThrow(/no bundles/)
  })

  test('readRepoSnapshotFields reports symbolic HEAD and refs', async () => {
    const root = tmp('fields')
    const repo = newRepo(root)
    const fields = await readRepoSnapshotFields(repo)
    expect(fields.head).toEqual({ ref: 'refs/heads/main' })
    expect(fields.refs['refs/heads/main']).toBe(git(repo, 'rev-parse', 'HEAD'))
    expect(fields.config).toContain('lfs')
  })
})
